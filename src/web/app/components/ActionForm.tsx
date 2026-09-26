import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/*
 * A labelled input, and a row of them that runs an action.
 *
 * ONE PATTERN, TEN USES. The admin actions differ in their parameters, not in their shape: a
 * label, some fields, a button, and the same build→sign→submit behind it. Writing ten forms
 * would be ten places to get the disabled state, the busy state and the error wording wrong.
 *
 * WHY THESE ARE FORMS AND NOT PROMPTS. The chat is the interface for the loop you repeat — an
 * escrow swap reads well as a sentence. These are setup: rare, and each takes a parameter that
 * moves money or changes a grant. A form beats a prompt for something you do twice, and doing
 * it by sentence means a model has to be right about a number it should not be choosing.
 */

export type FieldSpec = {
  key: string;
  label: string;
  placeholder: string;
  /** Width in characters — amounts are short, addresses are long. */
  width?: 'xs' | 'sm' | 'lg';
};

const WIDTHS = { xs: 'w-14', sm: 'w-20', lg: 'w-full' } as const;

export function ActionForm({
  label,
  fields,
  runLabel,
  busy,
  danger,
  onRun,
}: {
  label: string;
  fields: FieldSpec[];
  runLabel: string;
  busy: boolean;
  danger?: boolean;
  onRun: (values: Record<string, string>) => void | Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);

  const complete = fields.every((f) => (values[f.key] ?? '').trim() !== '');

  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex items-center gap-1.5 text-left text-[11px] transition-colors',
          open ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <span className={cn('transition-transform', open && 'rotate-90')}>›</span>
        {label}
      </button>

      {open && (
        <div className="animate-rise-in flex flex-col gap-1.5 pl-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {fields.map((f) => (
              <label key={f.key} className="flex items-center gap-1 text-[11px] text-muted-foreground">
                {f.label}
                <input
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  className={cn(
                    'rounded-sm border border-input bg-background px-1.5 py-1 font-mono',
                    'text-[11px] text-foreground outline-none placeholder:text-muted-foreground/40',
                    'focus:border-brand/60',
                    WIDTHS[f.width ?? 'sm'],
                  )}
                />
              </label>
            ))}
          </div>
          <Button
            size="sm"
            variant={danger ? 'destructive' : 'outline'}
            className="w-full"
            // Disabled until every field has something in it. The server refuses an incomplete
            // action too — this just means the user is not told about it by a round trip.
            disabled={busy || !complete}
            onClick={() => void onRun(values)}
          >
            {runLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
