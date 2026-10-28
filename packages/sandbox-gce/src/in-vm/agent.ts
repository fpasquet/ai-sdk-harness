import type { IncomingMessage, ServerResponse } from 'node:http';

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Reply } from '../common/http-reply.js';
import type { Logger } from '../common/logger.js';
import type { AgentConfig, AgentDescription } from '../protocol/agent.js';
import type { CommandSettings } from './environment.js';
import type { CommandUser } from './processes.js';

import { readCommandLine } from '../common/command-line.js';
import {
  offsetOf,
  parseObject,
  readBytes,
  readJson,
  requiredString,
  stringRecord,
} from '../common/http-body.js';
import { HttpError } from '../common/http-error.js';
import { NO_CONTENT, waitForExit } from '../common/http-reply.js';
import { MAX_INPUT_WRITE_BYTES } from '../protocol/api.js';
import { encodeData, encodeFrame, FrameType, STDERR, STDOUT } from '../protocol/frames.js';
import { configureDocker } from './docker-proxy.js';
import { commandEnvironment } from './environment.js';
import { Processes } from './processes.js';

/** What the agent is made with: its machine's to give. */
export interface AgentSettings extends CommandSettings {
  /** What the service proves itself with, in `x-ai-sdk-sandbox-agent-token`. */
  token: string;
  /** Root's, out of the commands' reach: the configuration the service gave, kept across restarts. */
  stateDirectory: string;
  /** Whom the commands run as, when the agent runs as root: itself otherwise. */
  commandUser?: CommandUser;
  /** Whether to point Docker at the egress proxy: as root, on a machine that has it. */
  configureDocker: boolean;
  logger: Logger;
}

/** How long `GET /v1/processes/:id` waits for an exit: less than any request timeout. */
const WAIT_MS = 5 * 60_000;

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PROCESS = /^\/v1\/processes\/([^/]+)$/;

const PROCESS_INPUT = /^\/v1\/processes\/([^/]+)\/stdin$/;

function toConfig(body: Record<string, unknown>): AgentConfig {
  const proxy = requiredString(body, 'proxy');
  if (!URL.canParse(proxy)) throw new HttpError(400, '`proxy` must be a URL.');
  return { proxy, baseUrls: stringRecord(body, 'baseUrls') ?? {} };
}

/**
 * What the agent does for the service (`protocol/agent.ts`): run commands as the sandbox's user,
 * with nothing of its own environment, and stop them; take the network configuration the service
 * gives.
 */
export class Agent {
  readonly processes: Processes;
  private config?: AgentConfig;

  constructor(private readonly settings: AgentSettings) {
    this.processes = new Processes(settings.commandUser);
    try {
      this.config = toConfig(parseObject(readFileSync(this.configFile, 'utf8')));
    } catch {
      // Not configured yet: the service does so before the first command.
    }
  }

  private get configFile(): string {
    return join(this.settings.stateDirectory, 'config.json');
  }

  /** Answers a call, or streams its own answer and replies with nothing. */
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<Reply | undefined> {
    const method = request.method ?? 'GET';
    switch (`${method} ${path}`) {
      case 'PUT /v1/config':
        return { status: 200, body: await this.configure(toConfig(await readJson(request))) };
      case 'POST /v1/exec':
        await this.exec(request, response);
        return undefined;
      case 'DELETE /v1/processes':
        await this.processes.killAll();
        return NO_CONTENT;
    }
    const reply = this.processCall(method, path, request);
    if (reply === undefined) throw new HttpError(404, `No route for ${method} ${path}.`);
    return reply;
  }

  /** A call about one process, its input included: `undefined` for any other path. */
  private processCall(
    method: string,
    path: string,
    request: IncomingMessage,
  ): Promise<Reply> | undefined {
    const inputOf = PROCESS_INPUT.exec(path)?.[1];
    if (inputOf !== undefined && (method === 'POST' || method === 'DELETE')) {
      return this.input(method, decodeURIComponent(inputOf), request);
    }
    const id = PROCESS.exec(path)?.[1];
    if (id !== undefined && (method === 'GET' || method === 'DELETE')) {
      return this.process(method, decodeURIComponent(id));
    }
    return undefined;
  }

  private async configure(config: AgentConfig): Promise<AgentDescription> {
    const { settings } = this;
    if (settings.configureDocker) {
      await configureDocker(config, { home: settings.home, user: settings.commandUser });
    }
    mkdirSync(settings.stateDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(this.configFile, JSON.stringify(config), { mode: 0o600 });
    this.config = config;
    return { home: settings.home, workingDirectory: settings.workingDirectory };
  }

  private async process(method: 'DELETE' | 'GET', id: string): Promise<Reply> {
    const started = this.processes.get(id);
    if (started === undefined) throw new HttpError(404, `No process ${id}.`);
    if (method === 'GET') return waitForExit(started.exited, WAIT_MS);
    await this.processes.kill(id);
    return NO_CONTENT;
  }

  /** Writes or ends the standard input of a process started with `stdin`. */
  private async input(
    method: 'DELETE' | 'POST',
    id: string,
    request: IncomingMessage,
  ): Promise<Reply> {
    const started = this.processes.get(id);
    if (started === undefined) throw new HttpError(404, `No process ${id}.`);
    if (started.input === undefined) {
      throw new HttpError(409, `The process ${id} was started without a writable standard input.`);
    }
    if (method === 'DELETE') started.input.end();
    else
      await started.input.write(offsetOf(request), await readBytes(request, MAX_INPUT_WRITE_BYTES));
    return NO_CONTENT;
  }

  /**
   * `POST /v1/exec`: starts the command, its standard input the rest of the request (or written
   * by requests of their own, with `stdin`), and streams its output as frames, then its exit code.
   * The process outlives the request.
   */
  private async exec(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { command, rest } = await readCommandLine(request);
    const env = command.env ?? {};
    const invalid = Object.keys(env).find((name) => !VARIABLE.test(name));
    if (invalid !== undefined) throw new HttpError(400, `Invalid variable name: ${invalid}`);
    const { id, child, exited } = this.processes.exec(command.command, {
      directory: command.workingDirectory ?? this.settings.workingDirectory,
      env: commandEnvironment(this.settings, this.config, env),
      stdin: command.stdin,
    });
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'x-process-id': id });
    response.flushHeaders();
    response.write(encodeFrame(FrameType.Open, 0, Buffer.from(id)));
    if (command.stdin !== true) {
      child.stdin.write(rest);
      request.pipe(child.stdin);
    }
    request.resume();
    // Once the caller is gone, the output is drained still: the process must not block on it.
    const write = (frame: Buffer): void => {
      if (!response.destroyed) response.write(frame);
    };
    child.stdout.on('data', (chunk: Buffer) => encodeData(STDOUT, chunk).forEach(write));
    child.stderr.on('data', (chunk: Buffer) => encodeData(STDERR, chunk).forEach(write));
    const exitCode = await exited;
    if (!response.destroyed) {
      response.end(encodeFrame(FrameType.Exit, 0, Buffer.from(String(exitCode))));
    }
  }
}
