import type Srf from 'drachtio-srf';

export function isUacBehindNat(req: Srf.SrfRequest) {
  if (req.protocol !== 'udp') return false;
  return true;
}

export function getSipProtocol(req: Srf.SrfRequest): string | undefined {
  const via = req.getParsedHeader('Via');
  const proto = via[0]?.protocol?.toLowerCase();
  if (!proto) return undefined;
  if (proto.startsWith('wss')) return 'wss';
  if (proto.startsWith('ws')) return 'ws';
  if (proto.startsWith('tcp')) return 'tcp';
  if (proto.startsWith('udp')) return 'udp';
  return undefined;
}

export function makeBlacklistGatewayKey(key: string) {
  return `blacklist-sip-gateway:${key}`;
}

export async function addSipGatewayToBlacklist(
  client: { setex(key: string, ttl: number, val: string): Promise<unknown> },
  logger: { info: (msg: string) => void; error: (o: { err: unknown }, msg: string) => void },
  sip_gateway_sid: string,
  expired: number
) {
  try {
    await client.setex(makeBlacklistGatewayKey(sip_gateway_sid), expired, '1');
    logger.info(`addSipGatewayToBlacklist: added  ${sip_gateway_sid} to blacklist`);
  } catch (err) {
    logger.error({ err }, `addSipGatewayToBlacklist: Error add  ${sip_gateway_sid} to blacklist`);
  }
}

export async function removeSipGatewayFromBlacklist(
  client: { del(key: string): Promise<unknown> },
  logger: { info: (msg: string) => void; error: (o: { err: unknown }, msg: string) => void },
  sip_gateway_sid: string
) {
  try {
    await client.del(makeBlacklistGatewayKey(sip_gateway_sid));
    logger.info(`removeSipGatewayFromBlacklist: removed ${sip_gateway_sid} from blacklist`);
  } catch (err) {
    logger.error({ err }, `removeSipGatewayFromBlacklist: Error removing ${sip_gateway_sid} from blacklist`);
  }
}

export async function isSipGatewayBlacklisted(
  client: { get(key: string): Promise<string | null> },
  logger: { error: (o: { err: unknown }, msg: string) => void },
  sip_gateway_sid: string
) {
  try {
    const exists = await client.get(makeBlacklistGatewayKey(sip_gateway_sid));
    return exists === '1';
  } catch (err) {
    logger.error({ err }, `isSipGatewayBlacklisted: Error checking if ${sip_gateway_sid} is blacklisted`);
    return false;
  }
}

const ipv4Pattern =
  /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

export function isValidIPv4(ip: string) {
  return ipv4Pattern.test(ip);
}

export function isValidDomainOrIP(input: string) {
  const domainRegex = /^(?!:\/\/)([a-zA-Z0-9.-]+)(:\d+)?$/;
  const ipRegex =
    /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(:\d+)?$/;

  if (domainRegex.test(input) || ipRegex.test(input)) {
    return true;
  }

  return false;
}

export const sleepFor = async(ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const NAT_EXPIRES = 30;
