import dns = require('dns');
import debugFactory = require('debug');
import CIDRMatcher = require('cidr-matcher');
import sdpTransform = require('sdp-transform');
import type { Logger } from 'pino';
import type { JambonzSrfRequest, SrfInstance } from '../types/jambonz-sip';
import type { Express } from 'express';

/** Deep-cloned rtpengine "side" options from bundled JSON */
export interface RtpEngineMediaOpts extends Record<string, unknown> {
  flags: string[];
  ICE?: string;
  DTLS?: string;
  codec?: {
    accept?: string[];
    offer?: string[];
    strip?: string;
    mask?: string;
    transcode?: string;
  };
}

const rtpCharacteristics: Record<string, unknown> = require('../data/rtp-transcoding.json');
const srtpCharacteristics: { default: RtpEngineMediaOpts; teams: RtpEngineMediaOpts } = require('../data/srtp-transcoding.json');

const debug = debugFactory('jambonz:sbc-outbound');

export interface RtpEngineOptsBundle {
  common: Record<string, string | string[] | undefined>;
  uas: {
    tag: string | null;
    mediaOpts: RtpEngineMediaOpts;
  };
  uac: {
    tag: string | null;
    mediaOpts: RtpEngineMediaOpts;
  };
}


export function makeRtpEngineOpts(
  req: JambonzSrfRequest,
  srcIsUsingSrtp: boolean,
  dstIsUsingSrtp: boolean,
  padCrypto: boolean,
  teams: boolean,
  remove_ice = false,
  dtls_off = false
): RtpEngineOptsBundle {
  const from = req.getParsedHeader('from');
  const rtpCopy = JSON.parse(JSON.stringify(rtpCharacteristics)) as RtpEngineMediaOpts;
  const srtpCopy = JSON.parse(JSON.stringify(srtpCharacteristics)) as { default: RtpEngineMediaOpts; teams: RtpEngineMediaOpts };

  if (padCrypto) {
    srtpCopy.default.flags.push('SDES-pad');
    srtpCopy.teams.flags.push('SDES-pad');
  }

  const srtpOpts = teams ? srtpCopy.teams : srtpCopy.default;

  if (remove_ice) {
    srtpOpts.ICE = 'remove';
  }
  if (dtls_off) {
    srtpOpts.DTLS = 'off';
  }

  const dstOpts = JSON.parse(
    JSON.stringify(dstIsUsingSrtp ? srtpOpts : rtpCopy)
  ) as RtpEngineMediaOpts;
  const srcOpts = JSON.parse(
    JSON.stringify(srcIsUsingSrtp ? srtpOpts : rtpCopy)
  ) as RtpEngineMediaOpts;

  /** Allow feature server to send DTMF to the call excepts call from/to teams */
  if (!teams) {
    if (!dstOpts.flags.includes('inject DTMF')) {
      dstOpts.flags.push('inject DTMF');
    }
    if (!srcOpts.flags.includes('inject DTMF')) {
      srcOpts.flags.push('inject DTMF');
    }
  }

  /** By default, and for backwards compatibility, use media handover
   * set env var to true to use strict source instead (needed for rtpbleed vulnerability)
   */
  const enableStrictSource = Boolean(process.env.RTPENGINE_ENABLE_STRICT_SOURCE);
  dstOpts.flags.push(enableStrictSource ? 'strict source' : 'media handover');
  srcOpts.flags.push(enableStrictSource ? 'strict source' : 'media handover');

  const common: Record<string, string | string[] | undefined> = {
    'call-id': req.get('Call-ID'),
    replace: ['origin', 'session-connection'],
    'record call': process.env.JAMBONES_RECORD_ALL_CALLS ? 'yes' : 'no'
  };

  const codec: RtpEngineMediaOpts['codec'] = {
    accept: ['PCMU', 'PCMA', 'telephone-event'],
    ...(process.env.JAMBONES_CODEC_OFFER_WITH_ORDER && {
      offer: process.env.JAMBONES_CODEC_OFFER_WITH_ORDER.split(','),
      strip: 'all'
    })
  };

  return {
    common,
    uas: {
      tag: from.params?.tag != null ? String(from.params.tag) : null,
      mediaOpts: srcOpts
    },
    uac: {
      tag: null,
      mediaOpts: {
        ...dstOpts,
        codec
      }
    }
  };
}

export const selectHostPort = (
  hostport: string,
  protocol: string
): [string, string, string] | undefined => {
  debug(`selectHostPort: ${hostport}, ${protocol}`);
  const sel = hostport
    .split(',')
    .map((hp) => {
      const arr = /(.*)\/(.*):(.*)/.exec(hp);
      if (!arr) {
        return null;
      }
      return [arr[1], arr[2], arr[3]] as [string, string, string];
    })
    .filter((hp): hp is [string, string, string] => {
      if (!hp) return false;
      return hp[0] === protocol && hp[1] !== '127.0.0.1';
    });
  return sel[0];
};

const pingMs = (logger: Logger, srf: SrfInstance, gateway: string, fqdns: string[]) => {
  const uri = `sip:${gateway}`;
  const proxy = `sip:${gateway}:5061;transport=tls`;
  fqdns.forEach((fqdn) => {
    const contact = `<sip:${fqdn}:5061;transport=tls>`;
    (srf as unknown as {
      request(u: string, opts: Record<string, unknown>): Promise<unknown>;
    }).request(uri, {
      method: 'OPTIONS',
      proxy,
      headers: {
        Contact: contact,
        From: contact
      }
    }).catch((err: unknown) =>
      logger.error(err, `Error pinging MS Teams at ${gateway}`)
    );
  });
};

export const pingMsTeamsGateways = (logger: Logger, srf: SrfInstance) => {
  const { lookupAllTeamsFQDNs } = srf.locals.dbHelpers as { lookupAllTeamsFQDNs: () => Promise<string[]> };
  lookupAllTeamsFQDNs()
    .then((fqdns) => {
      if (fqdns.length > 0) {
        ['sip.pstnhub.microsoft.com', 'sip2.pstnhub.microsoft.com', 'sip3.pstnhub.microsoft.com'].forEach((gw) => {
          setInterval(pingMs.bind(null, logger, srf, gw, fqdns), 60000);
        });
      }
    })
    .catch((err: unknown) => {
      logger.error(err, 'Error looking up all ms teams fqdns');
    });
};

export const makeAccountCallCountKey = (sid: string) => `outcalls:account:${sid}`;
export const makeSPCallCountKey = (sid: string) => `outcalls:sp:${sid}`;
export const makeAppCallCountKey = (sid: string) => `outcalls:app:${sid}`;

export const equalsIgnoreOrder = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false;
  const uniqueValues = new Set([...a, ...b]);
  for (const v of uniqueValues) {
    const aCount = a.filter((e) => e === v).length;
    const bCount = b.filter((e) => e === v).length;
    if (aCount !== bCount) return false;
  }
  return true;
};

export const systemHealth = async(
  redisClient: { ping(): Promise<unknown> },
  ping: () => Promise<unknown>,
  getCount: () => number
) => {
  await Promise.all([redisClient.ping(), ping()]);
  return getCount();
};

export const createHealthCheckApp = (port: number, logger: Logger): Promise<Express> => {
  const express = require('express') as typeof import('express');
  const app = express();

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  return new Promise((resolve) => {
    app.listen(port, () => {
      logger.info(`Health check server started at http://localhost:${port}`);
      resolve(app);
    });
  });
};

export type NudgeWhy = 'init' | 'failure' | 'complete';

export interface NudgeSids {
  service_provider_sid: string;
  account_sid: string;
  application_sid?: string;
  callId: string;
}

export interface CallCountWriters {
  writeCallCount: (opts: Record<string, unknown>) => Promise<unknown>;
  writeCallCountSP: (opts: Record<string, unknown>) => Promise<unknown>;
  writeCallCountApp: (opts: Record<string, unknown>) => Promise<unknown>;
}

const shouldNudge = (why: NudgeWhy, req: JambonzSrfRequest): boolean => {
  const { nudge, logger } = req.locals;
  let modifyCount = false;
  const originalNudge = nudge;

  switch (why) {
    case 'init':
      if (nudge === 0) {
        req.locals.nudge = 1;
        modifyCount = true;
      } else if (nudge === -1) {
        req.locals.nudge = 0;
      } else {
        logger.info(`shouldNudge: unexpected nudge value ${nudge} for ${why}`);
      }
      break;
    case 'failure':
      if (nudge === 1) {
        req.locals.nudge = 0;
        modifyCount = true;
      } else if (nudge === 0) {
        req.locals.nudge = -1;
      } else {
        logger.info(`shouldNudge: unexpected nudge value ${nudge} for ${why}`);
      }
      break;
    case 'complete':
      if (nudge === 1) {
        req.locals.nudge = 0;
        modifyCount = true;
      } else {
        logger.info(`shouldNudge: unexpected nudge value ${nudge} for ${why}`);
      }
      break;
    default:
      logger.info(`shouldNudge: unexpected why value ${String(why)}`);
      break;
  }

  logger.info(`shouldNudge: '${why}': updating count: ${modifyCount}, nudge: ${originalNudge} -> ${req.locals.nudge}`);
  return modifyCount;
};

export const nudgeCallCounts = async(
  req: JambonzSrfRequest,
  why: NudgeWhy,
  sids: NudgeSids,
  nudgeOperator: (key: string) => Promise<number | null>,
  writers: CallCountWriters
): Promise<{ callsSP: number | null; calls: number | null; callsApp: number | null }> => {
  const { logger } = req.locals;
  const { service_provider_sid, account_sid, application_sid, callId } = sids;
  const { writeCallCount, writeCallCountSP, writeCallCountApp } = writers;
  const nudges: Array<() => Promise<number | null>> = [];
  const writes: Array<Promise<unknown>> = [];

  if (!shouldNudge(why, req)) {
    return { callsSP: null, calls: null, callsApp: null };
  }

  if (process.env.JAMBONES_DEBUG_CALL_COUNTS) {

    const { srf } = require('..') as { srf: SrfInstance };
    const { addKey, deleteKey } = srf.locals.realtimeDbHelpers as {
      addKey: (k: string, v: string, ttl: number) => Promise<unknown>;
      deleteKey: (k: string) => Promise<unknown>;
    };

    if (why === 'init') {
      await addKey(`debug:outcalls:${account_sid}:${callId}`, new Date().toISOString(), 259200);
    } else {
      await deleteKey(`debug:outcalls:${account_sid}:${callId}`);
    }
  }

  if (process.env.JAMBONES_TRACK_SP_CALLS) {
    const key = makeSPCallCountKey(service_provider_sid);
    nudges.push(() => nudgeOperator(key));
  } else {
    nudges.push(() => Promise.resolve(null));
  }

  if (process.env.JAMBONES_TRACK_ACCOUNT_CALLS || process.env.JAMBONES_HOSTING) {
    const key = makeAccountCallCountKey(account_sid);
    nudges.push(() => nudgeOperator(key));
  } else {
    nudges.push(() => Promise.resolve(null));
  }

  if (process.env.JAMBONES_TRACK_APP_CALLS && application_sid) {
    const key = makeAppCallCountKey(application_sid);
    nudges.push(() => nudgeOperator(key));
  } else {
    nudges.push(() => Promise.resolve(null));
  }

  try {
    const [callsSP, calls, callsApp] = await Promise.all(nudges.map((fn) => fn()));
    logger.debug(
      { calls, callsSP, callsApp, service_provider_sid, account_sid, application_sid },
      'call counts after adjustment'
    );
    if (process.env.JAMBONES_TRACK_SP_CALLS) {
      writes.push(writeCallCountSP({ service_provider_sid, calls_in_progress: callsSP }));
    }

    if (process.env.JAMBONES_TRACK_ACCOUNT_CALLS || process.env.JAMBONES_HOSTING) {
      writes.push(writeCallCount({ service_provider_sid, account_sid, calls_in_progress: calls }));
    }

    if (process.env.JAMBONES_TRACK_APP_CALLS && application_sid) {
      writes.push(
        writeCallCountApp({
          service_provider_sid,
          account_sid,
          application_sid,
          calls_in_progress: callsApp
        })
      );
    }

    void Promise.all(writes).catch((err: unknown) => logger.error({ err }, 'Error writing call counts'));

    return { callsSP, calls, callsApp };
  } catch (err: unknown) {
    logger.error(err, 'error incrementing call counts');
  }

  return { callsSP: null, calls: null, callsApp: null };
};

export const isPrivateVoipNetwork = async(uri: string): Promise<boolean> => {

  const { srf, logger } = require('..') as { srf: SrfInstance; logger: Logger };
  const { privateNetworkCidr } = srf.locals as { privateNetworkCidr: string | null };

  if (privateNetworkCidr) {
    try {
      const matcher = new CIDRMatcher(privateNetworkCidr.split(','));
      const arr = /sips?:.*@(.*?)(:\d+)?(;.*)?$/.exec(uri);
      if (arr) {
        const input = arr[1];
        let addresses: string[];
        if (input.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) {
          addresses = [input];
        } else {
          addresses = await dns.promises.resolve4(input);
        }
        for (const ip of addresses) {
          if (matcher.contains(ip)) {
            return true;
          }
        }
      }
    } catch (err: unknown) {
      logger.info(
        { err, privateNetworkCidr },
        'Error checking private network CIDR, probably misconfigured must be a comma separated list of CIDRs'
      );
    }
  }
  return false;
};

function makeBlacklistGatewayKey(key: string) {
  return `blacklist-sip-gateway:${key}`;
}

export async function isBlackListedSipGateway(
  client: { exists(key: string): Promise<number> },
  logger: Logger,
  sip_gateway_sid: string
): Promise<boolean | undefined> {
  try {
    return (await client.exists(makeBlacklistGatewayKey(sip_gateway_sid))) === 1;
  } catch (err: unknown) {
    logger.error({ err }, `isBlackListedSipGateway: error while checking blacklist for ${sip_gateway_sid}`);
  }
}

export const makeFullMediaReleaseKey = (callId: string) => `b_sdp:${callId}`;
export const makePartnerFullMediaReleaseKey = (callId: string) => `a_sdp:${callId}`;

export function isValidDomainOrIP(input: string) {
  const domainRegex = /^(?!:\/\/)([a-zA-Z0-9.-]+)(:\d+)?$/;

  const ipRegex =
    /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(:\d+)?$/;

  if (domainRegex.test(input) || ipRegex.test(input)) {
    return true;
  }

  return false;
}

export const removeVideoSdp = (sdp: string) => {
  const parsedSdp = sdpTransform.parse(sdp) as {
    media: Array<{ type: string }>;
  };
  parsedSdp.media = parsedSdp.media.filter((media) => media.type !== 'video');
  return sdpTransform.write(parsedSdp as Parameters<typeof sdpTransform.write>[0]);
};
