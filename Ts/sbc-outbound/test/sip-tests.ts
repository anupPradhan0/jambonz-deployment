import test = require('tape');
import sippFactory = require('./sipp');
import { execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import debugFactory = require('debug');
import bent = require('bent');
import appModule = require('../app');

const { sippUac } = sippFactory('test_sbc-outbound');
const debug = debugFactory('jambonz:sbc-outbound');
const getJSON = bent('json') as (url: string) => Promise<{ calls?: number }>;

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms * 1000);
  });
}

function connect(connectable: EventEmitter): Promise<void> {
  return new Promise((resolve) => {
    connectable.on('connect', () => {
      resolve();
    });
  });
}

test('sbc-outbound tests', async (t) => {
  const { srf } = appModule;
  const { queryCdrs } = srf.locals as { queryCdrs: (o: { account_sid: string }) => Promise<{ total: number }> };
  const redisClient = srf.locals.realtimeDbHelpers.client as {
    setex(key: string, seconds: number, value: string): Promise<unknown>;
    del(key: string): Promise<unknown>;
  };

  try {
    await connect(srf);

    let obj = await getJSON('http://127.0.0.1:3050/');
    t.ok(obj.calls === 0, 'HTTP GET / works (current call count)');
    obj = await getJSON('http://127.0.0.1:3050/system-health');
    t.ok(obj.calls === 0, 'HTTP GET /system-health works (health check)');

    /* call to unregistered user */
    debug('successfully connected to drachtio server');
    await sippUac('uac-pcap-device-404.xml');
    t.pass('return 404 to outbound attempt to unregistered user/device');

    /* call to PSTN with no lcr configured */
    await sippUac('uac-pcap-carrier-success.xml');
    t.pass('successfully completed outbound call to sip trunk');

    /* call to Sip URI with no lcr configured */
    await sippUac('uac-pcap-sip-routing-success.xml');
    t.pass('successfully completed outbound call to sip routing trunk');

    /* call to PSTN with no lcr configured */
    await sippUac('uac-pcap-inbound-carrier-success.xml');
    t.pass('successfully completed outbound call to sip trunk');

    /* call to PSTN with request uri we see in kubernetes */
    await sippUac('uac-pcap-carrier-success-k8s.xml');
    t.pass('successfully completed outbound call to sip trunk (k8S req uri)');

    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/jambones-sql.sql`);
    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/populate-test-data2.sql`);

    await sippUac('uac-pcap-carrier-success.xml');
    t.pass('successfully completed outbound call using LCR');

    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/jambones-sql.sql`);
    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/populate-test-data3.sql`);

    await sippUac('uac-cancel.xml');
    t.pass('successfully handled caller hangup during lcr outdial');

    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/jambones-sql.sql`);
    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/populate-test-data4.sql`);

    await sippUac('uac-pcap-carrier-success-reinvite.xml');
    t.pass('successfully handled reinvite during lcr outdial');

    await sippUac('uac-sip-uri-auth-success.xml');
    t.pass('successfully connected to sip uri that requires auth');

    await sippUac('uac-sip-uri-proxy.xml');
    t.pass('successfully connected to sip uri through proxy');

    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/jambones-sql.sql`);
    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/populate-test-data5.sql`);

    await sippUac('uac-pcap-carrier-fail-limits.xml');
    t.pass('fails when max calls in progress');

    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/jambones-sql.sql`);
    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/populate-test-data.sql`);

    await redisClient.setex('blacklist-sip-gateway:124a5339-c62c-4075-9e19-f4de70a96597', 3, '');
    await sippUac('uac-pcap-carrier-fail-blacklist.xml');
    t.pass('fails when carrier is blacklisted');
    await redisClient.del('blacklist-sip-gateway:124a5339-c62c-4075-9e19-f4de70a96597');

    await waitFor(25);

    const res = await queryCdrs({ account_sid: 'ed649e33-e771-403a-8c99-1780eabbc803' });
    console.log(`${res.total} cdrs: ${JSON.stringify(res)}`);
    t.ok(res.total === 9, 'wrote 9 cdrs');

    srf.disconnect();
  } catch (err: unknown) {
    console.error(err);
    srf.disconnect();
    t.error(err);
  }
});
