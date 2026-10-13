/** What the service reports, and to whom. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * A logger writing one line per message to the standard streams: plain text, or, with `json`, one
 * JSON object per line, as Cloud Logging reads them, with its `severity` field.
 */
export function createLogger({ json }: { json: boolean }): Logger {
  const write = (severity: 'ERROR' | 'INFO' | 'WARNING', message: string): void => {
    const stream = severity === 'INFO' ? process.stdout : process.stderr;
    stream.write(
      json
        ? `${JSON.stringify({ severity, message, time: new Date().toISOString() })}\n`
        : `${new Date().toISOString()} ${severity} ${message}\n`,
    );
  };
  return {
    info: (message) => write('INFO', message),
    warn: (message) => write('WARNING', message),
    error: (message) => write('ERROR', message),
  };
}

/** A logger that drops everything: for tests. */
export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
