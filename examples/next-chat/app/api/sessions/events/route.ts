import { sessions } from '@/lib/sessions';

export const dynamic = 'force-dynamic';

/**
 * Every change of every conversation, as server-sent events: the list follows each session from
 * `preparing` to `busy`, `idle`, `awaiting-input` or `suspended`, whichever tab or process caused
 * it.
 */
export function GET(request: Request): Response {
  const encoder = new TextEncoder();
  let stop = () => undefined as void;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text));
      const unsubscribe = sessions().subscribe((event) =>
        send(`data: ${JSON.stringify(event)}\n\n`),
      );
      // A comment now and then, so that no proxy closes a quiet stream.
      const heartbeat = setInterval(() => send(': heartbeat\n\n'), 15_000);
      stop = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.signal.addEventListener('abort', () => {
        stop();
        controller.close();
      });
    },
    cancel: () => stop(),
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}
