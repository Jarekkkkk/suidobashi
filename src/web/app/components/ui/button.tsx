import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/*
 * Vendored from the shadcn registry, unchanged apart from the comment.
 *
 * Copied rather than installed on purpose: shadcn is a source registry, not a dependency,
 * so these components become OUR tree. That is what makes the publisher vocabulary a
 * closed set by construction — a publisher may name a component only if it exists here.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium '
    + 'transition-colors focus-visible:outline-none focus-visible:ring-1 '
    + 'focus-visible:ring-white/30 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-white text-black hover:bg-white/90',
        outline: 'border border-white/15 hover:bg-white/5',
        ghost: 'hover:bg-white/5',
        destructive: 'bg-red-600 text-white hover:bg-red-500',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>
  & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
