import * as dns from 'node:dns';
import assert = require('node:assert');
import {
  JAMBONES_REGBOT_DEFAULT_EXPIRES_INTERVAL,
  JAMBONES_REGBOT_MIN_EXPIRES_INTERVAL,
  JAMBONES_REGBOT_CONTACT_USE_IP,
  REGISTER_RESPONSE_REMOVE,
  JAMBONES_REGBOT_USER_AGENT,
  JAMBONES_REGBOT_FAILURE_RETRY_INTERVAL
} from './config';
import { isValidDomainOrIP, isValidIPv4 } from './utils';
import type { Logger } from 'pino';
import type { SidecarSrf } from '../types/jambonz-locals';

const dnsPromises = dns.promises;
const DEFAULT_EXPIRES = parseInt(JAMBONES_REGBOT_DEFAULT_EXPIRES_INTERVAL || '3600', 10);
const MIN_EXPIRES = parseInt(JAMBONES_REGBOT_MIN_EXPIRES_INTERVAL || '30', 10);
const FAILURE_RETRY_INTERVAL = parseInt(JAMBONES_REGBOT_FAILURE_RETRY_INTERVAL || '300', 10);

const { version } = require('../package.json') as { version: string };
const useragent = JAMBONES_REGBOT_USER_AGENT || `Jambonz ${version}`;

export interface RegbotOpts {
  voip_carrier_sid: string;
  ipv4: string;
  port: number;
  username: string;
  password: string;
  protocol: string;
  account_sip_realm?: string;
  outbound_sip_proxy?: string | null;
  trunk_type?: string;
  sip_gateway_sid: string;
  sip_realm?: string;
  use_public_ip_in_contact?: boolean | null;
  use_sips_scheme?: boolean;
  from_user?: string | null;
  from_domain?: string | null;
}

type DrachtioRes = {
  status: number;
  reason: string;
  has(name: string): boolean;
  get(name: string): string;
  getParsedHeader(name: string): Array<{ params?: { expires?: string } }>;
};

export default class Regbot {
  logger: Logger;
  voip_carrier_sid!: string;
  ipv4!: string;
  port!: number;
  username!: string;
  password!: string;
  protocol!: string;
  account_sip_realm?: string;
  outbound_sip_proxy?: string | null;
  trunk_type?: string;
  sip_gateway_sid!: string;
  sip_realm!: string;
  use_public_ip_in_contact!: boolean | string | undefined | null;
  use_sips_scheme!: boolean;
  fromUser!: string;
  from!: string;
  aor!: string;
  status = 'none';
  addresses?: string[];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(logger: Logger, opts: RegbotOpts) {
    this.logger = logger;

    for (const prop of [
      'voip_carrier_sid',
      'ipv4',
      'port',
      'username',
      'password',
      'protocol',
      'account_sip_realm',
      'outbound_sip_proxy',
      'trunk_type',
      'sip_gateway_sid'
    ] as const) {
      (this as unknown as Record<string, unknown>)[prop] = opts[prop];
    }

    this.sip_realm = opts.sip_realm || opts.ipv4;
    this.use_public_ip_in_contact = opts.use_public_ip_in_contact || JAMBONES_REGBOT_CONTACT_USE_IP;
    this.use_sips_scheme = opts.use_sips_scheme || false;

    this.fromUser = opts.from_user || this.username;
    const fromDomain = opts.from_domain || this.sip_realm;
    if (!isValidDomainOrIP(fromDomain)) {
      throw new Error(`Invalid from_domain ${fromDomain}`);
    }
    this.from = `sip:${this.fromUser}@${fromDomain}`;
    this.aor = `${this.fromUser}@${this.sip_realm}`;
    this.status = 'none';
  }

  async start(srf: SidecarSrf) {
    assert(!this.timer);

    this.logger.info(`starting regbot for ${this.fromUser}@${this.sip_realm}`);
    void this.register(srf);
  }

  stop(srf: SidecarSrf) {
    const { deleteEphemeralGateway } = srf.locals.realtimeDbHelpers;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.addresses && this.addresses.length) {
      for (const ip of this.addresses) {
        deleteEphemeralGateway(ip, this.voip_carrier_sid).catch((err: unknown) => {
          this.logger.error({ err, ip }, 'Error deleting ephemeral gateway on regbot stop');
        });
      }
    }
  }

  toJSON() {
    return {
      voip_carrier_sid: this.voip_carrier_sid,
      username: this.username,
      fromUser: this.fromUser,
      sip_realm: this.sip_realm,
      ipv4: this.ipv4,
      port: this.port,
      aor: this.aor,
      status: this.status
    };
  }

  async register(srf: SidecarSrf) {
    const { createEphemeralGateway } = srf.locals.realtimeDbHelpers;
    const { updateVoipCarriersRegisterStatus } = srf.locals.dbHelpers;
    const { writeAlerts, localSIPDomain } = srf.locals;
    try {
      const transport = (
        this.protocol.includes('/') ? this.protocol.substring(0, this.protocol.indexOf('/')) : this.protocol
      ).toLowerCase();

      let scheme = 'sip';
      if (transport === 'tls' && this.use_sips_scheme) scheme = 'sips';

      let publicAddress = srf.locals.sbcPublicIpAddress.udp;
      if (transport !== 'udp') {
        if (srf.locals.sbcPublicIpAddress[transport as 'tls' | 'wss']) {
          publicAddress = srf.locals.sbcPublicIpAddress[transport as 'tls' | 'wss'];
        } else if (transport === 'tls') {
          publicAddress = srf.locals.sbcPublicIpAddress.udp;
        }
      }

      let contactAddress = this.aor;
      if (this.use_public_ip_in_contact) {
        contactAddress = `${this.fromUser}@${publicAddress}`;
      } else if (this.account_sip_realm) {
        contactAddress = `${this.fromUser}@${this.account_sip_realm}`;
      } else if (localSIPDomain) {
        contactAddress = `${this.fromUser}@${localSIPDomain}`;
      }

      this.logger.debug(`sending REGISTER for ${this.aor}`);

      let proxy: string;
      if (this.outbound_sip_proxy) {
        proxy = `sip:${this.outbound_sip_proxy};transport=${transport}`;
        this.logger.debug(`sending via proxy ${proxy}`);
      } else {
        const isIPv4 = isValidIPv4(this.ipv4);
        proxy = `sip:${this.ipv4}${isIPv4 ? `:${this.port}` : ''};transport=${transport}`;
        this.logger.debug(`sending to registrar ${proxy}`);
      }
      const req = await srf.request(`${scheme}:${this.sip_realm}`, {
        method: 'REGISTER',
        proxy,
        headers: {
          'Call-ID': this.sip_gateway_sid,
          From: this.from,
          To: this.from,
          Contact: `<${scheme}:${contactAddress};transport=${transport}>;expires=${DEFAULT_EXPIRES}`,
          Expires: DEFAULT_EXPIRES,
          'User-Agent': useragent
        },
        auth: {
          username: this.username,
          password: this.password
        }
      });
      req.on('response', async(res: DrachtioRes) => {
        let expires: number;
        if (res.status !== 200) {
          this.status = 'fail';
          this.logger.info(`${this.aor}: got ${res.status} registering to ${this.ipv4}:${this.port}`);
          this.timer = setTimeout(() => void this.register(srf), FAILURE_RETRY_INTERVAL * 1000);
          if (REGISTER_RESPONSE_REMOVE.includes(res.status)) {
            const { updateCarrierBySid, lookupCarrierBySid } = srf.locals.dbHelpers;
            await updateCarrierBySid(this.voip_carrier_sid, { requires_register: false });
            this.stop(srf);
            const carrier = await lookupCarrierBySid(this.voip_carrier_sid);
            if (carrier) {
              this.logger.info(
                `Disabling Outbound Registration for carrier ${carrier.name} (sid:${carrier.voip_carrier_sid})`
              );
              writeAlerts({
                account_sid: carrier.account_sid,
                service_provider_sid: carrier.service_provider_sid,
                message: `Disabling Outbound Registration for carrier ${carrier.name} (sid:${carrier.voip_carrier_sid})`
              });
            }
          }
          expires = 0;
        } else {
          this.status = 'registered';
          expires = DEFAULT_EXPIRES;

          if (res.has('Expires')) {
            expires = parseInt(res.get('Expires'), 10);
            this.logger.debug(`Using Expires header value of ${expires}`);
          }

          if (res.has('Contact')) {
            const contact = res.getParsedHeader('Contact');
            if (contact.length > 0 && contact[0].params && contact[0].params.expires) {
              expires = parseInt(contact[0].params.expires, 10);
            }
          } else {
            this.logger.debug({ aor: this.aor, ipv4: this.ipv4, port: this.port }, 'no Contact header in 200 OK');
          }

          if (isNaN(expires) || expires < MIN_EXPIRES) {
            this.logger.debug(
              { aor: this.aor, ipv4: this.ipv4, port: this.port },
              `got expires of ${expires} in 200 OK, too small so setting to ${MIN_EXPIRES}`
            );
            expires = MIN_EXPIRES;
          }
          this.logger.debug(`setting timer for next register to ${expires} seconds`);
          this.timer = setTimeout(() => void this.register(srf), (expires / 2) * 1000);
        }
        const timestamp = new Date().toISOString();

        updateVoipCarriersRegisterStatus(
          this.voip_carrier_sid,
          JSON.stringify({
            status: res.status === 200 ? 'ok' : 'fail',
            reason: `${res.status} ${res.reason}`,
            cseq: req.get('Cseq'),
            callId: req.get('Call-Id'),
            timestamp,
            expires
          })
        );

        if (this.trunk_type === 'reg') {
          this.addresses = [];
          if (isValidIPv4(this.ipv4)) {
            this.addresses.push(this.ipv4);
          } else if (this.port) {
            const addrs = await dnsResolverA(this.logger, this.ipv4);
            this.addresses.push(...addrs);
          } else {
            const addrs = await dnsResolverSrv(this.logger, this.ipv4, transport);
            if (addrs.length) {
              this.addresses.push(...addrs);
            } else {
              this.logger.info({ ipv4: this.ipv4, transport }, 'No SRV addresses found for reg-gateway');
              const addrsARecord = await dnsResolverA(this.logger, this.ipv4);
              if (addrsARecord.length) {
                this.addresses.push(...addrsARecord);
              } else {
                this.logger.info({ ipv4: this.ipv4 }, 'No A record found for reg-gateway');
              }
            }
          }
          if (this.addresses.length) {
            try {
              await Promise.all(
                this.addresses.map((ip) => createEphemeralGateway(ip, this.voip_carrier_sid, expires))
              );
            } catch (err) {
              this.logger.error({ addresses: this.addresses, err }, 'Error creating hash for reg-gateway');
            }
            this.logger.debug(
              { addresses: this.addresses },
              `Created ephemeral gateways for registration trunk ${this.voip_carrier_sid}, ${this.sip_realm}`
            );
          }
        }
      });
    } catch (err) {
      this.logger.error({ err }, `${this.aor}: Error registering to ${this.ipv4}:${this.port}`);
      this.timer = setTimeout(() => void this.register(srf), FAILURE_RETRY_INTERVAL * 1000);
      updateVoipCarriersRegisterStatus(
        this.voip_carrier_sid,
        JSON.stringify({
          status: 'fail',
          reason: String(err)
        })
      );
    }
  }
}

const dnsResolverA = async(logger: Logger, hostname: string): Promise<string[]> => {
  try {
    const addresses = await dnsPromises.resolve4(hostname);
    logger.debug({ addresses }, `Regbot: resolved ${hostname} into ${addresses.length} IPs`);
    return addresses;
  } catch (err) {
    logger.info({ err }, `Error resolving ${hostname}`);
  }
  return [];
};

const dnsResolverSrv = async(logger: Logger, hostname: string, transport: string): Promise<string[]> => {
  let name: string;
  switch (transport) {
    case 'tls':
      name = `_sips._tcp.${hostname}`;
      break;
    case 'tcp':
      name = `_sip._tcp.${hostname}`;
      break;
    default:
      name = `_sip._udp.${hostname}`;
  }

  try {
    const arr = await dnsPromises.resolveSrv(name);
    logger.debug({ arr }, `Regbot: resolved ${hostname}/${transport} into ${arr.length} results`);
    const ips = await Promise.all(arr.map((obj) => dnsResolverA(logger, obj.name)));
    return ips.flat();
  } catch (err) {
    logger.info({ err }, `SRV Error resolving ${hostname}`);
  }
  return [];
};
