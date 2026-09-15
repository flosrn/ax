/** Recover the current session's own ask receipt address; never manufacture approval. */
import { readFileSync } from 'node:fs';

interface ConfirmationContext { sessionManager?: { getSessionFile?(): string | undefined } }
interface ConfirmationHost {
  zod: { object(shape: Record<string, never>): unknown };
  registerTool(tool: {
    name: string; label: string; description: string; parameters: unknown;
    execute(id: string, args: unknown, signal: unknown, update: unknown, ctx: ConfirmationContext): Promise<unknown>;
  }): void;
}

export function latestModelQuestion(file: string): string | null {
  const calls = new Set<string>();
  let latest: string | null = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = entry.message;
    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'toolCall' && part.name === 'ask' && typeof part.id === 'string'
          && part.arguments?.questions?.some((q: { id?: unknown }) => typeof q.id === 'string' && q.id.startsWith('ax-model:'))) {
          calls.add(part.id);
        }
      }
    }
    if (message?.role === 'toolResult' && message.toolName === 'ask' && calls.has(message.toolCallId)) {
      latest = `${file}#${message.toolCallId}`;
      calls.delete(message.toolCallId);
    }
  }
  return latest;
}

export default function modelConfirmation(pi: ConfirmationHost) {
  pi.registerTool({
    name: 'worker_model_confirmation',
    label: 'Worker model confirmation',
    description: 'Return the current session transcript reference for the latest completed AX model ask question. Pass it to ax worker dispatch --model-confirmation. The dispatch independently verifies the answer; a timeout, cancellation or stale choice is not approval.',
    parameters: pi.zod.object({}),
    async execute(_id: string, _args: unknown, _signal: unknown, _update: unknown, ctx: ConfirmationContext) {
      try {
        const file = ctx.sessionManager?.getSessionFile?.();
        const reference = file ? latestModelQuestion(file) : null;
        if (reference) return { content: [{ type: 'text', text: reference }], details: { reference } };
        return { content: [{ type: 'text', text: 'No completed AX model ask question in this session. Run the dispatch dry-run, then use ask with its question.' }], isError: true };
      } catch (error) {
        return { content: [{ type: 'text', text: `Cannot read this session: ${String(error)}. Retry after the ask result is written.` }], isError: true };
      }
    },
  });
}
