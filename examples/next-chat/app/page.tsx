import { ChatApp } from '@/components/chat';
import { describeMarketplace } from '@/lib/plugins';
import { sandboxIdOf } from '@/lib/sandboxes';

// The sandbox is read from the environment of the running server, not of the build.
export const dynamic = 'force-dynamic';

/**
 * The page says which sandbox the agents run in, and what each plugin offers — their public
 * description only, never their code. It never touches the sandbox packages.
 */
export default async function Page() {
  return (
    <ChatApp
      marketplace={await describeMarketplace()}
      sandbox={sandboxIdOf(process.env.EXAMPLE_SANDBOX)}
    />
  );
}
