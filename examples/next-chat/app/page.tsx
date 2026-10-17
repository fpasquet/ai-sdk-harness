import { ChatApp } from '@/components/chat';
import { describeMarketplace } from '@/lib/plugins';
import { sandboxIdOf } from '@/lib/sandboxes';
import { sessions } from '@/lib/sessions';
import { repositoryLabel } from '@/lib/workspace';

// The sandbox is read from the environment of the running server, not of the build.
export const dynamic = 'force-dynamic';

/**
 * The page lists the conversations, says which sandbox the agents run in, which repository they
 * work on, and what each plugin offers — their public description only, never their code. Listing the sessions opens no sandbox.
 */
export default async function Page() {
  return (
    <ChatApp
      initialSessions={await sessions().list()}
      marketplace={await describeMarketplace()}
      repository={repositoryLabel()}
      sandbox={sandboxIdOf(process.env.EXAMPLE_SANDBOX)}
    />
  );
}
