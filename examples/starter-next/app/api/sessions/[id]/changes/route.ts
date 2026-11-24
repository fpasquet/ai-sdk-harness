import { errorResponse } from '@/lib/http';
import { workspace } from '@/lib/sessions';

type Context = { params: Promise<{ id: string }> };

/** At most this much of the patch goes to the page: the list of files says the rest. */
const MAX_PATCH = 200_000;

/**
 * What the agent of a conversation changed in its checkout of `EXAMPLE_REPOSITORY`, since the
 * checkout started: its files, and the patch as text. 404 without a repository; 409 while the
 * conversation is not live — suspended, closed, or still preparing.
 */
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const current = workspace();
  if (current === undefined) return new Response('No EXAMPLE_REPOSITORY.', { status: 404 });
  const checkout = current.session((await params).id);
  if (checkout === undefined) {
    return new Response('The conversation is not live: its checkout cannot be read.', {
      status: 409,
    });
  }
  try {
    const [files, patch] = await Promise.all([checkout.changedFiles(), checkout.changes()]);
    const text = new TextDecoder().decode(patch);
    return Response.json({
      branch: checkout.branch,
      base: checkout.base,
      files,
      patch: text.length > MAX_PATCH ? `${text.slice(0, MAX_PATCH)}\n…` : text,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
