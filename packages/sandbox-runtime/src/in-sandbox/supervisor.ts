import type { ChildProcess } from 'node:child_process';

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { constants } from 'node:os';
import { dirname } from 'node:path';

import type { Outcome, Request, SupervisorSettings } from '../protocol/messages.js';

import {
  encodeData,
  encodeFrame,
  encodeJson,
  FrameDecoder,
  FrameType,
} from '../protocol/frames.js';

/**
 * Runs inside a sandbox, as the one process srt wraps: every command, file and connection of the
 * sandbox goes through it, so they all share its filesystem view and its network namespace — the
 * loopback where a harness bridge listens, reached through {@link connectTo}. It speaks the frames
 * of `protocol/frames.ts` on its standard input and output, and exits when its input ends: with
 * the host process, whatever the way it went.
 *
 * Usage: `node supervisor.js <settings as JSON>`.
 */
interface Channel {
  data?(chunk: Buffer): void;
  end?(): void;
  kill?(): void;
}

const settings = JSON.parse(process.argv[2] ?? '{}') as SupervisorSettings;
const channels = new Map<number, Channel>();
const processes = new Set<ChildProcess>();
const closed = new Set<number>();

function send(frame: Buffer): void {
  process.stdout.write(frame);
}

function sendData(channel: number, chunk: Buffer, type: FrameType = FrameType.Data): void {
  for (const frame of encodeData(channel, chunk, type)) send(frame);
}

/** Ends `channel` with `outcome`, once: what comes after is dropped. */
function close(channel: number, outcome: Outcome): void {
  if (closed.has(channel)) return;
  closed.add(channel);
  channels.delete(channel);
  send(encodeJson(FrameType.Close, channel, outcome));
}

function failure(error: unknown): Outcome {
  const { code, message } = error as NodeJS.ErrnoException;
  return { error: { code, message: message ?? String(error) } };
}

/** Stops `child` and everything it started: each process runs in a process group of its own. */
function killTree(child: ChildProcess): void {
  try {
    process.kill(-(child.pid ?? 0), 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function exitCodeOf(code: null | number, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  return 128 + (signal === null ? constants.signals.SIGKILL : constants.signals[signal]);
}

function run(channel: number, { command, cwd, env }: Extract<Request, { kind: 'spawn' }>): void {
  if (statSync(cwd, { throwIfNoEntry: false })?.isDirectory() !== true) {
    sendData(channel, Buffer.from(`sh: cd: ${cwd}: No such file or directory\n`), FrameType.Stderr);
    close(channel, { exitCode: 2 });
    return;
  }
  const child = spawn('/bin/sh', ['-c', command], {
    cwd,
    env: { ...process.env, HOME: settings.home, TMPDIR: settings.tmpdir, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processes.add(child);
  channels.set(channel, { kill: () => killTree(child) });
  child.stdout.on('data', (chunk: Buffer) => sendData(channel, chunk));
  child.stderr.on('data', (chunk: Buffer) => sendData(channel, chunk, FrameType.Stderr));
  child.once('error', (error) => {
    processes.delete(child);
    sendData(channel, Buffer.from(`${error.message}\n`), FrameType.Stderr);
    close(channel, { exitCode: 127 });
  });
  child.once('close', (code, signal) => {
    processes.delete(child);
    close(channel, { exitCode: exitCodeOf(code, signal) });
  });
}

function connectTo(channel: number, port: number): void {
  const socket = connect({ host: '127.0.0.1', port });
  channels.set(channel, {
    data: (chunk) => socket.write(chunk),
    end: () => socket.end(),
    kill: () => socket.destroy(),
  });
  socket.on('data', (chunk: Buffer) => sendData(channel, chunk));
  socket.once('end', () => send(encodeFrame(FrameType.End, channel)));
  socket.once('error', (error) => close(channel, failure(error)));
  socket.once('close', () => close(channel, { ok: true }));
}

function read(channel: number, path: string): void {
  readFile(path).then(
    (content) => {
      sendData(channel, content);
      close(channel, { ok: true });
    },
    (error: unknown) => close(channel, failure(error)),
  );
}

function write(channel: number, path: string): void {
  const chunks: Buffer[] = [];
  channels.set(channel, {
    data: (chunk) => chunks.push(Buffer.from(chunk)),
    end: () => {
      mkdir(dirname(path), { recursive: true })
        .then(() => writeFile(path, Buffer.concat(chunks)))
        .then(
          () => close(channel, { ok: true }),
          (error: unknown) => close(channel, failure(error)),
        );
    },
  });
}

function killAll(): void {
  for (const child of processes) killTree(child);
}

function open(channel: number, request: Request): void {
  switch (request.kind) {
    case 'connect':
      return connectTo(channel, request.port);
    case 'kill-all':
      killAll();
      return close(channel, { ok: true });
    case 'read':
      return read(channel, request.path);
    case 'spawn':
      return run(channel, request);
    case 'write':
      return write(channel, request.path);
    default:
      return close(channel, { error: { message: 'Unknown request.' } });
  }
}

/** What each frame from the host does to the channel it names. */
const HANDLERS: Partial<Record<FrameType, (target: Channel, payload: Buffer) => void>> = {
  [FrameType.Data]: (target, payload) => target.data?.(payload),
  [FrameType.End]: (target) => target.end?.(),
  [FrameType.Kill]: (target) => target.kill?.(),
};

function receive(type: FrameType, channel: number, payload: Buffer): void {
  if (type !== FrameType.Open) {
    const target = channels.get(channel);
    if (target !== undefined) HANDLERS[type]?.(target, payload);
    return;
  }
  try {
    open(channel, JSON.parse(payload.toString()) as Request);
  } catch (error) {
    close(channel, failure(error));
  }
}

function shutdown(): never {
  killAll();
  process.exit(0);
}

const decoder = new FrameDecoder();
process.stdin.on('data', (chunk: Buffer) => {
  for (const { type, channel, payload } of decoder.push(chunk)) receive(type, channel, payload);
});
process.stdin.once('end', shutdown);
process.once('SIGTERM', shutdown);
process.stdout.on('error', shutdown);
send(encodeJson(FrameType.Ready, 0, { pid: process.pid }));
