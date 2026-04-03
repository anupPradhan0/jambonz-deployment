/** Script (non-module) typings shared across sbc-outbound. */

interface RegistrationRecord {
  contact: string;
  sbcAddress: string;
  privateSbcAddress: string;
  proxy?: string;
  protocol?: string;
}

interface OutboundCdr {
  account_sid?: string;
  call_sid?: string;
  sip_callid?: string;
  sip_parent_callid?: string;
  application_sid?: string;
  service_provider_sid?: string;
  from?: string;
  to?: string;
  duration?: number;
  answered?: boolean;
  attempted_at?: number;
  direction?: string;
  host?: string;
  remote_host?: string;
  trace_id?: string;
  answered_at?: number;
  terminated_at?: number;
  termination_reason?: string;
  sip_status?: number;
  recording_url?: string;
  trunk?: string;
}

interface OutboundAccount extends Record<string, unknown> {
  service_provider_sid: string;
  enable_debug_log?: boolean;
  disable_cdrs?: boolean;
  record_format?: string;
}

interface OutboundRequestLocals {
  logger: import('pino').Logger;
  callId: string;
  nudge: number;
  account_sid: string;
  application_sid?: string;
  service_provider_sid: string;
  trace_id?: string;
  record_all_calls?: string | boolean;
  account: OutboundAccount;
  target?: 'teams' | 'user' | 'forward' | 'lcr';
  registration?: RegistrationRecord;
  cdr?: OutboundCdr;
  originator?: string;
}

interface RealtimeClient {
  ping(): Promise<string>;
  exists(key: string): Promise<number>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}
