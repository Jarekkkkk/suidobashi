import * as React from 'react';
import { cn } from '@/lib/utils';

/** Vendored from the shadcn registry, unchanged apart from the comment. */
export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'flex h-9 w-full rounded-md border border-white/15 bg-black/30 px-3 py-1 text-sm',
        'placeholder:text-white/30 focus-visible:outline-none focus-visible:ring-1',
        'focus-visible:ring-white/30 disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
