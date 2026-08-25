/**
 * Reading values off a raw `db.execute` result.
 *
 * Drizzle's query builder knows each column's type and hands back a `Date` for a
 * `timestamptz`. A raw `db.execute(sql\`...\`)` does not: it returns whatever the
 * driver produced, which for a timestamp is a **string**. Every row shape in this
 * codebase is therefore hand-written, and `r.created_at as Date` is a lie the
 * compiler happily accepts and nothing catches until a page calls `.toISOString()`
 * on it in production.
 *
 * That has now happened three times — the ticket board's due date, the channel
 * list's last message, and a dashboard column before either. So the cast is
 * replaced by a coercion with a name: `asDate` produces a real `Date` whichever the
 * driver gave, and the declared type stops being a guess.
 */

/** A timestamp column from a raw result, as a real Date. */
export function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/** The same, for a column that may be null. */
export function asDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return asDate(value);
}

/**
 * A numeric column. `bigint` and `numeric` come back as strings from postgres-js —
 * deliberately, since they can exceed a JS number — so paise totals need this and
 * not a cast. Values beyond `Number.MAX_SAFE_INTEGER` would lose precision here,
 * which for money in paise means sums above ~₹90,000,000,000,000.
 */
export function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}
