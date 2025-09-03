import type { PullRequest, WorkItem } from "~/models/zod-ado";
import type { Segment, StateMapping } from "~/models/workitem-timeline";
import { computeWorkItemMetrics } from "~/models/workitem-metrics";
import type { AuthoredMetrics } from "~/models/pr-authored-metrics";
import { computeAuthoredMetrics } from "~/models/pr-authored-metrics";
import type { ReviewMetrics } from "~/models/pr-review-metrics";
import { computeReviewMetrics } from "~/models/pr-review-metrics";
import type { Schedule } from "~/utils/business-time";

export type Person = Readonly<{
  id: string;
  email: string;
  displayName: string;
}>;

export type PersonRollup = Readonly<{
  person: Person;
  team?: string;
  notes?: ReadonlyArray<string>;
  workItems?: Readonly<{
    count: number;
    completedTotal: number;
    throughputTotal: number;
    leadTimeAvgMs: number | null;
    cycleTimeAvgMs: number | null;
    timeInStateMs: Readonly<{ toDo: number; inProgress: number; done: number }>;
    reworkCountTotal: number;
  }>;
  prAuthored?: AuthoredMetrics & Readonly<{ count: number }>;
  prReviewed?: ReviewMetrics & Readonly<{ count: number }>;
}>;

export type PeopleRollupResponse = Readonly<{
  generatedAt: string; // ISO timestamp
  items: ReadonlyArray<PersonRollup>;
}>;

export function computePersonRollups(
  input: Readonly<{
    people: ReadonlyArray<Person>;
    wiByPerson: ReadonlyMap<string, ReadonlyArray<WorkItem>>;
    prAuthoredByPerson: ReadonlyMap<string, ReadonlyArray<PullRequest>>;
    prReviewParticipationByPerson: ReadonlyMap<
      string,
      ReadonlyArray<PullRequest>
    >;
    timelinesByWi: ReadonlyMap<number, ReadonlyArray<Segment>>;
    wiMetricsByWi: ReadonlyMap<
      number,
      ReturnType<typeof computeWorkItemMetrics>
    >;
    authoredCtx: Parameters<typeof computeAuthoredMetrics>[1];
    reviewCtx: Parameters<typeof computeReviewMetrics>[2];
    mapping: StateMapping;
    nThreshold: number;
    workingHours: Schedule;
    teamByEmail?: Record<string, string | undefined>;
  }>
): PeopleRollupResponse {
  const items: PersonRollup[] = [];
  const threshold = Math.max(0, Math.floor(input.nThreshold ?? 0));

  for (const p of input.people) {
    const emailKey = (p.email || "").trim().toLowerCase();

    // Work items owned/attributed to the person
    const wis = input.wiByPerson.get(emailKey) ?? [];
    const wiAgg = aggregateWorkItems(
      wis,
      input.timelinesByWi,
      input.wiMetricsByWi,
      input.mapping,
      threshold
    );

    // PRs authored by the person
    const prsAuth = input.prAuthoredByPerson.get(emailKey) ?? [];
    const authored = computeAuthoredMetrics(prsAuth, input.authoredCtx);

    // PRs reviewed by the person
    const prsReviewed = input.prReviewParticipationByPerson.get(emailKey) ?? [];
    const reviewed = computeReviewMetrics(
      prsReviewed,
      p.email || p.id,
      input.reviewCtx
    );

    const team =
      input.teamByEmail?.[emailKey] ||
      input.teamByEmail?.[p.email] ||
      undefined;

    const hasWi = wiAgg && wiAgg.count >= threshold;
    const hasAuthored = authored.count >= threshold;
    const hasReviewed = reviewed.count >= threshold;
    const notes: string[] = [];
    if (!hasWi) notes.push("Work item metrics suppressed (n < nThreshold)");
    if (!hasAuthored) notes.push("Authored PR metrics suppressed (n < nThreshold)");
    if (!hasReviewed) notes.push("Review participation metrics suppressed (n < nThreshold)");

    // Directional notes for small samples within [nThreshold, nThreshold+2]
    const dirUpper = threshold + 2;
    if (hasWi && wiAgg && wiAgg.count <= dirUpper) notes.push(`Directional (n=${wiAgg.count})`);
    if (hasAuthored && authored.count <= dirUpper) notes.push(`Directional (n=${authored.count})`);
    if (hasReviewed && reviewed.count <= dirUpper) notes.push(`Directional (n=${reviewed.count})`);

    const entry: PersonRollup = {
      person: p,
      team,
      // Omit sections that do not meet threshold instead of zeroing/nulling them
      ...(hasWi ? { workItems: wiAgg } : {}),
      ...(hasAuthored ? { prAuthored: authored } : {}),
      ...(hasReviewed ? { prReviewed: reviewed } : {}),
      ...(notes.length ? { notes } : {}),
    } as PersonRollup;
    items.push(entry);
  }

  // Sort by displayName
  items.sort((a, b) =>
    a.person.displayName.localeCompare(b.person.displayName, undefined, {
      sensitivity: "accent",
    })
  );

  return { generatedAt: new Date().toISOString(), items };
}

function aggregateWorkItems(
  wis: ReadonlyArray<WorkItem>,
  segmentsByWi: ReadonlyMap<number, ReadonlyArray<Segment>>,
  metricsByWi: ReadonlyMap<number, ReturnType<typeof computeWorkItemMetrics>>,
  mapping: StateMapping,
  threshold: number
): PersonRollup["workItems"] {
  let count = 0;
  let completedTotal = 0;
  let throughputTotal = 0;
  let reworkCountTotal = 0;

  let leadSum = 0;
  let leadN = 0;
  let cycleSum = 0;
  let cycleN = 0;

  let toDoMs = 0;
  let inProgressMs = 0;
  let doneMs = 0;

  for (const wi of wis) {
    const id = wi.id;
    if (typeof id !== "number") continue;
    count++;

    let m = metricsByWi.get(id);
    if (!m) {
      const segs = segmentsByWi.get(id) ?? [];
      const createdStr = (wi.fields as any)?.["System.CreatedDate"] as
        | string
        | undefined;
      const created = createdStr ? new Date(createdStr) : undefined;
      if (segs.length && created && Number.isFinite(created.getTime()))
        m = computeWorkItemMetrics(segs, created, mapping);
    }
    if (!m) continue;

    if (m.completed) completedTotal += 1;
    throughputTotal += m.throughput ?? 0;
    reworkCountTotal += m.reworkCount ?? 0;

    if (typeof m.leadTimeMs === "number") {
      leadSum += m.leadTimeMs;
      leadN++;
    }
    if (typeof m.cycleTimeMs === "number") {
      cycleSum += m.cycleTimeMs;
      cycleN++;
    }
    if (m.timeInStateMs) {
      toDoMs += m.timeInStateMs.toDo || 0;
      inProgressMs += m.timeInStateMs.inProgress || 0;
      doneMs += m.timeInStateMs.done || 0;
    }
  }

  const leadTimeAvgMs =
    leadN >= threshold && leadN > 0 ? Math.round(leadSum / leadN) : null;
  const cycleTimeAvgMs =
    cycleN >= threshold && cycleN > 0 ? Math.round(cycleSum / cycleN) : null;

  return {
    count,
    completedTotal,
    throughputTotal,
    leadTimeAvgMs,
    cycleTimeAvgMs,
    timeInStateMs: { toDo: toDoMs, inProgress: inProgressMs, done: doneMs },
    reworkCountTotal,
  };
}
