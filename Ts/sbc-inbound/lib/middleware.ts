// @ts-nocheck — drachtio response/request surface is wider than typings (res.once, res.send overloads).
import assert from 'node:assert';
import debugFactory = require('debug');
import DrachtioSrf = require('drachtio-srf');
import digestChallenge = require('@jambonz/digest-utils');
import type { Logger } from 'pino';
import { nudgeCallCounts, roundTripTime, isMSTeamsCIDR } from './utils';
import type { JambonzSrfRequest, JambonzSrfResponse, SrfInstance } from '../types/jambonz-sip';

const debug = debugFactory('jambonz:sbc-inbound');
const Dmod = DrachtioSrf as unknown as {
  parseUri(u: string): { host?: string } | null;
};
const parseUri = Dmod.parseUri.bind(Dmod);

const msProxyIps = process.env.MS_TEAMS_SIP_PROXY_IPS ?
  process.env.MS_TEAMS_SIP_PROXY_IPS.split(',').map((i) => i.trim()) :
  [];

type SrfMiddlewareNext = (err?: unknown) => void;

type MultipartReq = JambonzSrfRequest & {
  payload?: Array<{ type: string; content: string }>;
  body?: string;
};

const initCdr = (req: JambonzSrfRequest) => {
  return {
    from: req.callingNumber,
    to: req.calledNumber,
    sip_callid: req.get('Call-ID'),
    duration: 0,
    attempted_at: Date.now(),
    direction: 'inbound',
    host: (req.srf.locals as { sipAddress?: string }).sipAddress,
    remote_host: req.source_address,
    answered: false
  };
};

export default function middlewareFactory(srf: SrfInstance, logger: Logger) {

  const {
    lookupAppByTeamsTenant,
    lookupAccountBySipRealm,
    lookupAccountBySid,
    lookupAccountCapacitiesBySid,
    queryCallLimits,
  } = srf.locals.dbHelpers as {
    lookupAppByTeamsTenant: (host: string | undefined) => Promise<Record<string, unknown> | null>;
    lookupAccountBySipRealm: (realm: string | undefined) => Promise<Record<string, unknown> | null>;
    lookupAccountBySid: (sid: string) => Promise<Record<string, unknown>>;
    lookupAccountCapacitiesBySid: (
      sid: string
    ) => Promise<Array<{ category: string; quantity: number }>>;
    queryCallLimits: (
      spSid: string,
      accountSid: string
    ) => Promise<{ account_limit: number; sp_limit: number }>;
  };
  const {
    stats,
    writeCdrs,
    lookupAuthCarriersForAccountAndSP,
    getApplicationForDidAndCarrier
  } = srf.locals as {
    stats: {
      increment: (name: string, tags?: string[]) => void;
      histogram: (name: string, value: string | number, tags?: string[]) => void;
    };
    writeCdrs: (o: Record<string, unknown>) => Promise<unknown>;
    lookupAuthCarriersForAccountAndSP: (a: string, b: string) => Promise<unknown[] | null>;
    getApplicationForDidAndCarrier: (req: JambonzSrfRequest, sid: string) => Promise<string | null | undefined>;
  };

  const initLocals = (req: JambonzSrfRequest, res: JambonzSrfResponse, next: SrfMiddlewareNext) => {
    const callId = req.get('Call-ID');
    req.locals = (req.locals ?? { callId }) as InboundRequestLocals;
    req.locals.callId = callId;
    req.locals.nudge = 0;

    if (req.has('X-Forwarded-For') || req.has('X-Subspace-Forwarded-For')) {
      const original_source_address = req.get('X-Forwarded-For') || req.get('X-Subspace-Forwarded-For');
      logger.info({
        callId: req.get('Call-ID'),
        original_source_address,
        proxy_source_address: req.source_address,
      }, 'overwriting source address for proxied SIP INVITE');
      req.source_address = original_source_address;
    }
    req.locals.cdr = initCdr(req);
    req.on('cancel', () => {
      logger.info({callId}, 'caller hungup before connecting to feature server');
      req.canceled = true;
      const tags = ['canceled:yes', 'sipStatus:487'];
      if (req.locals.originator) tags.push(`originator:${req.locals.originator}`);
      stats.increment('sbc.terminations', tags);
    });
    stats.increment('sbc.invites', ['direction:inbound']);

    res.once('end', ({ status }: { status: number }) => {
      const cdr = req.locals.cdr;
      if (cdr && cdr.account_sid && status > 200 && 401 !== status) {
        const originator = req.locals.originator;
        const trunk = ['trunk', 'teams'].includes(originator as string) ?
          req.locals.carrier :
          originator;
        writeCdrs({...cdr,
          terminated_at: Date.now(),
          termination_reason: status === 487 ? 'caller abandoned' : 'failed',
          sip_status: status,
          trunk
        }).catch((err: unknown) => logger.error({err}, 'Error writing cdr for call failure'));
      }
    });

    next();
  };

  const handleSipRec = (req: MultipartReq, res: JambonzSrfResponse, next: SrfMiddlewareNext) => {
    const {callId} = req.locals;
    if (Array.isArray(req.payload) && req.payload.length > 1) {
      const sdpPart = req.payload.find((p) => p.type === 'application/sdp');
      const sdp = sdpPart?.content;
      if (!sdp) {
        logger.error({callId}, 'No SDP in multipart sdp');
        return res.send(503);
      }
      const xml = req.payload.find((p) => p.type !== 'application/sdp');
      if (!xml) {
        return res.send(503);
      }
      const endPos = xml.content.indexOf('</recording>');
      xml.content = endPos !== -1 ?
        `${xml.content.substring(0, endPos + 12)}` :
        xml.content;
      logger.debug({callId, xml}, 'incoming call with SIPREC body');
      req.locals = {...req.locals, sdp, siprec: true, xml};
    }
    else req.locals = {...req.locals, sdp: req.body};
    next();
  };

  const identifyAccount = async(req: JambonzSrfRequest, res: JambonzSrfResponse, next: SrfMiddlewareNext) => {
    try {
      const {siprec, callId} = req.locals;
      const {
        getSPForAccount,
        wasOriginatedFromCarrier,
        getApplicationForDidAndCarrier: getAppForDidCarrier,
        stats: sstats
      } = req.srf.locals as {
        getSPForAccount: (sid: string) => Promise<string | null>;
        wasOriginatedFromCarrier: (req: JambonzSrfRequest) => Promise<{
          fromCarrier: boolean;
          gateway?: Record<string, unknown> & {
            name?: string;
            voip_carrier_sid?: string;
            application_sid?: string;
          };
          account_sid?: string;
          application_sid?: string | null;
          service_provider_sid?: string;
          account?: Record<string, unknown> & { siprec_hook_sid?: string };
          error?: string;
        }>;
        getApplicationForDidAndCarrier: (req: JambonzSrfRequest, sid: string) => Promise<string | null | undefined>;
        stats: typeof stats;
      };
      const startAt = process.hrtime();
      const {
        fromCarrier,
        gateway,
        account_sid,
        application_sid,
        service_provider_sid,
        account,
        error
      } = await wasOriginatedFromCarrier(req);
      const rtt = roundTripTime(startAt);
      sstats.histogram('app.mysql.response_time', rtt, [
        'query:wasOriginatedFromCarrier', 'app:sbc-inbound']);
      if (fromCarrier) {
        if (error) {
          return res.send(503, {
            headers: {
              'X-Reason': error
            }
          });
        }
        if (!gateway) {
          logger.info('identifyAccount: rejecting call from carrier because DID has not been provisioned');
          return res.send(404, 'Number Not Provisioned');
        }
        logger.info({gateway}, 'identifyAccount: incoming call from gateway');
        const appSidHeader = req.get('x-application-sid');
        if (appSidHeader && appSidHeader == application_sid) {
          logger.info({callId}, 'Loop Detected, x-application-sid header on incoming call matches applicationSid');
          return res.send(482, 'Loop Detected on x-application-sid');
        }
        let sid;
        const acc = account as { siprec_hook_sid?: string } | undefined;
        if (siprec) {
          if (!acc?.siprec_hook_sid) {
            logger.info({callId}, 'identifyAccount: rejecting call because SIPREC hook has not been provisioned');
            return res.send(404);
          }
          sid = acc.siprec_hook_sid;
        }
        else {
          sid = application_sid || await getAppForDidCarrier(req, gateway.voip_carrier_sid as string);
        }
        req.locals = {
          originator: 'trunk',
          carrier: gateway.name,
          gateway,
          voip_carrier_sid: gateway.voip_carrier_sid,
          application_sid: sid || gateway.application_sid,
          service_provider_sid,
          account_sid,
          account,
          ...req.locals
        } as InboundRequestLocals;
      }
      else if (msProxyIps.includes(req.source_address) || isMSTeamsCIDR(req.source_address)) {
        logger.info({source_address: req.source_address}, 'identifyAccount: incoming call from Microsoft Teams');
        const uri = parseUri(req.uri);

        const app = await lookupAppByTeamsTenant(uri?.host);
        if (!app) {
          stats.increment('sbc.terminations', ['sipStatus:404']);
          res.send(404, {headers: {'X-Reason': 'no configured application'}});
          return req.srf.endSession(req);
        }
        const service_provider_sid = await getSPForAccount(app.account_sid as string);
        req.locals = {
          originator: 'teams',
          carrier: 'Microsoft Teams',
          msTeamsTenantFqdn: uri?.host,
          account_sid: app.account_sid,
          service_provider_sid,
          ...req.locals
        } as InboundRequestLocals;
      }
      else {
        req.locals.originator = 'user';
        const uri = parseUri(req.uri);
        logger.info({source_address: req.source_address, realm: uri?.host},
          'identifyAccount: incoming user call');
        const account = await lookupAccountBySipRealm(uri?.host);
        if (!account) {
          stats.increment('sbc.terminations', ['sipStatus:404']);
          res.send(404);
          return req.srf.endSession(req);
        }
        const auth_trunks = await lookupAuthCarriersForAccountAndSP(
          account.account_sid as string,
          account.service_provider_sid as string
        ) as unknown[] | null;

        if (process.env.SBC_ACCOUNT_SID && account.account_sid !== process.env.SBC_ACCOUNT_SID) {
          logger.info(
            `identifyAccount: static IP for ${process.env.SBC_ACCOUNT_SID} but call for ${account.account_sid}`);
          stats.increment('sbc.terminations', ['sipStatus:404']);
          delete req.locals.cdr;
          res.send(404);
          return req.srf.endSession(req);
        }
        req.locals = {
          service_provider_sid: account.service_provider_sid,
          account_sid: account.account_sid,
          account,
          application_sid: account.device_calling_application_sid,
          webhook_secret: account.webhook_secret,
          realm: uri?.host,
          ...(account.registration_hook && {
            registration_hook_url: (account.registration_hook as { url?: string }).url,
            registration_hook_method: (account.registration_hook as { method?: string }).method,
            registration_hook_username: (account.registration_hook as { username?: string }).username,
            registration_hook_password: (account.registration_hook as { password?: string }).password
          }),
          ...(auth_trunks?.length && {auth_trunks}),
          ...req.locals
        } as InboundRequestLocals;
      }
      assert(req.locals.service_provider_sid);
      assert(req.locals.account_sid);
      if (req.locals.cdr) {
        req.locals.cdr.account_sid = req.locals.account_sid as string;
      }

      if (!req.locals.account) {
        req.locals.account = await lookupAccountBySid(req.locals.account_sid as string);
      }
      if (req.locals.cdr && req.locals.account) {
        req.locals.cdr.service_provider_sid = req.locals.account.service_provider_sid as string | undefined;
      }

      if (!req.locals.account?.is_active) {
        stats.increment('sbc.terminations', ['sipStatus:503']);
        return res.send(503, {headers: {'X-Reason': 'Account exists but is inactive'}});
      }

      if (req.locals.account?.disable_cdrs) {
        logger.info({account_sid: req.locals.account_sid}, 'Not writing CDRs for this account');
        delete req.locals.cdr;
      }

      req.locals.logger = logger.child({
        callId: req.get('Call-ID'),
        service_provider_sid: req.locals.service_provider_sid,
        account_sid: req.locals.account_sid
      }, {
        ...(req.locals.account?.enable_debug_log && {level: 'debug' as const})
      });

      next();
    } catch (err) {
      stats.increment('sbc.terminations', ['sipStatus:500']);
      logger.error(err, `${req.get('Call-ID')} database error for inbound call`);
      res.send(500);
    }
  };

  const checkLimits = async(req: JambonzSrfRequest, res: JambonzSrfResponse, next: SrfMiddlewareNext) => {
    const trackingOn = process.env.JAMBONES_TRACK_ACCOUNT_CALLS ||
    process.env.JAMBONES_TRACK_SP_CALLS ||
    process.env.JAMBONES_TRACK_APP_CALLS;
    if (!process.env.JAMBONES_HOSTING && !trackingOn) return next();

    const {incrKey, decrKey} = req.srf.locals.realtimeDbHelpers as {
      incrKey: (k: string) => Promise<number | null>;
      decrKey: (k: string) => Promise<number | null>;
    };
    const {logger, account_sid, account, service_provider_sid, application_sid} = req.locals;
    const {writeCallCount, writeCallCountSP, writeCallCountApp, writeAlerts, AlertType} = req.srf.locals as {
      writeCallCount: (o: Record<string, unknown>) => Promise<unknown>;
      writeCallCountSP: (o: Record<string, unknown>) => Promise<unknown>;
      writeCallCountApp: (o: Record<string, unknown>) => Promise<unknown>;
      writeAlerts: (o: Record<string, unknown>) => Promise<unknown>;
      AlertType: Record<string, string>;
    };
    assert(account_sid);
    assert(service_provider_sid);
    assert(logger);

    if (req.canceled) {
      logger.info('checkLimits: call was immediately canceled, no need to increment call count as we are done');
      return;
    }

    res.once('end', async({status}: { status: number }) => {
      if (status > 200) {
        nudgeCallCounts(req, 'failure', {
          service_provider_sid: service_provider_sid as string,
          account_sid: account_sid as string,
          application_sid,
          callId: req.locals.callId
        }, decrKey, {writeCallCountSP, writeCallCount, writeCallCountApp})
          .catch((err: unknown) => logger.error(err, 'Error decrementing call counts'));
      }
    });

    try {
      const {callsSP, calls} = await nudgeCallCounts(req, 'init', {
        service_provider_sid: service_provider_sid as string,
        account_sid: account_sid as string,
        application_sid,
        callId: req.locals.callId
      }, incrKey, {writeCallCountSP, writeCallCount, writeCallCountApp});

      const minLimit = process.env.MIN_CALL_LIMIT ?
        parseInt(process.env.MIN_CALL_LIMIT, 10) :
        0;
      logger.debug(`checkLimits: call count is now ${calls}, limit is ${minLimit}`);
      if (calls !== null && calls !== undefined && calls <= minLimit) return next();

      const accountCapacities = await lookupAccountCapacitiesBySid(account_sid as string);
      const accountLimit = accountCapacities.find((c) => c.category == 'voice_call_session');
      if (accountLimit) {
        const limit_sessions = accountLimit.quantity;
        if (calls !== null && calls !== undefined && calls > limit_sessions) {
          debug(`checkLimits: limits exceeded: call count ${calls}, limit ${limit_sessions}`);
          logger.info({calls, limit_sessions}, 'checkLimits: limits exceeded');
          writeAlerts({
            alert_type: AlertType.ACCOUNT_CALL_LIMIT,
            service_provider_sid: (account as { service_provider_sid: string }).service_provider_sid,
            account_sid,
            count: limit_sessions
          }).catch((err: unknown) => logger.info({err}, 'checkLimits: error writing alert'));
          res.send(503, 'Maximum Calls In Progress');
          return req.srf.endSession(req);
        }
      }
      else if (trackingOn) {
        const {account_limit, sp_limit} = await queryCallLimits(service_provider_sid as string, account_sid as string);
        if (process.env.JAMBONES_TRACK_ACCOUNT_CALLS && account_limit > 0 && calls !== null && calls !== undefined && calls > account_limit) {
          logger.info({calls, account_limit}, 'checkLimits: account limits exceeded');
          writeAlerts({
            alert_type: AlertType.ACCOUNT_CALL_LIMIT,
            service_provider_sid: service_provider_sid,
            account_sid,
            count: account_limit
          }).catch((err: unknown) => logger.info({err}, 'checkLimits: error writing alert'));
          res.send(503, 'Max Account Calls In Progress', {
            headers: {
              'X-Account-Sid': account_sid,
              'X-Call-Limit': account_limit
            }
          });
          return req.srf.endSession(req);
        }
        if (!account_limit && !sp_limit && process.env.JAMBONES_HOSTING) {
          logger.info(`checkLimits: no active subscription found for account ${account_sid}, rejecting call`);
          res.send(503, 'No Active Subscription');
          return req.srf.endSession(req);
        }
        if (process.env.JAMBONES_TRACK_SP_CALLS && sp_limit > 0 && callsSP !== null && callsSP !== undefined && callsSP > sp_limit) {
          logger.info({callsSP, sp_limit}, 'checkLimits: service provider limits exceeded');
          writeAlerts({
            alert_type: AlertType.SP_CALL_LIMIT,
            service_provider_sid: service_provider_sid,
            count: sp_limit
          }).catch((err: unknown) => logger.info({err}, 'checkLimits: error writing alert'));
          res.send(503, 'Max Service Provider Calls In Progress', {
            headers: {
              'X-Service-Provider-Sid': service_provider_sid,
              'X-Call-Limit': sp_limit
            }
          });
          return req.srf.endSession(req);
        }
      }
      next();
    } catch (err) {
      stats.increment('sbc.terminations', ['sipStatus:500']);
      logger.error({err}, 'error checking limits error for inbound call');
      res.send(500);
      req.srf.endSession(req);
    }
  };

  const identifyAuthTrunk = async(req: JambonzSrfRequest, res: JambonzSrfResponse, next: SrfMiddlewareNext) => {
    try {
      type AuthGrant = {
        status?: string;
        auth_trunk?: Record<string, unknown> & {
          name?: string;
          voip_carrier_sid?: string;
          application_sid?: string;
        };
      };
      if (req.authorization) {
        const {grant} = req.authorization as { grant?: AuthGrant };
        if (grant && grant.status === 'ok' && grant.auth_trunk) {
          const application_sid = await getApplicationForDidAndCarrier(req, grant.auth_trunk.voip_carrier_sid as string);

          req.locals = {
            ...req.locals,
            originator: 'trunk',
            carrier: grant.auth_trunk.name,
            gateway: grant.auth_trunk,
            voip_carrier_sid: grant.auth_trunk.voip_carrier_sid,
            application_sid: application_sid || grant.auth_trunk.application_sid,
          } as InboundRequestLocals;
          delete req.authorization;
          logger.debug({callId: req.locals.callId, auth_trunk: grant.auth_trunk.name},
            'identifyAuthTrunk: call authenticated for auth trunk');
        }
      }
      next();
    } catch (err) {
      stats.increment('sbc.terminations', ['sipStatus:500']);
      logger.error(err, `${req.get('Call-ID')} Error challenging auth trunk`);
      res.send(500);
      req.srf.endSession(req);
    }
  };

  const challengeDeviceCalls = async(req: JambonzSrfRequest, res: JambonzSrfResponse, next: SrfMiddlewareNext) => {
    try {
      if (req.locals.originator !== 'user') return next();
      return digestChallenge(req, res, next) as unknown as void;
    } catch (err) {
      stats.increment('sbc.terminations', ['sipStatus:500']);
      logger.error(err, `${req.get('Call-ID')} Error looking up related info for inbound call`);
      res.send(500);
      req.srf.endSession(req);
    }
  };

  return {
    initLocals,
    handleSipRec,
    challengeDeviceCalls,
    identifyAccount,
    identifyAuthTrunk,
    checkLimits
  };
}
