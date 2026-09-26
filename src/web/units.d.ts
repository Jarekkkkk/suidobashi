/*
 * Types for units.js, which stays plain JavaScript because the CLI scripts import it
 * directly and are not part of the TypeScript program.
 *
 * This exists because inference from the .js file was unreliable: `tsc` resolved it and
 * reported clean, while the editor's language server reported "implicitly has an 'any'
 * type" on every edit. Rather than keep re-checking which one was right, the shape is
 * declared once and both agree.
 *
 * It is also a better answer than inference: these are the exact return types, and the
 * distinction between a nullable parse and a total format is the one that matters. A
 * `null` from toUnits means "not a number", which is different from "zero" — a difference
 * that has already caused three bugs in this project.
 */

export const SUI_DECIMALS: number;
export const USDC_DECIMALS: number;

/** Decimal text -> integer units, or null if it is not a valid amount. */
export function toUnits(text: unknown, decimals: number): string | null;

/** Integer units -> a decimal string. Always succeeds. */
export function fromUnits(raw: unknown, decimals: number): string;

/** SUI as typed by a person -> MIST, or null. */
export const suiToMist: (text: unknown) => string | null;

/** USDC as typed by a person -> 6-decimal units, or null. */
export const usdcToUnits: (text: unknown) => string | null;

/** MIST -> a decimal string, for messages. */
export const mistToSui: (raw: unknown) => string;

/** 6-decimal USDC units -> a decimal string, for messages. */
export const unitsToUsdc: (raw: unknown) => string;
