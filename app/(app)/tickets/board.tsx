"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Check, ChevronDown, Columns3, Command, Filter, Keyboard, List, Plus,
  Search, SquareCheckBig, X,
} from "lucide-react";
import { formatPaise } from "@/lib/money";
import { chipStyle, stateLabel } from "@/lib/state-chip";
import {
  CATEGORY_ENTRY_ACTIONS, CATEGORY_LABEL, TICKET_CATEGORIES,
  type TicketCategory,
} from "@/lib/state-machines/ticket";
import { useBoard, useSelection } from "./use-board";
import { CommandPalette, type Command as PaletteCommand } from "./palette";
import { Peek } from "./peek";

/**
 * The ticket board.
 *
 * Two things carried over from Linear, and one that could not be.
 *
 * Carried over: **the board is a view, not a state.** Filters, grouping and layout
 * all live in the URL, so a board is a link you can send someone — "here is every
 * urgent Logistics ticket in this cycle" — and the back button does what it should.
 * And **the keyboard is the primary interface** for anyone who lives here: select a
 * row, press S for status, A for assignee, P for priority, L for labels.
 *
 * Not carried over: dragging a card between columns does *not* set its status.
 * Status only moves through the state machine (18.2 rule 2), where each transition
 * knows who may fire it and what it needs — a rejection needs a reason, starting
 * work is the assignee's to do. So a drop is resolved to the first *legal*
 * transition into that column and refused, out loud, when there is none. That is
 * the honest version of the interaction: the board can express anything the rules
 * allow and nothing they don't.
 *
 * The interaction layer around all that is in three files beside this one, because
 * each is a whole idea: `use-board` holds what has changed but not yet come back
 * from the server, `palette` is Cmd+K, and `peek` is reading a card without losing
 * your place. Dragging *within* a column is ordering rather than a decision, so it
 * goes to its own endpoint and never through a transition.
 */

/* ------------------------------------------------------------------- types */

export interface BoardTicket {
  id: string;
  human_id: string;
  title: string;
  status: string;
  category: TicketCategory;
  priority: string;
  due_at: string;
  overdue: boolean;
  escalated: boolean;
  requesting_department: string;
  requesting_department_id: string;
  target_department: string;
  target_department_id: string;
  requester: string;
  assignee: string | null;
  assignee_id: string | null;
  location: string | null;
  estimated_cost_paise: number | null;
  comment_count: number;
  labels: { id: string; name: string; color: string }[];
  project: string | null;
  project_id: string | null;
  cycle: string | null;
  cycle_id: string | null;
  parent_id: string | null;
  parent_human_id: string | null;
  child_count: number;
  child_done_count: number;
  blocked_by: number;
  /** Where it sits in its column once somebody has dragged it. */
  board_rank: number | null;
}

export interface Option { id: string; name: string }
export interface LabelOption extends Option { color: string }
export interface MemberOption extends Option { departmentId: string }

export interface BoardProps {
  tickets: BoardTicket[];
  labels: LabelOption[];
  projects: Option[];
  cycles: Option[];
  departments: Option[];
  members: MemberOption[];
  counts: Record<string, number>;
  me: { id: string; departmentId: string };
}

type GroupBy = "status" | "assignee" | "priority" | "department" | "project" | "cycle" | "label" | "none";

const SCOPES = [
  { key: "inbox", label: "Inbox", hint: "Asked of your department" },
  { key: "outgoing", label: "Outgoing", hint: "Your department's asks of others" },
  { key: "assigned", label: "Assigned", hint: "On you" },
  { key: "created", label: "Created", hint: "Raised by you" },
  { key: "subscribed", label: "Subscribed", hint: "Tickets you watch" },
  { key: "all", label: "All", hint: "Everything you can see" },
] as const;

const PRIORITIES = ["URGENT", "HIGH", "MEDIUM", "LOW"] as const;

const PRIORITY_TONE: Record<string, string> = {
  URGENT: "var(--flag-high-fg)", HIGH: "var(--flag-high-fg)",
  MEDIUM: "var(--flag-medium-fg)", LOW: "var(--yg-text-muted)",
};

/** Priority is a chip like everything else, not bare lowercase text. */
const PRIORITY_BG: Record<string, string> = {
  URGENT: "var(--flag-high-bg)", HIGH: "var(--flag-high-bg)",
  MEDIUM: "var(--flag-medium-bg)", LOW: "var(--yg-surface-2)",
};

/** The dot on a board column head — the same semantic tones as the chips. */
const CATEGORY_TONE: Record<TicketCategory, string> = {
  TRIAGE: "var(--state-waiting-fg)",
  BACKLOG: "var(--state-waiting-fg)",
  TODO: "var(--state-moving-fg)",
  IN_PROGRESS: "var(--state-moving-fg)",
  DONE: "var(--state-done-fg)",
  CANCELLED: "var(--flag-high-fg)",
};

const GROUPS: { key: GroupBy; label: string }[] = [
  { key: "status", label: "Status" },
  { key: "assignee", label: "Assignee" },
  { key: "priority", label: "Priority" },
  { key: "department", label: "Department" },
  { key: "project", label: "Project" },
  { key: "cycle", label: "Cycle" },
  { key: "label", label: "Label" },
  { key: "none", label: "Nothing" },
];

/* ---------------------------------------------------------------- grouping */

interface Group { key: string; label: string; tickets: BoardTicket[]; category?: TicketCategory }

/**
 * Status grouping always shows every column, empty ones included — a board where
 * "In Progress" vanishes when nothing is in progress is a board you cannot drop
 * onto. Every other grouping shows only the buckets that have something in them.
 */
function group(tickets: BoardTicket[], by: GroupBy, opts: {
  members: MemberOption[]; labels: LabelOption[]; projects: Option[]; cycles: Option[];
}): Group[] {
  if (by === "status") {
    return TICKET_CATEGORIES.map((c) => ({
      key: c,
      label: CATEGORY_LABEL[c],
      category: c,
      tickets: tickets.filter((t) => t.category === c),
    }));
  }

  if (by === "priority") {
    return PRIORITIES
      .map((p) => ({ key: p, label: p[0] + p.slice(1).toLowerCase(), tickets: tickets.filter((t) => t.priority === p) }))
      .filter((g) => g.tickets.length > 0);
  }

  if (by === "none") return [{ key: "all", label: "All tickets", tickets }];

  if (by === "label") {
    // A ticket with three labels belongs in three buckets, which is the only
    // honest way to group by something a ticket can have many of.
    const groups = opts.labels.map((l) => ({
      key: l.id, label: l.name, tickets: tickets.filter((t) => t.labels.some((x) => x.id === l.id)),
    })).filter((g) => g.tickets.length > 0);
    const none = tickets.filter((t) => t.labels.length === 0);
    return none.length ? [...groups, { key: "none", label: "No label", tickets: none }] : groups;
  }

  const keyOf = (t: BoardTicket) =>
    by === "assignee" ? t.assignee_id
    : by === "department" ? t.target_department_id
    : by === "project" ? t.project_id
    : t.cycle_id;

  const nameOf = (t: BoardTicket) =>
    by === "assignee" ? t.assignee
    : by === "department" ? t.target_department
    : by === "project" ? t.project
    : t.cycle;

  const empty =
    by === "assignee" ? "Unassigned"
    : by === "project" ? "No project"
    : by === "cycle" ? "No cycle"
    : "No department";

  const buckets = new Map<string, Group>();
  for (const t of tickets) {
    const k = keyOf(t) ?? "∅";
    const g = buckets.get(k) ?? { key: k, label: nameOf(t) ?? empty, tickets: [] };
    g.tickets.push(t);
    buckets.set(k, g);
  }
  // Unfiled last: it is the bucket you are trying to empty, not the one you read first.
  return [...buckets.values()].sort((a, b) =>
    a.key === "∅" ? 1 : b.key === "∅" ? -1 : a.label.localeCompare(b.label));
}

/* ------------------------------------------------------------------ the UI */

export function Board(props: BoardProps) {
  const { tickets, labels, projects, cycles, departments, members, counts, me } = props;
  const router = useRouter();
  const params = useSearchParams();

  const scope = params.get("scope") ?? "inbox";
  const layout = params.get("layout") === "list" ? "list" : "board";
  const groupBy = (params.get("group") ?? "status") as GroupBy;
  const query = params.get("q") ?? "";

  const [search, setSearch] = useState(query);
  const [menu, setMenu] = useState<{ kind: string; ticket: string } | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [peeking, setPeeking] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // What has changed but not yet come back from the server, plus the errors from
  // anything that failed on the way. See `use-board`.
  const { view, apply, reorder, errors, dismiss, pending } = useBoard(tickets);

  /** Every control writes to the URL, so a board is always a link. */
  const setParam = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    router.push(`/tickets?${next}`, { scroll: false });
  }, [params, router]);

  const toggleInList = useCallback((param: string, value: string) => {
    const current = (params.get(param) ?? "").split(",").filter(Boolean);
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    setParam({ [param]: next.join(",") || null });
  }, [params, setParam]);

  const groups = useMemo(
    () => group(view, groupBy, { members, labels, projects, cycles }),
    [view, groupBy, members, labels, projects, cycles],
  );

  const ordered = useMemo(() => groups.flatMap((g) => g.tickets), [groups]);
  const byId = useMemo(() => new Map(view.map((t) => [t.id, t])), [view]);

  // The row the keyboard is on, and the rows a bulk action would touch. They are
  // different things: you move focus with J/K and take rows with X.
  const [focused, setFocused] = useState<string | null>(null);
  const { selected, click, toggle, clear } = useSelection(ordered);

  // What a command would act on: the taken rows if there are any, otherwise the one
  // under the keyboard. Memoised because the palette is rebuilt from it.
  const acting = useMemo(
    () => (selected.size > 0 ? [...selected] : focused ? [focused] : []),
    [selected, focused],
  );

  /* ------------------------------------------------------------ mutations */

  /**
   * A field change on one or many tickets. It lands on screen at once and the
   * request follows; a failure reverts that field and says which ticket.
   */
  const patch = useCallback((ids: string[], body: Record<string, unknown>, optimistic: Partial<BoardTicket>, what: string) => {
    if (ids.length === 0) return;
    apply(ids, {
      label: ids.length === 1 ? `${byId.get(ids[0])?.human_id ?? "That ticket"} — ${what}` : `${ids.length} tickets — ${what}`,
      optimistic,
      send: async () => {
        // One request per ticket: the API takes one at a time, and a partial
        // failure should leave the ones that worked alone.
        const results = await Promise.all(ids.map((id) => fetch(`/api/v1/tickets/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })));
        return results.find((r) => !r.ok) ?? results[0];
      },
    });
  }, [apply, byId]);

  /**
   * A drop resolves to a transition. `CATEGORY_ENTRY_ACTIONS` lists the ways into
   * each column in preference order; the first the server accepts wins, and if the
   * ticket is already there we do nothing rather than firing something spurious.
   *
   * Deliberately *not* optimistic. Everything else on this board is a field the
   * caller owns, but a status is the state machine's and it is allowed to say no —
   * showing the card in its new column before the server agrees would be the
   * interface making a promise it does not get to keep.
   */
  const moveTo = useCallback(async (ids: string[], category: TicketCategory) => {
    const candidates = CATEGORY_ENTRY_ACTIONS[category];
    if (candidates.length === 0) return;

    for (const id of ids) {
      const ticket = byId.get(id);
      if (!ticket || ticket.category === category) continue;

      await apply([id], {
        label: `${ticket.human_id} cannot move to ${CATEGORY_LABEL[category]}`,
        optimistic: {},
        send: async () => {
          let last: Response | null = null;
          for (const action of candidates) {
            const res = await fetch(`/api/v1/tickets/${id}/transitions`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action }),
            });
            if (res.ok) return res;
            // A transition that needs a reason, or that this person may not fire,
            // is not a reason to give up on the column — the next candidate may
            // still work.
            const body = await res.clone().json().catch(() => null);
            last = res;
            if ((body as { error?: { code?: string } })?.error?.code !== "INVALID_TRANSITION") break;
          }
          return last!;
        },
      });
    }
  }, [apply, byId]);

  /* ------------------------------------------------------------- keyboard */

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

      // Cmd+K is the one shortcut that works from anywhere, including a field.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }

      if (e.key === "Escape") {
        if (menu) setMenu(null);
        else if (peeking) setPeeking(null);
        else if (typing) (el as HTMLInputElement).blur();
        else if (selected.size > 0) clear();
        else setFocused(null);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key === "c") { e.preventDefault(); router.push("/tickets/new"); return; }
      if (e.key === "?") { e.preventDefault(); setShowKeys((v) => !v); return; }

      if (e.key === "j" || e.key === "ArrowDown" || e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        if (ordered.length === 0) return;
        const step = e.key === "j" || e.key === "ArrowDown" ? 1 : -1;
        const at = focused ? ordered.findIndex((t) => t.id === focused) : -1;
        const next = at === -1 ? (step === 1 ? 0 : ordered.length - 1)
          : Math.min(ordered.length - 1, Math.max(0, at + step));
        setFocused(ordered[next].id);
        document.getElementById(`ticket-${ordered[next].id}`)?.scrollIntoView({ block: "nearest" });
        return;
      }

      if (!focused) return;

      // X takes a row without opening it — the keyboard half of multi-select.
      if (e.key === "x") { e.preventDefault(); toggle(focused); return; }
      if (e.key === " ") { e.preventDefault(); setPeeking((p) => (p === focused ? null : focused)); return; }
      if (e.key === "Enter") { e.preventDefault(); router.push(`/tickets/${focused}`); return; }

      const opens: Record<string, string> = { s: "status", a: "assignee", p: "priority", l: "label" };
      if (opens[e.key]) {
        e.preventDefault();
        setMenu({ kind: opens[e.key], ticket: focused });
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ordered, focused, selected, menu, peeking, router, clear, toggle]);

  /* -------------------------------------------------------------- palette */

  /**
   * Built from what is available right now: with rows taken it offers actions on
   * them, with none it offers navigation and filters. A palette that offers you
   * things you cannot do is a menu.
   */
  const commands = useMemo<PaletteCommand[]>(() => {
    const list: PaletteCommand[] = [];
    const count = acting.length;
    const on = count === 1 ? byId.get(acting[0])?.human_id ?? "" : `${count} tickets`;

    if (count > 0) {
      for (const c of TICKET_CATEGORIES.filter((x) => CATEGORY_ENTRY_ACTIONS[x].length > 0)) {
        list.push({
          id: `move-${c}`, group: `Move ${on}`, label: `to ${CATEGORY_LABEL[c]}`,
          icon: <span className="size-2 rounded-full" style={{ background: CATEGORY_TONE[c] }} />,
          run: () => moveTo(acting, c),
        });
      }
      for (const p of PRIORITIES) {
        list.push({
          id: `prio-${p}`, group: `Set priority on ${on}`, label: p[0] + p.slice(1).toLowerCase(),
          icon: <span className="size-2 rounded-full" style={{ background: PRIORITY_TONE[p] }} />,
          run: () => patch(acting, { priority: p }, { priority: p }, "priority"),
        });
      }
      const shared = acting.length === 1 ? byId.get(acting[0])?.target_department_id : null;
      for (const m of members.filter((x) => !shared || x.departmentId === shared)) {
        list.push({
          id: `assign-${m.id}`, group: `Assign ${on}`, label: m.name,
          hint: m.id === me.id ? "you" : undefined,
          run: () => patch(acting, { assignee_id: m.id }, { assignee: m.name, assignee_id: m.id }, "assignee"),
        });
      }
      list.push({
        id: "unassign", group: `Assign ${on}`, label: "Nobody",
        run: () => patch(acting, { assignee_id: null }, { assignee: null, assignee_id: null }, "assignee"),
      });
      for (const p of projects) {
        list.push({
          id: `proj-${p.id}`, group: `File ${on}`, label: `in ${p.name}`,
          run: () => patch(acting, { project_id: p.id }, { project: p.name, project_id: p.id }, "project"),
        });
      }
      for (const c of cycles) {
        list.push({
          id: `cyc-${c.id}`, group: `File ${on}`, label: `in ${c.name}`,
          run: () => patch(acting, { cycle_id: c.id }, { cycle: c.name, cycle_id: c.id }, "cycle"),
        });
      }
    }

    for (const sc of SCOPES) {
      list.push({ id: `scope-${sc.key}`, group: "Go to", label: sc.label, hint: sc.hint, run: () => setParam({ scope: sc.key }) });
    }
    list.push({ id: "layout-board", group: "View", label: "Board", run: () => setParam({ layout: "board" }) });
    list.push({ id: "layout-list", group: "View", label: "List", run: () => setParam({ layout: "list" }) });
    for (const g of GROUPS) {
      list.push({ id: `group-${g.key}`, group: "Group by", label: g.label, run: () => setParam({ group: g.key }) });
    }
    for (const p of PRIORITIES) {
      list.push({ id: `filter-${p}`, group: "Filter", label: `Priority is ${p.toLowerCase()}`, run: () => setParam({ priority: p }) });
    }
    for (const l of labels) {
      list.push({
        id: `filter-label-${l.id}`, group: "Filter", label: `Labelled ${l.name}`,
        icon: <span className="size-2 rounded-full" style={{ background: l.color }} />,
        run: () => toggleInList("labels", l.id),
      });
    }
    list.push({ id: "filter-overdue", group: "Filter", label: "Overdue only", run: () => setParam({ overdue: "1" }) });
    list.push({ id: "filter-unassigned", group: "Filter", label: "Unassigned only", run: () => setParam({ unassigned: "1" }) });
    list.push({
      id: "filter-clear", group: "Filter", label: "Clear every filter",
      run: () => setParam({ priority: null, labels: null, project: null, cycle: null, department: null, overdue: null, unassigned: null }),
    });
    list.push({ id: "new", group: "Create", label: "New ticket", hint: "C", run: () => router.push("/tickets/new") });
    list.push({ id: "plan", group: "Create", label: "Labels & projects", run: () => router.push("/tickets/planning") });

    return list;
  }, [acting, byId, members, projects, cycles, labels, me.id, moveTo, patch, setParam, toggleInList, router]);

  /* --------------------------------------------------------------- render */

  const activeFilters = ["priority", "labels", "project", "cycle", "department", "overdue", "unassigned"]
    .filter((k) => params.get(k));

  return (
    <div className="flex min-h-0 flex-col">
      {/* ---- scopes */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {SCOPES.map((s) => (
          <button
            key={s.key}
            type="button"
            title={s.hint}
            onClick={() => setParam({ scope: s.key })}
            className="flex h-[var(--row-h)] items-center rounded-full px-4 text-[13px]"
            style={
              scope === s.key
                ? { background: "var(--yg-accent)", color: "var(--yg-on-accent)" }
                : { border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }
            }
          >
            {s.label}
            {counts[s.key] > 0 && <span className="tnum ml-1.5 opacity-70">{counts[s.key]}</span>}
          </button>
        ))}
      </div>

      {/* ---- toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div
          className="flex h-[var(--row-h)] min-w-56 flex-1 items-center gap-2.5 rounded-full px-4"
          style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
        >
          <Search size={14} className="text-text-muted" aria-hidden />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setParam({ q: search || null });
              if (e.key === "Escape") { setSearch(""); setParam({ q: null }); }
            }}
            placeholder="Search titles, ids and descriptions — press /"
            className="w-full bg-transparent text-sm outline-none"
            aria-label="Search tickets"
          />
          {query && (
            <button type="button" onClick={() => { setSearch(""); setParam({ q: null }); }} aria-label="Clear search">
              <X size={14} className="text-text-muted" aria-hidden />
            </button>
          )}
        </div>

        <Dropdown
          label={`Group: ${GROUPS.find((g) => g.key === groupBy)?.label ?? "Status"}`}
          icon={<Filter size={13} aria-hidden />}
        >
          {GROUPS.map((g) => (
            <MenuItem key={g.key} selected={groupBy === g.key} onSelect={() => setParam({ group: g.key })}>
              {g.label}
            </MenuItem>
          ))}
        </Dropdown>

        <Dropdown label="Filter" icon={<Filter size={13} aria-hidden />} badge={activeFilters.length}>
          <MenuLabel>Priority</MenuLabel>
          {PRIORITIES.map((p) => (
            <MenuItem
              key={p}
              selected={params.get("priority") === p}
              onSelect={() => setParam({ priority: params.get("priority") === p ? null : p })}
            >
              <span style={{ color: PRIORITY_TONE[p] }}>{p[0] + p.slice(1).toLowerCase()}</span>
            </MenuItem>
          ))}

          {labels.length > 0 && <MenuLabel>Label</MenuLabel>}
          {labels.map((l) => (
            <MenuItem
              key={l.id}
              selected={(params.get("labels") ?? "").split(",").includes(l.id)}
              onSelect={() => toggleInList("labels", l.id)}
            >
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: l.color }} aria-hidden />
                {l.name}
              </span>
            </MenuItem>
          ))}

          {projects.length > 0 && <MenuLabel>Project</MenuLabel>}
          {projects.map((p) => (
            <MenuItem
              key={p.id}
              selected={params.get("project") === p.id}
              onSelect={() => setParam({ project: params.get("project") === p.id ? null : p.id })}
            >
              {p.name}
            </MenuItem>
          ))}

          {cycles.length > 0 && <MenuLabel>Cycle</MenuLabel>}
          {cycles.map((c) => (
            <MenuItem
              key={c.id}
              selected={params.get("cycle") === c.id}
              onSelect={() => setParam({ cycle: params.get("cycle") === c.id ? null : c.id })}
            >
              {c.name}
            </MenuItem>
          ))}

          <MenuLabel>Department</MenuLabel>
          {departments.map((d) => (
            <MenuItem
              key={d.id}
              selected={params.get("department") === d.id}
              onSelect={() => setParam({ department: params.get("department") === d.id ? null : d.id })}
            >
              {d.name}
            </MenuItem>
          ))}

          <MenuLabel>Only</MenuLabel>
          <MenuItem
            selected={params.get("overdue") === "1"}
            onSelect={() => setParam({ overdue: params.get("overdue") === "1" ? null : "1" })}
          >
            Overdue
          </MenuItem>
          <MenuItem
            selected={params.get("unassigned") === "1"}
            onSelect={() => setParam({ unassigned: params.get("unassigned") === "1" ? null : "1" })}
          >
            Unassigned
          </MenuItem>
        </Dropdown>

        {activeFilters.length > 0 && (
          <button
            type="button"
            onClick={() => setParam({
              priority: null, labels: null, project: null, cycle: null,
              department: null, overdue: null, unassigned: null,
            })}
            className="rounded-full px-3 py-1.5 text-xs"
            style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-muted)" }}
          >
            Clear {activeFilters.length}
          </button>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setParam({ layout: "board" })}
            aria-label="Board view"
            aria-pressed={layout === "board"}
            className="tap"
            style={layout === "board"
              ? { background: "var(--yg-surface-2)", color: "var(--yg-text)" }
              : { color: "var(--yg-text-muted)" }}
          >
            <Columns3 size={15} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setParam({ layout: "list" })}
            aria-label="List view"
            aria-pressed={layout === "list"}
            className="tap"
            style={layout === "list"
              ? { background: "var(--yg-surface-2)", color: "var(--yg-text)" }
              : { color: "var(--yg-text-muted)" }}
          >
            <List size={15} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-[var(--row-h)] items-center gap-1.5 rounded-full px-3.5 text-[12.5px]"
            style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-muted)" }}
            aria-label="Command palette"
          >
            <Command size={13} aria-hidden />K
          </button>
          <button
            type="button"
            onClick={() => setShowKeys((v) => !v)}
            aria-label="Keyboard shortcuts"
            className="tap text-text-muted"
          >
            <Keyboard size={15} aria-hidden />
          </button>
        </div>
      </div>

      {showKeys && <Shortcuts onClose={() => setShowKeys(false)} />}

      {/* One per failed change: a revert without a reason is worse than a wait. */}
      {errors.map((e, i) => (
        <div
          key={`${e}-${i}`}
          className="mb-2.5 flex items-start gap-2.5 rounded-[var(--r-card)] px-4 py-3 text-[13.5px]"
          style={{ background: "var(--flag-high-bg)", color: "var(--flag-high-fg)" }}
          role="status"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span className="flex-1">{e}</span>
          <button type="button" onClick={() => dismiss(i)} aria-label="Dismiss"><X size={15} aria-hidden /></button>
        </div>
      ))}

      {view.length === 0 ? (
        <div
          className="rounded-xl px-4 py-10 text-center text-sm text-text-muted"
          style={{ border: "1px dashed var(--yg-surface-2)" }}
        >
          Nothing here.{" "}
          <Link href="/tickets/new" className="text-accent">Ask a department for something</Link>
          {" "}or widen the filters.
        </div>
      ) : layout === "board" ? (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {groups.map((g) => (
            <section
              key={g.key}
              className="flex w-72 shrink-0 flex-col rounded-[var(--r-shell)] p-3"
              style={{
                background: dropTarget === g.key ? "var(--yg-surface-2)" : "var(--yg-surface)",
                border: `1px solid ${dropTarget === g.key ? "var(--yg-accent)" : "var(--yg-surface-2)"}`,
              }}
              onDragOver={(e) => {
                if (!g.category || !dragging) return;
                e.preventDefault();
                setDropTarget(g.key);
              }}
              onDragLeave={() => setDropTarget((t) => (t === g.key ? null : t))}
              onDrop={(e) => {
                e.preventDefault();
                setDropTarget(null);
                setDropBefore(null);
                if (!dragging) return;
                const from = byId.get(dragging);
                // Same column is ordering; a different one is a status decision, and
                // they go to different places on purpose.
                if (from && g.category && from.category === g.category) {
                  const list = g.tickets.filter((x) => x.id !== dragging);
                  const at = dropBefore ? list.findIndex((x) => x.id === dropBefore) : list.length;
                  const before = at >= 0 && at < list.length ? list[at] : null;
                  const after = at > 0 ? list[at - 1] : null;
                  reorder(dragging, after?.id ?? null, before?.id ?? null,
                    ((after?.board_rank ?? -1024) + (before?.board_rank ?? (after?.board_rank ?? 0) + 2048)) / 2);
                } else if (g.category) {
                  moveTo([dragging], g.category);
                }
                setDragging(null);
              }}
            >
              <header className="flex items-center gap-2.5 px-1 pb-3">
                {g.category && (
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ background: CATEGORY_TONE[g.category] }}
                    aria-hidden
                  />
                )}
                <h2 className="text-[13px] font-medium">{g.label}</h2>
                <span className="tnum text-[11.5px] text-text-muted">{g.tickets.length}</span>
              </header>
              <div className="flex flex-col gap-2">
                {g.tickets.map((t) => (
                  <Row
                    key={t.id}
                    ticket={t}
                    card
                    focused={focused === t.id}
                    taken={selected.has(t.id)}
                    pending={pending.has(t.id)}
                    onFocus={(mods) => { setFocused(t.id); click(t.id, mods); }}
                    onPeek={() => setPeeking(t.id)}
                    onDragStart={() => setDragging(t.id)}
                    onDragEnd={() => { setDragging(null); setDropTarget(null); setDropBefore(null); }}
                    onDragOverCard={() => { if (dragging && dragging !== t.id) setDropBefore(t.id); }}
                    dropMarker={dropBefore === t.id}
                    openMenu={menu?.ticket === t.id ? menu.kind : null}
                    setMenu={(kind) => setMenu(kind ? { kind, ticket: t.id } : null)}
                    labels={labels}
                    members={members}
                    projects={projects}
                    cycles={cycles}
                    patch={patch}
                    moveTo={moveTo}
                    me={me}
                  />
                ))}
                {g.tickets.length === 0 && (
                  <p className="px-2 py-6 text-center text-xs text-text-muted">
                    {g.category && CATEGORY_ENTRY_ACTIONS[g.category].length > 0 ? "Drop here" : "Empty"}
                  </p>
                )}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="space-y-5">
          {groups.filter((g) => g.tickets.length > 0).map((g) => (
            <section key={g.key}>
              <header className="mb-1.5 flex items-center gap-2 px-1">
                <h2 className="text-sm font-medium text-text-soft">{g.label}</h2>
                <span className="tnum text-xs text-text-muted">{g.tickets.length}</span>
              </header>
              <div
                className="overflow-hidden rounded-xl"
                style={{ border: "1px solid var(--yg-surface-2)" }}
              >
                {g.tickets.map((t) => (
                  <Row
                    key={t.id}
                    ticket={t}
                    focused={focused === t.id}
                    taken={selected.has(t.id)}
                    pending={pending.has(t.id)}
                    onFocus={(mods) => { setFocused(t.id); click(t.id, mods); }}
                    onPeek={() => setPeeking(t.id)}
                    openMenu={menu?.ticket === t.id ? menu.kind : null}
                    setMenu={(kind) => setMenu(kind ? { kind, ticket: t.id } : null)}
                    labels={labels}
                    members={members}
                    projects={projects}
                    cycles={cycles}
                    patch={patch}
                    moveTo={moveTo}
                    me={me}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
        placeholder={
          acting.length > 0
            ? `${acting.length} ticket${acting.length === 1 ? "" : "s"} — what should happen?`
            : "Search commands, filters and views…"
        }
      />

      <Peek ticket={peeking ? byId.get(peeking) ?? null : null} onClose={() => setPeeking(null)} />

      {/*
        The bulk bar. It appears only when rows are taken, says how many, and every
        control on it does to all of them what the row menus do to one.
      */}
      {selected.size > 0 && (
        <div
          className="fixed inset-x-0 bottom-24 z-30 mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 rounded-full px-3 py-2 md:bottom-6"
          style={{
            background: "var(--yg-surface)",
            border: "1px solid var(--yg-surface-2)",
            boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
          }}
          role="toolbar"
          aria-label={`${selected.size} tickets selected`}
        >
          <span className="flex items-center gap-2 px-2 text-[13px]">
            <SquareCheckBig size={15} style={{ color: "var(--yg-info)" }} aria-hidden />
            <span className="tnum">{selected.size}</span> selected
          </span>

          <Dropdown label="Move to">
            {TICKET_CATEGORIES.filter((c) => CATEGORY_ENTRY_ACTIONS[c].length > 0).map((c) => (
              <MenuItem key={c} onSelect={() => moveTo([...selected], c)}>{CATEGORY_LABEL[c]}</MenuItem>
            ))}
          </Dropdown>

          <Dropdown label="Priority">
            {PRIORITIES.map((p) => (
              <MenuItem
                key={p}
                onSelect={() => patch([...selected], { priority: p }, { priority: p }, "priority")}
              >
                <span style={{ color: PRIORITY_TONE[p] }}>{p[0] + p.slice(1).toLowerCase()}</span>
              </MenuItem>
            ))}
          </Dropdown>

          <Dropdown label="Assign">
            <MenuItem onSelect={() => patch([...selected], { assignee_id: null }, { assignee: null, assignee_id: null }, "assignee")}>
              Unassigned
            </MenuItem>
            {members.map((m) => (
              <MenuItem
                key={m.id}
                onSelect={() => patch([...selected], { assignee_id: m.id }, { assignee: m.name, assignee_id: m.id }, "assignee")}
              >
                {m.name}{m.id === me.id ? " (you)" : ""}
              </MenuItem>
            ))}
          </Dropdown>

          {projects.length > 0 && (
            <Dropdown label="Project">
              <MenuItem onSelect={() => patch([...selected], { project_id: null }, { project: null, project_id: null }, "project")}>
                No project
              </MenuItem>
              {projects.map((p) => (
                <MenuItem
                  key={p.id}
                  onSelect={() => patch([...selected], { project_id: p.id }, { project: p.name, project_id: p.id }, "project")}
                >
                  {p.name}
                </MenuItem>
              ))}
            </Dropdown>
          )}

          <button
            type="button"
            onClick={clear}
            className="tap text-text-muted hover:text-text"
            aria-label="Clear the selection"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- one ticket */

interface RowMods { meta?: boolean; shift?: boolean }

function Row({
  ticket: t, card, focused, taken, pending, onFocus, onPeek,
  onDragStart, onDragEnd, onDragOverCard, dropMarker,
  openMenu, setMenu, labels, members, projects, cycles, patch, moveTo, me,
}: {
  ticket: BoardTicket;
  card?: boolean;
  /** Where the keyboard is. */
  focused: boolean;
  /** Taken by multi-select — a different thing from focus, and drawn differently. */
  taken: boolean;
  /** A change on this row has not come back from the server yet. */
  pending: boolean;
  onFocus: (mods: RowMods) => void;
  onPeek: () => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDragOverCard?: () => void;
  dropMarker?: boolean;
  openMenu: string | null;
  setMenu: (kind: string | null) => void;
  labels: LabelOption[];
  members: MemberOption[];
  projects: Option[];
  cycles: Option[];
  patch: (ids: string[], body: Record<string, unknown>, optimistic: Partial<BoardTicket>, what: string) => void;
  moveTo: (ids: string[], category: TicketCategory) => Promise<void>;
  me: { id: string; departmentId: string };
}) {
  // The assignee has to be somebody in the department doing the work — the service
  // enforces it, so offering anyone else would just be a form that fails.
  const router = useRouter();
  const assignable = members.filter((m) => m.departmentId === t.target_department_id);
  const due = new Date(t.due_at).toLocaleString("en-IN", {
    day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
  });

  // Focus is a ring, selection is a fill. Conflating them is why multi-select in
  // most tools is confusing: you cannot tell what Enter will act on.
  const edge = taken ? "var(--yg-info)" : focused ? "var(--yg-accent)" : "var(--yg-surface-2)";
  const frame = card ? "rounded-[var(--r-card)] p-[15px]" : "px-4 py-3";
  const style = card
    ? {
        background: taken ? "var(--yg-surface-2)" : "var(--yg-bg-app)",
        border: `1px solid ${edge}`,
        opacity: pending ? 0.55 : 1,
      }
    : {
        background: taken ? "var(--yg-surface-2)" : focused ? "var(--yg-surface-2)" : "var(--yg-surface)",
        borderBottom: "1px solid var(--yg-surface-2)",
        boxShadow: focused && !taken ? "inset 2px 0 0 var(--yg-accent)" : undefined,
        opacity: pending ? 0.55 : 1,
      };

  return (
    <div
      id={`ticket-${t.id}`}
      className={`${frame} relative`}
      style={style}
      draggable={Boolean(onDragStart)}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOverCard ? (e) => { e.preventDefault(); onDragOverCard(); } : undefined}
      onClick={(e) => onFocus({ meta: e.metaKey || e.ctrlKey, shift: e.shiftKey })}
      onDoubleClick={(e) => { e.preventDefault(); onPeek(); }}
    >
      {dropMarker && (
        <span
          className="absolute -top-[5px] right-0 left-0 h-0.5 rounded-full"
          style={{ background: "var(--yg-accent)" }}
          aria-hidden
        />
      )}
      <div className={card ? "" : "flex flex-wrap items-center gap-x-3 gap-y-1"}>
        <div className={card ? "flex flex-wrap items-center gap-1.5" : "flex items-center gap-2"}>
          <span className="tnum text-xs text-text-muted">{t.human_id}</span>

          <Inline
            open={openMenu === "status"}
            onToggle={(v) => setMenu(v ? "status" : null)}
            trigger={
              <span
                className="inline-flex items-center gap-[6px] rounded-full py-[4px] pr-2.5 pl-2 text-[11.5px] font-medium"
                style={chipStyle(t.status)}
              >
                <span
                  className="size-[6px] rounded-full"
                  style={{ background: chipStyle(t.status).color }}
                  aria-hidden
                />
                {stateLabel(t.status)}
              </span>
            }
          >
            <MenuLabel>Move to</MenuLabel>
            {TICKET_CATEGORIES.filter((c) => CATEGORY_ENTRY_ACTIONS[c].length > 0).map((c) => (
              <MenuItem
                key={c}
                selected={t.category === c}
                onSelect={() => { setMenu(null); moveTo([t.id], c); }}
              >
                {CATEGORY_LABEL[c]}
              </MenuItem>
            ))}
            <MenuLabel>Or open it for the actions that need a reason</MenuLabel>
            <MenuItem onSelect={() => router.push(`/tickets/${t.id}`)}>
              Open {t.human_id}
            </MenuItem>
          </Inline>

          <Inline
            open={openMenu === "priority"}
            onToggle={(v) => setMenu(v ? "priority" : null)}
            trigger={
              <span
                className="rounded-full px-2.5 py-[3px] text-[10.5px]"
                style={{ background: PRIORITY_BG[t.priority], color: PRIORITY_TONE[t.priority] }}
              >
                {t.priority[0] + t.priority.slice(1).toLowerCase()}
              </span>
            }
          >
            {PRIORITIES.map((p) => (
              <MenuItem
                key={p}
                selected={t.priority === p}
                onSelect={() => patch([t.id], { priority: p }, { priority: p }, "priority")}
              >
                <span style={{ color: PRIORITY_TONE[p] }}>{p[0] + p.slice(1).toLowerCase()}</span>
              </MenuItem>
            ))}
          </Inline>

          {t.escalated && (
            <span
              className="rounded-full px-1.5 py-0.5 text-[11px]"
              style={{ background: "var(--flag-high-bg)", color: "var(--flag-high-fg)" }}
            >
              escalated
            </span>
          )}
        </div>

        <Link
          href={`/tickets/${t.id}`}
          onClick={(e) => e.stopPropagation()}
          className={`${card ? "mt-1.5 block" : "min-w-0 flex-1 truncate"} text-sm hover:text-accent`}
        >
          {t.parent_human_id && (
            <span className="tnum mr-1 text-xs text-text-muted">{t.parent_human_id} ›</span>
          )}
          {t.title}
        </Link>

        <div className={`${card ? "mt-2" : ""} flex flex-wrap items-center gap-1.5`}>
          {t.labels.map((l) => (
            <span
              key={l.id}
              className="rounded-full px-1.5 py-0.5 text-[11px]"
              style={{ background: `${l.color}22`, color: l.color, border: `1px solid ${l.color}55` }}
            >
              {l.name}
            </span>
          ))}

          <Inline
            open={openMenu === "label"}
            onToggle={(v) => setMenu(v ? "label" : null)}
            trigger={
              <span className="rounded-full px-1.5 py-0.5 text-[11px] text-text-muted"
                style={{ border: "1px dashed var(--yg-surface-2)" }}>
                <Plus size={10} className="inline" aria-hidden /> label
              </span>
            }
          >
            {labels.length === 0 && <MenuLabel>No labels yet — make one in Planning</MenuLabel>}
            {labels.map((l) => {
              const on = t.labels.some((x) => x.id === l.id);
              return (
                <MenuItem
                  key={l.id}
                  selected={on}
                  onSelect={() => {
                    const next = on ? t.labels.filter((x) => x.id !== l.id) : [...t.labels, l];
                    patch([t.id], { label_ids: next.map((x) => x.id) }, { labels: next }, "labels");
                  }}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ background: l.color }} aria-hidden />
                    {l.name}
                  </span>
                </MenuItem>
              );
            })}
          </Inline>
        </div>

        <div className={`${card ? "mt-2 justify-between" : "ml-auto"} flex flex-wrap items-center gap-x-3 gap-y-1 text-xs`}>
          <Inline
            open={openMenu === "assignee"}
            onToggle={(v) => setMenu(v ? "assignee" : null)}
            trigger={
              <span className="text-text-muted">
                {t.assignee ?? "unassigned"}
              </span>
            }
          >
            <MenuItem onSelect={() => patch([t.id], { assignee_id: null }, { assignee: null, assignee_id: null }, "assignee")}>
              Unassigned
            </MenuItem>
            {assignable.map((m) => (
              <MenuItem
                key={m.id}
                selected={t.assignee_id === m.id}
                onSelect={() => patch([t.id], { assignee_id: m.id }, { assignee: m.name, assignee_id: m.id }, "assignee")}
              >
                {m.name}{m.id === me.id ? " (you)" : ""}
              </MenuItem>
            ))}
            {assignable.length === 0 && (
              <MenuLabel>Nobody active in {t.target_department}</MenuLabel>
            )}
          </Inline>

          {/*
            * Shown, never enforced. The card says what is in front of this one; it
            * does not stop anybody moving it, because the person holding the ticket
            * knows whether the blocker really has to land first.
            */}
          {t.blocked_by > 0 && (
            <span
              className="rounded-full px-1.5 py-px text-[10.5px] font-medium"
              style={{ background: "var(--flag-med-bg)", color: "var(--flag-med-fg)" }}
              title={`Waiting on ${t.blocked_by} open ticket${t.blocked_by === 1 ? "" : "s"}`}
            >
              blocked
            </span>
          )}
          {t.child_count > 0 && (
            <span className="tnum text-text-muted" title="Sub-tickets done">
              {t.child_done_count}/{t.child_count}
            </span>
          )}
          {t.comment_count > 0 && (
            <span className="tnum text-text-muted">{t.comment_count}c</span>
          )}
          {t.estimated_cost_paise !== null && (
            <span className="tnum text-text-muted">{formatPaise(t.estimated_cost_paise)}</span>
          )}
          <span style={{ color: t.overdue ? "var(--state-bad-fg)" : "var(--yg-text-muted)" }}>
            {t.overdue ? "overdue · " : ""}{due}
          </span>
        </div>
      </div>

      <div className={`${card ? "mt-1.5" : "mt-1"} flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-muted`}>
        {card && <span>{t.requesting_department} → {t.target_department}</span>}

        <Inline
          open={openMenu === "project"}
          onToggle={(v) => setMenu(v ? "project" : null)}
          trigger={<span className="text-[11px]">{t.project ?? "no project"}</span>}
        >
          <MenuItem onSelect={() => patch([t.id], { project_id: null }, { project: null, project_id: null }, "project")}>
            No project
          </MenuItem>
          {projects.map((p) => (
            <MenuItem
              key={p.id}
              selected={t.project_id === p.id}
              onSelect={() => patch([t.id], { project_id: p.id }, { project: p.name, project_id: p.id }, "project")}
            >
              {p.name}
            </MenuItem>
          ))}
          {projects.length === 0 && <MenuLabel>None yet — make one in Labels &amp; projects</MenuLabel>}
        </Inline>

        <Inline
          open={openMenu === "cycle"}
          onToggle={(v) => setMenu(v ? "cycle" : null)}
          trigger={<span className="text-[11px]">{t.cycle ?? "no cycle"}</span>}
        >
          <MenuItem onSelect={() => patch([t.id], { cycle_id: null }, { cycle: null, cycle_id: null }, "cycle")}>
            No cycle
          </MenuItem>
          {cycles.map((c) => (
            <MenuItem
              key={c.id}
              selected={t.cycle_id === c.id}
              onSelect={() => patch([t.id], { cycle_id: c.id }, { cycle: c.name, cycle_id: c.id }, "cycle")}
            >
              {c.name}
            </MenuItem>
          ))}
          {cycles.length === 0 && <MenuLabel>None yet — make one in Labels &amp; projects</MenuLabel>}
        </Inline>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ menu plumbing */

function Inline({
  open, onToggle, trigger, children,
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
  trigger: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggle(!open); }}
        className="cursor-pointer rounded hover:opacity-80"
      >
        {trigger}
      </button>
      {open && (
        <>
          {/* Click-away. A dropdown that only closes on Escape is a trap on a phone. */}
          <span className="fixed inset-0 z-20" onClick={(e) => { e.stopPropagation(); onToggle(false); }} />
          <span
            className="absolute left-0 z-30 mt-1 block max-h-72 w-56 overflow-y-auto rounded-lg py-1 shadow-xl"
            style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </span>
        </>
      )}
    </span>
  );
}

function Dropdown({
  label, icon, badge, children,
}: {
  label: string; icon?: React.ReactNode; badge?: number; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-[var(--row-h)] items-center gap-2 rounded-full px-4 text-[13px]"
        style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
      >
        {icon}
        {label}
        {badge ? <span className="tnum opacity-70">{badge}</span> : null}
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <span
            className="absolute left-0 z-30 mt-1 block max-h-80 w-56 overflow-y-auto rounded-lg py-1 shadow-xl"
            style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
          >
            {children}
          </span>
        </>
      )}
    </span>
  );
}

function MenuItem({
  children, selected, disabled, onSelect,
}: {
  children: React.ReactNode; selected?: boolean; disabled?: boolean; onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-2 disabled:opacity-40"
      style={{ color: "var(--yg-text-soft)" }}
    >
      <span className="w-3 shrink-0">{selected && <Check size={12} aria-hidden />}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="block px-3 pt-2 pb-1 text-[10px] tracking-wide text-text-muted uppercase">
      {children}
    </span>
  );
}

const KEYS: [string, string][] = [
  ["\u2318K", "Everything, by name"],
  ["C", "New ticket"],
  ["/", "Search"],
  ["J / K", "Move down / up"],
  ["X", "Take this row — again for more"],
  ["Space", "Peek without leaving the board"],
  ["Enter", "Open it properly"],
  ["S", "Status"],
  ["A", "Assignee"],
  ["P", "Priority"],
  ["L", "Labels"],
  ["Esc", "Close, then drop the selection"],
  ["?", "This list"],
];

function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="mb-3 rounded-xl p-3"
      style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium">Keyboard</h2>
        <button type="button" onClick={onClose} aria-label="Close"><X size={14} aria-hidden /></button>
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        {KEYS.map(([key, what]) => (
          <div key={key} className="flex items-center gap-2">
            <dt>
              <kbd
                className="rounded px-1.5 py-0.5 text-[11px]"
                style={{ background: "var(--yg-surface-2)", color: "var(--yg-text)" }}
              >
                {key}
              </kbd>
            </dt>
            <dd className="text-text-muted">{what}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[11px] text-text-muted">
        Anything that needs a reason — rejecting, blocking, reopening — is on the ticket itself,
        because the reason is the point of it.
      </p>
    </div>
  );
}
