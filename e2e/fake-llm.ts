/**
 * Minimal OpenAI-compatible chat-completions stub for live E2E tests.
 *
 * Speaks just enough of POST /v1/chat/completions (SSE streaming) for the pi
 * SDK's `openai-completions` api to complete a turn: streams a deterministic
 * assistant reply derived from the last user message, then finishes.
 *
 * No auth check — bound to 127.0.0.1 and only reachable during tests.
 */


const PORT = Number(process.env.FAKE_LLM_PORT || 8787);

const encoder = new TextEncoder();

function sse(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function lastUserText(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const parts = m.content
        .filter((p): p is { type: 'text'; text: string } => p?.type === 'text')
        .map((p) => p.text);
      return parts.join(' ');
    }
    return '';
  }
  return '';
}
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    console.log(`[fake-llm] ${req.method} ${url.pathname}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      return new Response('ok');
    }
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      return new Response('not found', { status: 404 });
    }

    const body = (await req.json()) as {
      model?: string;
      stream?: boolean;
      messages?: Array<{ role: string; content: unknown }>;
    };
    const messages = body.messages ?? [];
    const userText = lastUserText(messages).slice(0, 2000);
    const reply = `FAKE-LLM REPLY: ${userText}`;
    const model = body.model ?? 'e2e-fake-model';
    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-e2e-${created}`;

    if (body.stream === false) {
      return Response.json({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: reply },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }

    // Stream the reply in small chunks so the client exercises real deltas.
    const chunks = reply.match(/.{1,12}/gs) ?? [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          sse({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          })
        );
        for (const c of chunks) {
          controller.enqueue(
            sse({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { content: c }, finish_reason: null }],
            })
          );
        }
        controller.enqueue(
          sse({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: chunks.length, total_tokens: 10 + chunks.length },
          })
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
    });
  },
});

console.log(`[fake-llm] listening on http://127.0.0.1:${server.port}`);
