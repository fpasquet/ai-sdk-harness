import { workspace } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * What the agent changed in its checkout, as a patch on the commit it started from: what you
 * would review, then apply with `git apply` and push with your own credentials.
 */
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  if (workspace === undefined) return new Response('No REPOSITORY.', { status: 404 });
  const checkout = workspace.session((await params).id);
  if (checkout === undefined) {
    return new Response('The conversation is suspended: send it a message.', { status: 409 });
  }
  const patch = new TextDecoder().decode(await checkout.changes());
  return Response.json({ base: checkout.base, patch });
}
