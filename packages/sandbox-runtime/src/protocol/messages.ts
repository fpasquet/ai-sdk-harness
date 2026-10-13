/** What an {@link FrameType.Open} frame asks the supervisor for, as JSON. */
export type Request =
  /** Bytes to and from `127.0.0.1:<port>` in the sandbox, as the channel's data. */
  | { kind: 'connect'; port: number }
  /** Stops every process the supervisor runs, then closes the channel. */
  | { kind: 'kill-all' }
  /** The content of a file, as the channel's data. */
  | { kind: 'read'; path: string }
  /** Runs `sh -c <command>`: its output comes as data and stderr, its exit code on close. */
  | { kind: 'spawn'; command: string; cwd: string; env: Record<string, string> }
  /** Writes the channel's data to a file, creating its directories, once the host ends it. */
  | { kind: 'write'; path: string };

/** The outcome of a channel, on its {@link FrameType.Close} frame. */
export type Outcome =
  /** The request failed. `code` is the Node.js error code, `ENOENT` for a missing file. */
  | { error: { code?: string; message: string } }
  /** A process exited, with `128 + n` when killed by signal `n`. */
  | { exitCode: number }
  /** Done: the file was read or written, the connection closed, the processes stopped. */
  | { ok: true };

/** What the supervisor needs to know of its sandbox, given as its first argument, in JSON. */
export interface SupervisorSettings {
  /** The sandbox's own home directory: `HOME` for every process. */
  home: string;
  /** The sandbox's own temporary directory: `TMPDIR` for every process. */
  tmpdir: string;
}
