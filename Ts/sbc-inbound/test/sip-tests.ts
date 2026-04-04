import test = require('tape');
import bent = require('bent');
import sippFactory from './sipp';

const { sippUac } = sippFactory('test_sbc-inbound');
const getJSON = bent('json') as (url: string) => Promise<{ calls?: number }>;

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

function connect(connectable: { on: (ev: string, fn: () => void) => void }) {
  return new Promise<void>((resolve) => {
    connectable.on('connect', () => {
      resolve();
    });
  });
}

function waitFor(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms * 1000);
  });
}

test('incoming call tests', async(t) => {
  const {srf} = require('../app') as {
    srf: {
      locals: {
        queryCdrs: (o: { account_sid: string }) => Promise<{ total: number }>;
        realtimeDbHelpers: { createEphemeralGateway: (a: string, b: string, c: number) => Promise<unknown> };
      };
      on: (ev: string, fn: () => void) => void;
      disconnect: () => void;
    };
  };
  const { queryCdrs } = srf.locals;

  try {
    await connect(srf);

    let obj = await getJSON('http://127.0.0.1:3050/');
    t.ok(obj.calls === 0, 'HTTP GET / works (current call count)');
    obj = await getJSON('http://127.0.0.1:3050/system-health');
    t.ok(obj.calls === 0, 'HTTP GET /system-health works (health check)');

    await sippUac('uac-late-media.xml', '172.38.0.20');
    t.pass('incoming call with no SDP packet is rejected with a 488');

    await sippUac('uac-did-applicationsid-loop.xml', '172.38.0.20');
    t.pass('incoming call with x-application-sid header is rejected with 482');

    await sippUac('uac-pcap-carrier-success.xml', '172.38.0.20');
    t.pass('incoming call from carrier completed successfully');

    const { createEphemeralGateway } = srf.locals.realtimeDbHelpers as {
      createEphemeralGateway: (a: string, b: string, c: number) => Promise<unknown>;
    };
    await createEphemeralGateway('172.38.0.60', '4a7d1c8e-5f2b-4d9a-8e3c-6b5a9f1e4c7d', 3600);
    await sippUac('uac-pcap-ephemeral-gateway-success.xml', '172.38.0.60');
    t.pass('incoming call from ephemeral gateway (registration trunk) completed successfully');

    await sippUac('uac-pcap-pbx-success.xml', '172.38.0.21');
    t.pass('incoming call from account-level carrier completed successfully');

    await sippUac('uac-did-regex-match.xml', '172.38.0.20');
    t.pass('incoming call matched by trailing wildcard *');

    await sippUac('uac-pcap-device-success.xml', '172.38.0.30');
    t.pass('incoming call from authenticated device completed successfully');

    await sippUac('uac-device-unknown-user.xml', '172.38.0.30');
    t.pass('unknown user is rejected with a 403');

    await sippUac('uac-device-unknown-realm.xml', '172.38.0.30');
    t.pass('unknown realm is rejected with a 404');

    await sippUac('uac-device-invalid-password.xml', '172.38.0.30');
    t.pass('invalid password for valid user is rejected with a 403');

    await sippUac('uac-pcap-device-success-in-dialog-request.xml', '172.38.0.30');
    t.pass('handles in-dialog requests');

    await sippUac('uac-pcap-carrier-max-call-limit.xml', '172.38.0.20');
    t.pass('rejects incoming call with 503 when max calls per account reached');

    await sippUac('uac-did-regex-match-vc-all-accts.xml', '172.38.0.50');
    t.pass('incoming call matched by trailing wildcard *, voice gateway belongs to all accounts, with sip realm');

    await sippUac('uac-did-regex-match-vc-all-accts-nosiprealm.xml', '172.38.0.51');
    t.pass('incoming call matched by trailing wildcard *, voice gateway belongs to all accounts, without sip realm');

    await sippUac('uac-did-regex-match-vc-all-accts-nosiprealm.xml', '172.38.0.50');
    t.pass('incoming call matched by trailing wildcard *, voice gateway belongs to all accounts, without sip realm');

    delete process.env.JAMBONES_HOSTING;
    await sippUac('uac-pcap-carrier-fail-ambiguous.xml', '172.38.0.40');
    t.pass('rejects incoming call with 503 when multiple accounts have same carrier witrh default routing');

    await waitFor(12);
    const res = await queryCdrs({account_sid: 'ed649e33-e771-403a-8c99-1780eabbc803'});
    console.log(`cdrs res.total: ${res.total}`);
    t.ok(8 === res.total, 'successfully wrote 8 cdrs for calls (including ephemeral gateway)');

    srf.disconnect();
    t.end();
  } catch (err) {
    console.log(`error received: ${err}`);
    srf.disconnect();
    t.error(err);
  }
});
