import Srf = require('drachtio-srf');

/** Runtime has endSession; upstream .d.ts omits it. */
export type SrfWithEndSession = Srf & {
  endSession(req: Srf.SrfRequest): void;
};

/** INVITE request after sbc-outbound middleware initialisation */
export type JambonzSrfRequest = Srf.SrfRequest & {
  locals: OutboundRequestLocals;
  canceled?: boolean;
  server: { hostport: string };
  srf: SrfWithEndSession;
};

export type JambonzSrfResponse = Srf.SrfResponse;

export type SipDialog = Srf.Dialog;

export type SrfInstance = SrfWithEndSession;
