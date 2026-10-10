import {
  SessionCapacityError,
  SessionConflictError,
  SessionNotFoundError,
} from 'ai-sdk-harness-sessions';

import { ExampleConfigurationError } from '@/lib/sandbox';

/**
 * The response to an error of the sessions: 404 for a session that does not exist, 409 for one
 * that cannot do it in its status, 503 when every sandbox slot is taken. Plain text: `useChat`
 * shows the body of a failed response as the error message.
 */
export function errorResponse(
  error: unknown,
  describe: (error: unknown) => string = (unknown) =>
    unknown instanceof Error ? unknown.message : String(unknown),
): Response {
  const status = SessionNotFoundError.isInstance(error)
    ? 404
    : SessionConflictError.isInstance(error)
      ? 409
      : SessionCapacityError.isInstance(error)
        ? 503
        : 500;
  const text =
    status !== 500 || error instanceof ExampleConfigurationError
      ? (error as Error).message
      : describe(error);
  return new Response(text, { status });
}
