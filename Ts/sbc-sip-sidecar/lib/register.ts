import { isUacBehindNat, getSipProtocol, NAT_EXPIRES } from './utils';
import DrachtioSrf = require('drachtio-srf');
import type { Logger } from 'pino';
import type { SidecarSrf } from '../types/jambonz-locals';

const { parseUri } = DrachtioSrf;

type RegistrableSipRequest = DrachtioSrf.SrfRequest & {
  registration: { type: string; expires: string; aor: string };
};

export default function handler({ logger }: { logger: Logger }) {
  return async(req: DrachtioSrf.SrfRequest, res: DrachtioSrf.SrfResponse) => {
    logger.debug(`received ${req.method} from ${req.protocol}/${req.source_address}:${req.source_port}`);

    const registration = (req as RegistrableSipRequest).registration;
    if (registration.type === 'register' && registration.expires !== '0') await register(logger, req, res);
    else await unregister(logger, req, res);

    (req.srf as SidecarSrf).endSession(req);
  };
}

async function register(
  logger: Logger,
  req: DrachtioSrf.SrfRequest,
  res: DrachtioSrf.SrfResponse & { finalResponseSent?: boolean }
) {
  try {
    const registrar = (req.srf as SidecarSrf).locals.registrar;
    const registration = (req as RegistrableSipRequest).registration;
    const authorization = (
      req as DrachtioSrf.SrfRequest & {
        authorization: {
          grant: {
            expires?: number;
            call_hook?: unknown;
            call_status_hook?: unknown;
            allow_direct_app_calling?: boolean;
            allow_direct_queue_calling?: boolean;
            allow_direct_user_calling?: boolean;
          };
        };
      }
    ).authorization;
    const uri = parseUri(registration.aor);
    const aor = `${uri!.user}@${uri!.host}`;
    let expires = authorization.grant.expires || parseInt(registration.expires, 10);
    const grantedExpires = expires;
    let contactHdr = req.get('Contact');

    if (isUacBehindNat(req) && expires > NAT_EXPIRES) {
      expires = NAT_EXPIRES;
    }
    contactHdr = contactHdr.replace(/expires=\d+/, `expires=${expires}`);
    const proto = getSipProtocol(req) || 'udp';
    const opts = {
      contact: req.getParsedHeader('Contact')[0].uri,
      sbcAddress: (req as DrachtioSrf.SrfRequest & { server: { hostport: string } }).server.hostport,
      privateSbcAddress: (req.srf as SidecarSrf).locals.privateSipAddress,
      protocol: proto,
      proxy: `sip:${req.source_address}:${req.source_port}`,
      callHook: authorization.grant.call_hook,
      callStatusHook: authorization.grant.call_status_hook,
      allow_direct_app_calling: authorization.grant.allow_direct_app_calling || false,
      allow_direct_queue_calling: authorization.grant.allow_direct_queue_calling || false,
      allow_direct_user_calling: authorization.grant.allow_direct_user_calling || false
    };
    logger.debug(`adding aor to redis ${aor} with expires ${grantedExpires}`);
    await registrar.add(aor, opts, grantedExpires);

    res.send(200, {
      headers: {
        Contact: contactHdr,
        Expires: expires
      }
    });
  } catch (err) {
    logger.error({ err }, 'Error trying to process REGISTER');
    if (!res.finalResponseSent) res.send(500);
  }
}

async function unregister(logger: Logger, req: DrachtioSrf.SrfRequest, res: DrachtioSrf.SrfResponse) {
  const registrar = (req.srf as SidecarSrf).locals.registrar;
  const registration = (req as RegistrableSipRequest).registration;
  const uri = parseUri(registration.aor);
  const aor = `${uri!.user}@${uri!.host}`;
  const result = await registrar.remove(aor);

  logger.debug({ result }, `successfully unregistered ${registration.aor}`);

  res.send(200, {
    headers: {
      Contact: req.get('Contact'),
      Expires: 0
    }
  });
}
