import { sessions } from '@/lib/sessions';

export const dynamic = 'force-dynamic';

/** The conversations, newest first, with their status: idle, working, waiting for you, suspended. */
export async function GET(): Promise<Response> {
  const list = await sessions().list();
  return Response.json(list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}
