import type { IncomingMessage } from 'node:http';

import type { SandboxCommand } from '../protocol/api.js';

import {
  optionalBoolean,
  optionalString,
  parseObject,
  requiredString,
  stringRecord,
} from './http-body.js';
import { HttpError } from './http-error.js';

/** The longest command line accepted before its standard input. */
const MAX_COMMAND_BYTES = 1 << 20;

/** The first line of an `exec` request, and the standard input that came with it. */
export interface CommandLine {
  command: SandboxCommand;
  /** The line as it came, without its newline. */
  line: Buffer;
  /** What followed it in the chunks read so far: the start of the standard input. */
  rest: Buffer;
}

/**
 * Reads an `exec` request up to its first newline: the command, a line of JSON. What follows is
 * its standard input, left in the request, paused, past `rest`.
 */
export function readCommandLine(request: IncomingMessage): Promise<CommandLine> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) {
        if (buffered.length > MAX_COMMAND_BYTES) {
          request.off('data', onData);
          reject(new HttpError(413, 'The command is too large.'));
        }
        return;
      }
      request.off('data', onData);
      request.pause();
      try {
        const line = buffered.subarray(0, newline);
        const body = parseObject(line.toString());
        resolve({
          command: {
            command: requiredString(body, 'command'),
            workingDirectory: optionalString(body, 'workingDirectory'),
            env: stringRecord(body, 'env'),
            stdin: optionalBoolean(body, 'stdin'),
          },
          line,
          rest: buffered.subarray(newline + 1),
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    request.on('data', onData);
    request.once('end', () => {
      request.off('data', onData);
      reject(new HttpError(400, 'The request holds no command line.'));
    });
  });
}
