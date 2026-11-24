import { errorResponse } from '@/lib/http';
import { sessions } from '@/lib/sessions';

type Context = { params: Promise<{ id: string }> };

/** Suspends the conversation now, as idleness would: the next message resumes it. */
export async function POST(_request: Request, { params }: Context): Promise<Response> {
  try {
    return Response.json(await sessions().suspend((await params).id));
  } catch (error) {
    return errorResponse(error);
  }
}
