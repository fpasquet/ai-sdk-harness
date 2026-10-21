import { checkPluginText } from '@/lib/plugin-check';

/**
 * Checks the plugin, or the item, the body holds as JSON text: on the server, as a back office
 * would before it saves one. Nothing is kept, nothing is run.
 */
export async function POST(request: Request): Promise<Response> {
  return Response.json(checkPluginText(await request.text()));
}
