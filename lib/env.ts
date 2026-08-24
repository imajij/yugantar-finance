/**
 * Reading configuration, with one rule: **blank is unset.**
 *
 * `.env.example` lists every variable, including the optional ones, with nothing
 * after the `=`. Copying it — which is the documented first step — leaves
 * `R2_ENDPOINT=""` in the environment rather than absent. `??` and `?.` only fall
 * back on `undefined`, so an empty string sails straight past a default:
 *
 *     process.env.R2_ENDPOINT ?? `https://${id}.r2.cloudflarestorage.com`
 *     // => "" , and every presigned URL is then built against an empty host
 *
 * That failure is silent and looks like a credentials problem, so it costs an
 * afternoon. `env()` returns `undefined` for anything blank, which is what every
 * caller already assumes it gets.
 */

/** The value of `name`, or `undefined` if it is unset, empty, or only whitespace. */
export function env(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The value of `name`, or `fallback` when it is blank. */
export function envOr(name: string, fallback: string): string {
  return env(name) ?? fallback;
}

/** True when every one of these is set to something. Used for "is X configured?". */
export function envAllSet(...names: string[]): boolean {
  return names.every((name) => env(name) !== undefined);
}
