import CIDRMatcher = require('cidr-matcher');
import express = require('express');
import type { Express } from 'express';
import type { Logger } from 'pino';
import type { JambonzSrfRequest, SrfInstance } from '../types/jambonz-sip';

const rtpCharacteristics = require('../data/rtp-transcoding.json');

const srtpCharacteristics = require('../data/srtp-transcoding.json');

let idx = 0;

export const isWSS = (req: JambonzSrfRequest) => {
  return req.getParsedHeader('Via')[0].protocol.toLowerCase().startsWith('ws');
};

export const getAppserver = (srf: SrfInstance & { locals: { featureServers: string[] } }) => {
  const len = srf.locals.featureServers.length;
  return srf.locals.featureServers[idx++ % len];
};

export function makeRtpEngineOpts(
  req: JambonzSrfRequest,
  srcIsUsingSrtp: boolean,
  dstIsUsingSrtp: boolean,
  teams = false
) {
  const rtpCopy = JSON.parse(JSON.stringify(rtpCharacteristics)) as {
    flags: string[];
    [key: string]: unknown;
  };
  const srtpCopy = JSON.parse(JSON.stringify(srtpCharacteristics)) as Record<
  string,
  { flags: string[]; [key: string]: unknown }
  >;
  const from = req.getParsedHeader('from');
  const srtpOpts = teams ? srtpCopy['teams'] : srtpCopy['default'];
  if (((req.locals.gateway as { pad_crypto?: number } | undefined)?.pad_crypto || 0) > 0) {
    srtpOpts.flags.push('pad crypto');
  }
  const dstOpts = dstIsUsingSrtp ? srtpOpts : rtpCopy;
  const srcOpts = srcIsUsingSrtp ? srtpOpts : rtpCopy;

  /* Allow Feature server to inject DTMF to both leg except call from Teams */
  if (!teams) {
    dstOpts.flags.push('inject DTMF');
    srcOpts.flags.push('inject DTMF');
  }

  /** By default, and for backwards compatibility, use media handover
   * set env var to true to use strict source instead (needed for rtpbleed vulnerability)
   */
  const enableStrictSource = !!process.env.RTPENGINE_ENABLE_STRICT_SOURCE;
  dstOpts.flags.push(enableStrictSource ? 'strict source' : 'media handover');
  srcOpts.flags.push(enableStrictSource ? 'strict source' : 'media handover');
  const acceptCodecs = process.env.JAMBONES_ACCEPT_AND_TRANSCODE ?
    process.env.JAMBONES_ACCEPT_AND_TRANSCODE :
    process.env.JAMBONES_ACCEPT_G729 ? 'g729' : '';
  const common = {
    'call-id': req.get('Call-ID'),
    'replace': ['origin', 'session-connection'],
    'record call': process.env.JAMBONES_RECORD_ALL_CALLS ? 'yes' : 'no',
    ...(acceptCodecs && { codec: { mask: acceptCodecs, transcode: 'pcmu,pcma' } })
  };
  return {
    common,
    uas: {
      tag: from.params?.tag,
      mediaOpts: srcOpts
    },
    uac: {
      tag: null,
      mediaOpts: dstOpts
    }
  };
}

export const SdpWantsSDES = (sdp: string) => {
  return /m=audio.*\s+RTP\/SAVP/.test(sdp);
};
export const SdpWantsSrtp = (sdp: string) => {
  return /m=audio.*SAVP/.test(sdp);
};

export const makeAccountCallCountKey = (sid: string) => `incalls:account:${sid}`;
export const makeSPCallCountKey = (sid: string) => `incalls:sp:${sid}:`;
export const makeAppCallCountKey = (sid: string) => `incalls:app${sid}:`;

export const normalizeDID = (tel: string) => {
  const regex = /^\+(\d+)$/;
  const arr = regex.exec(tel);
  return arr ? arr[1] : tel;
};

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
  redisClient: RealtimeClient,
  ping: () => Promise<unknown>,
  getCount: () => number | Promise<number>
) => {
  await Promise.all([redisClient.ping(), ping()]);
  return getCount();
};

const doListen = (logger: Logger, app: Express, port: number, resolve: (v: Express) => void) => {
  return app.listen(port, () => {
    logger.info(`Health check server listening on http://localhost:${port}`);
    resolve(app);
  });
};
const handleErrors = (
  logger: Logger,
  app: Express,
  resolve: (v: Express) => void,
  reject: (e: unknown) => void,
  e: NodeJS.ErrnoException & { port?: number }
) => {
  if (e.code === 'EADDRINUSE' &&
    process.env.HTTP_PORT_MAX &&
    e.port !== undefined &&
    e.port < Number(process.env.HTTP_PORT_MAX)) {

    logger.info(`Health check server failed to bind port on ${e.port}, will try next port`);
    const server = doListen(logger, app, ++e.port, resolve);
    server.on('error', handleErrors.bind(null, logger, app, resolve, reject));
    return;
  }
  reject(e);
};

export const createHealthCheckApp = (port: number, logger: Logger): Promise<Express> => {
  const app = express();

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  return new Promise((resolve, reject) => {
    const server = doListen(logger, app, port, resolve);
    server.on('error', handleErrors.bind(null, logger, app, resolve, reject));
  });
};

export type NudgeWhy = 'init' | 'failure' | 'complete';

const shouldNudge = (why: NudgeWhy, req: JambonzSrfRequest) => {
  const {nudge, logger} = req.locals;
  let modifyCount = false;
  const originalNudge = nudge;
  if (!logger) return false;

  switch (why) {
    case 'init':
      if (nudge === 0) {
        req.locals.nudge = 1;
        modifyCount = true;
      }
      else if (nudge === -1) {
        req.locals.nudge = 0;
      }
      else {
        logger.info(`shouldNudge: unexpected nudge value ${nudge} for ${why}`);
      }
      break;
    case 'failure':
      if (nudge === 1) {
        req.locals.nudge = 0;
        modifyCount = true;
      }
      else if (nudge === 0) {
        req.locals.nudge = -1;
      }
      else {
        logger.info(`shouldNudge: unexpected nudge value ${nudge} for ${why}`);
      }
      break;
    case 'complete':
      if (nudge === 1) {
        req.locals.nudge = 0;
        modifyCount = true;
      }
      else {
        logger.info(`shouldNudge: unexpected nudge value ${nudge} for ${why}`);
      }
      break;
    default:
      logger.info(`shouldNudge: unexpected why value ${why}`);
      break;
  }

  logger.info(`shouldNudge: '${why}': updating count: ${modifyCount}, nudge: ${originalNudge} -> ${req.locals.nudge}`);
  return modifyCount;
};

type NudgeSids = {
  service_provider_sid: string;
  account_sid: string;
  application_sid?: string | null;
  callId: string;
};

type NudgeWriters = {
  writeCallCount: (o: Record<string, unknown>) => Promise<unknown>;
  writeCallCountSP: (o: Record<string, unknown>) => Promise<unknown>;
  writeCallCountApp: (o: Record<string, unknown>) => Promise<unknown>;
};

export const nudgeCallCounts = async(
  req: JambonzSrfRequest,
  why: NudgeWhy,
  sids: NudgeSids,
  nudgeOperator: (key: string) => Promise<number | null>,
  writers: NudgeWriters
) => {
  const logger = req.locals.logger;
  const {service_provider_sid, account_sid, application_sid, callId} = sids;
  const {writeCallCount, writeCallCountSP, writeCallCountApp} = writers;
  const nudges: Array<() => Promise<number | null>> = [];
  const writes: Array<Promise<unknown>> = [];

  if (!logger || !shouldNudge(why, req)) {
    return {callsSP: null, calls: null, callsApp: null};
  }

  if (process.env.JAMBONES_DEBUG_CALL_COUNTS) {
    const {srf} = require('..') as { srf: SrfInstance };
    const {addKey, deleteKey} = srf.locals.realtimeDbHelpers as {
      addKey: (k: string, v: string, ttl: number) => Promise<unknown>;
      deleteKey: (k: string) => Promise<unknown>;
    };

    if (why === 'init') {
      await addKey(`debug:incalls:${account_sid}:${callId}`, new Date().toISOString(), 259200);
    }
    else {
      await deleteKey(`debug:incalls:${account_sid}:${callId}`);
    }
  }

  if (process.env.JAMBONES_TRACK_SP_CALLS) {
    const key = makeSPCallCountKey(service_provider_sid);
    nudges.push(() => nudgeOperator(key));
  }
  else {
    nudges.push(() => Promise.resolve(null));
  }

  if (process.env.JAMBONES_TRACK_ACCOUNT_CALLS || process.env.JAMBONES_HOSTING) {
    const key = makeAccountCallCountKey(account_sid);
    nudges.push(() => nudgeOperator(key));
  }
  else {
    nudges.push(() => Promise.resolve(null));
  }

  if (process.env.JAMBONES_TRACK_APP_CALLS && application_sid) {
    const key = makeAppCallCountKey(application_sid);
    nudges.push(() => nudgeOperator(key));
  }
  else {
    nudges.push(() => Promise.resolve(null));
  }

  try {
    const [callsSP, calls, callsApp] = await Promise.all(nudges.map((fn) => fn()));
    logger.debug({
      calls, callsSP, callsApp,
      service_provider_sid, account_sid, application_sid}, 'call counts after adjustment');
    if (process.env.JAMBONES_TRACK_SP_CALLS) {
      writes.push(writeCallCountSP({service_provider_sid, calls_in_progress: callsSP}));
    }

    if (process.env.JAMBONES_TRACK_ACCOUNT_CALLS || process.env.JAMBONES_HOSTING) {
      writes.push(writeCallCount({service_provider_sid, account_sid, calls_in_progress: calls}));
    }

    if (process.env.JAMBONES_TRACK_APP_CALLS && application_sid) {
      writes.push(writeCallCountApp({service_provider_sid, account_sid, application_sid, calls_in_progress: callsApp}));
    }

    Promise.all(writes).catch((err: unknown) => logger.error({err}, 'Error writing call counts'));

    return {callsSP, calls, callsApp};
  } catch (err) {
    logger.error(err, 'error incrementing call counts');
  }

  return {callsSP: null, calls: null, callsApp: null};
};

export const roundTripTime = (startAt: [number, number]) => {
  const diff = process.hrtime(startAt);
  const time = diff[0] * 1e3 + diff[1] * 1e-6;
  return time.toFixed(0);
};

export const parseConnectionIp = (sdp: string) => {
  const regex = /c=IN IP4 ([0-9.]+)/;
  const arr = regex.exec(sdp);
  return arr ? arr[1] : null;
};

export const isMSTeamsCIDR = (ip: string) => {
  const cidrs = [
    '52.112.0.0/14',
    '52.120.0.0/14'
  ];
  const matcher = new CIDRMatcher(cidrs);
  return matcher.contains(ip);
};

export const isPrivateVoipNetwork = (ip: string) => {
  const {srf, logger} = require('..') as { srf: SrfInstance; logger: Logger };
  const {privateNetworkCidr} = srf.locals as { privateNetworkCidr: string | null };
  if (privateNetworkCidr) {
    try {
      const matcher = new CIDRMatcher(privateNetworkCidr.split(','));
      return matcher.contains(ip);
    } catch (err) {
      logger.info({err, privateNetworkCidr},
        'Error checking private network CIDR, probably misconfigured must be a comma separated list of CIDRs');
    }
  }
  return false;
};

export const parseHostPorts = (
  logger: Logger,
  hostports: string | string[],
  srf: SrfInstance & { locals: { sipAddress: string } }
) => {
  if (typeof hostports === 'string') hostports = hostports.split(',');
  const obj: Record<string, string> = {};
  for (const hp of hostports) {
    const m = hp.match(/^(.*)\/(.*):(\d+)$/);
    if (!m) continue;
    const [, protocol, ipv4, port] = m;
    if (protocol && ipv4 && port) {
      obj[protocol] = `${ipv4}:${port}`;
    }
  }
  if (!obj.tls) {
    obj.tls = `${srf.locals.sipAddress}:5061`;
  }

  if (!obj.tcp) {
    obj.tcp = `${srf.locals.sipAddress}:5060`;
  }

  logger.info({ obj }, 'sip endpoints');
  return obj;
};

export const makeFullMediaReleaseKey = (callId: string) => {
  return `a_sdp:${callId}`;
};
export const makePartnerFullMediaReleaseKey = (callId: string) => {
  return `b_sdp:${callId}`;
};
