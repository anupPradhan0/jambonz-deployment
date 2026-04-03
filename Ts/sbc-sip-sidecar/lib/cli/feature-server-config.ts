import { getInstance } from './runtime-config';

export function isValidIP(ip: unknown): ip is string {
  if (!ip || typeof ip !== 'string') return false;

  const ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  if (ipv4.test(ip)) return true;

  const ipv6 = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::1$|^::$/;
  if (ipv6.test(ip)) return true;

  const ipv6Short = new RegExp(
    [
      '^([0-9a-fA-F]{1,4}:)*::([0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}$',
      '^([0-9a-fA-F]{1,4}:)*::[0-9a-fA-F]{1,4}$',
      '^[0-9a-fA-F]{1,4}::([0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}$'
    ].join('|')
  );
  if (ipv6Short.test(ip)) return true;

  return false;
}

export async function isDrained(serverIP: string) {
  if (!isValidIP(serverIP)) {
    return false;
  }

  try {
    const runtimeConfig = getInstance();
    return await runtimeConfig.isServerDrained(serverIP);
  } catch {
    return false;
  }
}

export async function getDrainedServers() {
  try {
    const runtimeConfig = getInstance();
    return await runtimeConfig.getDrainedFeatureServers();
  } catch {
    return [];
  }
}

export async function getActiveServers() {
  try {
    const runtimeConfig = getInstance();
    return await runtimeConfig.getActiveFeatureServers();
  } catch {
    return [];
  }
}

export async function getAvailableServers() {
  try {
    const runtimeConfig = getInstance();
    return await runtimeConfig.getAvailableFeatureServers();
  } catch {
    return [];
  }
}

export async function getAllServersWithStatus() {
  try {
    const runtimeConfig = getInstance();
    return await runtimeConfig.getAllFeatureServersWithStatus();
  } catch {
    return { servers: [], drained: [] };
  }
}
