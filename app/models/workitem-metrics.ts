import type { Segment, StateMapping } from "~/models/workitem-timeline";

export type WorkItemMetrics = Readonly<{
  completed: boolean;
  firstDoneAt?: Date;
  throughput: 0 | 1;
  leadTimeMs?: number;
  cycleTimeMs?: number;
  timeInStateMs: Readonly<{
    toDo: number;
    inProgress: number;
    done: number;
  }>;
  reworkCount: number;
}>;

/**
 * Compute per-Work-Item metrics from timeline segments.
 * - completed: last known state is "done".
 * - firstDoneAt: first time the item entered "done".
 * - throughput: 1 if completed, else 0.
 * - leadTimeMs: createdAt -> firstDoneAt (if known).
 * - cycleTimeMs: first "inProgress" -> first "done" (if both known).
 * - timeInStateMs: accumulated ms spent in toDo/inProgress/done across segments.
 * - reworkCount: count of backward transitions across stages (done/inProgress/toDo).
 */
export function computeWorkItemMetrics(
  segments: ReadonlyArray<Segment>,
  createdAt: Date,
  _mapping: StateMapping
): WorkItemMetrics {
  if (!Array.isArray(segments) || segments.length === 0) {
    return {
      completed: false,
      throughput: 0,
      timeInStateMs: { toDo: 0, inProgress: 0, done: 0 },
      reworkCount: 0,
    };
  }

  let toDoMs = 0;
  let inProgressMs = 0;
  let doneMs = 0;

  let firstDoneAt: Date | undefined;
  let firstInProgressAt: Date | undefined;
  let hasInWindowFirstDoneTransition = false;

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const dur = Math.max(0, s.tEnd.getTime() - s.tStart.getTime());
    switch (s.state) {
      case "toDo":
        toDoMs += dur;
        break;
      case "inProgress":
        inProgressMs += dur;
        if (!firstInProgressAt) firstInProgressAt = s.tStart;
        break;
      case "done":
        doneMs += dur;
        if (!firstDoneAt) firstDoneAt = s.tStart;
        // Throughput is 1 iff first entry into done exists within the provided window
        // (segments are pre-clipped). Detect an in-window transition where previous state is non-done.
        if (i > 0 && segments[i - 1].state !== "done") {
          hasInWindowFirstDoneTransition = true;
        }
        break;
      default:
        // Ignore states outside the mapped trio for aggregation purposes
        break;
    }
  }

  const completed = segments[segments.length - 1]?.state === "done";
  const throughput: 0 | 1 = hasInWindowFirstDoneTransition ? 1 : 0;

  const leadTimeMs = firstDoneAt
    ? Math.max(0, firstDoneAt.getTime() - createdAt.getTime())
    : undefined;

  const cycleTimeMs = firstDoneAt && firstInProgressAt && firstDoneAt >= firstInProgressAt
    ? Math.max(0, firstDoneAt.getTime() - firstInProgressAt.getTime())
    : undefined;

  // Rework: number of done -> non-done transitions
  let reworkCount = 0;
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1].state;
    const next = segments[i].state;
    if (prev === "done" && next !== "done") reworkCount++;
  }

  return {
    completed,
    firstDoneAt,
    throughput,
    leadTimeMs,
    cycleTimeMs,
    timeInStateMs: { toDo: toDoMs, inProgress: inProgressMs, done: doneMs },
    reworkCount,
  };
}
