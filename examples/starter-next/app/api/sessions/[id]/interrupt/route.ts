import { errorResponse } from '@/lib/http';
import { sessions } from '@/lib/sessions';

type Context = { params: Promise<{ id: string }> };

/**
 * Cuts the conversation's turn short: the stop button. A turn is not tied to the page's request,
 * which may be closed while the agent works; this is how it stops.
 */
export async function POST(_request: Request, { params }: Context): Promise<Response> {
  try {
    await sessions().interrupt((await params).id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
