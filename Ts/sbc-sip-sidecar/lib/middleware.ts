import debug = require('debug');
import DrachtioSrf = require('drachtio-srf');
import type Srf from 'drachtio-srf';

const { parseUri } = DrachtioSrf;
import { NAT_EXPIRES } from './utils';
import { JAMBONES_HOSTING } from './config';
import type { SidecarRequestLocals, SidecarSrf } from '../types/jambonz-locals';

const dbg = debug('jambonz:sbc-registrar');

type RegistrableRequest = Srf.SrfRequest & {
  locals: SidecarRequestLocals;
  registration: { type: string; expires: string; aor: string };
};

export const initLocals = (req: Srf.SrfRequest, res: Srf.SrfResponse, next: (err?: unknown) => void) => {
  const r = req as Srf.SrfRequest & { locals?: SidecarRequestLocals };
  r.locals = r.locals || ({} as SidecarRequestLocals);
  r.locals.logger = (req.srf as SidecarSrf).locals.logger;
  next();
};

export const rejectIpv4 = (req: Srf.SrfRequest, res: Srf.SrfResponse, next: (err?: unknown) => void) => {
  const r = req as RegistrableRequest;
  const { logger } = r.locals;
  const uri = parseUri(req.uri);
  if (!uri?.host || /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(uri.host)) {
    logger.info(`rejecting REGISTER from ${req.uri} as it has an ipv4 address and sip realm is required`);
    res.send(403);
    (req.srf as SidecarSrf).endSession(req);
    return;
  }
  next();
};

export const checkCache = async(req: Srf.SrfRequest, res: Srf.SrfResponse, next: (err?: unknown) => void) => {
  const r = req as RegistrableRequest;
  const { logger } = r.locals;
  const registration = r.registration;
  const uri = parseUri(registration.aor);
  if (!uri) {
    return res.send(403, {
      headers: {
        'X-Reason': 'Invalid address of record'
      }
    });
  }
  const aor = `${uri.user}@${uri.host}`;
  r.locals.realm = uri.host;

  if (registration.type === 'unregister') return next();

  const registrar = (req.srf as SidecarSrf).locals.registrar;
  const result = await registrar.query(aor);
  if (result) {
    if (result.proxy === `sip:${req.source_address}:${req.source_port}`) {
      if (Date.now() + NAT_EXPIRES * 1000 < (result.expiryTime ?? 0)) {
        const ex = new Date(result.expiryTime as number).toISOString();
        const check = new Date(Date.now() + NAT_EXPIRES * 1000).toISOString();
        logger.debug({ ex, check }, `responding to cached register for ${aor}`);
        (res as Srf.SrfResponse & { cached?: boolean }).cached = true;
        res.send(200, {
          headers: {
            Contact: req.get('Contact').replace(/expires=\d+/, `expires=${NAT_EXPIRES}`),
            Expires: NAT_EXPIRES
          }
        });
        (req.srf as SidecarSrf).endSession(req);
        return;
      }
      dbg(`cached registration for ${aor} is about to expire, need to re-authenticate`);
    }
  }
  next();
};

export const checkAccountLimits = async(
  req: Srf.SrfRequest,
  res: Srf.SrfResponse,
  next: (err?: unknown) => void
) => {
  const r = req as RegistrableRequest;
  const { logger } = r.locals;
  const { lookupAccountBySipRealm, lookupAccountCapacitiesBySid } = (req.srf as SidecarSrf).locals.dbHelpers;
  const { realm } = r.locals;
  const { registrar, writeAlerts, AlertType } = (req.srf as SidecarSrf).locals;
  try {
    const account = await lookupAccountBySipRealm(realm as string);
    if (account && !account.is_active) {
      dbg('checkAccountLimits: account is deactivated, reject registration');
      return res.send(403, {
        headers: {
          'X-Reason': 'Account has been deactivated'
        }
      });
    }
    if (account) {
      r.locals = {
        ...r.locals,
        account_sid: account.account_sid,
        webhook_secret: account.webhook_secret,
        ...(account.registration_hook && {
          registration_hook_url: account.registration_hook.url,
          registration_hook_method: account.registration_hook.method,
          registration_hook_username: account.registration_hook.username,
          registration_hook_password: account.registration_hook.password
        })
      };
      dbg(account, `checkAccountLimits: retrieved account for realm: ${realm}`);
    } else if (JAMBONES_HOSTING) {
      dbg(`checkAccountLimits: unknown sip realm ${realm}`);
      logger.info(`checkAccountLimits: rejecting register for unknown sip realm: ${realm}`);
      return res.send(403);
    }

    if (r.registration.type === 'unregister' || !JAMBONES_HOSTING) return next();

    const { account_sid } = account as { account_sid: string };
    const capacities = await lookupAccountCapacitiesBySid(account_sid);
    const limit_calls = capacities.find((c) => c.category == 'voice_call_session');
    let limit_registrations = limit_calls!.quantity * account!.device_to_call_ratio!;
    const extra = capacities.find((c) => c.category == 'device');
    if (extra && extra.quantity) limit_registrations += extra.quantity;
    dbg(`call capacity: ${limit_calls!.quantity}, device capacity: ${limit_registrations}`);

    if (limit_registrations === 0) {
      logger.info({ account_sid }, 'checkAccountLimits: device calling not allowed for this account');
      writeAlerts({
        alert_type: AlertType.ACCOUNT_DEVICE_LIMIT,
        account_sid,
        count: 0
      }).catch((err) => logger.info({ err }, 'checkAccountLimits: error writing alert'));

      return (res as { send(code: number, body?: string): void }).send(503, 'Max Devices Registered');
    }

    const deviceCount = await registrar.getCountOfUsers(realm);
    if (Number(deviceCount) > limit_registrations + 1) {
      logger.info({ account_sid }, 'checkAccountLimits: registration rejected due to limits');
      writeAlerts({
        alert_type: AlertType.ACCOUNT_DEVICE_LIMIT,
        account_sid,
        count: limit_registrations
      }).catch((err) => logger.info({ err }, 'checkAccountLimits: error writing alert'));
      return (res as { send(code: number, body?: string): void }).send(503, 'Max Devices Registered');
    }
    dbg(`checkAccountLimits - passed: devices registered ${deviceCount}, limit is ${limit_registrations}`);
    next();
  } catch (err) {
    logger.error({ err, realm }, 'checkAccountLimits: error checking account limits');
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('connect ECONNREFUSED')) {
      return next();
    }
    res.send(500);
  }
};
