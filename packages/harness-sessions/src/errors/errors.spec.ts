import { describe, expect, it } from 'vitest';

import { SessionCapacityError } from './session-capacity-error.js';
import { SessionConflictError } from './session-conflict-error.js';
import { SessionNotFoundError } from './session-not-found-error.js';
import { SessionOwnedElsewhereError } from './session-owned-elsewhere-error.js';

describe('session errors', () => {
  it('are recognised by isInstance, whichever copy of the package threw them', () => {
    const errors = [
      new SessionNotFoundError('a'),
      new SessionConflictError('a', 'busy', 'busy'),
      new SessionCapacityError(2),
    ];

    expect(errors.map((error) => error.name)).toEqual([
      'SessionNotFoundError',
      'SessionConflictError',
      'SessionCapacityError',
    ]);
    expect(SessionNotFoundError.isInstance(errors[0])).toBe(true);
    expect(SessionConflictError.isInstance(errors[1])).toBe(true);
    expect(SessionCapacityError.isInstance(errors[2])).toBe(true);
    expect(SessionNotFoundError.isInstance(errors[1])).toBe(false);
    expect(SessionConflictError.isInstance(new Error('no'))).toBe(false);
    expect(SessionCapacityError.isInstance(null)).toBe(false);
  });

  it('say which manager runs a session owned elsewhere, a conflict as well', () => {
    const error = new SessionOwnedElsewhereError('a', 'busy', 'manager-2');

    expect(error).toMatchObject({ name: 'SessionOwnedElsewhereError', owner: 'manager-2' });
    expect(SessionOwnedElsewhereError.isInstance(error)).toBe(true);
    expect(SessionConflictError.isInstance(error)).toBe(true);
    expect(SessionOwnedElsewhereError.isInstance(new SessionConflictError('a', 'busy', 'x'))).toBe(
      false,
    );
    expect(SessionOwnedElsewhereError.isInstance(null)).toBe(false);
    expect(SessionOwnedElsewhereError.isInstance('manager-2')).toBe(false);
  });

  it('say what went wrong', () => {
    expect(new SessionNotFoundError('a').message).toBe('No session a.');
    expect(new SessionConflictError('a', 'closed', 'The session is closed.')).toMatchObject({
      sessionId: 'a',
      status: 'closed',
    });
    expect(new SessionCapacityError(2).message).toMatch(/^2 sessions are live/);
  });
});
