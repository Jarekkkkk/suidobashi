import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names, letting later ones win over earlier ones of the same kind.
 *
 * Vendored from shadcn's convention rather than invented: it is what every component in
 * that registry expects to exist, so keeping it identical means components can be copied
 * in unmodified.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
