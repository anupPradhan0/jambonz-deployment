import assert from 'node:assert';
import * as dns from 'node:dns';
import CIDRMatcher = require('cidr-matcher');
import DrachtioSrf = require('drachtio-srf');
import healthCheck = require('@jambonz/http-health-check');
import pino = require('pino');
import type { Logger } from 'pino';
import CallSession = require('./lib/call-session');
import middlewareFactory from './lib/middleware';
import dbUtilsFactory from './lib/db-utils';
import fsTrackingFactory from './lib/fs-tracking';
import autoscaleManagerFactory from './lib/autoscale-manager';
import { equalsIgnoreOrder, createHealthCheckApp, systemHealth, parseHostPorts } from './lib/utils';
import lifecycleConstants from './lib/constants.json';
import type { JambonzSrfRequest, JambonzSrfResponse, SrfInstance } from './types/jambonz-sip';

const {LifeCycleEvents} = lifecycleConstants;

assert.ok(process.env.JAMBONES_MYSQL_HOST &&
  process.env.JAMBONES_MYSQL_USER &&
  process.env.JAMBONES_MYSQL_PASSWORD &&
  process.env.JAMBONES_MYSQL_DATABASE, 'missing JAMBONES_MYSQL_XXX env vars');
if (process.env.JAMBONES_REDIS_SENTINELS) {
  assert.ok(process.env.JAMBONES_REDIS_SENTINEL_MASTER_NAME,
    'missing JAMBONES_REDIS_SENTINEL_MASTER_NAME env var, JAMBONES_REDIS_SENTINEL_PASSWORD env var is optional');
} else {
  assert.ok(process.env.JAMBONES_REDIS_HOST, 'missing JAMBONES_REDIS_HOST env var');
}
assert.ok(process.env.DRACHTIO_PORT || process.env.DRACHTIO_HOST, 'missing DRACHTIO_PORT env vars');
assert.ok(process.env.DRACHTIO_SECRET, 'missing DRACHTIO_SECRET env var');
assert.ok(process.env.JAMBONES_TIME_SERIES_HOST, 'missing JAMBONES_TIME_SERIES_HOST env var');
assert.ok(process.env.JAMBONES_NETWORK_CIDR || process.env.K8S, 'missing JAMBONES_NETWORK_CIDR env var');

const srf: SrfInstance = new DrachtioSrf('sbc-inbound') as SrfInstance;
/** Drachtio SRF runtime exposes connect/listen/invite beyond the published method-typed .on() overloads. */

const srfAny = srf as any;
const opts = Object.assign({
  timestamp: () => {return `, "time": "${new Date().toISOString()}"`;}
}, {level: process.env.JAMBONES_LOGLEVEL || 'info'});
const logger: Logger = pino(opts);
const {
  writeCallCount,
  writeCallCountSP,
  writeCallCountApp,
  queryCdrs,
  writeCdrs,
  writeAlerts,
  AlertType
} = require('@jambonz/time-series')(logger, {
  host: process.env.JAMBONES_TIME_SERIES_HOST,
  port: process.env.JAMBONES_TIME_SERIES_PORT || 8086,
  commitSize: 50,
  commitInterval: 'test' === process.env.NODE_ENV ? 7 : 20
}) as {
  writeCallCount: (o: Record<string, unknown>) => Promise<unknown>;
  writeCallCountSP: (o: Record<string, unknown>) => Promise<unknown>;
  writeCallCountApp: (o: Record<string, unknown>) => Promise<unknown>;
  queryCdrs: (o: { account_sid: string }) => Promise<{ total: number }>;
  writeCdrs: (o: Record<string, unknown>) => Promise<unknown>;
  writeAlerts: (o: Record<string, unknown>) => Promise<unknown>;
  AlertType: Record<string, string>;
};
const StatsCollector = require('@jambonz/stats-collector') as new (l: Logger) => {
  increment: (name: string, tags?: string[]) => void;
  gauge: (name: string, value: number, tags?: string[]) => void;
  histogram: (name: string, value: string | number, tags?: string[]) => void;
};
const stats = new StatsCollector(logger);
const setNameRtp = `${(process.env.JAMBONES_CLUSTER_ID || 'default')}:active-rtp`;
const rtpServers: string[] = [];
const setName = `${(process.env.JAMBONES_CLUSTER_ID || 'default')}:active-sip`;

const {
  pool,
  ping,
  lookupAuthHook,
  lookupSipGatewayBySignalingAddress,
  addSbcAddress,
  lookupAccountByPhoneNumber,
  lookupAppByTeamsTenant,
  lookupAccountBySipRealm,
  lookupAccountBySid,
  lookupAccountCapacitiesBySid,
  queryCallLimits,
  lookupClientByAccountAndUsername,
  lookupSystemInformation
} = require('@jambonz/db-helpers')({
  host: process.env.JAMBONES_MYSQL_HOST,
  port: process.env.JAMBONES_MYSQL_PORT || 3306,
  user: process.env.JAMBONES_MYSQL_USER,
  password: process.env.JAMBONES_MYSQL_PASSWORD,
  database: process.env.JAMBONES_MYSQL_DATABASE,
  connectionLimit: process.env.JAMBONES_MYSQL_CONNECTION_LIMIT || 10
}, logger, process.env.JAMBONES_MYSQL_WRITE_HOST && process.env.JAMBONES_MYSQL_WRITE_USER &&
  process.env.JAMBONES_MYSQL_WRITE_PASSWORD && process.env.JAMBONES_MYSQL_WRITE_DATABASE ? {
    host: process.env.JAMBONES_MYSQL_WRITE_HOST,
    port: process.env.JAMBONES_MYSQL_WRITE_PORT || 3306,
    user: process.env.JAMBONES_MYSQL_WRITE_USER,
    password: process.env.JAMBONES_MYSQL_WRITE_PASSWORD,
    database: process.env.JAMBONES_MYSQL_WRITE_DATABASE,
    connectionLimit: process.env.JAMBONES_MYSQL_CONNECTION_LIMIT || 10
  } : null);
const {
  client: redisClient,
  addKey,
  deleteKey,
  retrieveKey,
  retrieveHash,
  createSet,
  retrieveSet,
  addToSet,
  removeFromSet,
  incrKey,
  decrKey,
  createEphemeralGateway,
  queryEphemeralGateways
} = require('@jambonz/realtimedb-helpers')({}, logger);

const ngProtocol = process.env.JAMBONES_NG_PROTOCOL || 'udp';
const ngPort = process.env.RTPENGINE_PORT || ('udp' === ngProtocol ? 22222 : 8080);
const {getRtpEngine, setRtpEngines} = require('@jambonz/rtpengine-utils')([], logger, {
  dtmfListenPort: process.env.DTMF_LISTEN_PORT || 22224,
  protocol: ngProtocol
}) as {
  getRtpEngine: () => unknown;
  setRtpEngines: (endpoints: string[]) => void;
};
srf.locals = {...srf.locals,
  stats,
  writeCallCount,
  writeCallCountSP,
  writeCallCountApp,
  queryCdrs,
  writeCdrs,
  writeAlerts,
  AlertType,
  activeCallIds: new Map(),
  getRtpEngine,
  privateNetworkCidr: process.env.PRIVATE_VOIP_NETWORK_CIDR || null,
  dbHelpers: {
    pool,
    ping,
    lookupAuthHook,
    lookupSipGatewayBySignalingAddress,
    lookupAccountByPhoneNumber,
    lookupAppByTeamsTenant,
    lookupAccountBySid,
    lookupAccountBySipRealm,
    lookupAccountCapacitiesBySid,
    queryCallLimits,
    lookupClientByAccountAndUsername,
    lookupSystemInformation
  },
  realtimeDbHelpers: {
    addKey,
    deleteKey,
    retrieveKey,
    retrieveHash,
    createSet,
    incrKey,
    decrKey,
    retrieveSet,
    addToSet,
    removeFromSet,
    createEphemeralGateway,
    queryEphemeralGateways
  }
};
const {
  getSPForAccount,
  wasOriginatedFromCarrier,
  getApplicationForDidAndCarrier,
  getOutboundGatewayForRefer,
  getApplicationBySid,
  lookupAuthCarriersForAccountAndSP
} = dbUtilsFactory(srf, logger);
srf.locals = {
  ...srf.locals,
  getSPForAccount,
  wasOriginatedFromCarrier,
  getApplicationForDidAndCarrier,
  getOutboundGatewayForRefer,
  getFeatureServer: fsTrackingFactory(srf, logger),
  getApplicationBySid,
  lookupAuthCarriersForAccountAndSP
};
const activeCallIds = srf.locals.activeCallIds as Map<string, InstanceType<typeof CallSession>>;

const {
  initLocals,
  handleSipRec,
  identifyAccount,
  checkLimits,
  challengeDeviceCalls,
  identifyAuthTrunk
} = middlewareFactory(srf, logger);

if (process.env.DRACHTIO_HOST && !process.env.K8S) {
  const cidrs = (process.env.JAMBONES_NETWORK_CIDR as string)
    .split(',')
    .map((s) => s.trim());
  const matcher = new CIDRMatcher(cidrs);

  srfAny.connect({
    host: process.env.DRACHTIO_HOST,
    port: Number(process.env.DRACHTIO_PORT),
    secret: process.env.DRACHTIO_SECRET
  });
  srfAny.on('connect', (err: Error | null, hp: string, version: string, localHostports: string) => {
    if (err) return logger.error({err}, 'Error connecting to drachtio server');
    let addedPrivateIp = false;
    logger.info(`connected to drachtio ${version} listening on ${hp}, local hostports: ${localHostports}`);

    const hostports = hp.split(',');

    if (localHostports) {
      const locals = localHostports.split(',');
      for (const hpStr of locals) {
        const arr = /^(.*)\/(.*):(\d+)$/.exec(hpStr);
        if (arr && 'tcp' === arr[1] && matcher.contains(arr[2])) {
          const hostport = `${arr[2]}:${arr[3]}`;
          logger.info(`adding sbc private address to redis: ${hostport}`);
          srf.locals.privateSipAddress = hostport;
          srf.locals.addToRedis = () => addToSet(setName, hostport);
          srf.locals.removeFromRedis = () => removeFromSet(setName, hostport);
          srf.locals.addToRedis();
          addedPrivateIp = true;
        }
      }
    }
    for (const hpStr of hostports) {
      const arr = /^(.*)\/(.*):(\d+)$/.exec(hpStr);
      if (arr && 'udp' === arr[1] && !matcher.contains(arr[2])) {
        logger.info(`adding sbc public address to database: ${arr[2]}`);
        srf.locals.sipAddress = arr[2];
        if (!process.env.SBC_ACCOUNT_SID) addSbcAddress(arr[2]);
      }
      else if (!addedPrivateIp && arr && 'tcp' === arr[1] && matcher.contains(arr[2])) {
        const hostport = `${arr[2]}:${arr[3]}`;
        logger.info(`adding sbc private address to redis: ${hostport}`);
        srf.locals.privateSipAddress = hostport;
        srf.locals.addToRedis = () => addToSet(setName, hostport);
        srf.locals.removeFromRedis = () => removeFromSet(setName, hostport);
        srf.locals.addToRedis();
      }
    }
    srf.locals.sbcPublicIpAddress = parseHostPorts(logger, hostports, srf as SrfInstance & { locals: { sipAddress: string } });
  });
}
else {
  srfAny.on('listening', () => {
    logger.info(`listening in outbound mode on port ${process.env.DRACHTIO_PORT}`);
  });
  srfAny.listen({port: Number(process.env.DRACHTIO_PORT), secret: process.env.DRACHTIO_SECRET});
  srfAny.on('connect', (err: Error | null, hp: string, version: string, localHostports: string) => {
    if (err) return logger.error({err}, 'Error connecting to drachtio server');
    logger.info(`connected to drachtio ${version} listening on ${hp}, local hostports: ${localHostports}`);

    if (process.env.K8S_FEATURE_SERVER_TRANSPORT === 'tcp') {
      const matcher = new CIDRMatcher(['192.168.0.0/24', '172.16.0.0/16', '10.0.0.0/8']);
      const hostports = localHostports ? localHostports.split(',') : hp.split(',');
      for (const hpStr of hostports) {
        const arr = /^(.*)\/(.*):(\d+)$/.exec(hpStr);
        if (arr && matcher.contains(arr[2])) {
          const hostport = `${arr[2]}:${arr[3]}`;
          logger.info(`using sbc private address when sending to feature-server: ${hostport}`);
          srf.locals.privateSipAddress = hostport;
        }
      }
    }
    srf.locals.sbcPublicIpAddress = parseHostPorts(logger, hp, srf as SrfInstance & { locals: { sipAddress: string } });
  });
}
if (process.env.NODE_ENV === 'test') {
  srfAny.on('error', (err: Error) => {
    logger.info(err, 'Error connecting to drachtio');
  });
}

srfAny.use('invite', [
  initLocals,
  handleSipRec,
  identifyAccount,
  checkLimits,
  challengeDeviceCalls,
  identifyAuthTrunk
]);

srfAny.invite((req: JambonzSrfRequest, res: JambonzSrfResponse) => {
  if (req.has('Replaces')) {
    const arr = /^(.*);from/.exec(req.get('Replaces'));
    if (arr) logger.info(`replacing call-id ${arr}`);
    else logger.info(`failed parsing ${req.get('Replaces')}`);
    const session = arr ? activeCallIds.get(arr[1]) : null;
    if (!session) {
      logger.info(`failed to find session in Replaces header: ${req.has('Replaces')}`);
      return res.send(404);
    }
    return session.replaces(req, res);
  }
  const session = new CallSession(logger, req, res);
  session.connect();
});

srfAny.use((req: JambonzSrfRequest, res: JambonzSrfResponse, next: () => void, err: Error) => {
  logger.error(err, 'hit top-level error handler');
  res.send(500);
});

if (process.env.K8S || process.env.HTTP_PORT) {
  const PORT = process.env.HTTP_PORT || 3000;

  const getCount = () => (srf.locals.activeCallIds as Map<string, unknown>).size;

  createHealthCheckApp(Number(PORT), logger)
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
      return;
    })
    .catch((err: unknown) => {
      logger.error({err}, 'Error creating health check server');
    });
}
if ('test' !== process.env.NODE_ENV) {
  setInterval(async() => {
    stats.gauge('sbc.sip.calls.count', activeCallIds.size,
      ['direction:inbound', `instance_id:${process.env.INSTANCE_ID || 0}`]);

    const r = await lookupSystemInformation();
    if (r) {
      if (r.private_network_cidr !== srf.locals.privateNetworkCidr) {
        logger.info(`updating private network cidr from ${srf.locals.privateNetworkCidr} to ${r.private_network_cidr}`);
        srf.locals.privateNetworkCidr = r.private_network_cidr;
      }
      if (r.log_level) {
        logger.level = r.log_level;
      }
    }
  }, 20000);
}

const lookupRtpServiceEndpoints = (
  lookup: typeof dns.lookup,
  serviceName: string
) => {
  lookup(serviceName, {family: 4, all: true}, (err, addresses) => {
    if (err) {
      logger.error({err}, `Error looking up ${serviceName}`);
      return;
    }
    if (!addresses) return;
    logger.debug({addresses, rtpServers}, `dns lookup for ${serviceName} returned`);
    const addrs = addresses.map((a) => a.address);
    if (!equalsIgnoreOrder(addrs, rtpServers)) {
      rtpServers.length = 0;
      Array.prototype.push.apply(rtpServers, addrs);
      logger.info({rtpServers}, 'rtpserver endpoints have been updated');
      setRtpEngines(rtpServers.map((a) => `${a}:${ngPort}`));
    }
  });
};

if (process.env.K8S_RTPENGINE_SERVICE_NAME) {
  const arr = /^(.*):(\d+)$/.exec(process.env.K8S_RTPENGINE_SERVICE_NAME);
  const svc = arr![1];
  logger.info(`rtpengine(s) will be found at dns name: ${svc}`);
  lookupRtpServiceEndpoints(dns.lookup, svc);
  setInterval(lookupRtpServiceEndpoints.bind(null, dns.lookup, svc), Number(process.env.RTPENGINE_DNS_POLL_INTERVAL) || 10000);
}
else if (process.env.JAMBONES_RTPENGINES) {
  setRtpEngines([process.env.JAMBONES_RTPENGINES]);
}
else {
  const getActiveRtpServers = async() => {
    try {
      const set = await retrieveSet(setNameRtp);
      const newArray = Array.from(set) as string[];
      logger.debug({newArray, rtpServers}, 'getActiveRtpServers');
      if (!equalsIgnoreOrder(newArray, rtpServers)) {
        logger.info({newArray}, 'resetting active rtpengines');
        setRtpEngines(newArray.map((a) => `${a}:${ngPort}`));
        rtpServers.length = 0;
        Array.prototype.push.apply(rtpServers, newArray);
      }
    } catch (err) {
      logger.error({err}, 'Error setting new rtpengines');
    }
  };
  setInterval(() => {
    void getActiveRtpServers();
  }, 30000);
  void getActiveRtpServers();

}

const {lifecycleEmitter} = autoscaleManagerFactory(logger);

setInterval(async() => {
  if (lifecycleEmitter.operationalState === LifeCycleEvents.ScaleIn) {
    if (0 === activeCallIds.size) {
      logger.info('scale-in complete now that calls have dried up');
      (lifecycleEmitter as { scaleIn?: () => void }).scaleIn?.();
    }
  }
}, 20000);

process.on('SIGUSR2', handle.bind(null, removeFromSet, setName));
process.on('SIGTERM', handle.bind(null, removeFromSet, setName));

function handle(
  removeFromSetFn: (name: string, member: string) => Promise<unknown>,
  setNameArg: string,
  signal: string
) {
  logger.info(`got signal ${signal}`);
  const priv = srf.locals.privateSipAddress as string | undefined;
  if (priv && setNameArg) {
    logger.info(`removing ${priv} from set ${setNameArg}`);
    void removeFromSetFn(setNameArg, priv);
  }
  if (process.env.K8S) {
    lifecycleEmitter.operationalState = LifeCycleEvents.ScaleIn;
    if (0 === activeCallIds.size) {
      logger.info('exiting immediately since we have no calls in progress');
      process.exit(0);
    }
  }
}

export {srf, logger};
