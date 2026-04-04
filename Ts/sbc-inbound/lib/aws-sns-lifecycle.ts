import { EventEmitter as Emitter } from 'node:events';
import express = require('express');
import bent = require('bent');
import assert = require('assert');
import {
  SNSClient,
  SubscribeCommand,
  UnsubscribeCommand
} from '@aws-sdk/client-sns';
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  CompleteLifecycleActionCommand
} from '@aws-sdk/client-auto-scaling';
import { Parser } from 'xml2js';
import { validatePayload } from 'verify-aws-sns-signature';
import type { Logger } from 'pino';
import type { Express, Request, Response, NextFunction } from 'express';
import lifecycleConstants from './constants.json';

const PORT = process.env.AWS_SNS_PORT || 3010;
const {LifeCycleEvents} = lifecycleConstants;
const app: Express = express();
const getString = bent('string');
const snsClient = new SNSClient({ region: process.env.AWS_REGION, apiVersion: '2010-03-31' });
const autoScalingClient = new AutoScalingClient({ region: process.env.AWS_REGION, apiVersion: '2011-01-01' });
const parser = new Parser();

type ScaleInParams = {
  AutoScalingGroupName: string;
  LifecycleActionResult: string;
  LifecycleActionToken: string;
  LifecycleHookName: string;
};

class SnsNotifier extends Emitter {
  logger: Logger;
  snsEndpoint?: string;
  subscriptionArn?: string;
  subscriptionRequestId?: string;
  instanceId?: string;
  publicIp?: string;
  lifecycleState?: string;
  scaleInParams?: ScaleInParams;
  operationalState?: string;

  constructor(logger: Logger) {
    super();
    this.logger = logger;
  }

  _doListen(logger: Logger, app: Express, port: number, resolve: (v: unknown) => void) {
    return app.listen(port, () => {
      this.snsEndpoint = `http://${this.publicIp}:${port}`;
      logger.info(`SNS lifecycle server listening on http://localhost:${port}`);
      resolve(app);
    });
  }

  _handleErrors(
    logger: Logger,
    app: Express,
    resolve: (v: unknown) => void,
    reject: (e: unknown) => void,
    e: NodeJS.ErrnoException & { port?: number }
  ) {
    if (e.code === 'EADDRINUSE' &&
      process.env.AWS_SNS_PORT_MAX &&
      e.port !== undefined &&
      e.port < Number(process.env.AWS_SNS_PORT_MAX)) {

      logger.info(`SNS lifecycle server failed to bind port on ${e.port}, will try next port`);
      const server = this._doListen(logger, app, ++e.port, resolve);
      server.on('error', this._handleErrors.bind(this, logger, app, resolve, reject));
      return;
    }
    reject(e);
  }

  async _handlePost(req: Request, res: Response) {
    try {
      const parsedBody = (typeof req.body === 'string' ?
        JSON.parse(req.body) :
        req.body) as Record<string, unknown>;
      this.logger.debug({headers: req.headers, body: parsedBody}, 'Received HTTP POST from AWS');
      if (!validatePayload(parsedBody)) {
        this.logger.info('incoming AWS SNS HTTP POST failed signature validation');
        return res.sendStatus(403);
      }
      this.logger.debug('incoming HTTP POST passed validation');
      res.sendStatus(200);

      switch (parsedBody.Type) {
        case 'SubscriptionConfirmation': {
          const response = await getString(parsedBody.SubscribeURL as string) as string;
          const result = await parser.parseStringPromise(response) as {
            ConfirmSubscriptionResponse: {
              ConfirmSubscriptionResult: Array<{ SubscriptionArn: string[] }>;
              ResponseMetadata: Array<{ RequestId: string[] }>;
            };
          };
          this.subscriptionArn = result.ConfirmSubscriptionResponse.ConfirmSubscriptionResult[0].SubscriptionArn[0];
          this.subscriptionRequestId = result.ConfirmSubscriptionResponse.ResponseMetadata[0].RequestId[0];
          this.logger.info({
            subscriptionArn: this.subscriptionArn,
            subscriptionRequestId: this.subscriptionRequestId
          }, 'response from SNS SubscribeURL');
          const data = await this.describeInstance();

          const group = data.AutoScalingGroups?.find((g) =>
            g.Instances && g.Instances.some((instance) => instance.InstanceId === this.instanceId)
          );
          if (!group) {
            this.logger.error({data}, 'Current instance not found in any Auto Scaling group');
          } else {
            const instance = group.Instances?.find((inst) => inst.InstanceId === this.instanceId);
            this.lifecycleState = instance?.LifecycleState;
          }

          this.emit('SubscriptionConfirmation', {publicIp: this.publicIp});
          break;
        }

        case 'Notification':
          if (String(parsedBody.Subject).startsWith('Auto Scaling:  Lifecycle action \'TERMINATING\'')) {
            const msg = JSON.parse(parsedBody.Message as string) as {
              EC2InstanceId?: string;
              AutoScalingGroupName?: string;
              LifecycleActionToken?: string;
              LifecycleHookName?: string;
            };
            if (msg.EC2InstanceId === this.instanceId) {
              this.logger.info('SnsNotifier - begin scale-in operation');
              this.scaleInParams = {
                AutoScalingGroupName: msg.AutoScalingGroupName as string,
                LifecycleActionResult: 'CONTINUE',
                LifecycleActionToken: msg.LifecycleActionToken as string,
                LifecycleHookName: msg.LifecycleHookName as string
              };
              this.operationalState = LifeCycleEvents.ScaleIn;
              this.emit(LifeCycleEvents.ScaleIn);
              void this.unsubscribe();
            }
            else {
              this.logger.debug(`SnsNotifier - instance ${msg.EC2InstanceId} is scaling in (not us)`);
            }
          }
          break;

        default:
          this.logger.info(`unhandled SNS Post Type: ${String(parsedBody.Type)}`);
      }

    } catch (err) {
      this.logger.error({err}, 'Error processing SNS POST request');
      if (!res.headersSent) res.sendStatus(500);
    }
  }

  async init() {
    try {
      this.logger.debug('SnsNotifier: retrieving instance data');
      this.instanceId = await getString('http://169.254.169.254/latest/meta-data/instance-id') as string;
      this.publicIp = await getString('http://169.254.169.254/latest/meta-data/public-ipv4') as string;
      this.logger.info({
        instanceId: this.instanceId,
        publicIp: this.publicIp
      }, 'retrieved AWS instance data');

      app.use(express.urlencoded({ extended: true }));
      app.use(express.json());
      app.use(express.text());
      app.post('/', this._handlePost.bind(this));
      app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
        const e = err as { status?: number; message?: string };
        this.logger.error(err, 'burped error');
        res.status(e.status || 500).json({msg: e.message});
      });
      return new Promise((resolve, reject) => {
        const server = this._doListen(this.logger, app, Number(PORT), resolve);
        server.on('error', this._handleErrors.bind(this, this.logger, app, resolve, reject));
      });

    } catch (err) {
      this.logger.error({err}, 'Error retrieving AWS instance metadata');
    }
  }

  async subscribe() {
    try {
      const params = {
        Protocol: 'http',
        TopicArn: process.env.AWS_SNS_TOPIC_ARN,
        Endpoint: this.snsEndpoint
      };
      const response = await snsClient.send(new SubscribeCommand(params));
      this.logger.info({response}, `response to SNS subscribe to ${process.env.AWS_SNS_TOPIC_ARN}`);
    } catch (err) {
      this.logger.error({err}, `Error subscribing to SNS topic arn ${process.env.AWS_SNS_TOPIC_ARN}`);
    }
  }

  async unsubscribe() {
    if (!this.subscriptionArn) throw new Error('SnsNotifier#unsubscribe called without an active subscription');
    try {
      const params = {
        SubscriptionArn: this.subscriptionArn
      };
      const response = await snsClient.send(new UnsubscribeCommand(params));
      this.logger.info({response}, `response to SNS unsubscribe to ${process.env.AWS_SNS_TOPIC_ARN}`);
    } catch (err) {
      this.logger.error({err}, `Error unsubscribing to SNS topic arn ${process.env.AWS_SNS_TOPIC_ARN}`);
    }
  }

  /** Called by app when inbound calls have drained after a scale-in signal (mirrors K8S `scaleIn` hook). */
  scaleIn() {
    this.completeScaleIn();
  }

  completeScaleIn() {
    assert(this.scaleInParams);
    autoScalingClient.send(new CompleteLifecycleActionCommand(this.scaleInParams))
      .then((data) => {
        return this.logger.info({data}, 'Successfully completed scale-in action');
      })
      .catch((err) => {
        this.logger.error({err}, 'Error completing scale-in');
      });
  }

  describeInstance() {
    return new Promise<import('@aws-sdk/client-auto-scaling').DescribeAutoScalingGroupsCommandOutput>((resolve, reject) => {
      if (!this.instanceId) return reject(new Error('instance-id unknown'));
      autoScalingClient.send(new DescribeAutoScalingGroupsCommand({
        InstanceIds: [this.instanceId]
      } as Record<string, unknown>))
        .then((data) => {
          this.logger.info({data}, 'SnsNotifier: describeInstance');
          return resolve(data);
        })
        .catch((err) => {
          this.logger.error({err}, 'Error describing instances');
          reject(err);
        });
    });
  }

}

export default async function awsSnsLifecycle(logger: Logger) {
  const notifier = new SnsNotifier(logger);
  await notifier.init();
  await notifier.subscribe();

  process.on('SIGHUP', () => {
    void (async() => {
      try {
        const data = await notifier.describeInstance();
        const state = data.AutoScalingGroups?.[0]?.Instances?.[0]?.LifecycleState;
        if (state && state !== notifier.lifecycleState) {
          notifier.lifecycleState = state;
          switch (state) {
            case 'Standby':
              notifier.emit(LifeCycleEvents.StandbyEnter);
              break;
            case 'InService':
              notifier.emit(LifeCycleEvents.StandbyExit);
              break;
          }
        }
      } catch (err) {
        console.error(err);
      }
    })();
  });
  return notifier;
}
