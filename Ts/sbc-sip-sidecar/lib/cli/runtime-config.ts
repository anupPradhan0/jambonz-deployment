import * as net from 'node:net';
import * as fs from 'node:fs';
import type { Logger } from 'pino';
import type { SidecarSrfLocals } from '../../types/jambonz-locals';

const config = new Map<string, unknown>();
const queue: Array<{
  operation: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}> = [];
let processing = false;
let logger: Logger;

async function runOperation<T>(operation: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    queue.push({
      operation: operation as () => Promise<unknown>,
      resolve: resolve as (v: unknown) => void,
      reject
    });
    void processQueue();
  });
}

async function processQueue() {
  if (processing || queue.length === 0) return;

  processing = true;

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const { operation, resolve, reject } = item;
    try {
      const result = await operation();
      resolve(result);
    } catch (err) {
      reject(err);
    }
  }

  processing = false;
}

class RuntimeConfig {
  server: net.Server | null = null;
  socketPath: string;
  srfLocals: SidecarSrfLocals | null;

  constructor(srfLocals: SidecarSrfLocals | null = null, appLogger: Logger | null = null) {
    this.socketPath = process.env.SBC_SOCKET_PATH || '/tmp/sbc-sip-sidecar.sock';
    this.srfLocals = srfLocals;
    if (appLogger) {
      logger = appLogger;
    } else if (!logger) {
      throw new Error('Logger is required for RuntimeConfig');
    }
    this.startServer();
  }

  async set(key: string, value: unknown) {
    return runOperation(() => {
      config.set(key, value);
      logger.info({ key, value }, 'Config updated');
      return Promise.resolve({ key, value });
    });
  }

  async get(key: string, defaultValue?: unknown) {
    return runOperation(() => {
      return Promise.resolve(config.has(key) ? config.get(key) : defaultValue);
    });
  }

  async addToArray(key: string, item: string) {
    return runOperation(() => {
      let arr: unknown = config.get(key) ?? [];

      if (typeof arr === 'string') {
        arr = arr.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      }

      if (!Array.isArray(arr)) arr = [];

      const exists = (arr as string[]).includes(item);

      if (!exists) {
        (arr as string[]).push(item);
        config.set(key, arr);
        logger.info({ key, item, array: arr }, 'Added to array');
      }

      return Promise.resolve({ key, item, array: arr, added: !exists });
    });
  }

  async removeFromArray(key: string, item: string) {
    return runOperation(() => {
      let arr: unknown = config.get(key) ?? [];

      if (typeof arr === 'string') {
        arr = arr.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      }

      if (!Array.isArray(arr)) arr = [];

      const originalLength = (arr as string[]).length;
      const filtered = (arr as string[]).filter((existing) => existing !== item);

      if (filtered.length !== originalLength) {
        config.set(key, filtered);
        logger.info({ key, item, array: filtered }, 'Removed from array');
      }

      return Promise.resolve({ key, item, array: filtered, removed: filtered.length !== originalLength });
    });
  }

  async getAll() {
    return runOperation(() => {
      return Promise.resolve(Object.fromEntries(config));
    });
  }

  checkRedisConnection(requiredMethod: keyof SidecarSrfLocals) {
    return this.srfLocals && typeof this.srfLocals[requiredMethod] === 'function';
  }

  sendError(socket: net.Socket, message: string) {
    socket.write(JSON.stringify({ success: false, error: message }) + '\n');
  }

  sendSuccess(socket: net.Socket, data: Record<string, unknown>) {
    socket.write(JSON.stringify({ success: true, ...data }) + '\n');
  }

  getSetNames() {
    const JAMBONES_CLUSTER_ID = process.env.JAMBONES_CLUSTER_ID;
    return {
      activeFs: `${JAMBONES_CLUSTER_ID || 'default'}:active-fs`,
      drainedFs: `${JAMBONES_CLUSTER_ID || 'default'}:drained-fs`
    };
  }

  async isServerDrained(serverIP: string) {
    if (!this.checkRedisConnection('isMemberOfSet')) {
      return false;
    }

    try {
      const { drainedFs } = this.getSetNames();
      return await this.srfLocals!.isMemberOfSet(drainedFs, serverIP);
    } catch {
      return false;
    }
  }

  async getDrainedFeatureServers() {
    if (!this.checkRedisConnection('retrieveSet')) {
      return [];
    }

    try {
      const { drainedFs } = this.getSetNames();
      const servers = await this.srfLocals!.retrieveSet(drainedFs);
      return servers || [];
    } catch {
      return [];
    }
  }

  async getActiveFeatureServers() {
    if (!this.checkRedisConnection('retrieveSet')) {
      return [];
    }

    try {
      const { activeFs } = this.getSetNames();
      const servers = await this.srfLocals!.retrieveSet(activeFs);
      return servers || [];
    } catch {
      return [];
    }
  }

  async getAvailableFeatureServers() {
    try {
      const [active, drained] = await Promise.all([this.getActiveFeatureServers(), this.getDrainedFeatureServers()]);

      const drainedSet = new Set(drained);
      return active.filter((server) => !drainedSet.has(server));
    } catch {
      return [];
    }
  }

  async getAllFeatureServersWithStatus() {
    try {
      const [active, drained] = await Promise.all([this.getActiveFeatureServers(), this.getDrainedFeatureServers()]);

      const drainedSet = new Set(drained);
      const servers = active.map((server) => ({
        server,
        status: drainedSet.has(server) ? 'drained' : 'active'
      }));

      return { servers, drained };
    } catch {
      return { servers: [], drained: [] };
    }
  }

  async handleFeatureServerDrain(socket: net.Socket, server: string) {
    if (!this.checkRedisConnection('addToSet')) {
      this.sendError(socket, 'Redis connection not available');
      return;
    }

    const { isValidIP } = require('./feature-server-config') as typeof import('./feature-server-config');
    if (!isValidIP(server)) {
      this.sendError(socket, `Invalid IP address: ${server}`);
      return;
    }

    try {
      const { drainedFs } = this.getSetNames();
      await this.srfLocals!.addToSet(drainedFs, server);
      const drainedServers = await this.srfLocals!.retrieveSet(drainedFs);
      this.sendSuccess(socket, {
        action: 'drain',
        server,
        drained: drainedServers || []
      });
    } catch (err) {
      logger.error({ err }, 'Error draining server');
      this.sendError(socket, 'Failed to drain server');
    }
  }

  async handleFeatureServerUndrain(socket: net.Socket, server: string) {
    if (!this.checkRedisConnection('removeFromSet')) {
      this.sendError(socket, 'Redis connection not available');
      return;
    }

    const { isValidIP } = require('./feature-server-config') as typeof import('./feature-server-config');
    if (!isValidIP(server)) {
      this.sendError(socket, `Invalid IP address: ${server}`);
      return;
    }

    try {
      const { drainedFs } = this.getSetNames();
      await this.srfLocals!.removeFromSet(drainedFs, server);
      const drainedServers = await this.srfLocals!.retrieveSet(drainedFs);
      this.sendSuccess(socket, {
        action: 'undrain',
        server,
        drained: drainedServers || []
      });
    } catch (err) {
      logger.error({ err }, 'Error undraining server');
      this.sendError(socket, 'Failed to undrain server');
    }
  }

  async handleFeatureServerDrained(socket: net.Socket) {
    try {
      const drainedServers = await this.getDrainedFeatureServers();
      this.sendSuccess(socket, { drained: drainedServers });
    } catch (err) {
      logger.error({ err }, 'Error retrieving drained servers');
      this.sendError(socket, 'Failed to retrieve drained servers');
    }
  }

  async handleFeatureServerList(socket: net.Socket) {
    try {
      const result = await this.getAllFeatureServersWithStatus();
      this.sendSuccess(socket, result as unknown as Record<string, unknown>);
    } catch (err) {
      logger.error({ err }, 'Error listing servers');
      this.sendError(socket, 'Failed to list servers');
    }
  }

  async handleFeatureServerAvailable(socket: net.Socket) {
    try {
      const availableServers = await this.getAvailableFeatureServers();
      this.sendSuccess(socket, { available: availableServers });
    } catch (err) {
      logger.error({ err }, 'Error retrieving available servers');
      this.sendError(socket, 'Failed to retrieve available servers');
    }
  }

  startServer() {
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // socket file doesn't exist
    }

    this.server = net.createServer((socket) => {
      let buffer = '';

      socket.on('data', (data) => {
        buffer += data.toString();

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.trim()) {
            void this.handleCommand(socket, line.trim());
          }
        }
      });

      socket.on('error', (err) => {
        logger.error({ err }, 'Socket error');
      });
    });

    this.server.listen(this.socketPath, () => {
      logger.info({ socketPath: this.socketPath }, 'CLI server started');
      fs.chmodSync(this.socketPath, 0o600);
    });

    this.server.on('error', (err) => {
      logger.error({ err }, 'Server error');
    });
  }

  async handleCommand(socket: net.Socket, jsonString: string) {
    try {
      const cmd = JSON.parse(jsonString) as Record<string, unknown>;

      switch (cmd.action) {
        case 'set': {
          const setResult = await this.set(cmd.key as string, cmd.value);
          this.sendSuccess(socket, setResult as Record<string, unknown>);
          break;
        }

        case 'get': {
          const value = await this.get(cmd.key as string);
          this.sendSuccess(socket, { key: cmd.key, value });
          break;
        }

        case 'add': {
          const addResult = await this.addToArray(cmd.key as string, cmd.item as string);
          this.sendSuccess(socket, addResult as Record<string, unknown>);
          break;
        }

        case 'remove': {
          const removeResult = await this.removeFromArray(cmd.key as string, cmd.item as string);
          this.sendSuccess(socket, removeResult as Record<string, unknown>);
          break;
        }

        case 'list': {
          const allConfig = await this.getAll();
          this.sendSuccess(socket, { config: allConfig });
          break;
        }

        case 'fs-drain':
          await this.handleFeatureServerDrain(socket, cmd.server as string);
          break;

        case 'fs-undrain':
          await this.handleFeatureServerUndrain(socket, cmd.server as string);
          break;

        case 'fs-drained':
          await this.handleFeatureServerDrained(socket);
          break;

        case 'fs-list':
          await this.handleFeatureServerList(socket);
          break;

        case 'fs-available':
          await this.handleFeatureServerAvailable(socket);
          break;

        default:
          this.sendError(socket, 'Unknown action');
      }
    } catch (err) {
      logger.error({ err, command: jsonString }, 'Command error');
      this.sendError(socket, 'Invalid command');
    }
  }

  shutdown() {
    if (this.server) {
      this.server.close();
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        // ignore
      }
    }
  }
}

let runtimeConfig: RuntimeConfig | null = null;

function createInstance(srfLocals: SidecarSrfLocals | null = null, appLogger: Logger | null = null) {
  const instance = new RuntimeConfig(srfLocals, appLogger);
  process.on('SIGINT', () => instance.shutdown());
  process.on('SIGTERM', () => instance.shutdown());
  return instance;
}

export function initialize(srfLocals: SidecarSrfLocals, appLogger: Logger) {
  if (!appLogger) {
    throw new Error('Logger is required for RuntimeConfig initialization');
  }
  if (!runtimeConfig) {
    runtimeConfig = createInstance(srfLocals, appLogger);
  } else {
    runtimeConfig.srfLocals = srfLocals;
    logger = appLogger;
  }

  return runtimeConfig;
}

export function getInstance() {
  if (!runtimeConfig) {
    throw new Error('RuntimeConfig not initialized. Call initialize() first with logger.');
  }
  return runtimeConfig;
}
