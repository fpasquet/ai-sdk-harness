import type { IncomingMessage, ServerResponse } from 'node:http';

import type { SandboxCommand } from '../../protocol/api.js';
import type { Sandbox } from '../sandboxes/sandbox.js';

import { encodeData, encodeFrame, FrameType, STDERR, STDOUT } from '../../protocol/frames.js';
import { HttpError } from './http-error.js';
import { optionalString, parseObject, requiredString, stringRecord } from './request-body.js';

/** The longest command line accepted before its standard input. */
const MAX_COMMAND_BYTES = 1 << 20;

/**
 * `POST /v1/sandboxes/:name/exec`. The body is a line of JSON, `{ command, workingDirectory?, env? }`,
 * then the command's standard input. The answer streams frames, its stdout and stderr then its exit
 * code, the process named in `X-Process-Id`. The process outlives the request: Cloud Run cuts any
 * request after its timeout, and the caller then waits for its exit by id.
 */
export async function execStream(
  sandbox: Sandbox,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const { command, rest } = await readCommand(request);
  const { id, child } = sandbox.exec(command);
  response.writeHead(200, { 'content-type': 'application/octet-stream', 'x-process-id': id });
  // At once: the caller waits for the process's id, and a quiet command writes nothing for long.
  // Cloud Run's front end holds the headers back until the body starts: a first frame, the id
  // again, starts it.
  response.flushHeaders();
  response.write(encodeFrame(FrameType.Open, 0, Buffer.from(id)));
  child.stdin.write(rest);
  request.pipe(child.stdin);
  // Once the caller is gone, the output is drained still: the process must not block on it.
  const send = (frame: Buffer): void => {
    if (!response.destroyed) response.write(frame);
  };
  child.stdout.on('data', (chunk: Buffer) => encodeData(STDOUT, chunk).forEach(send));
  child.stderr.on('data', (chunk: Buffer) => encodeData(STDERR, chunk).forEach(send));
  const exitCode = await child.exited;
  if (!response.destroyed) {
    response.end(encodeFrame(FrameType.Exit, 0, Buffer.from(String(exitCode))));
  }
}

/** Reads the request up to its first newline: the command. What follows is its standard input. */
function readCommand(request: IncomingMessage): Promise<{ command: SandboxCommand; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) {
        if (buffered.length > MAX_COMMAND_BYTES)
          fail(new HttpError(413, 'The command is too large.'));
        return;
      }
      request.off('data', onData);
      request.pause();
      try {
        resolve({
          command: toCommand(buffered.subarray(0, newline)),
          rest: buffered.subarray(newline + 1),
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const fail = (error: Error): void => {
      request.off('data', onData);
      reject(error);
    };
    request.on('data', onData);
    request.once('end', () => fail(new HttpError(400, 'The request holds no command line.')));
  });
}

function toCommand(line: Buffer): SandboxCommand {
  const body = parseObject(line.toString());
  return {
    command: requiredString(body, 'command'),
    workingDirectory: optionalString(body, 'workingDirectory'),
    env: stringRecord(body, 'env'),
  };
}
