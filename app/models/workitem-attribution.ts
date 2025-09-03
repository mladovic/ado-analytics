import type { Segment, StateMapping } from "~/models/workitem-timeline";

/**
 * Assignee attribution at first entry into "done".
 * - Uses timeline segments (state normalized to toDo/inProgress/done).
 * - Picks the assignee for the first segment where previous segment is not "done" and current is "done".
 * - If not found (e.g., item was already done at window start), returns undefined.
 * - If assignee is an object, normalizes to uniqueName/mailAddress when possible.
 */
export function assigneeAtFirstDone(
  segments: ReadonlyArray<Segment>,
  _mapping: StateMapping
): string | undefined {
  if (!Array.isArray(segments) || segments.length === 0) return undefined;

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.state !== "done") continue;
    // Must be an in-window transition into done (previous state not done)
    if (i === 0 || segments[i - 1].state === "done") continue;
    return normalizeAssignee((s as unknown as { assignee?: unknown }).assignee);
  }
  return undefined;
}

function normalizeAssignee(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    const unique = asString(v["uniqueName"]) || asString(v["mailAddress"]);
    const display = asString(v["displayName"]);
    return unique || display || undefined;
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
