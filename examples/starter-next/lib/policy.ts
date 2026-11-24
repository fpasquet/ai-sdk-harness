import { defineApprovalPolicy } from 'ai-sdk-harness-approval';

/**
 * What the agent may do on its own, what it may never do, and the rest, which waits for you in the
 * page: ai-sdk-harness-approval answers within the turn, before anyone sees the request.
 */
export const policy = defineApprovalPolicy({
  commands: {
    allow: ['ls', 'pwd', 'cat', 'head', 'grep', 'wc', 'git status', 'git diff', 'git log'],
    deny: [
      { match: 'rm -rf', reason: 'Deleting recursively is not allowed.' },
      { match: 'git push', reason: 'Nothing leaves the sandbox: you publish the changes.' },
      { match: 'sudo', reason: 'No root.' },
    ],
  },
  edits: { deny: [{ match: '.env*', reason: 'Environment files hold secrets.' }] },
});
