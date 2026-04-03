import debugFactory = require('debug');
import DrachtioSrf = require('drachtio-srf');
import type { JambonzSrfRequest, JambonzSrfResponse, SrfInstance } from '../types/jambonz-sip';
import Registrar = require('@jambonz/mw-registrar');
import { nudgeCallCounts } from './utils';
import type { Logger } from 'pino';
const debug = debugFactory('jambonz:sbc-outbound');
const Dmod = DrachtioSrf as unknown as {
  parseUri(u: string): { user?: string; host?: string } | null;
};
const parseUri = Dmod.parseUri.bind(Dmod);

const FS_UUID_SET_NAME = 'fsUUIDs';

type SrfMiddlewareNext = (err?: unknown) => void;

export default function middlewareFactory(
  srf: SrfInstance,
  logger: Logger,
  redisClient: RealtimeClient
) {
  const { incrKey, decrKey, isMemberOfSet } = srf.locals.realtimeDbHelpers as {
    incrKey: (key: string) => Promise<number | null>;
    decrKey: (key: string) => Promise<number | null>;
    isMemberOfSet: (name: string, member: string | undefined) => Promise<boolean>;
  };
  const { stats } = srf.locals as { stats: { increment: (name: string, tags?: string[]) => void } };
  const registrar = new Registrar(logger, redisClient);
  const { lookupAccountCapacitiesBySid, lookupAccountBySid, queryCallLimits } = srf.locals.dbHelpers as {
    lookupAccountCapacitiesBySid: (sid: string) => Promise<Array<{ category: string; quantity: number }>>;
    lookupAccountBySid: (sid: string) => Promise<Record<string, unknown>>;
    queryCallLimits: (spSid: string, accountSid: string) => Promise<{ account_limit: number; sp_limit: number }>;
  };

  const initLocals = async(req: JambonzSrfRequest, res: JambonzSrfResponse, next: SrfMiddlewareNext) => {
    req.locals = (req.locals ?? {}) as OutboundRequestLocals;
    const callId = req.get('Call-ID');
    req.locals.nudge = 0;
    req.locals.callId = callId;
    req.locals.account_sid = req.get('X-Account-Sid');
    req.locals.application_sid = req.get('X-Application-Sid');
    req.locals.record_all_calls = req.get('X-Record-All-Calls');
    const traceId = (req.locals.trace_id = req.get('X-Trace-ID'));
    req.locals.logger = logger.child({
      callId,
      traceId,
      account_sid: req.locals.account_sid
    });

    if (!req.locals.account_sid) {
      logger.info('missing X-Account-Sid on outbound call');
      res.send(403, {
        headers: {
          'X-Reason': 'missing X-Account-Sid'
        }
      });
      req.srf.endSession(req);
      return;
    }

    /* must come from a valid FS */
    if (!req.has('X-Jambonz-Routing')) {
      logger.info({ msg: req.msg }, 'missing X-Jambonz-Routing header');
      res.send(403, {
        headers: {
          'X-Reason': 'missing required jambonz headers'
        }
      });
      req.srf.endSession(req);
      return;
    }
    if (process.env.K8S) {
      /* for K8S we do not use JAMBONES_CIDR so we must validate the sender by uuid FS creates */
      const fsUUID = req.get('X-Jambonz-FS-UUID');
      try {
        const exists = await isMemberOfSet(FS_UUID_SET_NAME, fsUUID);
        if (!exists || !fsUUID) {
          res.send(403, {
            headers: {
              'X-Reason': `missing or invalid FS-UUID ${fsUUID}`
            }
          });
          req.srf.endSession(req);
          return;
        }
      } catch {
        res.send(500);
        req.srf.endSession(req);
        return;
      }
    }

    stats.increment('sbc.invites', ['direction:outbound']);

    req.on('cancel', () => {
      req.locals.logger.info({ callId }, 'caller hungup before connecting');
      req.canceled = true;
      const tags = ['canceled:yes', 'sipStatus:487'];
      if (req.locals.originator) tags.push(`originator:${req.locals.originator}`);
      stats.increment('sbc.origination', tags);
    });

    try {
      const account = (await lookupAccountBySid(req.locals.account_sid)) as unknown as OutboundAccount;
      req.locals.account = account;
      if (account.enable_debug_log) {
        req.locals.logger.level = 'debug';
      }
      req.locals.service_provider_sid = req.locals.account.service_provider_sid;
    } catch (err: unknown) {
      req.locals.logger.error({ err }, `Error looking up account sid ${req.locals.account_sid}`);
      res.send(500);
      req.srf.endSession(req);
      return;
    }
    next();
  };

  const checkLimits = async(req: JambonzSrfRequest, res: JambonzSrfResponse, next: SrfMiddlewareNext) => {
    const { logger, account_sid, service_provider_sid, application_sid } = req.locals;
    const trackingOn =
      process.env.JAMBONES_TRACK_ACCOUNT_CALLS ||
      process.env.JAMBONES_TRACK_SP_CALLS ||
      process.env.JAMBONES_TRACK_APP_CALLS;
    if (!process.env.JAMBONES_HOSTING && !trackingOn) {
      logger.debug('tracking is off, skipping call limit checks');
      next();
      return;
    }

    const { writeCallCount, writeCallCountSP, writeCallCountApp, writeAlerts, AlertType } = req.srf.locals as {
      writeCallCount: (opts: Record<string, unknown>) => Promise<unknown>;
      writeCallCountSP: (opts: Record<string, unknown>) => Promise<unknown>;
      writeCallCountApp: (opts: Record<string, unknown>) => Promise<unknown>;
      writeAlerts: (opts: Record<string, unknown>) => Promise<unknown>;
      AlertType: Record<string, string>;
    };

    try {
      /* decrement count if INVITE is later rejected */
      (res as unknown as NodeJS.EventEmitter).once('end', async({ status }: { status: number }) => {
        if (status > 200) {
          void nudgeCallCounts(
            req,
            'failure',
            {
              service_provider_sid,
              account_sid,
              application_sid,
              callId: req.locals.callId
            },
            decrKey,
            { writeCallCountSP, writeCallCount, writeCallCountApp }
          ).catch((e: unknown) => logger.error(e, 'Error decrementing call counts'));
          const tags = ['accepted:no', `sipStatus:${status}`];
          stats.increment('sbc.originations', tags);
        } else {
          const tags = ['accepted:yes', 'sipStatus:200'];
          stats.increment('sbc.originations', tags);
        }
      });

      /* increment the call count */
      const { callsSP, calls } = await nudgeCallCounts(
        req,
        'init',
        {
          service_provider_sid,
          account_sid,
          application_sid,
          callId: req.locals.callId
        },
        incrKey,
        { writeCallCountSP, writeCallCount, writeCallCountApp }
      );

      /* compare to account's limit, though avoid db hit when call count is low */
      const minLimit = process.env.MIN_CALL_LIMIT ? parseInt(process.env.MIN_CALL_LIMIT, 10) : 0;
      if (calls != null && calls <= minLimit) {
        next();
        return;
      }

      const capacities = await lookupAccountCapacitiesBySid(account_sid);
      const limit = capacities.find((c) => c.category == 'voice_call_session');
      if (limit) {
        const limit_sessions = limit.quantity;

        if (calls != null && calls > limit_sessions) {
          logger.info({ calls, limit_sessions }, 'checkLimits: limits exceeded');
          void writeAlerts({
            alert_type: AlertType.ACCOUNT_CALL_LIMIT,
            service_provider_sid,
            account_sid,
            count: limit_sessions
          }).catch((e: unknown) => logger.info({ err: e }, 'checkLimits: error writing alert'));
          res.send(503, 'Maximum Calls In Progress', {});
          req.srf.endSession(req);
          return;
        }
      } else if (trackingOn) {
        const { account_limit, sp_limit } = await queryCallLimits(service_provider_sid, account_sid);
        if (process.env.JAMBONES_TRACK_ACCOUNT_CALLS && account_limit > 0 && calls != null && calls > account_limit) {
          logger.info({ calls, account_limit }, 'checkLimits: account limits exceeded');
          void writeAlerts({
            alert_type: AlertType.ACCOUNT_CALL_LIMIT,
            service_provider_sid,
            account_sid,
            count: calls
          }).catch((e: unknown) => logger.info({ err: e }, 'checkLimits: error writing alert'));
          res.send(503, 'Max Account Calls In Progress', {
            headers: {
              'X-Account-Sid': account_sid,
              'X-Call-Limit': String(account_limit)
            }
          });
          req.srf.endSession(req);
          return;
        }
        if (!account_limit && !sp_limit && process.env.JAMBONES_HOSTING) {
          logger.info(`checkLimits: no active subscription found for account ${account_sid}, rejecting call`);
          res.send(503, 'No Active Subscription', {});
          req.srf.endSession(req);
          return;
        }
        if (process.env.JAMBONES_TRACK_SP_CALLS && sp_limit > 0 && callsSP != null && callsSP > sp_limit) {
          logger.info({ callsSP, sp_limit }, 'checkLimits: service provider limits exceeded');
          void writeAlerts({
            alert_type: AlertType.SP_CALL_LIMIT,
            service_provider_sid,
            count: callsSP
          }).catch((e: unknown) => logger.info({ err: e }, 'checkLimits: error writing alert'));
          res.send(503, 'Max Service Provider Calls In Progress', {
            headers: {
              'X-Service-Provider-Sid': service_provider_sid,
              'X-Call-Limit': String(sp_limit)
            }
          });
          req.srf.endSession(req);
          return;
        }
      }
      next();
    } catch (err: unknown) {
      logger.error({ err }, 'error checking limits error for inbound call');
      res.send(500);
    }
  };

  const route = async(req: JambonzSrfRequest, res: JambonzSrfResponse, next: SrfMiddlewareNext) => {
    const routeLogger = req.locals.logger;
    const { lookupAccountBySipRealm } = req.srf.locals.dbHelpers as {
      lookupAccountBySipRealm: (host: string) => Promise<{ account_sid: string } | null>;
    };
    routeLogger.info(`received outbound INVITE to ${req.uri} from server at ${req.server.hostport}`);
    const uri = parseUri(req.uri);
    const desiredRouting = req.get('X-Jambonz-Routing');
    const validUri = uri && uri.user && uri.host;
    if (['user', 'sip'].includes(desiredRouting) && !validUri) {
      routeLogger.info({ uri: req.uri }, 'invalid request-uri on outbound call, rejecting');
      res.send(400, {
        headers: {
          'X-Reason': 'invalid request-uri'
        }
      });
      req.srf.endSession(req);
      return;
    }
    debug(`received outbound INVITE to ${req.calledNumber} from server at ${req.server.hostport}`);

    if (desiredRouting === 'teams') {
      routeLogger.debug('This is a call to ms teams');
      req.locals.target = 'teams';
    } else if (desiredRouting === 'user') {
      const aor = `${uri!.user}@${uri!.host}`;
      const reg = (await registrar.query(aor)) as RegistrationRecord | null;
      if (reg) {
        routeLogger.info({ details: reg }, `sending call to registered user ${aor}`);
        if (req.server.hostport !== reg.sbcAddress) {
          /* redirect to the correct SBC where this user is connected */
          const proxyAddress = reg.privateSbcAddress.split(':');
          const redirectUri = `<sip:${proxyAddress[0]}>`;
          routeLogger.info(
            {
              myHostPort: req.server.hostport,
              registeredHostPort: reg.sbcAddress
            },
            `redirecting call to SBC at ${redirectUri}`
          );
          res.send(302, { headers: { Contact: redirectUri } });
          return;
        }
        req.locals.registration = reg;
        req.locals.target = 'user';
      } else {
        const account = await lookupAccountBySipRealm(uri!.host!);
        if (account) {
          routeLogger.info({ host: uri!.host, account }, `returning 404 to unregistered user in valid domain: ${req.uri}`);
        } else {
          routeLogger.info({ host: uri!.host, account }, `returning 404 to user in invalid domain: ${req.uri}`);
        }
        res.send(404);
        req.srf.endSession(req);
        return;
      }
    } else if (desiredRouting === 'sip') {
      routeLogger.info(`forwarding call to sip endpoint ${req.uri}`);

      if (process.env.JAMBONES_LOCAL_SIP_DOMAINS) {
        const allowedDomains = process.env.JAMBONES_LOCAL_SIP_DOMAINS.split(',');
        const domain = uri!.host!;
        const isLoop = allowedDomains.some((allowed) => domain === allowed.trim() || domain.endsWith(`.${allowed.trim()}`));
        if (isLoop) {
          routeLogger.info({ host: domain }, `returning 482 Loop Detected for attempt to send to: ${req.uri}`);
          res.send(482, 'Loop Detected', {});
          req.srf.endSession(req);
          return;
        }
      }
      req.locals.target = 'forward';
    } else if (desiredRouting === 'phone') {
      debug('sending call to LCR');
      req.locals.target = 'lcr';
    }
    next();
  };

  return {
    initLocals,
    checkLimits,
    route
  };
}
