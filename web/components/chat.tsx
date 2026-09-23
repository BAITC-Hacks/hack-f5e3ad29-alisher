'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useEffect, useState, type SubmitEvent } from 'react';
import {
  Conversation,
  ConversationContent,
} from '@/components/ai-elements/conversation';
import {
  Message,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputTextarea,
} from '@/components/ai-elements/prompt-input';
import { Button } from '@/components/ui/button';

export function Chat() {
  const [session, setSession] = useState(0);
  return (
    <ChatSession key={session} onNewChat={() => setSession(session + 1)} />
  );
}

function ChatSession({ onNewChat }: { onNewChat: () => void }) {
  const [input, setInput] = useState('');

  const { messages, sendMessage, status, stop } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });

  const busy = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    return () => {
      void stop();
    };
  }, [stop]);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();

    const text = input.trim();

    if (!text || busy) {
      return;
    }

    setInput('');
    await sendMessage({ text });
  }

  return (
    <main className="mx-auto flex h-dvh w-full max-w-3xl flex-col">
      <header className="flex shrink-0 justify-end px-4 py-3 sm:px-6">
        <Button variant="ghost" size="sm" onClick={onNewChat}>
          New chat
        </Button>
      </header>
      <Conversation className="min-h-0" aria-label="Conversation">
        <ConversationContent className="gap-6 px-4 py-6 sm:px-6">
          {messages.map((message) => (
            <Message key={message.id} from={message.role}>
              <MessageContent>
                {message.parts.map(
                  (part, index) =>
                    part.type === 'text' &&
                    (message.role === 'assistant' ? (
                      <MessageResponse
                        key={index}
                        isAnimating={
                          status === 'streaming' &&
                          message.id === messages.at(-1)?.id
                        }
                      >
                        {part.text}
                      </MessageResponse>
                    ) : (
                      <p
                        key={index}
                        className="whitespace-pre-wrap wrap-break-word"
                      >
                        {part.text}
                      </p>
                    )),
                )}
              </MessageContent>
            </Message>
          ))}
        </ConversationContent>
      </Conversation>
      <footer className="shrink-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-6">
        <PromptInput onSubmit={submit}>
          <PromptInputTextarea
            aria-label="Message"
            value={input}
            readOnly={busy}
            onChange={(event) => setInput(event.target.value)}
          />
        </PromptInput>
      </footer>
    </main>
  );
}
