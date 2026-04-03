import assert from 'node:assert';
import CIDRMatcher = require('cidr-matcher');
import DrachtioSrf = require('drachtio-srf');
import pino = require('pino');
import type { Logger } from 'pino';
import StatsCollector = require('@jambonz/stats-collector');
import dbHelpersFactory = require('@jambonz/db-helpers');
import timeSeriesFactory = require('@jambonz/time-series');
import realtimeFactory = require('@jambonz/realtimedb-helpers');
import Registrar = require('@jambonz/mw-registrar');
import regParser = require('drachtio-mw-registration-parser');
import responseTime = require('drachtio-mw-response-time');
import digestChallenge = require('@jambonz/digest-utils');
import debug = require('debug');
import { initLocals, rejectIpv4, checkCache, checkAccountLimits } from './lib/middleware';
import registerFactory from './lib/register';
import optionsFactory from './lib/options';
import sipTrunkRegister from './lib/sip-trunk-register';
import sipTrunkOptionsPing from './lib/sip-trunk-options-ping';
import { initialize as initRuntimeConfig } from './lib/cli/runtime-config';
import {
  JAMBONES_MYSQL_HOST,
  JAMBONES_MYSQL_USER,
  JAMBONES_MYSQL_PASSWORD,
  JAMBONES_MYSQL_DATABASE,
  JAMBONES_MYSQL_WRITE_HOST,
  JAMBONES_MYSQL_WRITE_USER,
  JAMBONES_MYSQL_WRITE_PASSWORD,
  JAMBONES_MYSQL_WRITE_DATABASE,
  JAMBONES_MYSQL_WRITE_PORT,
  JAMBONES_REDIS_SENTINEL_MASTER_NAME,
  JAMBONES_REDIS_SENTINELS,
  JAMBONES_REDIS_HOST,
  DRACHTIO_HOST,
  DRACHTIO_PORT,
  DRACHTIO_SECRET,
  JAMBONES_TIME_SERIES_HOST,
  JAMBONES_LOGLEVEL,
  JAMBONES_MYSQL_PORT,
  JAMBONES_MYSQL_CONNECTION_LIMIT,
  NODE_ENV,
  SBC_PUBLIC_ADDRESS_KEEP_ALIVE_IN_MILISECOND
} from './lib/config';
import type { SidecarSrf, SidecarSrfLocals } from './types/jambonz-locals';

assert.ok(
  JAMBONES_MYSQL_HOST &&
    JAMBONES_MYSQL_USER &&
    JAMBONES_MYSQL_PASSWORD &&
    JAMBONES_MYSQL_DATABASE,
  'missing JAMBONES_MYSQL_XXX env vars'
);
if (JAMBONES_REDIS_SENTINELS) {
  assert.ok(
    JAMBONES_REDIS_SENTINEL_MASTER_NAME,
    'missing JAMBONES_REDIS_SENTINEL_MASTER_NAME env var, JAMBONES_REDIS_SENTINEL_PASSWORD env var is optional'
  );
} else {
  assert.ok(JAMBONES_REDIS_HOST, 'missing JAMBONES_REDIS_HOST env var');
}
assert.ok(DRACHTIO_HOST, 'missing DRACHTIO_HOST env var');
assert.ok(DRACHTIO_PORT, 'missing DRACHTIO_PORT env var');
assert.ok(DRACHTIO_SECRET, 'missing DRACHTIO_SECRET env var');
assert.ok(JAMBONES_TIME_SERIES_HOST, 'missing JAMBONES_TIME_SERIES_HOST env var');

const dbg = debug('jambonz:sbc-registrar');
const logger: Logger = pino({ level: JAMBONES_LOGLEVEL || 'info' });
const srf = new DrachtioSrf() as SidecarSrf;
const stats = new StatsCollector(logger);

const {
  lookupAuthHook,
  lookupAllVoipCarriers,
  lookupSipGatewaysByCarrier,
  lookupAccountBySipRealm,
  lookupAccountCapacitiesBySid,
  addSbcAddress,
  cleanSbcAddresses,
  updateVoipCarriersRegisterStatus,
  lookupClientByAccountAndUsername,
  lookupSipGatewaysByFilters,
  updateSipGatewayBySid,
  lookupCarrierBySid,
  lookupSystemInformation,
  updateCarrierBySid,
  lookupAccountBySid
} = dbHelpersFactory(
  {
    host: JAMBONES_MYSQL_HOST as string,
    user: JAMBONES_MYSQL_USER as string,
    port: parseInt(JAMBONES_MYSQL_PORT || '3306', 10),
    password: JAMBONES_MYSQL_PASSWORD as string,
    database: JAMBONES_MYSQL_DATABASE as string,
    connectionLimit: parseInt(JAMBONES_MYSQL_CONNECTION_LIMIT || '10', 10)
  },
  logger,
  JAMBONES_MYSQL_WRITE_HOST &&
    JAMBONES_MYSQL_WRITE_USER &&
    JAMBONES_MYSQL_WRITE_PASSWORD &&
    JAMBONES_MYSQL_WRITE_DATABASE
    ? {
      host: JAMBONES_MYSQL_WRITE_HOST,
      user: JAMBONES_MYSQL_WRITE_USER,
      port: parseInt(JAMBONES_MYSQL_WRITE_PORT || '3306', 10),
      password: JAMBONES_MYSQL_WRITE_PASSWORD,
      database: JAMBONES_MYSQL_WRITE_DATABASE,
      connectionLimit: parseInt(JAMBONES_MYSQL_CONNECTION_LIMIT || '10', 10)
    }
    : null
);

const { writeAlerts, AlertType } = timeSeriesFactory(logger, {
  host: JAMBONES_TIME_SERIES_HOST as string,
  commitSize: 50,
  commitInterval: NODE_ENV === 'test' ? 7 : 20
});

const {
  client,
  addKey,
  addKeyNx,
  retrieveKey,
  addToSet,
  removeFromSet,
  isMemberOfSet,
  retrieveSet,
  createEphemeralGateway,
  deleteEphemeralGateway
} = realtimeFactory({}, logger);

const interval = parseInt(SBC_PUBLIC_ADDRESS_KEEP_ALIVE_IN_MILISECOND || '900000', 10);

const locals: SidecarSrfLocals = {
  logger,
  stats,
  addToSet,
  removeFromSet,
  isMemberOfSet,
  retrieveSet,
  registrar: new Registrar(logger, client),
  dbHelpers: {
    lookupAccountBySid,
    lookupAuthHook,
    lookupAllVoipCarriers,
    lookupSipGatewaysByCarrier,
    lookupAccountBySipRealm,
    lookupAccountCapacitiesBySid,
    updateVoipCarriersRegisterStatus,
    lookupClientByAccountAndUsername,
    lookupSipGatewaysByFilters,
    updateSipGatewayBySid,
    lookupCarrierBySid,
    lookupSystemInformation,
    updateCarrierBySid
  },
  realtimeDbHelpers: {
    client,
    addKey,
    addKeyNx,
    retrieveKey,
    retrieveSet,
    createEphemeralGateway,
    deleteEphemeralGateway
  },
  writeAlerts,
  AlertType,
  sbcPublicIpAddress: {}
};

srf.locals = {
  ...srf.locals,
  ...locals
};

const cidrsEnv = process.env.JAMBONES_NETWORK_CIDR || '192.168.0.0/24,172.16.0.0/16,10.0.0.0/8';
const cidrs = cidrsEnv.split(',').map((s) => s.trim());
const matcher = new CIDRMatcher(cidrs);

srf.connect({
  host: DRACHTIO_HOST as string,
  port: parseInt(DRACHTIO_PORT as string, 10),
  secret: DRACHTIO_SECRET as string
});

srf.on('connect', (err: Error | undefined, hp: string, version: string, localHostports: string | undefined) => {
  if (err) return logger.error({ err }, 'Error connecting to drachtio server');
  logger.info(`connected to drachtio listening on ${hp}, local hostports: ${localHostports}`);

  if (localHostports) {
    const lhps = localHostports.split(',');
    for (const lhp of lhps) {
      const arr = /^(.*)\/(.*):(\d+)$/.exec(lhp);
      if (arr && arr[1] === 'tcp' && matcher.contains(arr[2])) {
        const hostport = `${arr[2]}:${arr[3]}`;
        srf.locals.privateSipAddress = hostport;
      }
    }
  }

  srf.locals.sbcPublicIpAddress = {};
  let defaultIp: string | undefined;
  const map = new Map<string, { ipv4: string; port?: string; tls_port?: string; wss_port?: string }>();
  const hostports = (hp as string).split(',');
  for (const hpp of hostports) {
    const arr = /^(.*)\/(.*):(\d+)$/.exec(hpp);
    if (arr) {
      const ipv4 = arr[2];
      const port = arr[3];
      const addr = map.get(ipv4) || { ipv4 };
      switch (arr[1]) {
        case 'udp':
          srf.locals.sbcPublicIpAddress = {
            ...srf.locals.sbcPublicIpAddress,
            udp: `${ipv4}:${port}`
          };
          map.set(ipv4, { ...addr, port });
          defaultIp = ipv4;
          break;
        case 'tls':
          map.set(ipv4, { ...addr, tls_port: port });
          srf.locals.sbcPublicIpAddress = {
            ...srf.locals.sbcPublicIpAddress,
            tls: `${ipv4}:${port}`
          };
          break;
        case 'wss':
          srf.locals.sbcPublicIpAddress = {
            ...srf.locals.sbcPublicIpAddress,
            wss: `${ipv4}:${port}`
          };
          map.set(ipv4, { ...addr, wss_port: port });
          break;
      }
    }
  }

  if (!srf.locals.sbcPublicIpAddress.tls && defaultIp) {
    srf.locals.sbcPublicIpAddress.tls = `${defaultIp}:5061`;
  }

  logger.info({ sbcPublicIpAddress: srf.locals.sbcPublicIpAddress }, 'sbc public ip addresses');

  const isPrivateSubnet = (ip: string) => {
    const [firstOctet, secondOctet] = ip.split('.').map(Number);
    return (
      firstOctet === 10 ||
      (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) ||
      (firstOctet === 192 && secondOctet === 168)
    );
  };

  logger.info({ ips: [...map.entries()] }, 'drachtio sip contacts');
  const mapOfPublicAddresses =
    map.size === 0 ? map : new Map(Array.from(map.entries()).filter(([key]) => !isPrivateSubnet(key)));

  logger.info({ ips: [...mapOfPublicAddresses.entries()] }, 'drachtio sip public contacts');

  mapOfPublicAddresses.forEach((addr) => {
    void addSbcAddress(addr.ipv4, addr.port, addr.tls_port, addr.wss_port);
    setTimeout(() => {
      void addSbcAddress(addr.ipv4, addr.port, addr.tls_port, addr.wss_port);
    }, interval);
  });

  void cleanSbcAddresses();
  setTimeout(() => void cleanSbcAddresses(), interval);

  void sipTrunkRegister(logger, srf);
  void sipTrunkOptionsPing(logger, srf);
});

if (NODE_ENV === 'test') {
  srf.on('error', (err) => {
    logger.info(err, 'Error connecting to drachtio');
  });
}

const rttMetric = (
  req: unknown,
  res: { cached?: boolean; statusCode?: number },
  time: number
) => {
  if (res.cached) {
    stats.histogram('sbc.registration.cached.response_time', time.toFixed(0), [`status:${res.statusCode}`]);
  } else {
    stats.histogram('sbc.registration.total.response_time', time.toFixed(0), [`status:${res.statusCode}`]);
  }
};

srf.use('register', [
  initLocals,
  responseTime(rttMetric),
  rejectIpv4,
  regParser,
  checkCache,
  checkAccountLimits,
  digestChallenge
]);

srf.use('options', [initLocals]);

srf.register(registerFactory({ logger }));
srf.options(optionsFactory({ srf, logger }));

initRuntimeConfig(srf.locals as SidecarSrfLocals, logger);

setInterval(async() => {
  const count = await srf.locals.registrar.getCountOfUsers();
  dbg(`count of registered users: ${count}`);
  stats.gauge('sbc.users.count', parseInt(String(count), 10));
}, 30000);

export { srf, logger };
