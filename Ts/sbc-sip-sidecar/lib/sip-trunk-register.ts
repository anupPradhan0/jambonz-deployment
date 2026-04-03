import debug = require('debug');
import {
  JAMBONES_CLUSTER_ID,
  JAMBONES_REGBOT_BATCH_SLEEP_MS,
  JAMBONES_REGBOT_BATCH_SIZE
} from './config';
import short = require('short-uuid');
import Regbot from './regbot';
import { sleepFor } from './utils';
import type { Logger } from 'pino';
import type { SidecarSrf } from '../types/jambonz-locals';
import type { SipGatewayRowSidecar, VoipCarrierForRegbot } from '../types/jambonz-locals';

const dbg = debug('jambonz:sbc-registrar');

const MAX_INITIAL_DELAY = 15;
const REGBOT_STATUS_CHECK_INTERVAL = 60;
const regbotKey = `${JAMBONES_CLUSTER_ID || 'default'}:regbot-token`;
const waitFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let initialized = false;

const regbots: Regbot[] = [];
const carriers: VoipCarrierForRegbot[] = [];
const gateways: SipGatewayRowSidecar[] = [];

const BATCH_SLEEP_MS = parseInt(JAMBONES_REGBOT_BATCH_SLEEP_MS, 10);
const BATCH_SIZE = parseInt(JAMBONES_REGBOT_BATCH_SIZE, 10);

const getCountSuccessfulRegbots = () => regbots.filter((rb) => rb.status === 'registered').length;

function pickRelevantCarrierProperties(c: VoipCarrierForRegbot): VoipCarrierForRegbot {
  return {
    voip_carrier_sid: c.voip_carrier_sid,
    requires_register: c.requires_register,
    is_active: c.is_active,
    register_username: c.register_username,
    register_password: c.register_password,
    register_sip_realm: c.register_sip_realm,
    register_from_user: c.register_from_user,
    register_from_domain: c.register_from_domain,
    register_public_ip_in_contact: c.register_public_ip_in_contact,
    outbound_sip_proxy: c.outbound_sip_proxy,
    account_sid: c.account_sid,
    trunk_type: c.trunk_type || 'static_ip'
  };
}

async function getLocalSIPDomain(logger: Logger, srf: SidecarSrf) {
  const { lookupSystemInformation } = srf.locals.dbHelpers;
  try {
    const systemInfo = await lookupSystemInformation();
    if (systemInfo) {
      logger.info(`lookup of sip domain from system_information: ${systemInfo.sip_domain_name}`);
      srf.locals.localSIPDomain = systemInfo.sip_domain_name;
    } else {
      logger.info('no system_information found, we will use the realm or public ip as the domain');
    }
  } catch (err) {
    logger.info({ err }, 'Error looking up system information');
  }
}

function getUniqueGateways(gwList: SipGatewayRowSidecar[], logger: Logger) {
  const uniqueGatewayKeys = new Set<string>();
  const duplicateCounts = new Map<string, number>();
  const uniqueGateways: SipGatewayRowSidecar[] = [];

  for (const gw of gwList) {
    const key = `${gw.ipv4}:${gw.sip_realm}:${gw.carrier?.register_username}:${gw.carrier?.register_password}`;
    if (!gw.carrier?.register_password) {
      logger.info({ gw }, `Gateway ${key} does not have a password, ignoring`);
      continue;
    }

    if (uniqueGatewayKeys.has(key)) {
      duplicateCounts.set(key, (duplicateCounts.get(key) || 1) + 1);
    } else {
      uniqueGatewayKeys.add(key);
      uniqueGateways.push(gw);
    }
  }

  for (const [key, count] of duplicateCounts) {
    logger.info({ key, count }, `Found ${count} duplicate gateways for ${key}, ignoring duplicates`);
  }

  return uniqueGateways;
}

export default async function sipTrunkRegister(logger: Logger, srf: SidecarSrf) {
  if (initialized) return;
  initialized = true;
  const { addKeyNx } = srf.locals.realtimeDbHelpers;
  const myToken = short.generate();
  const regbotCtl = { myToken, active: false };
  srf.locals.regbot = regbotCtl;

  srf.locals.regbotStatus = () => {
    return {
      total: regbots.length,
      registered: getCountSuccessfulRegbots(),
      active: regbotCtl.active
    };
  };

  await getLocalSIPDomain(logger, srf);
  setInterval(() => void getLocalSIPDomain(logger, srf), 300000);

  const ms = Math.floor(Math.random() * MAX_INITIAL_DELAY) * 1000;
  logger.info(`waiting ${ms}ms before attempting to claim regbot responsibility with token ${myToken}`);
  await waitFor(ms);

  const result = await addKeyNx(regbotKey, myToken, REGBOT_STATUS_CHECK_INTERVAL + 10);
  if (result === 'OK') {
    regbotCtl.active = true;
    logger.info(`successfully claimed regbot responsibility with token ${myToken}`);
  } else {
    logger.info(`failed to claim regbot responsibility with my token ${myToken}`);
  }

  setInterval(() => void checkStatus(logger, srf), REGBOT_STATUS_CHECK_INTERVAL * 1000);

  if (regbotCtl.active) {
    updateCarrierRegbots(logger, srf).catch((err) => {
      logger.error({ err }, 'updateCarrierRegbots failure');
    });
  }

  return regbotCtl.active;
}

const checkStatus = async(logger: Logger, srf: SidecarSrf) => {
  const { addKeyNx, addKey, retrieveKey } = srf.locals.realtimeDbHelpers;
  const regbotCtl = srf.locals.regbot;
  if (!regbotCtl) return;
  const { myToken, active } = regbotCtl;

  logger.info({ active, myToken }, 'checking in on regbot status');
  try {
    const token = await retrieveKey(regbotKey);
    let grabForTheWheel = false;

    if (active) {
      if (token === myToken) {
        logger.info('I am active, and shall continue in my role as regbot');
        addKey(regbotKey, myToken, REGBOT_STATUS_CHECK_INTERVAL + 10)
          .then(() => updateCarrierRegbots(logger, srf))
          .catch((err) => {
            logger.error({ err }, 'updateCarrierRegbots failure');
          });
      } else if (token && token !== myToken) {
        logger.info('Someone else grabbed the role!  I need to stand down');
        regbots.forEach((rb) => rb.stop(srf));
        regbots.length = 0;
      } else {
        grabForTheWheel = true;
        regbots.forEach((rb) => rb.stop(srf));
        regbots.length = 0;
      }
    } else if (token) {
      logger.info('I am inactive and someone else is performing the role');
    } else {
      grabForTheWheel = true;
    }

    if (grabForTheWheel) {
      logger.info('regbot status is vacated, try to grab it!');
      const res = await addKeyNx(regbotKey, myToken, REGBOT_STATUS_CHECK_INTERVAL + 10);
      if (res === 'OK') {
        regbotCtl.active = true;
        logger.info(`successfully claimed regbot responsibility with token ${myToken}`);
        updateCarrierRegbots(logger, srf).catch((err) => {
          logger.error({ err }, 'updateCarrierRegbots failure');
        });
      } else {
        regbotCtl.active = false;
        logger.info('failed to claim regbot responsibility');
      }
    }
  } catch (err) {
    logger.error({ err }, 'checkStatus: ERROR');
  }
};

const updateCarrierRegbots = async(logger: Logger, srf: SidecarSrf) => {
  const { lookupAllVoipCarriers, lookupSipGatewaysByCarrier, lookupAccountBySid } = srf.locals.dbHelpers;
  try {
    let hasChanged = false;
    const gws: SipGatewayRowSidecar[] = [];
    const cs = (await lookupAllVoipCarriers())
      .filter((c) => c.requires_register && c.is_active)
      .map((c) => pickRelevantCarrierProperties(c));
    if (JSON.stringify(cs) !== JSON.stringify(carriers)) hasChanged = true;
    for (const c of cs) {
      try {
        const arr = (await lookupSipGatewaysByCarrier(c.voip_carrier_sid))
          .filter((gw) => gw.outbound && gw.is_active)
          .map((gw) => {
            gw.carrier = pickRelevantCarrierProperties(c);
            return gw;
          });
        gws.push(...arr);
      } catch (err) {
        logger.error({ err }, 'updateCarrierRegbots Error retrieving gateways');
      }
    }
    if (JSON.stringify(gws) !== JSON.stringify(gateways)) hasChanged = true;
    if (hasChanged) {
      dbg('updateCarrierRegbots: got new or changed carriers');
      logger.info({ count: gws.length }, 'updateCarrierRegbots: got new or changed carriers');

      carriers.length = 0;
      for (let i = 0; i < cs.length; i += 1000) {
        carriers.push(...cs.slice(i, i + 1000));
      }

      gateways.length = 0;
      for (let i = 0; i < gws.length; i += 1000) {
        gateways.push(...gws.slice(i, i + 1000));
      }

      regbots.forEach((rb) => rb.stop(srf));
      regbots.length = 0;

      let batch_count = 0;
      for (const gw of getUniqueGateways(gateways, logger)) {
        let accountSipRealm: string | undefined;
        if (!gw.carrier?.register_public_ip_in_contact && gw.carrier?.account_sid) {
          const account = await lookupAccountBySid(gw.carrier.account_sid);
          if (account?.sip_realm) {
            accountSipRealm = account.sip_realm;
          }
        }
        try {
          if (!gw.carrier) continue;
          const rb = new Regbot(logger, {
            voip_carrier_sid: gw.carrier.voip_carrier_sid,
            account_sip_realm: accountSipRealm,
            ipv4: gw.ipv4,
            port: gw.port,
            protocol: gw.protocol,
            use_sips_scheme: gw.use_sips_scheme,
            username: gw.carrier.register_username as string,
            password: gw.carrier.register_password as string,
            sip_realm: gw.carrier.register_sip_realm as string,
            from_user: gw.carrier.register_from_user,
            from_domain: gw.carrier.register_from_domain,
            use_public_ip_in_contact: gw.carrier.register_public_ip_in_contact ?? undefined,
            outbound_sip_proxy: gw.carrier.outbound_sip_proxy,
            trunk_type: gw.carrier.trunk_type,
            sip_gateway_sid: gw.sip_gateway_sid
          });
          regbots.push(rb);
          void rb.start(srf);
          batch_count++;
          if (batch_count >= BATCH_SIZE) {
            batch_count = 0;
            await sleepFor(BATCH_SLEEP_MS);
          }
        } catch (err) {
          const { updateVoipCarriersRegisterStatus } = srf.locals.dbHelpers;
          const message = err instanceof Error ? err.message : String(err);
          updateVoipCarriersRegisterStatus(gw.carrier!.voip_carrier_sid, JSON.stringify({
            status: 'fail',
            reason: message
          }));
          logger.error({ err }, `Error starting regbot, ignore register for gateway ${gw.sip_gateway_sid}`);
        }
      }
      dbg(`updateCarrierRegbots: we have started ${regbots.length} regbots`);
    }
  } catch (err) {
    logger.error({ err }, 'updateCarrierRegbots Error');
  }
};
