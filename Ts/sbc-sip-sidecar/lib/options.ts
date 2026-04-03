import debug = require('debug');
import type { Logger } from 'pino';
import { isDrained } from './cli/feature-server-config';
import {
  EXPIRES_INTERVAL,
  CHECK_EXPIRES_INTERVAL,
  JAMBONES_CLUSTER_ID
} from './config';
import type { SidecarSrf } from '../types/jambonz-locals';
import type Srf from 'drachtio-srf';

const dbg = debug('jambonz:sbc-options-handler');

const fsServers = new Map<string, number>();
const fsServiceUrls = new Map<string, number>();
const rtpServers = new Map<string, number>();

export default ({ srf, logger }: { srf: SidecarSrf; logger: Logger }) => {
  const { stats, addToSet, removeFromSet, isMemberOfSet, retrieveSet } = srf.locals;

  const setNameFs = `${JAMBONES_CLUSTER_ID || 'default'}:active-fs`;
  const setNameRtp = `${JAMBONES_CLUSTER_ID || 'default'}:active-rtp`;
  const setNameFsSeriveUrl = `${JAMBONES_CLUSTER_ID || 'default'}:fs-service-url`;

  setInterval(async() => {
    const now = Date.now();
    const expires = Number(EXPIRES_INTERVAL) || 60000;
    for (const [key, value] of fsServers) {
      const duration = now - value;
      if (duration > expires) {
        fsServers.delete(key);
        await removeFromSet(setNameFs, key);
        const members = await retrieveSet(setNameFs);
        const countOfMembers = members.length;
        logger.info({ members }, `expired member ${key} from ${setNameFs} we now have ${countOfMembers}`);
      }
    }
    for (const [key, value] of fsServiceUrls) {
      const duration = now - value;
      if (duration > expires) {
        fsServiceUrls.delete(key);
        await removeFromSet(setNameFsSeriveUrl, key);
        const members = await retrieveSet(setNameFsSeriveUrl);
        const countOfMembers = members.length;
        logger.info({ members }, `expired member ${key} from ${setNameFsSeriveUrl} we now have ${countOfMembers}`);
      }
    }
    for (const [key, value] of rtpServers) {
      const duration = now - value;
      if (duration > expires) {
        rtpServers.delete(key);
        await removeFromSet(setNameRtp, key);
        const members = await retrieveSet(setNameRtp);
        const countOfMembers = members.length;
        logger.info({ members }, `expired member ${key} from ${setNameRtp} we now have ${countOfMembers}`);
      }
    }
  }, Number(CHECK_EXPIRES_INTERVAL) || 20000);

  const _init = async() => {
    try {
      const now = Date.now();
      const runningFs = await retrieveSet(setNameFs);
      const runningRtp = await retrieveSet(setNameRtp);
      const runningFsServiceUrls = await retrieveSet(setNameFsSeriveUrl);

      if (runningFs.length) {
        logger.info({ runningFs }, 'start watching these FS servers');
        for (const ip of runningFs) fsServers.set(ip, now);
      }

      if (runningFsServiceUrls.length) {
        logger.info({ runningFsServiceUrls }, 'start watching these FS Service Urls');
        for (const url of runningFsServiceUrls) fsServiceUrls.set(url, now);
      }

      if (runningRtp.length) {
        logger.info({ runningRtp }, 'start watching these RTP servers');
        for (const ip of runningRtp) rtpServers.set(ip, now);
      }
    } catch (err) {
      logger.error({ err }, 'error initializing from redis');
    }
  };
  void _init();

  const _addToCache = async(
    map: Map<string, number>,
    status: string,
    setName: string,
    key: string
  ) => {
    let countOfMembers: number | undefined;
    if (status === 'open') {
      map.set(key, Date.now());
      const exists = await isMemberOfSet(setName, key);
      if (!exists) {
        await addToSet(setName, key);
        const members = await retrieveSet(setName);
        countOfMembers = members.length;
        logger.info({ members }, `added new member ${key} to ${setName} we now have ${countOfMembers}`);
        dbg({ members }, `added new member ${key} to ${setName}`);
      } else {
        const members = await retrieveSet(setName);
        countOfMembers = members.length;
        dbg(`checkin from existing member ${key} to ${setName}`);
      }
    } else {
      map.delete(key);
      await removeFromSet(setName, key);
      const members = await retrieveSet(setName);
      countOfMembers = members.length;
      logger.info({ members }, `removed member ${key} from ${setName} we now have ${countOfMembers}`);
      dbg({ members }, `removed member ${key} from ${setName}`);
    }
    return countOfMembers;
  };

  return async(req: Srf.SrfRequest, res: Srf.SrfResponse) => {
    const internal = req.has('X-FS-Status') || req.has('X-RTP-Status');
    if (!internal) {
      dbg('got external OPTIONS ping');
      res.send(200);
      (req.srf as SidecarSrf).endSession(req);
      return;
    }

    try {
      let map: Map<string, number> | undefined;
      let status: string | undefined;
      let countOfMembers: number | undefined;
      const h = ['X-FS-Status', 'X-RTP-Status'].find((hdr) => req.has(hdr));
      if (h) {
        const isRtpServer = req.has('X-RTP-Status');
        const key = isRtpServer ? req.source_address : `${req.source_address}:${req.source_port}`;
        const prefix = isRtpServer ? 'X-RTP' : 'X-FS';
        map = isRtpServer ? rtpServers : fsServers;
        const setName = isRtpServer ? setNameRtp : setNameFs;
        const gaugeName = isRtpServer ? 'rtpservers' : 'featureservers';
        const fsServiceUrlKey = req.has('X-FS-ServiceUrl') ? req.get('X-FS-ServiceUrl') : null;

        status = req.get(`${prefix}-Status`) as string;

        if (status === 'open' && !isRtpServer) {
          const fsIP = req.source_address;
          if (await isDrained(fsIP)) {
            logger.warn({ fsIP }, 'drained feature server attempted to check in - rejecting');
            status = 'closed';
          }
        }

        countOfMembers = await _addToCache(map, status, setName, key);
        if (fsServiceUrlKey) {
          await _addToCache(fsServiceUrls, status, setNameFsSeriveUrl, fsServiceUrlKey);
        }
        stats.gauge(gaugeName, map.size);
      }
      res.send(200, {
        headers: {
          'X-Members': countOfMembers as number
        }
      });
    } catch (err) {
      res.send(503);
      dbg(err);
      logger.error({ err }, 'Error handling OPTIONS');
    }
    (req.srf as SidecarSrf).endSession(req);
  };
};
