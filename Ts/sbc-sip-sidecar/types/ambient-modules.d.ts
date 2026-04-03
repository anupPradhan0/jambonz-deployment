declare module 'debug' {
  function debug(namespace: string): (...args: unknown[]) => void;
  export = debug;
}

declare module 'cidr-matcher' {
  class CIDRMatcher {
    constructor(cidrs: string[]);
    contains(ip: string): boolean;
  }
  export = CIDRMatcher;
}

declare module 'short-uuid' {
  const short: { generate(): string };
  export = short;
}

declare module 'drachtio-mw-registration-parser' {
  import type { Srf } from 'drachtio-srf';
  const mw: (req: Srf.SrfRequest, res: Srf.SrfResponse, next: (err?: unknown) => void) => void;
  export = mw;
}

declare module 'drachtio-mw-response-time' {
  type RttRes = { cached?: boolean; statusCode?: number };
  const factory: (
    fn: (req: unknown, res: RttRes, timeMs: number) => void
  ) => (req: unknown, res: unknown, next: (err?: unknown) => void) => void;
  export = factory;
}

declare module '@jambonz/digest-utils' {
  import type { Srf } from 'drachtio-srf';
  const mw: (req: Srf.SrfRequest, res: Srf.SrfResponse, next: (err?: unknown) => void) => void;
  export = mw;
}

declare module '@jambonz/mw-registrar' {
  type Logger = import('pino').Logger;
  class Registrar {
    constructor(logger: Logger, client: unknown);
    query(aor: string): Promise<Record<string, unknown> | null>;
    add(aor: string, opts: Record<string, unknown>, expires: number): Promise<unknown>;
    remove(aor: string): Promise<unknown>;
    getCountOfUsers(realm?: string): Promise<string | number>;
  }
  export = Registrar;
}

declare module '@jambonz/db-helpers' {
  type Logger = import('pino').Logger;

  interface RegistrationHook {
    url?: string;
    method?: string;
    username?: string;
    password?: string;
  }

  interface AccountByRealmRow {
    account_sid: string;
    is_active?: boolean;
    webhook_secret?: string;
    registration_hook?: RegistrationHook;
    device_to_call_ratio?: number;
  }

  interface SystemInformationRow {
    sip_domain_name?: string | null;
    private_network_cidr?: string | null;
    log_level?: string;
  }

  interface VoipCarrierRow {
    voip_carrier_sid: string;
    name: string;
    account_sid?: string;
    service_provider_sid?: string;
    requires_register?: boolean;
    is_active?: boolean;
    register_username?: string | null;
    register_password?: string | null;
    register_sip_realm?: string | null;
    register_from_user?: string | null;
    register_from_domain?: string | null;
    register_public_ip_in_contact?: boolean | null;
    outbound_sip_proxy?: string | null;
    trunk_type?: string;
  }

  interface SipGatewayRow {
    sip_gateway_sid: string;
    voip_carrier_sid: string;
    ipv4: string;
    port: number;
    protocol: string;
    outbound?: boolean;
    is_active?: boolean;
    use_sips_scheme?: boolean;
    send_options_ping?: boolean;
  }

  interface DbHelpers {
    lookupAuthHook(...args: unknown[]): Promise<unknown>;
    lookupAllVoipCarriers(): Promise<VoipCarrierRow[]>;
    lookupSipGatewaysByCarrier(sid: string): Promise<SipGatewayRow[]>;
    lookupAccountBySipRealm(host: string): Promise<AccountByRealmRow | null>;
    lookupAccountCapacitiesBySid(
      sid: string
    ): Promise<Array<{ category: string; quantity: number }>>;
    addSbcAddress(ipv4: string, port?: string, tls_port?: string, wss_port?: string): Promise<unknown>;
    cleanSbcAddresses(): Promise<unknown>;
    updateVoipCarriersRegisterStatus(sid: string, status: string): Promise<unknown>;
    lookupClientByAccountAndUsername(...args: unknown[]): Promise<unknown>;
    lookupSipGatewaysByFilters(filters: Record<string, unknown>): Promise<SipGatewayRow[]>;
    updateSipGatewayBySid(sid: string, patch: Record<string, unknown>): Promise<unknown>;
    lookupCarrierBySid(sid: string): Promise<VoipCarrierRow | null>;
    lookupSystemInformation(): Promise<SystemInformationRow | null>;
    updateCarrierBySid(sid: string, patch: Record<string, unknown>): Promise<unknown>;
    lookupAccountBySid(sid: string): Promise<{ sip_realm?: string } | null>;
  }

  const factory: (
    config: {
      host: string;
      user: string;
      port: number;
      password: string;
      database: string;
      connectionLimit: number;
    },
    logger: Logger,
    writeConfig?: {
      host: string;
      user: string;
      port: number;
      password: string;
      database: string;
      connectionLimit: number;
    } | null
  ) => DbHelpers;
  export = factory;
}

declare module '@jambonz/realtimedb-helpers' {
  type Logger = import('pino').Logger;
  interface RealtimeApi {
    client: {
      setex(key: string, ttl: number, val: string): Promise<unknown>;
      del(key: string): Promise<unknown>;
      get(key: string): Promise<string | null>;
    };
    addKey(key: string, value: string, ttl: number): Promise<unknown>;
    addKeyNx(key: string, value: string, ttl: number): Promise<string>;
    retrieveKey(key: string): Promise<string | null>;
    addToSet(name: string, member: string): Promise<unknown>;
    removeFromSet(name: string, member: string): Promise<unknown>;
    isMemberOfSet(name: string, member: string | undefined): Promise<boolean>;
    retrieveSet(name: string): Promise<string[]>;
    createEphemeralGateway(ip: string, carrierSid: string, ttl: number): Promise<unknown>;
    deleteEphemeralGateway(ip: string, carrierSid: string): Promise<unknown>;
  }
  const factory: (opts: Record<string, unknown>, logger: Logger) => RealtimeApi;
  export = factory;
}

declare module '@jambonz/time-series' {
  type Logger = import('pino').Logger;
  interface Api {
    writeAlerts(opts: Record<string, unknown>): Promise<unknown>;
    AlertType: Record<string, string>;
  }
  const factory: (
    logger: Logger,
    opts: { host: string; commitSize: number; commitInterval: number | string }
  ) => Api;
  export = factory;
}

declare module '@jambonz/stats-collector' {
  type Logger = import('pino').Logger;
  class StatsCollector {
    constructor(logger: Logger);
    histogram(name: string, value: string, tags?: string[]): void;
    gauge(name: string, value: number, tags?: string[]): void;
  }
  export = StatsCollector;
}
