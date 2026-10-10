import { sessions } from '@/lib/sessions';

export const dynamic = 'force-dynamic';

/** The conversations, the most recently updated first, without their messages. */
export async function GET(): Promise<Response> {
  return Response.json(await sessions().list());
}
