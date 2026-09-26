import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/*
 * Vendored from the shadcn registry, adapted to this app's tokens.
 *
 * Copied rather than installed on purpose: shadcn is a source registry, not a dependency, so
 * these components become OUR tree. That is what makes the publisher vocabulary a closed set by
 * construction — a publisher may name a component only if it exists here.
 *
 * The variant names are the registry's; only the colours changed, and they are now token
 * references rather than literal `white/10` values. A variant can be retuned in one place.
 *
 * THE `brand` VARIANT IS GONE. It was a second accent beside `primary`, and this theme has one:
 * `--brand` and `--primary` are the same green, so the variant drew the same button twice. It
 * had no callers — every one of them used `default`, `ghost`, `outline` or `destructive`.
 * `shadow-primary` is the theme's hard 2px printed edge, which is what makes a filled button
 * read as pressed into the sheet.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-[13px] '
    + 'font-medium transition-colors focus-visible:outline-none '
    + 'disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-primary hover:bg-primary/90',
        outline: 'border border-border bg-transparent hover:bg-accent hover:text-accent-foreground',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        destructive: 'bg-destructive text-destructive-foreground shadow-destructive hover:bg-destructive/90',
      },
      size: {
        default: 'h-8 px-3',
        sm: 'h-7 rounded-sm px-2.5 text-[12px]',
        lg: 'h-9 rounded-lg px-4',
        icon: 'h-7 w-7',
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
