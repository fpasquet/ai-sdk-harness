import { defineApprovalPolicy } from 'ai-sdk-harness-approval';

/**
 * The approval policy of a conversation that asks first, from `ai-sdk-harness-approval`: what
 * looks around runs at once, what deletes recursively or pushes is refused, and everything else,
 * other commands and every file edit, waits for you. Shared by the server, which decides with it,
 * and the page, which shows it.
 */
export const APPROVAL_POLICY = defineApprovalPolicy({
  commands: {
    allow: [
      'ls',
      'pwd',
      'cat',
      'head',
      'tail',
      'wc',
      'grep',
      'echo',
      'date',
      'which',
      'node --version',
      'git status',
      'git diff',
      'git log',
    ],
    deny: [
      { match: 'rm -rf', reason: 'Deleting recursively is not allowed in this example.' },
      { match: 'git push', reason: 'Nothing leaves the sandbox from this example.' },
      { match: 'sudo', reason: 'No root in this example.' },
    ],
  },
  edits: { deny: [{ match: '.env*', reason: 'The agent does not touch environment files.' }] },
});

const patternsOf = (rules: readonly (string | { match: string })[] = []): string[] =>
  rules.map((rule) => (typeof rule === 'string' ? rule : rule.match));

/** The policy in a few lists, for the page. */
export const POLICY_SUMMARY = {
  allowed: patternsOf(APPROVAL_POLICY.settings.commands?.allow),
  denied: [
    ...patternsOf(APPROVAL_POLICY.settings.commands?.deny),
    ...patternsOf(APPROVAL_POLICY.settings.edits?.deny).map((path) => `edits of ${path}`),
  ],
};
