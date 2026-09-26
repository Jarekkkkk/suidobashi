import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/*
 * Vendored from the shadcn registry, to its documented API.
 *
 * The registry JSON is not reachable from here, so this is written from the published interface
 * rather than copied — same props, same composition, same defaults. `Bubble` · `BubbleContent` ·
 * `BubbleReactions` · `BubbleGroup`, seven variants, start/end alignment. If the registry is ever
 * fetched directly it replaces this file without callers changing.
 *
 * Vendored rather than installed on purpose: shadcn is a source registry, not a dependency, so
 * these components become OUR tree. That is what makes the publisher vocabulary a closed set by
 * construction — a publisher may name a component only if it exists here.
 */

const bubbleVariants = cva(
  'flex w-fit max-w-[80%] flex-col rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground',
        secondary: 'bg-secondary text-secondary-foreground',
        muted: 'bg-muted text-muted-foreground',
        tinted: 'bg-brand-soft text-foreground',
        outline: 'border border-border bg-transparent',
        // Unframed, and it drops the max-width so assistant text can use the whole row.
        ghost: 'max-w-none bg-transparent p-0',
        destructive: 'bg-destructive/15 text-destructive',
      },
      align: {
        start: 'self-start',
        end: 'self-end',
      },
    },
    defaultVariants: { variant: 'default', align: 'start' },
  },
);

export type BubbleProps = React.HTMLAttributes<HTMLDivElement>
  & VariantProps<typeof bubbleVariants>;

export function Bubble({ className, variant, align, ...props }: BubbleProps) {
  return <div className={cn(bubbleVariants({ variant, align }), className)} {...props} />;
}

/** The content wrapper. `render` swaps the element, for a link or a button bubble. */
export function BubbleContent({
  className,
  render,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { render?: React.ReactElement }) {
  const content = (
    <div className={cn('min-w-0 whitespace-pre-line break-words', className)} {...props} />
  );
  if (!render) return content;
  return React.cloneElement(render, undefined, content);
}

/**
 * Reactions, or any short row anchored to the bubble's edge.
 *
 * `role="img"` with a label when they are decoration: a screen reader otherwise announces each
 * glyph with no context and reads a counter like "+8" as "plus eight".
 */
export function BubbleReactions({
  className,
  side = 'bottom',
  align = 'end',
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { side?: 'top' | 'bottom'; align?: 'start' | 'end' }) {
  return (
    <div
      className={cn(
        'mt-1.5 flex flex-wrap items-center gap-1.5',
        side === 'top' && 'order-first mb-1.5 mt-0',
        align === 'end' ? 'justify-end' : 'justify-start',
        className,
      )}
      {...props}
    />
  );
}

/** Consecutive bubbles from the same sender. Alignment stays on each `Bubble`. */
export function BubbleGroup({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex w-full flex-col gap-1', className)} {...props} />;
}
