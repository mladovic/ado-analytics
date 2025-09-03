import type {
  PullRequest,
  PRThread,
  PRReviewer,
  PolicyEvaluation,
  PRIteration,
} from "~/models/zod-ado";

export type AuthoredContext = Readonly<{
  threadsByPr: Map<number, ReadonlyArray<PRThread>>;
  reviewersByPr: Map<number, ReadonlyArray<PRReviewer>>;
  policiesByPr: Map<number, ReadonlyArray<PolicyEvaluation>>;
  iterationsByPr: Map<number, ReadonlyArray<PRIteration>>;
  businessTime: (start: Date, end: Date) => number;
  isDraftExcluded?: (pr: PullRequest) => boolean;
  start?: Date;
  end?: Date | null;
}>;

export type AuthoredMetrics = Readonly<{
  count: number;
  ttfrAvgMs: number | null;
  timeToApproveAvgMs: number | null;
  timeToMergeAvgMs: number | null;
  iterationsAvg: number | null;
  ciPassRate: number | null;
}>;

export function computeAuthoredMetrics(
  prs: ReadonlyArray<PullRequest>,
  ctx: AuthoredContext
): AuthoredMetrics {
  const start = ctx.start;
  const end = ctx.end ?? null;

  const isDraftExcluded = ctx.isDraftExcluded ?? ((pr) => Boolean(pr.isDraft));

  const included: PullRequest[] = [];
  for (const pr of prs) {
    const created = toDate(pr.creationDate);
    if (!created) continue;
    if (start && created < start) continue;
    if (end && created > end) continue;
    if (isDraftExcluded(pr)) continue;
    included.push(pr);
  }

  const count = included.length;
  if (count === 0) {
    return {
      count: 0,
      ttfrAvgMs: null,
      timeToApproveAvgMs: null,
      timeToMergeAvgMs: null,
      iterationsAvg: null,
      ciPassRate: null,
    };
  }

  let ttfrSum = 0;
  let ttfrN = 0;

  let approveSum = 0;
  let approveN = 0;

  let mergeSum = 0;
  let mergeN = 0;

  let iterSum = 0;
  let iterN = 0;

  let ciN = 0;
  let ciPass = 0;

  for (const pr of included) {
    const created = toDate(pr.creationDate)!;

    const threads = ctx.threadsByPr.get(pr.id) ?? [];

    // Determine draft->ready boundary (if available) to exclude draft window from TTFR
    const readyAt = detectReadyAt(threads) || (pr.isDraft ? undefined : created);
    const ttfrStart = readyAt && readyAt > created ? readyAt : created;

    // TTFR: effective start -> first reviewer comment (non-author), excluding draft window
    const authorKey = identityKey(pr.createdBy);
    const firstReviewAt = findFirstNonAuthorCommentAtOrAfter(threads, authorKey, ttfrStart);
    if (firstReviewAt && firstReviewAt > ttfrStart) {
      ttfrSum += safeBusinessTime(ctx.businessTime, ttfrStart, firstReviewAt);
      ttfrN++;
    }

    // Time to approval: creation -> first time approvals requirement met
    const policies = ctx.policiesByPr.get(pr.id) ?? [];
    const reviewerApprovals = policies
      .filter((p) => isReviewerPolicy(p))
      .filter((p) => eqi(p.status, "approved"))
      .map((p) => toDate(p.completedDate) || toDate(p.startedDate))
      .filter((d): d is Date => Boolean(d));
    if (reviewerApprovals.length) {
      const firstApprovalAt = reviewerApprovals.reduce((min, d) => (d < min ? d : min));
      if (firstApprovalAt > created) {
        approveSum += safeBusinessTime(ctx.businessTime, created, firstApprovalAt);
        approveN++;
      }
    } else {
      // Fallback: infer from reviewer votes + comments timestamps (best-effort)
      const reviewers = ctx.reviewersByPr.get(pr.id) ?? [];
      const approvalsMetAt = inferApprovalsMetAtFromVotesAndComments(reviewers, threads);
      if (approvalsMetAt && approvalsMetAt > created) {
        approveSum += safeBusinessTime(ctx.businessTime, created, approvalsMetAt);
        approveN++;
      }
    }

    // Time to merge: creation -> closed (completed)
    const closed = toDate(pr.closedDate);
    if (closed && eqi(pr.status, "completed") && closed > created) {
      mergeSum += safeBusinessTime(ctx.businessTime, created, closed);
      mergeN++;
    }

    // Iterations average
    const iters = ctx.iterationsByPr.get(pr.id);
    if (iters && iters.length >= 0) {
      iterSum += iters.length;
      iterN++;
    }

    // CI pass rate from build policy evaluations (success/sum on completed evaluations)
    const buildPolicies = policies.filter((p) => isBuildPolicy(p));
    for (const p of buildPolicies) {
      const completedAt = toDate(p.completedDate);
      if (!completedAt) continue; // Skip in-progress/not applicable evaluations
      ciN++;
      if (eqi(p.status, "approved")) ciPass++;
    }
  }

  const ttfrAvgMs = ttfrN ? Math.round(ttfrSum / ttfrN) : null;
  const timeToApproveAvgMs = approveN ? Math.round(approveSum / approveN) : null;
  const timeToMergeAvgMs = mergeN ? Math.round(mergeSum / mergeN) : null;
  const iterationsAvg = iterN ? iterSum / iterN : null;
  const ciPassRate = ciN ? ciPass / ciN : null;

  return { count, ttfrAvgMs, timeToApproveAvgMs, timeToMergeAvgMs, iterationsAvg, ciPassRate };
}

function toDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

function eqi(a: unknown, b: string): boolean {
  return typeof a === "string" && a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

function identityKey(author: unknown): string | undefined {
  if (!author || typeof author !== "object") return undefined;
  const a = author as Record<string, unknown>;
  const unique = asString(a["uniqueName"]) || asString(a["mailAddress"]);
  const id = asString(a["id"]);
  const display = asString(a["displayName"]);
  return (unique || id || display || "").toLowerCase() || undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function safeBusinessTime(fn: (a: Date, b: Date) => number, a: Date, b: Date): number {
  try {
    const ms = fn(a, b);
    return Number.isFinite(ms) && ms >= 0 ? ms : 0;
  } catch {
    const d = b.getTime() - a.getTime();
    return d > 0 ? d : 0;
  }
}

function isReviewerPolicy(p: PolicyEvaluation): boolean {
  const name = String((p as any)?.configuration?.type?.displayName ?? "").toLowerCase();
  return name.includes("reviewer") || name.includes("minimum number of reviewers") || name.includes("review");
}

function isBuildPolicy(p: PolicyEvaluation): boolean {
  const name = String((p as any)?.configuration?.type?.displayName ?? "").toLowerCase();
  return name.includes("build");
}

function detectReadyAt(threads: ReadonlyArray<PRThread>): Date | undefined {
  const re = /(ready\s*for\s*review|mark(?:ed)?\s*as\s*ready|convert(?:ed)?\s*to\s*ready|unmark(?:ed)?\s*as\s*draft|remove(?:d)?\s*draft)/i;
  let readyAt: Date | undefined;
  for (const t of threads) {
    const comments = Array.isArray(t.comments) ? t.comments : [];
    for (const c of comments) {
      const txt = asString((c as any)?.content) || "";
      if (!txt) continue;
      if (re.test(txt)) {
        const d = toDate((c as any)?.publishedDate);
        if (d && (!readyAt || d < readyAt)) readyAt = d;
      }
    }
  }
  return readyAt;
}

function findFirstNonAuthorCommentAtOrAfter(
  threads: ReadonlyArray<PRThread>,
  authorKey: string | undefined,
  notBefore: Date
): Date | undefined {
  let first: Date | undefined;
  for (const t of threads) {
    const comments = Array.isArray(t.comments) ? t.comments : [];
    for (const c of comments) {
      const when = toDate(c.publishedDate);
      if (!when || when < notBefore) continue;
      const whoKey = identityKey(c.author);
      if (!whoKey || (authorKey && whoKey === authorKey)) continue; // skip self-comments
      if (!first || when < first) first = when;
    }
  }
  return first;
}

function inferApprovalsMetAtFromVotesAndComments(
  reviewers: ReadonlyArray<PRReviewer>,
  threads: ReadonlyArray<PRThread>
): Date | undefined {
  if (!reviewers.length) return undefined;
  const approving = reviewers.filter((r) => typeof r.vote === "number" && r.vote >= 5);
  if (approving.length === 0) return undefined;

  // Require all reviewers to have approved to consider requirement met (best-effort fallback)
  if (approving.length < reviewers.length) return undefined;

  // For each approving reviewer, find their earliest comment; use the latest among them
  const earliestByReviewer: Date[] = [];
  for (const r of approving) {
    const key = reviewerKey(r);
    if (!key) return undefined;
    const d = findEarliestCommentByAuthorKey(threads, key);
    if (!d) return undefined; // cannot confidently infer timing
    earliestByReviewer.push(d);
  }
  return earliestByReviewer.reduce((max, d) => (d > max ? d : max));
}

function reviewerKey(r: PRReviewer): string | undefined {
  return (r.uniqueName || r.displayName || r.id || "").toLowerCase() || undefined;
}

function findEarliestCommentByAuthorKey(threads: ReadonlyArray<PRThread>, key: string): Date | undefined {
  let first: Date | undefined;
  for (const t of threads) {
    const comments = Array.isArray(t.comments) ? t.comments : [];
    for (const c of comments) {
      const whoKey = identityKey(c.author);
      if (!whoKey || whoKey !== key) continue;
      const when = toDate(c.publishedDate);
      if (!when) continue;
      if (!first || when < first) first = when;
    }
  }
  return first;
}
