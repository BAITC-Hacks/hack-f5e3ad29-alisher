import { openai } from '@ai-sdk/openai';
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from 'ai';

export const maxDuration = 60;

export async function POST(request: Request) {
  const { messages }: { messages: UIMessage[] } = await request.json();

  const result = streamText({
    model: openai.responses(process.env.OPENAI_MODEL || 'gpt-5-mini'),
    system:
      "You are a helpful general-purpose assistant. Respond in the user's language, clearly and concisely.",
    messages: await convertToModelMessages(
      messages.filter(({ role }) => role === 'user' || role === 'assistant'),
    ),
    providerOptions: { openai: { store: false } },
    abortSignal: request.signal,
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}
