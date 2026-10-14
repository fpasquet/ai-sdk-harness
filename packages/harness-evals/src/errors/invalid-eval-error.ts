/** What `isInstance` looks for, shared by every copy of this package. */
const MARKER: unique symbol = Symbol.for('ai-sdk-harness-evals.InvalidEvalError');

/**
 * The cases of `evaluate()` cannot run as they are: two cases under one name, a case with no
 * prompt, a `judge` expectation with no judge model… Thrown before any case runs.
 */
export class InvalidEvalError extends Error {
  private readonly [MARKER] = true;

  /** The case at fault, when the error is about one case. */
  readonly case: string | undefined;

  constructor(message: string, caseName?: string) {
    super(caseName === undefined ? message : `Case "${caseName}": ${message}`);
    this.name = 'InvalidEvalError';
    this.case = caseName;
  }

  /**
   * Whether `error` is one, rather than `instanceof`: a bundler may load this package twice, each
   * copy with its own class.
   */
  static isInstance(error: unknown): error is InvalidEvalError {
    return typeof error === 'object' && error !== null && MARKER in error;
  }
}
