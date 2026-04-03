import test from 'tape';
import clearModule from 'clear-module';
import sippModule from './sipp';
import type { SidecarSrf } from '../types/jambonz-locals';

const { sippUac } = sippModule('test_sbc-sip-sidecar');

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

function connect(connectable: SidecarSrf) {
  return new Promise<void>((resolve) => {
    connectable.on('connect', () => {
      return resolve();
    });
  });
}

test('register tests', (t) => {
  clearModule.all();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { srf } = require('../app') as { srf: SidecarSrf };

  const sippRegObj: { remote_host: string; data_file: string } = {
    remote_host: '172.38.0.10:5060',
    data_file: ''
  };

  connect(srf)
    .then(() => {
      sippRegObj.data_file = 'deactivated_account_user.csv';
      return sippUac('uac-register-unknown-realm.xml', sippRegObj);
    })
    .then(() => {
      sippRegObj.data_file = 'bad_realm.csv';
      return sippUac('uac-reject-ipv4-realm.xml', sippRegObj);
    })
    .then(() => {
      t.pass('received immediate 403 Forbidden when using ipv4 dot decimal for sip realm');
      sippRegObj.data_file = 'bad_password.csv';
      return sippUac('uac-register-auth-failure-expect-403.xml', sippRegObj);
    })
    .then(() => {
      t.pass('received 403 Forbidden after challenge when using invalid credentials');
      sippRegObj.data_file = 'good_user.csv';
      return sippUac('uac-register-auth-success.xml', sippRegObj);
    })
    .then(() => {
      t.pass('successfully registered when using valid credentials (service provider level auth hook)');
      return sippUac('uac-re-register-auth-success.xml', sippRegObj);
    })
    .then(() => {
      t.pass('successfully re-registered against cached registration');
      sippRegObj.data_file = 'good_user2.csv';
      return sippUac('uac-register-auth-success-jane.xml', sippRegObj);
    })
    .then(() => {
      t.pass('successfully registered against short expiry');
      return sippUac('uac-register-auth-success-jane.xml', sippRegObj);
    })
    .then(() => {
      t.pass('successfully registered for jane');
      return sippUac('uac-register-gh-83.xml', sippRegObj);
    })
    .then(() => {
      t.pass('unsuccessfully registered for invalid From and To headers');
      if (srf.locals.lb) srf.locals.lb.disconnect();
      srf.disconnect();
      t.end();
      return;
    })
    .catch((err) => {
      if (srf.locals.lb) srf.locals.lb.disconnect();
      if (srf) srf.disconnect();
      console.log(`error received: ${err}`);
      t.error(err);
    });
});
