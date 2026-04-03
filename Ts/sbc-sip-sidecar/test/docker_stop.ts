import test from 'tape';
import { exec } from 'node:child_process';
import path from 'node:path';

test('stopping docker network..', (t) => {
  t.timeoutAfter(10000);
  exec(`docker-compose -f ${path.join(__dirname, 'docker-compose-testbed.yaml')} down`, () => {
    process.exit(0);
  });
  t.end();
});
