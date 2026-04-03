import test from 'tape';
import { exec } from 'node:child_process';
import path from 'node:path';

test('starting docker network..', (t) => {
  exec(`docker-compose -f ${path.join(__dirname, 'docker-compose-testbed.yaml')} up -d`, (err) => {
    t.pass('docker started');
    t.end(err ?? undefined);
  });
});
