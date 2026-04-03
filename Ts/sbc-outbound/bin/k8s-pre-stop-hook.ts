#!/usr/bin/env node
import bent = require('bent');
const getJSON = bent('json') as (url: string) => Promise<{ calls?: number }>;
const PORT = process.env.HTTP_PORT || 3000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

void (async function main(): Promise<void> {
  try {
    for (;;) {
      const obj = await getJSON(`http://127.0.0.1:${PORT}/`);
      const { calls } = obj;
      if (calls === 0) {
        console.log('no calls on the system, we can exit');
        process.exit(0);
      } else {
        console.log(`waiting for ${String(calls)} to exit..`);
      }
      await sleep(10000);
    }
  } catch (err: unknown) {
    console.error(err, 'Error querying health endpoint');
    process.exit(-1);
  }
})();
