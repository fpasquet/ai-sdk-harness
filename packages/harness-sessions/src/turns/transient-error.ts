/** Network failures of Node.js and undici that a new attempt may not meet. */
const TRANSIENT_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * What a harness, its runtime or the provider says of a transient failure. The runtimes report an
 * API error as text (`API Error: 529 {…"overloaded_error"…}`), so the text is all there is to read.
 */
const TRANSIENT_TEXT = [
  // `@ai-sdk/harness-claude-code` and `@ai-sdk/harness-codex`, when their bridge goes away.
  /bridge closed before the turn finished/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN)\b/,
  /connection (?:dropped|reset|closed|error)/i,
  /socket hang up|fetch failed|network error/i,
  /overloaded/i,
  /\b(?:API Error|status(?: code)?|HTTP(?:\/[\d.]+)?)\W{1,3}(?:5\d\d)\b/i,
  /"type"\s*:\s*"api_error"/,
  /internal server error|bad gateway|service unavailable|gateway time-?out/i,
];

/** A failure that a new attempt meets again: a quota, credentials, a refusal. */
const FINAL_TEXT = [
  // Claude Code with a subscription: `You've hit your 5-hour limit · resets 5:40pm (UTC)`.
  /rate.?limit|quota|usage limit|hit your .*limit|\b429\b/i,
  /unauthori[sz]ed|forbidden|authentication|invalid[\s_-]?(?:api[\s_-]?key|token|credential)|\b40[13]\b/i,
];

/** How deep `cause`s are read: enough for a wrapped fetch error, not a loop. */
const MAX_CAUSES = 5;

function textOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return typeof error.message === 'string' ? error.message : '';
  }
  return '';
}

function field(error: unknown, name: string): unknown {
  return typeof error === 'object' && error !== null && name in error
    ? (error as Record<string, unknown>)[name]
    : undefined;
}

type Verdict = 'final' | 'transient' | undefined;

/** What an HTTP status says, when the error carries one (`APICallError.statusCode`). */
function statusVerdict(error: unknown): Verdict {
  const status = field(error, 'statusCode') ?? field(error, 'status');
  if (typeof status !== 'number') return undefined;
  if (status === 408 || (status >= 500 && status < 600)) return 'transient';
  return status >= 400 && status < 500 ? 'final' : undefined;
}

/** What one error of the chain says, if anything. */
function verdictOf(error: unknown): Verdict {
  const name = field(error, 'name');
  if (name === 'AbortError' || name === 'TimeoutError') return 'final';
  const status = statusVerdict(error);
  if (status !== undefined) return status;
  const text = textOf(error);
  if (FINAL_TEXT.some((pattern) => pattern.test(text))) return 'final';
  const code = field(error, 'code');
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return 'transient';
  if (TRANSIENT_TEXT.some((pattern) => pattern.test(text))) return 'transient';
  return undefined;
}

/**
 * Whether a turn that failed with `error` may succeed when run again: a lost harness bridge, a
 * network reset or timeout, a 5xx or an overloaded provider. A quota, a rate limit, credentials
 * refused, an abort and anything it does not recognise are final. Reads the error's `cause`s too.
 */
export function isTransientError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSES && current !== undefined; depth += 1) {
    const verdict = verdictOf(current);
    if (verdict !== undefined) return verdict === 'transient';
    current = field(current, 'cause');
  }
  return false;
}
