import { useId } from 'react';
import { cn } from '@/lib/utils';

/*
 * Pixel creatures, one per source.
 *
 * Adapted from the Bloks design system (github.com/hamedgitty/bloks): each identity is a black
 * bitmap creature on a coloured tile with smooth white eyes, merged into a single SVG path at
 * module load. The shapes are hand-drawn, so they are taken rather than reinvented.
 *
 * WHY THE TRANSCRIPT NEEDS THEM. Four sources talk in one column — you, the model, the pipeline,
 * and the chain — and colour alone makes that a wall of tinted text. A creature per source turns
 * it into a conversation with participants, which is what it actually is: the model reads, the
 * pipeline builds, the chain confirms, and you asked.
 *
 * IDENTITY IS DETERMINISTIC. The same source always gets the same creature, from a fixed map
 * rather than a hash — a source that changed shape between renders would be worse than no avatar.
 */

const INK = '#101013';
const GRID = 16;
/** The creature box inside the 100x100 tile. */
const BOX = 72;
const BOX_OFFSET = (100 - BOX) / 2;
const CELL = BOX / GRID;

/** '#' is body. Rows are 16 wide and kept chunky: they must read at 22px. */
const BITMAPS: Record<string, { rows: string[]; faceY: number }> = {
  star: {
    rows: [
      '.......##.......',
      '.......##.......',
      '......####......',
      '......####......',
      '.....######.....',
      '....########....',
      '..############..',
      '################',
      '################',
      '..############..',
      '....########....',
      '.....######.....',
      '......####......',
      '......####......',
      '.......##.......',
      '.......##.......',
    ],
    faceY: 7.5,
  },
  burst: {
    rows: [
      '.......##.......',
      '.......##.......',
      '..#....##....#..',
      '..##.######.##..',
      '...##########...',
      '...##########...',
      '..############..',
      '################',
      '################',
      '..############..',
      '...##########...',
      '...##########...',
      '..##.######.##..',
      '..#....##....#..',
      '.......##.......',
      '.......##.......',
    ],
    faceY: 7.5,
  },
  diamond: {
    rows: [
      '................',
      '.......##.......',
      '......####......',
      '.....######.....',
      '....########....',
      '...##########...',
      '..############..',
      '.##############.',
      '.##############.',
      '..############..',
      '...##########...',
      '....########....',
      '.....######.....',
      '......####......',
      '.......##.......',
      '................',
    ],
    faceY: 7.5,
  },
  bit: {
    rows: [
      '................',
      '................',
      '................',
      '................',
      '...##########...',
      '..############..',
      '.##############.',
      '.##############.',
      '.##############.',
      '.##############.',
      '..############..',
      '...##########...',
      '................',
      '................',
      '................',
      '................',
    ],
    faceY: 7.5,
  },
};

/** Each run of '#' becomes a rect subpath, so the whole body is one path. */
function bitmapPath(rows: string[], cell: number, ox: number, oy: number): string {
  let d = '';
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] === '#') {
        let w = 0;
        while (row[x + w] === '#') w++;
        d += `M${(ox + x * cell).toFixed(2)} ${(oy + y * cell).toFixed(2)}`
          + `h${(w * cell).toFixed(2)}v${cell.toFixed(2)}h${(-w * cell).toFixed(2)}Z`;
        x += w;
      } else x++;
    }
  });
  return d;
}

const BODIES: Record<string, { d: string; faceY: number }> = Object.fromEntries(
  Object.entries(BITMAPS).map(([shape, spec]) => [
    shape,
    { d: bitmapPath(spec.rows, CELL, BOX_OFFSET, BOX_OFFSET), faceY: spec.faceY },
  ]),
);

/** Checkerboard along the foot, the retro texture. Cheap and it makes the tile read as a tile. */
const DITHER = (() => {
  const cells: { x: number; y: number }[] = [];
  for (let y = 16; y < 20; y++) {
    for (let x = 0; x < 20; x++) if ((x + y) % 2 === 0) cells.push({ x, y });
  }
  return cells;
})();

function mix(hex: string, target: string, amount: number): string {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(target.slice(1), 16);
  const ch = (shift: number) => {
    const from = (a >> shift) & 0xff;
    const to = (b >> shift) & 0xff;
    return Math.round(from + (to - from) * amount);
  };
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

/** Smooth white eyes on a pixel body — the contrast is the charm. */
function Face({ mood, fy }: { mood: 'deadpan' | 'focused' | 'friendly'; fy: number }) {
  const stroke = {
    fill: 'none',
    stroke: '#fff',
    strokeWidth: 3.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  const eye = (x: number, tilt = 0) => (
    <ellipse
      cx={x}
      cy={fy - 3}
      rx="4"
      ry="6.5"
      fill="#fff"
      transform={tilt ? `rotate(${tilt} ${x} ${fy - 3})` : undefined}
    />
  );

  if (mood === 'focused') {
    return <path d={`M-13 ${fy - 3} H-4 M4 ${fy - 3} H13 M-5 ${fy + 8} H5`} {...stroke} />;
  }
  if (mood === 'friendly') {
    return (
      <>
        {eye(-8, -8)}
        {eye(8, 8)}
        <path d={`M-6 ${fy + 8} Q0 ${fy + 12} 6 ${fy + 8}`} {...stroke} />
      </>
    );
  }
  return (
    <>
      {eye(-8)}
      {eye(8)}
    </>
  );
}

export function Creature({
  shape,
  color,
  mood = 'deadpan',
  size = 22,
  className,
  label,
}: {
  shape: keyof typeof BITMAPS;
  color: string;
  mood?: 'deadpan' | 'focused' | 'friendly';
  size?: number;
  className?: string;
  label?: string;
}) {
  const uid = useId();
  const base = color;
  const deep = mix(base, '#000000', 0.22);
  const body = BODIES[shape] ?? BODIES.star;
  const clipId = `${uid}c`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={cn('shrink-0', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <clipPath id={clipId}>
          <rect width="100" height="100" rx="26" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <rect width="100" height="100" fill={base} />
        <g fill={deep}>
          {DITHER.map(({ x, y }) => (
            <rect key={`${x}-${y}`} x={x * 5} y={y * 5} width={5} height={5} />
          ))}
        </g>
      </g>
      <path d={body.d} fill={INK} shapeRendering="crispEdges" />
      <g transform="translate(50 50)">
        <Face mood={mood} fy={body.faceY} />
      </g>
    </svg>
  );
}

/**
 * A creature per source, fixed rather than derived.
 *
 * A source that changed shape between renders would be worse than no avatar at all, and the map
 * is four entries — a hash would be more code for a worse guarantee.
 */
export const SOURCE_CREATURE: Record<string, { shape: keyof typeof BITMAPS; color: string; mood: 'deadpan' | 'focused' | 'friendly' }> = {
  you: { shape: 'star', color: '#7c8aff', mood: 'friendly' },
  model: { shape: 'burst', color: '#f5a524', mood: 'deadpan' },
  pipeline: { shape: 'diamond', color: '#6b7280', mood: 'focused' },
  chain: { shape: 'bit', color: '#3dd68c', mood: 'deadpan' },
};

export function SourceAvatar({ source, size = 22 }: { source: string; size?: number }) {
  const c = SOURCE_CREATURE[source] ?? SOURCE_CREATURE.pipeline;
  return <Creature shape={c.shape} color={c.color} mood={c.mood} size={size} label={source} />;
}
