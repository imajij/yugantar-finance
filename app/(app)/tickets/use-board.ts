"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import type { BoardTicket } from "./board";

/**
 * The board's local state: what has changed but not yet come back from the server.
 *
 * Every mutation used to be a `fetch` followed by `router.refresh()`, which meant a
 * server round trip and a re-render before a priority chip changed colour. On a
 * board you are moving through quickly that reads as the interface being slow to
 * believe you.
 *
 * So a change lands locally first and the request follows. Three things make that
 * safe rather than a lie:
 *
 *   - **The override is keyed by ticket and field**, so two changes to different
 *     tickets never fight, and the refresh that arrives later wins cleanly.
 *   - **A failure reverts and says so.** The row goes back to what the server has
 *     and the error names the ticket, because a silent revert is worse than a wait.
 *   - **Only what the server would have allowed anyway.** This is a display cache,
 *     not a permission: the request is still made and still checked.
 */

export type Override = Partial<BoardTicket>;

export interface Mutation {
  /** What to show immediately. */
  optimistic: Override;
  /** The call to make. Returns false to revert. */
  send: () => Promise<Response>;
  /** Named in the error if it fails. */
  label: string;
}

export function useBoard(tickets: BoardTicket[]) {
  const router = useRouter();
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, setPending] = useState<Set<string>>(new Set());
  // Ordering is local until the server confirms, so a drag does not snap back.
  const [order, setOrder] = useState<Record<string, number> | null>(null);
  const inFlight = useRef(0);

  /** The tickets as they should look right now, server truth plus what is in flight. */
  const view = useMemo(() => {
    const merged = tickets.map((t) => (overrides[t.id] ? { ...t, ...overrides[t.id] } : t));
    if (!order) return merged;
    return [...merged].sort((a, b) => (order[a.id] ?? a.board_rank ?? Infinity) - (order[b.id] ?? b.board_rank ?? Infinity));
  }, [tickets, overrides, order]);

  const dismiss = useCallback((i: number) => {
    setErrors((prev) => prev.filter((_, n) => n !== i));
  }, []);

  const apply = useCallback(async (ids: string[], m: Mutation) => {
    setOverrides((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = { ...next[id], ...m.optimistic };
      return next;
    });
    setPending((prev) => new Set([...prev, ...ids]));
    inFlight.current += 1;

    let ok = false;
    let detail = "";
    try {
      const res = await m.send();
      ok = res.ok;
      if (!ok) {
        const body = await res.json().catch(() => null);
        detail = (body as { error?: { message?: string } })?.error?.message ?? `Failed (${res.status})`;
      }
    } catch {
      detail = "The request did not go through";
    }

    setPending((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });

    if (!ok) {
      // Revert exactly what this mutation set, leaving anything else in flight alone.
      setOverrides((prev) => {
        const next = { ...prev };
        for (const id of ids) {
          const rest = { ...next[id] };
          for (const k of Object.keys(m.optimistic)) delete rest[k as keyof Override];
          if (Object.keys(rest).length === 0) delete next[id];
          else next[id] = rest;
        }
        return next;
      });
      setErrors((prev) => [...prev, `${m.label}: ${detail}`]);
    }

    inFlight.current -= 1;
    // Reconcile once the last change settles, so a burst of edits is one refresh.
    if (inFlight.current === 0) {
      setOverrides({});
      setOrder(null);
      router.refresh();
    }
    return ok;
  }, [router]);

  /** A drag inside a column: reorder locally, then tell the server where it landed. */
  const reorder = useCallback(async (id: string, afterId: string | null, beforeId: string | null, at: number) => {
    setOrder((prev) => ({ ...(prev ?? {}), [id]: at }));
    await apply([id], {
      label: "Moving the card",
      optimistic: {},
      send: () => fetch(`/api/v1/tickets/${id}/rank`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ after_id: afterId, before_id: beforeId }),
      }),
    });
  }, [apply]);

  return { view, apply, reorder, errors, dismiss, pending };
}

/**
 * Multi-select, the way a file list does it.
 *
 * Plain click replaces the selection, `Cmd`/`Ctrl` adds one, `Shift` takes the run
 * between the last click and this one. `X` toggles the focused row, which is the
 * keyboard half of the same idea.
 */
export function useSelection(ordered: BoardTicket[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);

  const click = useCallback((id: string, mods: { meta?: boolean; shift?: boolean }) => {
    setSelected((prev) => {
      if (mods.shift && anchor.current) {
        const from = ordered.findIndex((t) => t.id === anchor.current);
        const to = ordered.findIndex((t) => t.id === id);
        if (from !== -1 && to !== -1) {
          const run = ordered.slice(Math.min(from, to), Math.max(from, to) + 1).map((t) => t.id);
          return new Set([...prev, ...run]);
        }
      }
      if (mods.meta) {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        anchor.current = id;
        return next;
      }
      anchor.current = id;
      return new Set([id]);
    });
  }, [ordered]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    anchor.current = id;
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  return { selected, click, toggle, clear, setSelected };
}
