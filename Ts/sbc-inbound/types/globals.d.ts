/** Script (non-module) typings shared across sbc-inbound. */

interface InboundCdr extends Record<string, unknown> {
  account_sid?: string;
  service_provider_sid?: string;
  from?: string;
  to?: string;
  sip_callid?: string;
  duration?: number;
  answered?: boolean;
  attempted_at?: number;
  direction?: string;
  host?: string;
  remote_host?: string;
}

/** INVITE request after sbc-inbound middleware initialisation */
interface InboundRequestLocals extends Record<string, unknown> {
  callId: string;
  nudge: number;
  logger?: import('pino').Logger;
  sdp?: string;
  siprec?: boolean;
  xml?: { content: string; type?: string };
  originator?: 'trunk' | 'teams' | 'user';
  carrier?: string;
  gateway?: Record<string, unknown> & { voip_carrier_sid?: string; name?: string; pad_crypto?: number; application_sid?: string };
  voip_carrier_sid?: string;
  application_sid?: string | null;
  service_provider_sid?: string;
  account_sid?: string;
  account?: Record<string, unknown> & {
    service_provider_sid?: string;
    is_active?: boolean;
    disable_cdrs?: boolean;
    enable_debug_log?: boolean;
    record_all_calls?: string | boolean;
    record_format?: string;
    siprec_hook_sid?: string;
    device_calling_application_sid?: string;
    webhook_secret?: string;
    registration_hook?: { url?: string; method?: string; username?: string; password?: string };
  };
  cdr?: InboundCdr;
  msTeamsTenantFqdn?: string;
  realm?: string;
  webhook_secret?: string;
  auth_trunks?: unknown[];
  possibleWebRtcClient?: boolean;
  callCountNudged?: boolean;
}

interface RealtimeClient {
  ping(): Promise<string>;
}
