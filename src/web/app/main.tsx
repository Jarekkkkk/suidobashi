/*
 * The React entry.
 *
 * Deliberately a SKELETON: it proves React, TypeScript, Tailwind and the three-pane
 * layout build and render, before any of the existing page's logic is ported across.
 *
 * Port first, then add — a rewrite that also redesigns is two changes at once, and when
 * it breaks you cannot tell which one did it. So this step adds nothing but the shell,
 * and the port comes next.
 *
 * Nothing here talks to the server yet.
 */
import { createRoot } from 'react-dom/client';
import { cn } from '@/lib/utils';

/**
 * The layout, in one place.
 *
 * Three panes, and the widths are a first guess rather than a design: the sidebar is
 * narrow because it lists names, the right pane is wide because it shows terms and a
 * chart. Both collapse when the window is small, since a three-column trading surface on
 * a laptop is the common case and a broken grid is worse than a hidden pane.
 */
function App() {
  return (
    <div className={cn(
      'grid h-full',
      'grid-cols-1 md:grid-cols-[240px_1fr] xl:grid-cols-[240px_1fr_400px]',
    )}>
      {/* Left — the marketplace. Published tools and installed ones. */}
      <aside className="hidden border-r border-white/10 p-4 md:block">
        <div className="text-xs uppercase tracking-wider text-white/40">agents</div>
        <p className="mt-3 text-sm text-white/50">
          Published and installed tools will list here.
        </p>
      </aside>

      {/* Centre — the chat. The core loop, and the first pane to be built. */}
      <main className="flex min-w-0 flex-col">
        <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <span className="font-semibold">sui-tokyo</span>
          <span className="text-xs text-white/40">shell</span>
        </header>
        <div className="flex-1 overflow-y-auto p-4">
          <p className="text-sm text-white/50">
            The chat goes here, driven by the pipeline's events.
          </p>
        </div>
      </main>

      {/* Right — what is about to be signed, and which step of the flow we are at. */}
      <aside className="hidden border-l border-white/10 p-4 xl:block">
        <div className="text-xs uppercase tracking-wider text-white/40">signing</div>
        <p className="mt-3 text-sm text-white/50">
          The step indicator and the transaction's terms, read from the chain.
        </p>
      </aside>
    </div>
  );
}

const root = document.getElementById('app');
if (!root) throw new Error('no #app element — the page shell is missing');
createRoot(root).render(<App />);
