import { errorResponse } from '@/lib/http';
import { blockedHosts } from '@/lib/sandbox';

/**
 * The hosts the proxy of the shared Docker Sandbox refused since the example opened it. 404 with
 * another sandbox, or before a conversation opened it.
 */
export async function GET(): Promise<Response> {
  try {
    const hosts = await blockedHosts();
    if (hosts === undefined) {
      return new Response('Only an open local Docker Sandbox reports the hosts it was refused.', {
        status: 404,
      });
    }
    return Response.json(hosts);
  } catch (error) {
    return errorResponse(error);
  }
}
