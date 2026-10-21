import { checkText, isCheckKind } from '@/lib/plugin-check';

/**
 * Checks the plugin — or, with `?kind=item`, the item — the body holds as JSON text: on the
 * server, alone then against the marketplace, as a back office would before it saves one.
 * Nothing is kept, nothing is run.
 */
export async function POST(request: Request): Promise<Response> {
  const kind = new URL(request.url).searchParams.get('kind') ?? 'plugin';
  if (!isCheckKind(kind)) return new Response('kind: must be plugin or item.', { status: 400 });
  const text = await request.text();
  const check = await checkText(text, kind);
  return Response.json(check);
}
