import Srf = require('drachtio-srf');

/** Runtime has endSession; upstream .d.ts may omit it. */
export type SrfWithEndSession = Srf & {
  endSession(req: Srf.SrfRequest): void;
};

/** INVITE request after sbc-inbound middleware initialisation */
export type JambonzSrfRequest = Srf.SrfRequest & {
  locals: InboundRequestLocals;
  canceled?: boolean;
  server: { hostport: string };
  srf: SrfWithEndSession;
};

export type JambonzSrfResponse = Srf.SrfResponse;

export type SipDialog = Srf.Dialog;

export type SrfInstance = SrfWithEndSession;
