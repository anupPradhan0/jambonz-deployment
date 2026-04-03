declare module '@jambonz/db-helpers' {
  type Logger = import('pino').Logger;

  interface SystemInformationRow {
    private_network_cidr: string | null;
    log_level?: string;
  }

  interface DbHelpers {
    ping(): Promise<unknown>;
    lookupOutboundCarrierForAccount(accountSid: string): Promise<string | null>;
    lookupAllTeamsFQDNs(): Promise<string[]>;
    lookupAccountBySipRealm(host: string): Promise<{ account_sid: string } | null>;
    lookupAccountBySid(sid: string): Promise<Record<string, unknown>>;
    lookupAccountCapacitiesBySid(
      sid: string
    ): Promise<Array<{ category: string; quantity: number }>>;
    lookupSipGatewaysByCarrier(sid: string): Promise<SipGatewayRow[]>;
    lookupCarrierBySid(sid: string): Promise<VoipCarrierRow | null>;
    queryCallLimits(
      spSid: string,
      accountSid: string
    ): Promise<{ account_limit: number; sp_limit: number }>;
    lookupCarrierByAccountLcr(
      accountSid: string,
      calledNumber: string
    ): Promise<string | null>;
    lookupSystemInformation(): Promise<SystemInformationRow | null>;
  }

  export interface SipGatewayRow {
    sip_gateway_sid: string;
    outbound: boolean;
    ipv4: string;
    port?: number | null;
    protocol?: string | null;
    pad_crypto?: boolean;
    remove_ice?: boolean;
    dtls_off?: boolean;
    use_sips_scheme?: boolean;
  }

  export interface VoipCarrierRow {
    name: string;
    tech_prefix?: string | null;
    diversion?: string | null;
    e164_leading_plus?: boolean;
    register_from_domain?: string | null;
    register_username?: string | null;
    register_password?: string | null;
    requires_register?: boolean;
    register_sip_realm?: string | null;
    outbound_sip_proxy?: string | null;
  }

  const factory: (
    config: {
      host: string;
      port: number;
      user: string;
      password: string;
      database: string;
      connectionLimit: number;
    },
    logger: Logger
  ) => DbHelpers;
  export = factory;
}

declare module '@jambonz/realtimedb-helpers' {
  type Logger = import('pino').Logger;

  interface RealtimeDbApi {
    client: RealtimeClient;
    createHash(key: string, obj: Record<string, unknown>, ttl: number): Promise<unknown>;
    retrieveHash(key: string): Promise<Record<string, unknown> | null>;
    incrKey(key: string): Promise<number | null>;
    decrKey(key: string): Promise<number | null>;
    retrieveSet(name: string): Promise<Set<string>>;
    isMemberOfSet(name: string, member: string | undefined): Promise<boolean>;
    addKey(key: string, value: string, ttl: number): Promise<unknown>;
    deleteKey(key: string): Promise<unknown>;
    retrieveKey(key: string): Promise<string | null>;
  }

  const factory: (opts: Record<string, never>, logger: Logger) => RealtimeDbApi;
  export = factory;
}

declare module '@jambonz/time-series' {
  type Logger = import('pino').Logger;

  interface TimeSeriesApi {
    writeCallCount(opts: Record<string, unknown>): Promise<unknown>;
    writeCallCountSP(opts: Record<string, unknown>): Promise<unknown>;
    writeCallCountApp(opts: Record<string, unknown>): Promise<unknown>;
    writeCdrs(opts: Record<string, unknown>): Promise<unknown>;
    queryCdrs(opts: { account_sid: string }): Promise<{ total: number }>;
    writeAlerts(opts: Record<string, unknown>): Promise<unknown>;
    AlertType: Record<string, string>;
  }

  const factory: (
    logger: Logger,
    opts: { host?: string; commitSize: number; commitInterval: number }
  ) => TimeSeriesApi;
  export = factory;
}

declare module '@jambonz/stats-collector' {
  type Logger = import('pino').Logger;

  class StatsCollector {
    constructor(logger: Logger);
    increment(name: string, tags?: string[]): void;
    gauge(name: string, value: number, tags?: string[]): void;
  }
  export = StatsCollector;
}

declare module '@jambonz/rtpengine-utils' {
  type Logger = import('pino').Logger;

  interface RtpEngineResponse {
    result: string;
    sdp?: string;
    'error-reason'?: string;
  }

  interface RtpEngine {
    offer(opts: Record<string, unknown>): Promise<RtpEngineResponse>;
    answer(opts: Record<string, unknown>): Promise<RtpEngineResponse>;
    del(opts: Record<string, unknown>): Promise<unknown>;
    blockMedia(opts: Record<string, unknown>): Promise<unknown>;
    unblockMedia(opts: Record<string, unknown>): Promise<unknown>;
    blockDTMF(opts: Record<string, unknown>): Promise<unknown>;
    unblockDTMF(opts: Record<string, unknown>): Promise<unknown>;
    playDTMF(opts: Record<string, unknown>): Promise<RtpEngineResponse>;
    subscribeDTMF(
      logger: Logger,
      callId: string,
      tag: string | null,
      cb: (payload: { event: number; duration: number }) => void
    ): void;
    unsubscribeDTMF(logger: Logger, callId: string, tag: string | null): void;
    subscribeRequest: (...args: unknown[]) => unknown;
    subscribeAnswer: (...args: unknown[]) => unknown;
    unsubscribe: (...args: unknown[]) => unknown;
  }

  const factory: (
    seeds: string[],
    logger: Logger,
    opts: { dtmfListenPort: number; protocol: string }
  ) => {
    getRtpEngine(): RtpEngine | null;
    setRtpEngines(endpoints: string[]): void;
  };
  export = factory;
}

declare module '@jambonz/siprec-client-utils' {
  type Logger = import('pino').Logger;
  type DrachtioSrf = InstanceType<typeof import('drachtio-srf')>;
  type DrachtioReq = import('drachtio-srf').Srf.SrfRequest;

  interface SrsClientOpts {
    srf: DrachtioSrf;
    direction: string;
    originalInvite: DrachtioReq;
    callingNumber: string;
    calledNumber: string;
    srsUrl: string;
    srsRecordingId: string;
    callSid: string;
    accountSid: string;
    applicationSid: string;
    rtpEngineOpts: Record<string, unknown>;
    toTag: string | null;
    aorFrom: string;
    aorTo: string;
    subscribeRequest: unknown;
    subscribeAnswer: unknown;
    del: unknown;
    blockMedia: unknown;
    unblockMedia: unknown;
    unsubscribe: unknown;
    headers: Record<string, unknown>;
    isSipRecCall: boolean;
  }

  class SrsClient {
    constructor(logger: Logger, opts: SrsClientOpts);
    activated: boolean;
    paused: boolean;
    start(): Promise<unknown>;
    stop(): void;
    pause(opts: { headers: Record<string, unknown> }): unknown;
    resume(opts: { headers: Record<string, unknown> }): unknown;
  }
  export = SrsClient;
}

declare module '@jambonz/http-health-check' {
  type Express = import('express').Express;
  type Logger = import('pino').Logger;

  function healthCheck(opts: {
    app: Express;
    logger: Logger;
    path: string;
    fn: () => number | Promise<number>;
  }): void;
  export = healthCheck;
}

declare module '@jambonz/mw-registrar' {
  type Logger = import('pino').Logger;

  class Registrar {
    constructor(logger: Logger, client: unknown);
    query(aor: string): Promise<RegistrationRecord | null>;
  }
  export = Registrar;
}

declare module 'drachtio-fn-b2b-sugar' {
  export function forwardInDialogRequests(dlg: import('drachtio-srf').Srf.Dialog, methods: string[]): void;
}

declare module 'bent' {
  type BentDecoder = 'json' | 'buffer' | 'string';
  interface BentFn {
    (url: string, body?: unknown): Promise<unknown>;
  }
  function bent(base: string, ...decoders: BentDecoder[]): BentFn;
  export = bent;
}

declare module 'cidr-matcher' {
  class CIDRMatcher {
    constructor(cidrs: string[]);
    contains(ip: string): boolean;
  }
  export = CIDRMatcher;
}
