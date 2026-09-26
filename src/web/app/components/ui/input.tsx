import * as React from 'react';
import { cn } from '@/lib/utils';

/** Vendored from the shadcn registry, adapted to this app's tokens.
 *
 * It arrived with literal `white/15` and `black/30`, which is how the registry writes a field for
 * a DARK surface. This app is light now, so those became tokens — the literal was a colour choice
 * hidden in a class, and a light theme is exactly what exposes it. */
export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs',
        'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1',
        'focus-visible:ring-ring/40 disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
