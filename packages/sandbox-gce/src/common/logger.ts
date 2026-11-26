/** What a server of the package reports, and to whom. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Reports what happened to a sandbox, as a structured line: what a log-based metric counts. */
  event(event: LogEvent): void;
}

/**
 * What happened to a sandbox: `{ event, sandbox, at, … }` in a JSON line, beside the `message` a
 * person reads, and any field of the event's own.
 */
export interface LogEvent {
  event: 'create' | 'delete' | 'resume' | 'suspend';
  /** The sandbox's name. */
  sandbox: string;
  /** What a person reads: `box created in 1890 ms`. */
  message: string;
  /** Fields of the event's own: its timings, the bytes its connections carried… */
  [field: string]: unknown;
}

/**
 * A logger writing one line per message to the standard streams: plain text, or, with `json`, one
 * JSON object per line, as Cloud Logging reads them, with its `severity` field. An event's fields
 * go in its JSON line, its message alone in a plain one.
 */
export function createLogger({ json }: { json: boolean }): Logger {
  const write = (
    severity: 'ERROR' | 'INFO' | 'WARNING',
    message: string,
    fields: Record<string, unknown> = {},
  ): void => {
    const stream = severity === 'INFO' ? process.stdout : process.stderr;
    const time = new Date().toISOString();
    stream.write(
      json
        ? `${JSON.stringify({ ...fields, severity, message, time })}\n`
        : `${time} ${severity} ${message}\n`,
    );
  };
  return {
    info: (message) => write('INFO', message),
    warn: (message) => write('WARNING', message),
    error: (message) => write('ERROR', message),
    event: ({ message, ...fields }) =>
      write('INFO', message, { at: new Date().toISOString(), ...fields }),
  };
}

/** A logger that drops everything: for tests. */
export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  event: () => undefined,
};
