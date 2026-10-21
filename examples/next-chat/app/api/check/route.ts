import { checkText, isCheckKind } from '@/lib/plugin-check';

/**
 * Checks the plugin — or, with `?kind=item`, the item — the body holds as JSON text: on the
 * server, as a back office would before it saves one. Nothing is kept, nothing is run.
 */
export async function POST(request: Request): Promise<Response> {
  const kind = new URL(request.url).searchParams.get('kind') ?? 'plugin';
  if (!isCheckKind(kind)) return new Response('kind: must be plugin or item.', { status: 400 });
  return Response.json(checkText(await request.text(), kind));
}
