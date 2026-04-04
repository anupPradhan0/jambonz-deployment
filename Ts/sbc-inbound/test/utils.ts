import test = require('tape');
import { parseHostPorts } from '../lib/utils';

const { parseUri } = require('drachtio-srf') as {
  parseUri: (u: string) => Record<string, unknown> | undefined;
};

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

const hostports = 'tls/3.70.141.74:5061,wss/3.70.141.74:8443,tcp/3.70.141.74:5060,udp/3.70.141.74:5060';
const hostportsNoTls = 'wss/3.70.141.74:8443,tcp/3.70.141.74:5060,udp/3.70.141.74:5060';
const logger = { info: (args: unknown) => console.log(args) };

const srf = {
  locals: {
    sipAddress: '127.0.0.1'
  }
};

test('utils tests - parseHostPorts', async (t) => {
  try {
    let obj = parseHostPorts(logger as never, hostports, srf as never);

    const expected = {
      tls: '3.70.141.74:5061',
      wss: '3.70.141.74:8443',
      tcp: '3.70.141.74:5060',
      udp: '3.70.141.74:5060'
    };

    t.ok(obj.tls === expected.tls, 'sip endpoint tls');
    t.ok(obj.wss === expected.wss, 'sip endpoint wss');
    t.ok(obj.tcp === expected.tcp, 'sip endpoint tcp');
    t.ok(obj.udp === expected.udp, 'sip endpoint udp');

    obj = parseHostPorts(logger as never, hostportsNoTls.split(','), srf as never);

    t.ok(obj.tls === '127.0.0.1:5061', 'sip endpoint tls');

    t.end();
  } catch (err) {
    console.log(`error received: ${err}`);
    t.error(err);
  }
});


test('utils tests - parse URI user', async (t) => {
  try {
    let invalidUri = 'sip:@202660.tenios.com';
    const req = {
      getParsedHeader: (_name?: string) => ({ uri: invalidUri })
    };

    const referTo = req.getParsedHeader('Refer-To') as { uri: string };
    let uri = parseUri(referTo.uri) as Record<string, unknown>;

    const expected = {
      family: 'ipv4',
      scheme: 'sip',
      user: '',
      password: undefined,
      host: '202660.tenios.com',
      port: NaN,
      params: {},
      headers: {},
    };

    t.ok(uri.family === expected.family, 'family eq ipv4');
    t.ok(uri.scheme === expected.scheme, 'scheme eq sip');
    t.ok(uri.password === expected.password, 'pw eq undefined');
    t.ok(uri.host === expected.host, 'host eq 202660.tenios.com');
    t.ok(uri.user === '', 'user eq empty string');
    t.ok(isNaN(uri.port as number), 'port eq NaN');
    t.ok(typeof uri.params === 'object', 'params eq object');
    t.ok(typeof uri.headers === 'object', 'headers eq object');

    invalidUri = '<sip:@202660.tenios.com>';
    uri = parseUri(invalidUri) as Record<string, unknown>;
    t.ok(uri === undefined, 'uri is undefined');

    t.end();
  } catch (err) {
    console.log(`error received: ${err}`);
    t.error(err);
  }
});
