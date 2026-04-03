import {
  addSipGatewayToBlacklist,
  removeSipGatewayFromBlacklist,
  isSipGatewayBlacklisted
} from './utils';
import { OPTIONS_RESPONSE_REMOVE } from './config';
import type DrachtioSrf = require('drachtio-srf');
import type { Logger } from 'pino';
import type { SidecarSrf } from '../types/jambonz-locals';
import type { SipGatewayRowSidecar } from '../types/jambonz-locals';

const send_options_gateways: SipGatewayRowSidecar[] = [];

class OptionsBot {
  logger: Logger;
  sip_gateway_sid: string;
  voip_carrier_sid: string;
  ipv4: string;
  port: number;
  protocol: string;
  expiry: number;
  blacklist_expiry: number;
  proxy: string;
  uri: string;

  constructor(logger: Logger, gateway: SipGatewayRowSidecar) {
    this.logger = logger;
    this.sip_gateway_sid = gateway.sip_gateway_sid;
    this.voip_carrier_sid = gateway.voip_carrier_sid;
    this.ipv4 = gateway.ipv4;
    this.port = gateway.port;
    this.protocol = gateway.protocol;
    this.expiry = Number(process.env.SEND_OPTIONS_PING_INTERVAL) || 60;
    this.blacklist_expiry = Number(process.env.OPTIONS_PING_TTL) || 300;

    const useSipsScheme = gateway.protocol.includes('tls') && gateway.use_sips_scheme;
    const isIPv4 = /[0-9]{1,3}.[0-9]{1,3}.[0-9]{1,3}.[0-9]{1,3}/.test(gateway.ipv4);
    const transport = gateway.protocol.includes('/')
      ? gateway.protocol.substring(0, gateway.protocol.indexOf('/'))
      : gateway.protocol;
    this.proxy = `sip:${this.ipv4}${isIPv4 ? `:${this.port}` : ''};transport=${transport}`;
    this.uri = `sip${useSipsScheme ? 's' : ''}:${gateway.ipv4}${
      gateway.port && !useSipsScheme ? `:${gateway.port}` : ''
    }`;
  }

  async options(srf: SidecarSrf) {
    const { lookupCarrierBySid } = srf.locals.dbHelpers;
    const { writeAlerts, logger, realtimeDbHelpers } = srf.locals;
    try {
      const req = await srf.request({
        uri: this.uri,
        method: 'OPTIONS',
        proxy: this.proxy
      });
      req.on('response', async(res?: DrachtioSrf.SrfResponse) => {
        if (!res) return;
        if (res.status !== 200) {
          this.logger.info(`Received Options response ${res.status} for ${this.uri}`);
          if (!(await isSipGatewayBlacklisted(realtimeDbHelpers.client, logger, this.sip_gateway_sid))) {
            await addSipGatewayToBlacklist(
              realtimeDbHelpers.client,
              logger,
              this.sip_gateway_sid,
              this.blacklist_expiry
            );
            const carrier = await lookupCarrierBySid(this.voip_carrier_sid);
            if (carrier) {
              writeAlerts({
                account_sid: carrier.account_sid,
                service_provider_sid: carrier.service_provider_sid,
                message: `Options ping ${this.ipv4}${this.port ? `:${this.port}` : ''};transport=${
                  this.protocol
                } unsuccessfully, received: ${res.status}`
              });
            }
          }
          if (OPTIONS_RESPONSE_REMOVE.includes(res.status)) {
            const { updateSipGatewayBySid } = srf.locals.dbHelpers;
            await updateSipGatewayBySid(this.sip_gateway_sid, { send_options_ping: false });
            const carrier = await lookupCarrierBySid(this.voip_carrier_sid);
            if (carrier) {
              const detail =
                `${this.ipv4} in carrier ${carrier.name}:${carrier.voip_carrier_sid} due to ${res.status}`;
              this.logger.info(`Disabling Options ping for ${detail}`);
              writeAlerts({
                account_sid: carrier.account_sid,
                service_provider_sid: carrier.service_provider_sid,
                message: `Disabling Options ping for ${detail}`
              });
            }
          }
        } else if (await isSipGatewayBlacklisted(realtimeDbHelpers.client, logger, this.sip_gateway_sid)) {
          await removeSipGatewayFromBlacklist(realtimeDbHelpers.client, logger, this.sip_gateway_sid);
        }
      });
    } catch (err) {
      this.logger.error({ err }, `Error Options ping to ${this.uri}`);
      if (!(await isSipGatewayBlacklisted(realtimeDbHelpers.client, logger, this.sip_gateway_sid))) {
        await addSipGatewayToBlacklist(realtimeDbHelpers.client, logger, this.sip_gateway_sid, this.blacklist_expiry);
        const carrier = await lookupCarrierBySid(this.voip_carrier_sid);
        if (carrier) {
          writeAlerts({
            account_sid: carrier.account_sid,
            service_provider_sid: carrier.service_provider_sid,
            message: `Options ping ${this.ipv4}${this.port ? `:${this.port}` : ''};transport=${
              this.protocol
            } unsuccessfully, error: ${err}`
          });
        }
      }
    }
  }
}

export default async function sipTrunkOptionsPing(logger: Logger, srf: SidecarSrf) {
  const updateSipGatewayOptsBot = async() => {
    try {
      const { lookupSipGatewaysByFilters } = srf.locals.dbHelpers;
      const gws = await lookupSipGatewaysByFilters({
        send_options_ping: true,
        outbound: true,
        is_active: true
      });

      if (gws.length > 0) {
        logger.debug(`updateSipGatewayOptsBot: sending OPTIONS ping to ${gws.length} gateways`);
        send_options_gateways.length = 0;
        send_options_gateways.push(...gws);
        for (const g of send_options_gateways) {
          const optsBot = new OptionsBot(logger, g);
          void optsBot.options(srf);
        }
        logger.debug(`updateSipGatewayOptsBot: we have started ${send_options_gateways.length} optionsBots`);
      }
    } catch (err) {
      logger.error({ err }, 'updateSipGatewayOptsBot Error');
    }
  };

  setInterval(() => void updateSipGatewayOptsBot(), (Number(process.env.SEND_OPTIONS_PING_INTERVAL) || 60) * 1000);
}
