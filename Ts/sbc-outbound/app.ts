import assert from 'node:assert';
import * as dns from 'node:dns';
import { EventEmitter } from 'node:events';
import CIDRMatcher = require('cidr-matcher');
import DrachtioSrf = require('drachtio-srf');
import healthCheck = require('@jambonz/http-health-check');
import pino = require('pino');
import type { Logger } from 'pino';
import CallSession = require('./lib/call-session');
import middlewareFactory from './lib/middleware';
import {
  equalsIgnoreOrder,
  pingMsTeamsGateways,
  createHealthCheckApp,
  systemHealth
} from './lib/utils';
import type { JambonzSrfRequest, JambonzSrfResponse, SrfInstance } from './types/jambonz-sip';

assert.ok(
  process.env.JAMBONES_MYSQL_HOST &&
    process.env.JAMBONES_MYSQL_USER &&
    process.env.JAMBONES_MYSQL_PASSWORD &&
    process.env.JAMBONES_MYSQL_DATABASE,
  'missing JAMBONES_MYSQL_XXX env vars'
);
if (process.env.JAMBONES_REDIS_SENTINELS) {
  assert.ok(
    process.env.JAMBONES_REDIS_SENTINEL_MASTER_NAME,
    'missing JAMBONES_REDIS_SENTINEL_MASTER_NAME env var, JAMBONES_REDIS_SENTINEL_PASSWORD env var is optional'
  );
} else {
  assert.ok(process.env.JAMBONES_REDIS_HOST, 'missing JAMBONES_REDIS_HOST env var');
}
assert.ok(process.env.DRACHTIO_PORT || process.env.DRACHTIO_HOST, 'missing DRACHTIO_PORT env var');
assert.ok(process.env.DRACHTIO_SECRET, 'missing DRACHTIO_SECRET env var');
assert.ok(process.env.JAMBONES_NETWORK_CIDR || process.env.K8S, 'missing JAMBONES_NETWORK_CIDR env var');
assert.ok(process.env.JAMBONES_TIME_SERIES_HOST, 'missing JAMBONES_TIME_SERIES_HOST env var');

const srf: SrfInstance = new DrachtioSrf('sbc-outbound') as SrfInstance;
const opts = Object.assign(
  {
    timestamp: () => {
      return `, "time": "${new Date().toISOString()}"`;
    }
  },
  { level: process.env.JAMBONES_LOGLEVEL || 'info' }
);
const logger: Logger = pino(opts);
const {
  writeCallCount,
  writeCallCountSP,
  writeCallCountApp,
  writeCdrs,
  queryCdrs,
  writeAlerts,
  AlertType
} = require('@jambonz/time-series')(logger, {
  host: process.env.JAMBONES_TIME_SERIES_HOST,
  commitSize: 50,
  commitInterval: 'test' === process.env.NODE_ENV ? 7 : 20
}) as {
  writeCallCount: (o: Record<string, unknown>) => Promise<unknown>;
  writeCallCountSP: (o: Record<string, unknown>) => Promise<unknown>;
  writeCallCountApp: (o: Record<string, unknown>) => Promise<unknown>;
  writeCdrs: (o: Record<string, unknown>) => Promise<unknown>;
  queryCdrs: (o: { account_sid: string }) => Promise<{ total: number }>;
  writeAlerts: (o: Record<string, unknown>) => Promise<unknown>;
  AlertType: Record<string, string>;
};
const StatsCollector = require('@jambonz/stats-collector') as new (l: Logger) => {
  increment: (name: string, tags?: string[]) => void;
  gauge: (name: string, value: number, tags?: string[]) => void;
};
const stats = new StatsCollector(logger);
const setNameRtp = `${process.env.JAMBONES_CLUSTER_ID || 'default'}:active-rtp`;
const rtpServers: string[] = [];
const {
  ping,
  lookupOutboundCarrierForAccount,
  lookupAllTeamsFQDNs,
  lookupAccountBySipRealm,
  lookupAccountBySid,
  lookupAccountCapacitiesBySid,
  lookupSipGatewaysByCarrier,
  lookupCarrierBySid,
  queryCallLimits,
  lookupCarrierByAccountLcr,
  lookupSystemInformation
} = require('@jambonz/db-helpers')(
  {
    host: process.env.JAMBONES_MYSQL_HOST,
    port: process.env.JAMBONES_MYSQL_PORT || 3306,
    user: process.env.JAMBONES_MYSQL_USER,
    password: process.env.JAMBONES_MYSQL_PASSWORD,
    database: process.env.JAMBONES_MYSQL_DATABASE,
    connectionLimit: process.env.JAMBONES_MYSQL_CONNECTION_LIMIT || 10
  },
  logger
);
const {
  client: redisClient,
  createHash,
  retrieveHash,
  incrKey,
  decrKey,
  retrieveSet,
  isMemberOfSet,
  addKey,
  deleteKey,
  retrieveKey
} = require('@jambonz/realtimedb-helpers')({}, logger);

const activeCallIds = new Map<string, InstanceType<typeof CallSession>>();
const idleEmitter = new EventEmitter();

srf.locals = {
  ...srf.locals,
  stats,
  writeCallCount,
  writeCallCountSP,
  writeCallCountApp,
  writeCdrs,
  writeAlerts,
  AlertType,
  queryCdrs,
  activeCallIds,
  idleEmitter,
  privateNetworkCidr: process.env.PRIVATE_VOIP_NETWORK_CIDR || null,
  dbHelpers: {
    ping,
    lookupOutboundCarrierForAccount,
    lookupAllTeamsFQDNs,
    lookupAccountBySipRealm,
    lookupAccountBySid,
    lookupAccountCapacitiesBySid,
    lookupSipGatewaysByCarrier,
    lookupCarrierBySid,
    queryCallLimits,
    lookupCarrierByAccountLcr,
    lookupSystemInformation
  },
  realtimeDbHelpers: {
    client: redisClient,
    addKey,
    deleteKey,
    retrieveKey,
    createHash,
    retrieveHash,
    incrKey,
    decrKey,
    isMemberOfSet
  }
};
const { initLocals, checkLimits, route } = middlewareFactory(srf, logger, redisClient);
const ngProtocol = process.env.JAMBONES_NG_PROTOCOL || 'udp';
const ngPort = process.env.RTPENGINE_PORT || ('udp' === ngProtocol ? 22222 : 8080);
const { getRtpEngine, setRtpEngines } = require('@jambonz/rtpengine-utils')([], logger, {
  dtmfListenPort: process.env.DTMF_LISTEN_PORT || 22225,
  protocol: ngProtocol
}) as {
  getRtpEngine: () => unknown;
  setRtpEngines: (endpoints: string[]) => void;
};
srf.locals.getRtpEngine = getRtpEngine;

if (process.env.DRACHTIO_HOST && !process.env.K8S) {
  const cidrs = process.env.JAMBONES_NETWORK_CIDR!.split(',').map((s) => s.trim());
  logger.info({ cidrs }, 'internal network CIDRs');
  const matcher = new CIDRMatcher(cidrs);

  srf.connect({
    host: process.env.DRACHTIO_HOST,
    port: process.env.DRACHTIO_PORT != null ? Number(process.env.DRACHTIO_PORT) : undefined,
    secret: process.env.DRACHTIO_SECRET
  });
  srf.on('connect', (err: Error, hp: string) => {
    logger.info(`connected to drachtio listening on ${hp}`);

    const hostports = hp.split(',');
    for (const hps of hostports) {
      const arr = /^(.*)\/(.*):(\d+)$/.exec(hps);
      if (arr && 'udp' === arr[1] && !matcher.contains(arr[2])) {
        logger.info(`sbc public address: ${arr[2]}`);
        srf.locals.sipAddress = arr[2];
      } else if (arr && 'tcp' === arr[1] && matcher.contains(arr[2])) {
        const hostport = `${arr[2]}:${arr[3]}`;
        logger.info(`sbc private address: ${hostport}`);
        srf.locals.privateSipAddress = hostport;
      }
    }
  });
} else {
  logger.info(`listening in outbound mode on port ${process.env.DRACHTIO_PORT}`);
  srf.listen({
    port: Number(process.env.DRACHTIO_PORT),
    secret: process.env.DRACHTIO_SECRET
  });
}
if (process.env.NODE_ENV === 'test') {
  srf.on('error', (err: Error) => {
    logger.info(err, 'Error connecting to drachtio');
  });
}

(srf.use as (msg: string, chain: unknown) => void)('invite', [initLocals, checkLimits, route]);
srf.invite((req, res) => {
  const session = new CallSession(logger, req as JambonzSrfRequest, res as JambonzSrfResponse);
  session.connect();
});

if (process.env.K8S || process.env.HTTP_PORT) {
  const PORT = process.env.HTTP_PORT || 3000;

  const getCount = () => srf.locals.activeCallIds.size;

  void createHealthCheckApp(Number(PORT), logger)
    .then((app) => {
      healthCheck({
        app,
        logger,
        path: '/',
        fn: getCount
      });
      healthCheck({
        app,
        logger,
        path: '/system-health',
        fn: systemHealth.bind(null, redisClient, ping, getCount)
      });
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'Error creating health check server');
    });
}
if ('test' !== process.env.NODE_ENV) {
  setInterval(() => {
    void (async() => {
      stats.gauge(
        'sbc.sip.calls.count',
        activeCallIds.size,
        ['direction:outbound', `instance_id:${process.env.INSTANCE_ID || 0}`]
      );

      const r = await lookupSystemInformation();
      if (r) {
        if (r.private_network_cidr !== srf.locals.privateNetworkCidr) {
          logger.info(
            `updating private network cidr from ${String(srf.locals.privateNetworkCidr)} to ${r.private_network_cidr}`
          );
          srf.locals.privateNetworkCidr = r.private_network_cidr;
        }
        if (r.log_level) {
          logger.level = r.log_level;
        }
      }
    })();
  }, 20000);
}

const lookupRtpServiceEndpoints = (serviceName: string) => {
  dns.lookup(serviceName, { family: 4, all: true }, (err, addresses) => {
    if (err) {
      logger.error({ err }, `Error looking up ${serviceName}`);
      return;
    }
    const list = addresses as dns.LookupAddress[];
    logger.debug({ addresses: list, rtpServers }, `dns lookup for ${serviceName} returned`);
    const addrs = list.map((a) => a.address);
    if (!equalsIgnoreOrder(addrs, rtpServers)) {
      rtpServers.length = 0;
      Array.prototype.push.apply(rtpServers, addrs);
      logger.info({ rtpServers }, 'rtpserver endpoints have been updated');
      setRtpEngines(rtpServers.map((a) => `${a}:${ngPort}`));
    }
  });
};

if (process.env.K8S_RTPENGINE_SERVICE_NAME) {
  const arr = /^(.*):(\d+)$/.exec(process.env.K8S_RTPENGINE_SERVICE_NAME);
  const svc = arr![1];
  logger.info(`rtpengine(s) will be found at dns name: ${svc}`);
  lookupRtpServiceEndpoints(svc);
  setInterval(lookupRtpServiceEndpoints.bind(null, svc), Number(process.env.RTPENGINE_DNS_POLL_INTERVAL) || 10000);
} else if (process.env.JAMBONES_RTPENGINES) {
  setRtpEngines([process.env.JAMBONES_RTPENGINES]);
} else {
  const getActiveRtpServers = async() => {
    try {
      const set = await retrieveSet(setNameRtp);
      const newArray = Array.from(set) as string[];
      logger.debug({ newArray, rtpServers }, 'getActiveRtpServers');
      if (!equalsIgnoreOrder(newArray, rtpServers)) {
        logger.info({ newArray }, 'resetting active rtpengines');
        setRtpEngines(newArray.map((a) => `${a}:${ngPort}`));
        rtpServers.length = 0;
        Array.prototype.push.apply(rtpServers, newArray);
      }
    } catch (err: unknown) {
      logger.error({ err }, 'Error setting new rtpengines');
    }
  };
  setInterval(() => {
    void getActiveRtpServers();
  }, 30000);
  void getActiveRtpServers();
}

pingMsTeamsGateways(logger, srf);

function handle(signal: NodeJS.Signals | string): void {
  logger.info(`got signal ${signal}`);
  if (process.env.K8S) {
    if (0 === activeCallIds.size) {
      logger.info('exiting immediately since we have no calls in progress');
      process.exit(0);
    } else {
      idleEmitter.once('idle', () => process.exit(0));
    }
  }
}

process.on('SIGUSR2', handle);
process.on('SIGTERM', handle);

export = { srf, logger };
