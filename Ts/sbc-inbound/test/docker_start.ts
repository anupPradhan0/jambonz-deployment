import test = require('tape');
import { exec } from 'node:child_process';

test('starting docker network..', (t) => {
  exec(`docker-compose -f ${__dirname}/docker-compose-testbed.yaml up -d`, (err) => {
    t.pass('docker started');
    t.end(err ?? undefined);
  });
});
