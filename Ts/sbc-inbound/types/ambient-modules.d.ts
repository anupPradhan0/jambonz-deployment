declare module '@jambonz/db-helpers' {
  type Logger = import('pino').Logger;

  interface SystemInformationRow {
    private_network_cidr: string | null;
    log_level?: string;
  }

  interface DbHelpers {
    ping(): Promise<unknown>;
    pool: { promise(): { query: (...args: unknown[]) => Promise<unknown[]> } };
    lookupAuthHook(opts: Record<string, unknown>): Promise<unknown>;
    lookupSipGatewayBySignalingAddress(addr: string): Promise<unknown>;
    addSbcAddress(ip: string): unknown;
    lookupAccountByPhoneNumber(num: string): Promise<unknown>;
    lookupAppByTeamsTenant(host: string): Promise<Record<string, unknown> | null>;
    lookupAccountBySipRealm(realm: string): Promise<Record<string, unknown> | null>;
    lookupAccountBySid(sid: string): Promise<Record<string, unknown>>;
    lookupAccountCapacitiesBySid(
      sid: string
    ): Promise<Array<{ category: string; quantity: number }>>;
    queryCallLimits(
      spSid: string,
      accountSid: string
    ): Promise<{ account_limit: number; sp_limit: number }>;
    lookupClientByAccountAndUsername(
      accountSid: string,
      username: string
    ): Promise<unknown>;
    lookupSystemInformation(): Promise<SystemInformationRow | null>;
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
    logger: Logger,
    writePool?: {
      host: string;
      port: number;
      user: string;
      password: string;
      database: string;
      connectionLimit: number;
    } | null
  ) => DbHelpers;
  export = factory;
}

declare module '@jambonz/realtimedb-helpers' {
  type Logger = import('pino').Logger;

  interface RealtimeDbApi {
    client: RealtimeClient;
    addKey(key: string, value: string, ttl: number): Promise<unknown>;
    deleteKey(key: string): Promise<unknown>;
    retrieveKey(key: string): Promise<string | null>;
    retrieveHash(key: string): Promise<Record<string, unknown> | null>;
    createSet(name: string, members: string[]): Promise<unknown>;
    retrieveSet(name: string): Promise<Set<string>>;
    addToSet(name: string, member: string): Promise<unknown>;
    removeFromSet(name: string, member: string): Promise<unknown>;
    incrKey(key: string): Promise<number | null>;
    decrKey(key: string): Promise<number | null>;
    createEphemeralGateway(opts: Record<string, unknown>): Promise<unknown>;
    queryEphemeralGateways(): Promise<unknown>;
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
    opts: {
      host?: string;
      port?: number;
      commitSize: number;
      commitInterval: number;
    }
  ) => TimeSeriesApi;
  export = factory;
}

declare module '@jambonz/stats-collector' {
  type Logger = import('pino').Logger;

  class StatsCollector {
    constructor(logger: Logger);
    increment(name: string, tags?: string[]): void;
    gauge(name: string, value: number, tags?: string[]): void;
    histogram(name: string, value: number | string, tags?: string[]): void;
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

declare module '@jambonz/digest-utils' {
  const digestChallenge: (
    req: import('drachtio-srf').Srf.SrfRequest,
    res: import('drachtio-srf').Srf.SrfResponse,
    next: () => void
  ) => unknown;
  export = digestChallenge;
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

declare module 'verify-aws-sns-signature' {
  export function validatePayload(body: Record<string, unknown>): boolean;
}
