'use client';

import { InputGroup, InputGroupTextarea } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';
import type { ComponentProps } from 'react';

export function PromptInput({ children, ...props }: ComponentProps<'form'>) {
  return (
    <form {...props}>
      <InputGroup>{children}</InputGroup>
    </form>
  );
}

export function PromptInputTextarea({
  className,
  onKeyDown,
  ...props
}: ComponentProps<typeof InputGroupTextarea>) {
  return (
    <InputGroupTextarea
      className={cn('max-h-48 min-h-16', className)}
      enterKeyHint="send"
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          !event.defaultPrevented &&
          event.key === 'Enter' &&
          !event.shiftKey &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229
        ) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }}
      {...props}
    />
  );
}
