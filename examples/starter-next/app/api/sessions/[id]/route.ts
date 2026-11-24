import { sessions } from '@/lib/sessions';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** A conversation with its messages, to show it again. */
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const session = await sessions().get((await params).id);
  if (session === undefined) return new Response('No such conversation.', { status: 404 });
  return Response.json(session);
}
