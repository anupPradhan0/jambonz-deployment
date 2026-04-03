import { spawn } from 'node:child_process';
import debug from 'debug';

const dbg = debug('jambonz:ci');
let output = '';
let idx = 1;

function clearOutput() {
  output = '';
}

function addOutput(str: string) {
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) < 128) output += str.charAt(i);
  }
}

export type SippReg = { remote_host: string; data_file: string };

export default function sippModule(network: string) {
  const sippUac = (
    file: string,
    regObj: SippReg | null,
    bindAddress?: string,
    injectionFile?: string
  ) => {
    const cmd = 'docker';
    let args: string[];
    if (regObj) {
      args = [
        'run',
        '--rm',
        '--net',
        network,
        '-v',
        `${__dirname}/scenarios:/tmp/scenarios`,
        'drachtio/sipp',
        'sipp',
        regObj.remote_host,
        '-inf',
        `/tmp/scenarios/${regObj.data_file}`,
        '-sf',
        `/tmp/scenarios/${file}`,
        '-m',
        '1',
        '-sleep',
        '250ms',
        '-nostdin',
        '-cid_str',
        `%u-%p@%s-${idx++}`,
        'sbc',
        '-trace_msg'
      ];
    } else if (injectionFile) {
      args = [
        'run',
        '-t',
        '--rm',
        '--net',
        network,
        '-v',
        `${__dirname}/scenarios:/tmp/scenarios`,
        'drachtio/sipp',
        'sipp',
        '-sf',
        `/tmp/scenarios/${file}`,
        '-inf',
        `/tmp/scenarios/${injectionFile}`,
        '-m',
        '1',
        '-sleep',
        '250ms',
        '-nostdin',
        '-cid_str',
        `%u-%p@%s-${idx++}`,
        '172.39.0.10'
      ];
    } else {
      args = [
        'run',
        '-t',
        '--rm',
        '--net',
        network,
        '-v',
        `${__dirname}/scenarios:/tmp/scenarios`,
        'drachtio/sipp',
        'sipp',
        '-sf',
        `/tmp/scenarios/${file}`,
        '-m',
        '1',
        '-sleep',
        '250ms',
        '-nostdin',
        '-cid_str',
        `%u-%p@%s-${idx++}`,
        '172.39.0.10'
      ];
    }

    if (bindAddress) args.splice(5, 0, '--ip', bindAddress);

    clearOutput();

    return new Promise<void>((resolve, reject) => {
      const child_process = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'pipe'] });

      child_process.on('exit', (code, signal) => {
        if (code === 0) {
          return resolve();
        }
        console.log(`sipp exited with non-zero code ${code} signal ${signal}`);
        reject(code);
      });
      child_process.on('error', () => {
        console.log(`error spawing child process for docker: ${args}`);
      });

      child_process.stdout?.on('data', (data) => {
        dbg(`stdout: ${data}`);
        addOutput(data.toString());
      });
      child_process.stderr?.on('data', (data) => {
        dbg(`stderr: ${data}`);
        addOutput(data.toString());
      });
    });
  };

  return {
    output: () => output,
    sippUac
  };
}
