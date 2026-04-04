import { EventEmitter as Emitter } from 'node:events';
import type { Logger } from 'pino';
import type { SrfInstance } from '../types/jambonz-sip';
import lifecycleConstants from './constants.json';

const noopLogger = {info: () => {}, error: () => {}};
const {LifeCycleEvents} = lifecycleConstants;

export default function autoscaleManagerFactory(logger: Logger | undefined) {
  const log = (logger ?? noopLogger) as Logger;

  let lifecycleEmitter = new Emitter() as Emitter & {
    dryUpCalls: boolean;
    operationalState?: string;
    scaleIn?: () => void;
    completeScaleIn?: () => void;
    on: Emitter['on'];
  };
  lifecycleEmitter.dryUpCalls = false;
  if (process.env.AWS_SNS_TOPIC_ARN) {

    void (async function() {
      try {
        const snsModule = await import('./aws-sns-lifecycle');
        const snsFactory = snsModule.default;
        lifecycleEmitter = await snsFactory(log) as unknown as typeof lifecycleEmitter;

        lifecycleEmitter
          .on(LifeCycleEvents.ScaleIn, async() => {
            log.info('AWS scale-in notification: begin drying up calls');
            lifecycleEmitter.dryUpCalls = true;
            lifecycleEmitter.operationalState = LifeCycleEvents.ScaleIn;

            const {srf} = require('..') as { srf: SrfInstance };
            const {activeCallIds, removeFromRedis} = srf.locals as {
              activeCallIds: Map<string, unknown>;
              removeFromRedis: () => void;
            };

            removeFromRedis();

            const calls = activeCallIds.size;
            if (0 === calls) {
              log.info('scale-in can complete immediately as we have no calls in progress');
              lifecycleEmitter.completeScaleIn?.();
            }
            else {
              log.info(`${calls} calls in progress; scale-in will complete when they are done`);
            }
          })
          .on(LifeCycleEvents.StandbyEnter, () => {
            lifecycleEmitter.dryUpCalls = true;
            const {srf} = require('..') as { srf: SrfInstance };
            const {removeFromRedis} = srf.locals as { removeFromRedis: () => void };
            removeFromRedis();

            log.info('AWS enter pending state notification: begin drying up calls');
          })
          .on(LifeCycleEvents.StandbyExit, () => {
            lifecycleEmitter.dryUpCalls = false;
            const {srf} = require('..') as { srf: SrfInstance };
            const {addToRedis} = srf.locals as { addToRedis: () => void };
            addToRedis();

            log.info('AWS exit pending state notification: re-enable calls');
          });
      } catch (err) {
        log.error({err}, 'Failure creating SNS notifier, lifecycle events will be disabled');
      }
    })();
  }
  else if (process.env.K8S) {
    lifecycleEmitter.scaleIn = () => process.exit(0);
  }

  return {lifecycleEmitter};
}
