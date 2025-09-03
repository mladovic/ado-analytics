import type { PullRequest, PRThread, PRReviewer } from "~/models/zod-ado";

export type ReviewContext = Readonly<{
  threadsByPr: Map<number, ReadonlyArray<PRThread>>;
  reviewersByPr: Map<number, ReadonlyArray<PRReviewer>>;
  businessTime: (start: Date, end: Date) => number;
  reviewerAssignedAt: (pr: PullRequest, reviewerId: string) => Date | null;
  personTeamByEmail?: Record<string, string>;
  authorTeamByPr?: (prId: number) => string | undefined;
}>;

export type ReviewMetrics = Readonly<{
  count: number;
  responsivenessAvgMs: number | null;
  commentsAvg: number | null;
  crossTeamPct: number | null;
}>;

export function computeReviewMetrics(
  prs: ReadonlyArray<PullRequest>,
  reviewerId: string,
  ctx: ReviewContext
): ReviewMetrics {
  let count = 0; // PRs where reviewer participated (commented/voted/resolved)
  let respSum = 0;
  let respN = 0;
  let commentsSum = 0;

  let crossTeamDen = 0;
  let crossTeamNum = 0;

  for (const pr of prs) {
    const reviewers = ctx.reviewersByPr.get(pr.id) ?? [];
    const threads = ctx.threadsByPr.get(pr.id) ?? [];

    // Build aliases for matching and capture reviewer email
    const { keys: aliases, email: reviewerEmail } = buildReviewerAliases(reviewers, reviewerId);
    if (!aliases.size) aliases.add(normalizeKey(reviewerId));

    // Determine participation: any comment by reviewer OR any non-zero vote
    const commentsByReviewer = countCommentsBy(threads, aliases);
    const voted = hasNonZeroVote(reviewers, reviewerId);
    const participated = commentsByReviewer > 0 || voted;
    if (!participated) continue;
    count++;

    // Responsiveness: assignedAt (or PR created) -> first action (first comment)
    const startAt = ctx.reviewerAssignedAt(pr, reviewerId) ?? toDate(pr.creationDate) ?? undefined;
    if (startAt) {
      const firstAt = findFirstCommentBy(threads, aliases, startAt);
      if (firstAt && firstAt > startAt) {
        respSum += safeBusinessTime(ctx.businessTime, startAt, firstAt);
        respN++;
      }
    }

    commentsSum += commentsByReviewer;

    // Cross-team %: compare author team vs reviewer team if both known
    const authorTeam = ctx.authorTeamByPr?.(pr.id);
    const rEmail = reviewerEmail ?? pickEmailFromAliases(aliases);
    const reviewerTeam = resolveReviewerTeam(ctx.personTeamByEmail, rEmail);
    if (authorTeam && reviewerTeam) {
      crossTeamDen++;
      if (!eqi(authorTeam, reviewerTeam)) crossTeamNum++;
    }
  }

  if (count === 0) {
    return { count: 0, responsivenessAvgMs: null, commentsAvg: null, crossTeamPct: null };
  }

  const responsivenessAvgMs = respN ? Math.round(respSum / respN) : null;
  const commentsAvg = count ? commentsSum / count : null;
  const crossTeamPct = crossTeamDen ? crossTeamNum / crossTeamDen : null;

  return { count, responsivenessAvgMs, commentsAvg, crossTeamPct };
}

function isReviewerAssigned(reviewers: ReadonlyArray<PRReviewer>, reviewerId: string): boolean {
  const id = normalizeKey(reviewerId);
  return reviewers.some((r) => normalizeKey(r.id) === id || (r.uniqueName && normalizeKey(r.uniqueName) === id));
}

function buildReviewerAliases(
  reviewers: ReadonlyArray<PRReviewer>,
  reviewerId: string
): { keys: Set<string>; email?: string } {
  const keys = new Set<string>();
  let email: string | undefined;
  const id = normalizeKey(reviewerId);
  for (const r of reviewers) {
    const rid = normalizeKey(r.id);
    const rmail = r.uniqueName ? normalizeKey(r.uniqueName) : undefined;
    if (rid === id || (rmail && rmail === id)) {
      if (rid) keys.add(rid);
      if (rmail) keys.add(rmail);
      if (!email && r.uniqueName && looksLikeEmail(r.uniqueName)) email = r.uniqueName;
    }
  }
  if (!keys.size && id) keys.add(id);
  return { keys, email };
}

function hasNonZeroVote(reviewers: ReadonlyArray<PRReviewer>, reviewerId: string): boolean {
  const id = normalizeKey(reviewerId);
  for (const r of reviewers) {
    const rid = normalizeKey(r.id);
    const rmail = r.uniqueName ? normalizeKey(r.uniqueName) : undefined;
    if (rid === id || (rmail && rmail === id)) {
      if (typeof r.vote === "number" && r.vote !== 0) return true;
    }
  }
  return false;
}

function looksLikeEmail(s: string): boolean {
  return /@/.test(s);
}

function normalizeKey(s: unknown): string {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

function findFirstCommentBy(
  threads: ReadonlyArray<PRThread>,
  aliases: ReadonlySet<string>,
  notBefore: Date
): Date | undefined {
  let first: Date | undefined;
  for (const t of threads) {
    const comments = Array.isArray(t.comments) ? t.comments : [];
    for (const c of comments) {
      const when = toDate((c as any)?.publishedDate);
      if (!when || when < notBefore) continue;
      const key = identityKey((c as any)?.author);
      if (!key || !aliases.has(key)) continue;
      if (!first || when < first) first = when;
    }
  }
  return first;
}

function countCommentsBy(threads: ReadonlyArray<PRThread>, aliases: ReadonlySet<string>): number {
  let n = 0;
  for (const t of threads) {
    const comments = Array.isArray(t.comments) ? t.comments : [];
    for (const c of comments) {
      const key = identityKey((c as any)?.author);
      if (key && aliases.has(key)) n++;
    }
  }
  return n;
}

function identityKey(author: unknown): string | undefined {
  if (!author || typeof author !== "object") return undefined;
  const a = author as Record<string, unknown>;
  const unique = asString(a["uniqueName"]) || asString(a["mailAddress"]);
  const id = asString(a["id"]);
  const display = asString(a["displayName"]);
  const key = (unique || id || display || "").trim().toLowerCase();
  return key || undefined;
}

function resolveReviewerTeam(
  personTeamByEmail: Record<string, string> | undefined,
  email: string | undefined
): string | undefined {
  if (!personTeamByEmail || !email) return undefined;
  return personTeamByEmail[email] || personTeamByEmail[email.toLowerCase()] || undefined;
}

function pickEmailFromAliases(aliases: ReadonlySet<string>): string | undefined {
  for (const k of aliases) if (/@/.test(k)) return k;
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function toDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : undefined;
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

function eqi(a: unknown, b: string): boolean {
  return typeof a === "string" && a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}
