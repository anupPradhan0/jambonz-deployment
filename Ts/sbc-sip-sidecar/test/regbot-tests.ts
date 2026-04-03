import test from 'tape';
import clearModule from 'clear-module';
import { exec } from 'node:child_process';
import path from 'node:path';
import type { SidecarSrf } from '../types/jambonz-locals';

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

const wait = (duration: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, duration);
  });
};

test('populating more test case data', (t) => {
  exec(
    `mysql -h 127.0.0.1 -u root --protocol=tcp -D jambones_test < ${path.join(__dirname, 'db', 'populate-test-data2.sql')}`,
    (err) => {
      if (err) return t.end(err);
      t.pass('test data set created');
      t.end();
    }
  );
});

test('trunk register tests', (t) => {
  clearModule.all();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { srf } = require('../app') as { srf: SidecarSrf };
  t.timeoutAfter(180000);

  console.log('waiting 15 seconds for regbot to start up');
  connect(srf)
    .then(wait.bind(null, 15000))
    .then(() => {
      const obj = srf.locals.regbotStatus!();
      return t.ok(obj.total === 1 && obj.registered === 1, 'initial regbot running and successfully registered to trunk');
    })
    .then(() => {
      return new Promise<void>((resolve, reject) => {
        exec(
          `mysql -h 127.0.0.1 -u root --protocol=tcp   -D jambones_test < ${path.join(__dirname, 'db', 'populate-test-data3.sql')}`,
          (err) => {
            if (err) return reject(err);
            t.pass('added new gateway');
            resolve();
          }
        );
      });
    })
    .then(() => {
      console.log('waiting 65 seconds for regbot to come around to check for new gateways');
      return wait(65000);
    })
    .then(() => {
      const obj = srf.locals.regbotStatus!();
      console.log(`regbotStatus: total=${obj.total}, registered=${obj.registered}, active=${obj.active}`);
      return t.ok(obj.total === 2 && obj.registered === 1, 'successfully added gateway that tests failure result');
    })
    .then(() => {
      return new Promise<void>((resolve, reject) => {
        exec(
          `mysql -h 127.0.0.1 -u root --protocol=tcp   -D jambones_test < ${path.join(__dirname, 'db', 'populate-test-data4.sql')}`,
          (err) => {
            if (err) return reject(err);
            t.pass('added new reg trunk');
            resolve();
          }
        );
      });
    })
    .then(() => {
      console.log('waiting 65 seconds for regbot to come around to check for new reg trunk');
      return wait(65000);
    })
    .then(() => {
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
