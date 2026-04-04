import test = require('tape');
import { exec } from 'node:child_process';

test('stopping docker network..', (t) => {
  t.timeoutAfter(10000);
  exec(`docker-compose -f ${__dirname}/docker-compose-testbed.yaml down`, () => {
    process.exit(0);
  });
  t.end();
});
