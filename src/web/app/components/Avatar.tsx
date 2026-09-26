/*
 * One face per identity.
 *
 * THESE WERE PIXEL CREATURES: hand-written 16×16 bitmaps merged into SVG paths at module load.
 * They are now five illustrations under `src/web/app/icons/`, so the drawing code is gone rather
 * than sitting dead beside the images. The history has it (`pixel creatures, one source, so the
 * transcript reads as a conversation`) if the old shapes are ever wanted back.
 *
 * WHY THE TRANSCRIPT NEEDS THEM AT ALL, which has not changed: four sources talk in one column —
 * you, the model, the pipeline, and the chain — and colour alone makes that a wall of tinted text.
 * A face per source turns it back into a conversation with participants: the model reads, the
 * pipeline builds, the chain confirms, and you asked.
 *
 * IDENTITY IS DETERMINISTIC. The same source always gets the same face, from a fixed map rather
 * than a hash — a source that changed face between renders would be worse than no avatar.
 *
 * THE IMAGES ARE SERVED FROM OUR OWN ORIGIN (`/icons/<name>.png`, see ui.ts) and are 256×256. They
 * are shown at 14–22px, so the 1254×1254 originals were ~90× more pixels than any render can use;
 * the tree keeps the ~75 KB versions rather than the 4.6 MB set. Vendored art, not fetched at page
 * load — the same rule as the fonts, the texture and the wallet bundle.
 */
import { cn } from '@/lib/utils';

/** Which illustration each identity wears: the four event sources, and the wallet's own face. */
const FACE: Record<string, string> = {
  you: 'pink',
  model: 'blonde',
  pipeline: 'black',
  chain: 'teal',
  wallet: 'blue',
};

/**
 * A face for a source, fixed rather than derived.
 *
 * An unknown source falls back to the pipeline's face. A face is decoration, and rendering a blank
 * where a participant should be is worse than rendering the wrong one — the colour and the source
 * label still say who it is.
 */
export function SourceAvatar({ source, size = 22, className }: {
  source: string; size?: number; className?: string;
}) {
  return (
    <img
      src={`/icons/${FACE[source] ?? FACE.pipeline}.png`}
      width={size}
      height={size}
      // Decorative: the transcript names the source in the bubble's own text and colour, so a
      // screen reader announcing "pink" would be noise. Matches what the old avatar did.
      alt=""
      aria-hidden
      // One rule for art with and without an alpha channel: two of the five carry transparency and
      // three do not, and clipping to a circle makes them the same shape either way.
      className={cn('shrink-0 rounded-full object-cover', className)}
    />
  );
}
