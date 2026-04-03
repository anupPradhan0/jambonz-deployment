import { spawn } from 'node:child_process';
import debugFactory = require('debug');
const debug = debugFactory('jambonz:ci');

let network: string;
const obj: {
  output: () => string;
  sippUac: (file: string, opts?: SippOpts) => Promise<void>;
} = {} as {
  output: () => string;
  sippUac: (file: string, opts?: SippOpts) => Promise<void>;
};

let output = '';
let idx = 1;

interface SippOpts {
  ip?: string;
  remote_host?: string[];
  data_file?: string;
}

function clearOutput(): void {
  output = '';
}

function addOutput(str: string): void {
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) < 128) output += str.charAt(i);
  }
}

export = (networkName: string) => {
  network = networkName;
  return obj;
};

obj.output = () => output;

obj.sippUac = (file, opts = {}) => {
  const cmd = 'docker';
  const args = [
    'run',
    '--rm',
    '--net',
    `${network}`,
    ...(opts.ip ? ['--ip', opts.ip] : []),
    '-v',
    `${__dirname}/scenarios:/tmp/scenarios`,
    'drachtio/sipp',
    'sipp',
    ...(opts.remote_host ?? []),
    ...(opts.data_file ? ['-inf', `/tmp/scenarios/${opts.data_file}`] : []),
    '-sf',
    `/tmp/scenarios/${file}`,
    '-m',
    '1',
    '-sleep',
    '100ms',
    '-nostdin',
    '-cid_str',
    `%u-%p@%s-${String(idx++)}`,
    'sbc'
  ];

  debug(`args: ${args.join(' ')}`);
  clearOutput();

  return new Promise<void>((resolve, reject) => {
    const child_process = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'pipe'] });

    child_process.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      console.log(`sipp exited with non-zero code ${String(code)} signal ${String(signal)}`);
      reject(code);
    });
    child_process.on('error', () => {
      console.log(`error spawing child process for docker: ${args.join(' ')}`);
    });

    child_process.stdout?.on('data', (data: Buffer) => {
      debug(`stdout: ${data.toString()}`);
      addOutput(data.toString());
    });
    child_process.stderr?.on('data', (data: Buffer) => {
      debug(`stderr: ${data.toString()}`);
      addOutput(data.toString());
    });
  });
};
