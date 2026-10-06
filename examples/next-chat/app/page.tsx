import { ChatApp } from '@/components/chat';
import { sandboxIdOf } from '@/lib/sandboxes';

// The sandbox is read from the environment of the running server, not of the build.
export const dynamic = 'force-dynamic';

/** The page only says which sandbox the agents run in: it never touches the sandbox packages. */
export default function Page() {
  return <ChatApp sandbox={sandboxIdOf(process.env.EXAMPLE_SANDBOX)} />;
}
