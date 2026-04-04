import assert from 'node:assert';
import type { Logger } from 'pino';
import type { SrfInstance } from '../types/jambonz-sip';

const setName = `${(process.env.JAMBONES_CLUSTER_ID || 'default')}:active-fs`;

assert.ok(!process.env.K8S || process.env.K8S_FEATURE_SERVER_SERVICE_NAME,
  'when running in Kubernetes, an env var K8S_FEATURE_SERVER_SERVICE_NAME is required');

export default function fsTrackingFactory(srf: SrfInstance, logger: Logger) {
  const {retrieveSet, createSet} = srf.locals.realtimeDbHelpers as {
    retrieveSet: (name: string) => Promise<Set<string>>;
    createSet: (name: string, members: string[]) => Promise<unknown>;
  };
  let idx = 0;

  if ('test' === process.env.NODE_ENV) {
    createSet(setName, [process.env.JAMBONES_FEATURE_SERVERS as string]);
  }

  return async() => {
    try {
      if (process.env.K8S) {
        return process.env.K8S_FEATURE_SERVER_TRANSPORT ?
          `${process.env.K8S_FEATURE_SERVER_SERVICE_NAME};transport=${process.env.K8S_FEATURE_SERVER_TRANSPORT}` :
          process.env.K8S_FEATURE_SERVER_SERVICE_NAME;
      }
      const fs = await retrieveSet(setName);
      const list = Array.isArray(fs) ? fs : Array.from(fs as Set<string>);
      if (0 === list.length) {
        logger.info('No available feature servers to handle incoming call');
        return;
      }
      logger.debug({fs: list}, `retrieved ${setName}`);
      return list[idx++ % list.length];
    } catch (err) {
      logger.error({err}, `Error retrieving ${setName}`);
    }
  };
}
