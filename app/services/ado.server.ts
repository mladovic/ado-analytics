import { getServerEnv } from "~/env.server";
import { adoFetchJson } from "~/services/http.server";
import { getOrSet } from "~/services/cache.server";
import {
  WiqlResponseSchema as ZWiqlResponse,
  WorkItemSchema as ZWorkItem,
  WorkItemUpdateSchema as ZWorkItemUpdate,
  PullRequestSchema as ZPullRequest,
  PRThreadSchema as ZPRThread,
  PRReviewerSchema as ZPRReviewer,
} from "~/models/zod-ado";
import type { WorkItem, WorkItemUpdate, PullRequest, PRThread, PRReviewer } from "~/models/zod-ado";

// Small stable hash (FNV-1a 32-bit) for cache keys
function hashString(input: string): string {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // h *= 16777619 (with overflow in 32-bit)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
}

export class AdoClient {
  private org: string;
  private project: string;
  private repoId: string;
  private ttlMs: number;
  private baseUrl: string;

  constructor() {
    const { ADO_ORG, ADO_PROJECT, ADO_REPO_ID, APP_CACHE_TTL_MS } = getServerEnv();
    this.org = ADO_ORG;
    this.project = ADO_PROJECT;
    this.repoId = ADO_REPO_ID;
    this.ttlMs = APP_CACHE_TTL_MS;
    this.baseUrl = `https://dev.azure.com/${this.org}`;
  }

  async queryByWiql(wiql: string): Promise<number[]> {
    const cacheKey = `wiql:${hashString(wiql)}`;
    return getOrSet<number[]>(cacheKey, this.ttlMs, async () => {
      const url = `${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/wit/wiql?api-version=7.1`;
      const body = JSON.stringify({ query: wiql });
      const json = await adoFetchJson<unknown>(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const parsed = ZWiqlResponse.safeParse(json);
      if (!parsed.success) {
        throw new Error(`Invalid WIQL response: ${parsed.error.message}`);
      }
      const ids = parsed.data.workItems.map((w) => w.id);
      return ids;
    });
  }

  async getWorkItemsBatch(ids: number[], fields?: string[]): Promise<WorkItem[]> {
    if (!ids.length) return [];

    const url = `${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/wit/workitemsbatch?api-version=7.1`;

    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += 200) {
      chunks.push(ids.slice(i, i + 200));
    }

    const results = await Promise.all(
      chunks.map(async (chunk) => {
        const hashInput = JSON.stringify([chunk, fields ?? []]);
        const cacheKey = `workitemsBatch:${hashString(hashInput)}`;
        return getOrSet<WorkItem[]>(cacheKey, this.ttlMs, async () => {
          const payload: Record<string, unknown> = { ids: chunk };
          if (fields && fields.length) payload.fields = fields;
          const json = await adoFetchJson<unknown>(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });

          const arr: unknown = Array.isArray(json)
            ? json
            : (json as any)?.value && Array.isArray((json as any).value)
            ? (json as any).value
            : undefined;

          if (!Array.isArray(arr)) {
            throw new Error("Invalid WorkItemsBatch response shape");
          }

          // Validate each item
          const items = (arr as unknown[]).map((it) => ZWorkItem.parse(it)) as WorkItem[];
          return items;
        });
      })
    );

    const all = results.flat();
    // Order by the input ids order
    const indexById = new Map<number, number>();
    ids.forEach((id, i) => indexById.set(id, i));
    const ordered = all
      .filter((w) => indexById.has(w.id))
      .sort((a, b) => (indexById.get(a.id)! - indexById.get(b.id)!));

    return ordered;
  }

  async listWorkItemUpdatesPaged(id: number): Promise<WorkItemUpdate[]> {
    const cacheKey = `updates:${id}`;
    return getOrSet<WorkItemUpdate[]>(cacheKey, this.ttlMs, async () => {
      const all: WorkItemUpdate[] = [];
      let continuationToken: string | undefined;
      let safety = 0;

      do {
        let url = `${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/wit/workitems/${id}/updates?api-version=7.1`;
        if (continuationToken) {
          url += `&continuationToken=${encodeURIComponent(continuationToken)}`;
        }

        const json = await adoFetchJson<unknown>(url);

        const pageArr: unknown = Array.isArray(json)
          ? json
          : (json as any)?.value && Array.isArray((json as any).value)
          ? (json as any).value
          : undefined;

        if (!Array.isArray(pageArr)) {
          throw new Error("Invalid WorkItemUpdates response shape");
        }

        for (const it of pageArr as unknown[]) {
          all.push(ZWorkItemUpdate.parse(it));
        }

        const token = (json as any)?.continuationToken;
        continuationToken = typeof token === "string" && token.length > 0 ? token : undefined;

        safety++;
        if (safety > 200) {
          throw new Error("WorkItem updates paging exceeded safety limit");
        }
      } while (continuationToken);

      all.sort((a, b) => {
        const da = a.revisedDate ? Date.parse(a.revisedDate) : 0;
        const db = b.revisedDate ? Date.parse(b.revisedDate) : 0;
        return da - db;
      });

      return all;
    });
  }

  async listPullRequests(params: {
    from: string
    to: string
    status?: "active" | "completed"
    targetRefs?: string[]
  }): Promise<PullRequest[]> {
    const targets = (params.targetRefs && params.targetRefs.length
      ? params.targetRefs
      : ["refs/heads/main"]) as string[]

    const cacheKey = `prs:${hashString(
      JSON.stringify({ from: params.from, to: params.to, status: params.status ?? "", targetRefs: targets })
    )}`

    return getOrSet<PullRequest[]>(cacheKey, this.ttlMs, async () => {
      const queries = targets.map(async (targetRef) => {
        const searchParams = new URLSearchParams()
        searchParams.set("searchCriteria.createdAfter", params.from)
        searchParams.set("searchCriteria.createdBefore", params.to)
        searchParams.set("searchCriteria.targetRefName", targetRef)
        if (params.status) searchParams.set("searchCriteria.status", params.status)
        searchParams.set("api-version", "7.1")

        const url = `${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(
          this.repoId
        )}/pullrequests?${searchParams.toString()}`

        const json = await adoFetchJson<unknown>(url)
        const arr: unknown = Array.isArray(json)
          ? json
          : (json as any)?.value && Array.isArray((json as any).value)
          ? (json as any).value
          : undefined
        if (!Array.isArray(arr)) throw new Error("Invalid PullRequests response shape")
        return (arr as unknown[]).map((it) => ZPullRequest.parse(it))
      })

      const batches = await Promise.all(queries)
      const merged = ([] as PullRequest[]).concat(...batches)

      // Deduplicate by id when multiple targets overlap
      const seen = new Set<number>()
      const deduped: PullRequest[] = []
      for (const pr of merged) {
        if (!seen.has(pr.id)) {
          seen.add(pr.id)
          deduped.push(pr)
        }
      }
      return deduped
    })
  }

  async listPRThreads(prId: number): Promise<PRThread[]> {
    const cacheKey = `threads:${prId}`;
    return getOrSet<PRThread[]>(cacheKey, this.ttlMs, async () => {
      const url = `${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(
        this.repoId
      )}/pullRequests/${encodeURIComponent(String(prId))}/threads?api-version=7.1`;

      const json = await adoFetchJson<unknown>(url);
      const arr: unknown = Array.isArray(json)
        ? json
        : (json as any)?.value && Array.isArray((json as any).value)
        ? (json as any).value
        : undefined;
      if (!Array.isArray(arr)) throw new Error("Invalid PRThreads response shape");
      return (arr as unknown[]).map((it) => ZPRThread.parse(it));
    });
  }

  async listPRReviewers(prId: number): Promise<PRReviewer[]> {
    const cacheKey = `reviewers:${prId}`;
    return getOrSet<PRReviewer[]>(cacheKey, this.ttlMs, async () => {
      const url = `${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(
        this.repoId
      )}/pullRequests/${encodeURIComponent(String(prId))}/reviewers?api-version=7.1`;

      const json = await adoFetchJson<unknown>(url);
      const arr: unknown = Array.isArray(json)
        ? json
        : (json as any)?.value && Array.isArray((json as any).value)
        ? (json as any).value
        : undefined;
      if (!Array.isArray(arr)) throw new Error("Invalid PRReviewers response shape");
      return (arr as unknown[]).map((it) => ZPRReviewer.parse(it));
    });
  }
}
