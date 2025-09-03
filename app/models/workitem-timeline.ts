import type { WorkItemUpdate } from "~/models/zod-ado";

/**
 * Timeline segment for a work item.
 * - `state` is normalized via mapping: "toDo" | "inProgress" | "done" when matched, otherwise the raw ADO state.
 * - `assignee` is a displayable string (if available).
 */
export type Segment = Readonly<{
  state: string;
  assignee?: string;
  tStart: Date;
  tEnd: Date;
}>;

export type StateMapping = Readonly<{
  toDo: string;
  inProgress: string;
  done: string;
}>;

export type BuildSegmentsOpts = Readonly<{
  window?: Readonly<{ from: Date; to: Date }>;
  mapping: StateMapping;
}>;

const STATE_FIELD = "System.State" as const;
const ASSIGNEE_FIELD = "System.AssignedTo" as const;
const UNKNOWN_STATE = "unknown" as const;

/**
 * Build time-ordered, non-overlapping segments from Work Item updates.
 * - First segment starts at earliest update time; last ends at last update time.
 * - Segments change only when `System.State` or `System.AssignedTo` change.
 * - If a field is missing in an update, the last known value is carried forward.
 * - If initial state is unknown, uses "unknown" until first state is observed.
 * - If `window` is provided, results are clipped to the intersection.
 */
export function buildSegments(
  updates: ReadonlyArray<WorkItemUpdate>,
  opts: BuildSegmentsOpts
): Segment[] {
  const events = groupEvents(normalizeAndSort(updates));
  if (events.length === 0) return [];

  const base = buildBaseSegments(events, opts.mapping);
  const clipped = opts.window ? clipToWindow(base, opts.window) : base;
  return clipped;
}

// Internals

type NormalizedUpdate = Readonly<{
  date: Date;
  stateRaw?: string;
  assignee?: string;
}>;

type Event = NormalizedUpdate;

function normalizeAndSort(updates: ReadonlyArray<WorkItemUpdate>): NormalizedUpdate[] {
  const out: NormalizedUpdate[] = [];
  for (let i = 0; i < updates.length; i++) {
    const u = updates[i];
    const d = toDate(u.revisedDate);
    if (!d) continue;
    const delta = (u.fields ?? {}) as Record<string, { newValue?: unknown }>;
    const stateRaw = extractState(delta[STATE_FIELD]?.newValue);
    const assignee = extractAssignee(delta[ASSIGNEE_FIELD]?.newValue);
    out.push({ date: d, stateRaw, assignee });
  }
  // Sort by timestamp ascending
  out.sort((a, b) => a.date.getTime() - b.date.getTime());
  return out;
}

// Merge updates that share the exact same timestamp, keeping the last seen values per field.
function groupEvents(rows: ReadonlyArray<NormalizedUpdate>): Event[] {
  if (rows.length === 0) return [];
  const events: Event[] = [];
  let current = { ...rows[0] } as Event;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.date.getTime() === current.date.getTime()) {
      // Merge into the same event, last one wins
      if (r.stateRaw !== undefined) current = { ...current, stateRaw: r.stateRaw };
      if (r.assignee !== undefined) current = { ...current, assignee: r.assignee };
    } else {
      events.push(current);
      current = { ...r };
    }
  }
  events.push(current);
  return events;
}

function buildBaseSegments(events: ReadonlyArray<Event>, mapping: StateMapping): Segment[] {
  const segments: Segment[] = [];
  let stateRaw: string | undefined;
  let assignee: string | undefined;

  let segStart = events[0].date;
  // Apply first event deltas
  if (events[0].stateRaw !== undefined) stateRaw = events[0].stateRaw;
  if (events[0].assignee !== undefined) assignee = events[0].assignee;
  let segState = normalizeState(stateRaw, mapping);
  let segAssignee = assignee;

  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    if (e.stateRaw !== undefined) stateRaw = e.stateRaw;
    if (e.assignee !== undefined) assignee = e.assignee;

    const nextState = normalizeState(stateRaw, mapping);
    const nextAssignee = assignee;

    // Only split when tracked fields change
    if (nextState !== segState || nextAssignee !== segAssignee) {
      // Close current at this event time
      segments.push({ state: segState, assignee: segAssignee, tStart: segStart, tEnd: e.date });
      // Start new segment from this time
      segStart = e.date;
      segState = nextState;
      segAssignee = nextAssignee;
    }
  }

  // Final segment ends at last update timestamp
  const lastTime = events[events.length - 1].date;
  segments.push({ state: segState, assignee: segAssignee, tStart: segStart, tEnd: lastTime });

  return segments;
}

function clipToWindow(
  segments: ReadonlyArray<Segment>,
  win: Readonly<{ from: Date; to: Date }>
): Segment[] {
  const from = win.from;
  const to = win.to;
  if (to <= from) return [];
  const out: Segment[] = [];
  for (const s of segments) {
    const start = maxDate(s.tStart, from);
    const end = minDate(s.tEnd, to);
    if (start < end) {
      out.push({ state: s.state, assignee: s.assignee, tStart: start, tEnd: end });
    }
  }
  return out;
}

function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}
function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

function toDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

function normalizeState(raw: string | undefined, mapping: StateMapping): string {
  if (!raw) return UNKNOWN_STATE;
  const r = raw.trim();
  const eq = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
  if (eq(r, mapping.toDo)) return "toDo";
  if (eq(r, mapping.inProgress)) return "inProgress";
  if (eq(r, mapping.done)) return "done";
  return r;
}

function extractState(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value.trim();
  return String(value);
}

function extractAssignee(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "object" && value) {
    const v = value as Record<string, unknown>;
    const displayName = asString(v["displayName"]);
    const uniqueName = asString(v["uniqueName"]) || asString(v["mailAddress"]);
    return displayName || uniqueName || undefined;
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
