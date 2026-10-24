import { ChatApp } from '@/components/chat';
import { harnessAvailability } from '@/lib/harness-adapters';
import { HARNESS_IDS } from '@/lib/harnesses';
import { openRouterModelsFor } from '@/lib/models';
import { describeMarketplace } from '@/lib/plugins';
import { sandboxIdOf } from '@/lib/sandboxes';
import { sessions } from '@/lib/sessions';
import { repositoryLabel } from '@/lib/workspace';

// The sandbox is read from the environment of the running server, not of the build.
export const dynamic = 'force-dynamic';

/**
 * The page lists the conversations, says which sandbox the agents run in, which repository they
 * work on, and what each plugin offers — their public description only, never their code. It says
 * which coding agents have their credential: whether it is set, never its value. Listing the
 * sessions opens no sandbox.
 */
export default async function Page() {
  const availability = harnessAvailability();
  // The models of OpenRouter, for the harnesses that go through it and can run.
  const openRouterModels = await openRouterModelsFor(HARNESS_IDS.filter((id) => availability[id]));
  return (
    <ChatApp
      availability={availability}
      initialSessions={await sessions().list()}
      marketplace={await describeMarketplace()}
      openRouterModels={openRouterModels}
      repository={repositoryLabel()}
      sandbox={sandboxIdOf(process.env.EXAMPLE_SANDBOX)}
    />
  );
}
