import { errorResponse } from '@/lib/http';
import { sessions } from '@/lib/sessions';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** A conversation with its messages, to show it again. */
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const session = await sessions().get((await params).id);
  return session === undefined
    ? new Response('No such conversation.', { status: 404 })
    : Response.json(session);
}

/** Closes the conversation's session, then forgets it. */
export async function DELETE(_request: Request, { params }: Context): Promise<Response> {
  try {
    await sessions().delete((await params).id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
