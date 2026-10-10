import type { SessionStatus } from 'ai-sdk-harness-sessions';

import type { HarnessId } from '@/lib/harnesses';

/**
 * What the example keeps with each session, its metadata: the agent the conversation picked
 * before its first message, kept for the whole conversation. Shared by the page and the server.
 */
export interface Conversation {
  harness: HarnessId;
  model: string;
  /** The ids of what it picked in the marketplace: plugins, and items on their own. */
  selection: string[];
  /**
   * Whether the agent asks before it edits a file or runs a command (`permissionMode:
   * 'allow-reads'`): the session waits for your approval meanwhile.
   */
  askFirst: boolean;
  /** The first message, shortened: what the list of conversations shows. */
  title: string;
}

/** How each status reads in the list of conversations. */
export const STATUS_LABELS: Record<SessionStatus, string> = {
  preparing: 'Preparing',
  idle: 'Ready',
  busy: 'Working',
  'awaiting-input': 'Needs you',
  suspended: 'Suspended',
  closed: 'Closed',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

/** A conversation's title, from its first message. */
export const titleOf = (text: string): string => {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New conversation';
};
