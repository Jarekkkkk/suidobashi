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
 * are shown at 20–36px, so the 1254×1254 originals were ~90× more pixels than any render can use;
 * the tree keeps the ~75 KB versions rather than the 4.6 MB set. Vendored art, not fetched at page
 * load — the same rule as the fonts, the texture and the wallet bundle.
 *
 * pink.png IS NOW UNREFERENCED, kept because it was downloaded deliberately and is one line away
 * from being a fifth identity.
 */
import { cn } from '@/lib/utils';

/**
 * Which illustration each identity wears.
 *
 * `you` AND `wallet` ARE DELIBERATELY THE SAME FACE: they are the same person. The footer and the
 * home page draw the account, and the transcript draws the person who typed the request — showing
 * two different faces for one human made the app look like it had a participant nobody could
 * identify. Blue was already the account's, so the user's turn took it and pink fell out of use.
 */
const FACE: Record<string, string> = {
  you: 'blue',
  model: 'blonde',
  pipeline: 'black',
  chain: 'teal',
  wallet: 'blue',
};

/**
 * THE SHAPE IS A MASK, NOT A CLIP — and that distinction is the whole reason for the file.
 *
 * The theme's shape 5 is a soft-edged blob: its own SVG carries an `feGaussianBlur`, so its alpha
 * feathers at the edge. `clip-path` is a HARD cut and would throw the feather away, leaving a
 * sticker. `mask-image` keeps the alpha gradient, which is what makes it read as watercolour.
 *
 * Served from our own origin like every other asset here — the fonts, the texture, the hero and
 * the five faces — so nothing about how the app looks depends on a CDN being reachable.
 */
const MASK = '/mask-shape-5.svg';
const MASK_STYLE: React.CSSProperties = {
  maskImage: `url(${MASK})`,
  maskSize: '100% 100%',
  maskRepeat: 'no-repeat',
  maskPosition: 'center',
  // Safari needs the prefix; Chrome ignores it. Both are here rather than a browser sniff.
  WebkitMaskImage: `url(${MASK})`,
  WebkitMaskSize: '100% 100%',
  WebkitMaskRepeat: 'no-repeat',
  WebkitMaskPosition: 'center',
};

/**
 * A face for a source, fixed rather than derived.
 *
 * An unknown source falls back to the pipeline's face. A face is decoration, and rendering a blank
 * where a participant should be is worse than rendering the wrong one — the colour and the source
 * label still say who it is.
 */
export function SourceAvatar({ source, size = 28, className }: {
  source: string; size?: number; className?: string;
}) {
  return (
    <img
      src={`/icons/${FACE[source] ?? FACE.pipeline}.png`}
      width={size}
      height={size}
      // Decorative: the transcript names the source in the bubble's own text and colour, so a
      // screen reader announcing "pink" would be noise.
      alt=""
      aria-hidden
      // The shape comes from the mask, so there is no border radius here — and `object-cover`
      // keeps one rule for art with and without an alpha channel.
      style={MASK_STYLE}
      className={cn('shrink-0 object-cover', className)}
    />
  );
}
