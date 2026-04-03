import DrachtioSrf = require('drachtio-srf');
import type { Logger } from 'pino';

/** SRF instance with runtime helpers; drachtio .d.ts omits several methods/events. */
export type SidecarSrf = InstanceType<typeof DrachtioSrf> & {
  endSession(req: DrachtioSrf.SrfRequest): void;
  locals: SidecarSrfLocals;
  request(
    uriOrOpts: string | Record<string, unknown>,
    opts?: Record<string, unknown>
  ): Promise<
    DrachtioSrf.SrfRequest & {
      on(event: 'response', cb: (res: DrachtioSrf.SrfResponse) => void): void;
      get(name: string): string;
    }
  >;
  use(
    messageType: string,
    middlewares: Array<
      (req: DrachtioSrf.SrfRequest, res: DrachtioSrf.SrfResponse, next: (err?: unknown) => void) => void
    >
  ): void;
  register(handler: (req: DrachtioSrf.SrfRequest, res: DrachtioSrf.SrfResponse) => void | Promise<void>): void;
  options(handler: (req: DrachtioSrf.SrfRequest, res: DrachtioSrf.SrfResponse) => void | Promise<void>): void;
  on(
    event: 'connect',
    listener: (
      err: Error | undefined,
      hp: string,
      version: string,
      localHostports: string | undefined
    ) => void
  ): SidecarSrf;
};

export interface SidecarRequestLocals {
  logger: Logger;
  realm?: string;
  account_sid?: string;
  webhook_secret?: string;
  registration_hook_url?: string;
  registration_hook_method?: string;
  registration_hook_username?: string;
  registration_hook_password?: string;
}

export interface VoipCarrierForRegbot {
  voip_carrier_sid: string;
  requires_register?: boolean;
  is_active?: boolean;
  register_username?: string | null;
  register_password?: string | null;
  register_sip_realm?: string | null;
  register_from_user?: string | null;
  register_from_domain?: string | null;
  register_public_ip_in_contact?: boolean | null;
  outbound_sip_proxy?: string | null;
  account_sid?: string;
  trunk_type?: string;
  name?: string;
  service_provider_sid?: string;
}

export interface SipGatewayRowSidecar {
  sip_gateway_sid: string;
  voip_carrier_sid: string;
  ipv4: string;
  /** Present on some in-memory gateway rows for dedup keys */
  sip_realm?: string;
  port: number;
  protocol: string;
  outbound?: boolean;
  is_active?: boolean;
  use_sips_scheme?: boolean;
  send_options_ping?: boolean;
  carrier?: VoipCarrierForRegbot;
}

export interface SidecarSrfLocals {
  logger: Logger;
  stats: {
    histogram(name: string, value: string, tags?: string[]): void;
    gauge(name: string, value: number, tags?: string[]): void;
  };
  addToSet: (name: string, member: string) => Promise<unknown>;
  removeFromSet: (name: string, member: string) => Promise<unknown>;
  isMemberOfSet: (name: string, member: string | undefined) => Promise<boolean>;
  retrieveSet: (name: string) => Promise<string[]>;
  registrar: {
    query(aor: string): Promise<{ proxy?: string; expiryTime?: number } | null>;
    add(aor: string, opts: Record<string, unknown>, expires: number): Promise<unknown>;
    remove(aor: string): Promise<unknown>;
    getCountOfUsers(realm?: string): Promise<string | number>;
  };
  dbHelpers: {
    lookupAccountBySid(sid: string): Promise<{ sip_realm?: string } | null>;
    lookupAuthHook: (...args: unknown[]) => Promise<unknown>;
    lookupAllVoipCarriers: () => Promise<VoipCarrierForRegbot[]>;
    lookupSipGatewaysByCarrier: (sid: string) => Promise<SipGatewayRowSidecar[]>;
    lookupAccountBySipRealm: (
      host: string
    ) => Promise<{
      account_sid: string;
      is_active?: boolean;
      webhook_secret?: string;
      registration_hook?: {
        url?: string;
        method?: string;
        username?: string;
        password?: string;
      };
      device_to_call_ratio?: number;
    } | null>;
    lookupAccountCapacitiesBySid: (
      sid: string
    ) => Promise<Array<{ category: string; quantity: number }>>;
    updateVoipCarriersRegisterStatus: (sid: string, status: string) => Promise<unknown>;
    lookupClientByAccountAndUsername: (...args: unknown[]) => Promise<unknown>;
    lookupSipGatewaysByFilters: (filters: Record<string, unknown>) => Promise<SipGatewayRowSidecar[]>;
    updateSipGatewayBySid: (sid: string, patch: Record<string, unknown>) => Promise<unknown>;
    lookupCarrierBySid: (sid: string) => Promise<VoipCarrierForRegbot | null>;
    lookupSystemInformation: () => Promise<{ sip_domain_name?: string | null } | null>;
    updateCarrierBySid: (sid: string, patch: Record<string, unknown>) => Promise<unknown>;
  };
  realtimeDbHelpers: {
    client: {
      setex(key: string, ttl: number, val: string): Promise<unknown>;
      del(key: string): Promise<unknown>;
      get(key: string): Promise<string | null>;
    };
    addKey: (key: string, value: string, ttl: number) => Promise<unknown>;
    addKeyNx: (key: string, value: string, ttl: number) => Promise<string>;
    retrieveKey: (key: string) => Promise<string | null>;
    retrieveSet: (name: string) => Promise<string[]>;
    createEphemeralGateway: (ip: string, carrierSid: string, ttl: number) => Promise<unknown>;
    deleteEphemeralGateway: (ip: string, carrierSid: string) => Promise<unknown>;
  };
  writeAlerts: (opts: Record<string, unknown>) => Promise<unknown>;
  AlertType: Record<string, string>;
  privateSipAddress?: string;
  sbcPublicIpAddress: Partial<Record<'udp' | 'tls' | 'wss', string>>;
  localSIPDomain?: string | null;
  /** Filled when sip-trunk-register initialises */
  regbot?: {
    myToken: string;
    active: boolean;
  };
  regbotStatus?: () => { total: number; registered: number; active: boolean };
  /** Optional test / legacy hook */
  lb?: { disconnect(): void };
}
