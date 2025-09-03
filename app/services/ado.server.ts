import { getServerEnv } from "~/env.server";
import { adoFetchJson, hashString } from "~/services/http.server";
import { getOrSet } from "~/services/cache.server";
import {
  WiqlResponseSchema as ZWiqlResponse,
  WorkItemSchema as ZWorkItem,
  WorkItemUpdateSchema as ZWorkItemUpdate,
  PullRequestSchema as ZPullRequest,
  PRThreadSchema as ZPRThread,
  PRReviewerSchema as ZPRReviewer,
  PRIterationSchema as ZPRIteration,
  PolicyEvaluationSchema as ZPolicyEvaluation,
  GraphUserSchema as ZGraphUser,
  AreaNodeSchema as ZAreaNode,
} from "~/models/zod-ado";
import type {
  WorkItem,
  WorkItemUpdate,
  PullRequest,
  PRThread,
  PRReviewer,
  PRIteration,
  PolicyEvaluation,
  AreaNode,
} from "~/models/zod-ado";

// Centralized API versions
const API = {
  wit: "7.1",
  git: "7.1",
  policyPreview: "7.1-preview.1",
  graph: "7.1-preview.1",
} as const;

// Normalize Azure DevOps list responses which often use { value: [] }
function asArray(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  const value = (json as any)?.value;
  return Array.isArray(value) ? value : [];
}

export class AdoClient {
  private readonly org: string;
  private readonly project: string;
  private readonly repoId: string;
  private readonly ttlMs: number;
  private readonly baseUrl: string;
  private readonly graphBaseUrl: string;

  constructor() {
    const { ADO_ORG, ADO_PROJECT, ADO_REPO_ID, APP_CACHE_TTL_MS } = getServerEnv();
    this.org = ADO_ORG;
    this.project = ADO_PROJECT;
    this.repoId = ADO_REPO_ID;
    this.ttlMs = APP_CACHE_TTL_MS;
    this.baseUrl = `https://dev.azure.com/${this.org}`;
    this.graphBaseUrl = `https://vssps.dev.azure.com/${this.org}`;
  }

  /** Query work item IDs by WIQL string. */
  async queryByWiql(wiql: string): Promise<number[]> {
    const cacheKey = `wiql:${hashString(wiql)}`;
    return getOrSet<number[]>(cacheKey, this.ttlMs, async () => {
      const url = `${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/wit/wiql?api-version=${API.wit}`;
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

    const url = `${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/wit/workitemsbatch?api-version=${API.wit}`;

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
          const arr = asArray(json);
          if (!Array.isArray(arr)) throw new Error("Invalid WorkItemsBatch response shape");
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
        let url = `${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/wit/workitems/${id}/updates?api-version=${API.wit}`;
        if (continuationToken) {
          url += `&continuationToken=${encodeURIComponent(continuationToken)}`;
        }

        const json = await adoFetchJson<unknown>(url);
        const pageArr = asArray(json);
        if (!Array.isArray(pageArr)) throw new Error("Invalid WorkItemUpdates response shape");
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
        searchParams.set("api-version", API.git)

        const url = `${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(
          this.repoId
        )}/pullrequests?${searchParams.toString()}`

        const json = await adoFetchJson<unknown>(url)
        const arr = asArray(json)
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
      )}/pullRequests/${encodeURIComponent(String(prId))}/threads?api-version=${API.git}`;

      const json = await adoFetchJson<unknown>(url);
      const arr = asArray(json);
      if (!Array.isArray(arr)) throw new Error("Invalid PRThreads response shape");
      return (arr as unknown[]).map((it) => ZPRThread.parse(it));
    });
  }

  async listPRReviewers(prId: number): Promise<PRReviewer[]> {
    const cacheKey = `reviewers:${prId}`;
    return getOrSet<PRReviewer[]>(cacheKey, this.ttlMs, async () => {
      const url = `${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(
        this.repoId
      )}/pullRequests/${encodeURIComponent(String(prId))}/reviewers?api-version=${API.git}`;

      const json = await adoFetchJson<unknown>(url);
      const arr = asArray(json);
      if (!Array.isArray(arr)) throw new Error("Invalid PRReviewers response shape");
      return (arr as unknown[]).map((it) => ZPRReviewer.parse(it));
    });
  }

  async listPRIterations(prId: number): Promise<PRIteration[]> {
    const cacheKey = `iterations:${prId}`;
    return getOrSet<PRIteration[]>(cacheKey, this.ttlMs, async () => {
      const url = `${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(
        this.repoId
      )}/pullRequests/${encodeURIComponent(String(prId))}/iterations?api-version=${API.git}`;

      const json = await adoFetchJson<unknown>(url);
      const arr = asArray(json);
      if (!Array.isArray(arr)) throw new Error("Invalid PRIterations response shape");
      return (arr as unknown[]).map((it) => ZPRIteration.parse(it));
    });
  }

  async listPRWorkItems(prId: number): Promise<number[]> {
    const cacheKey = `prLinks:${prId}`;
    return getOrSet<number[]>(cacheKey, this.ttlMs, async () => {
      const url = `${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(
        this.repoId
      )}/pullRequests/${encodeURIComponent(String(prId))}/workitems?api-version=${API.git}`;

      const json = await adoFetchJson<unknown>(url);
      const arr = asArray(json);
      if (!Array.isArray(arr)) throw new Error("Invalid PRWorkItems response shape");

      const ids = (arr as unknown[])
        .map((it) =>
          typeof it === "number"
            ? it
            : it && typeof (it as any).id === "number"
            ? (it as any).id
            : undefined
        )
        .filter((n): n is number => typeof n === "number");

      return ids;
    });
  }

  async listPolicyEvaluations(projectId: string, prId: number): Promise<PolicyEvaluation[]> {
    const cacheKey = `policies:${projectId}:${prId}`;
    return getOrSet<PolicyEvaluation[]>(cacheKey, this.ttlMs, async () => {
      const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${prId}`;
      const params = new URLSearchParams();
      params.set("artifactId", artifactId);
      params.set("api-version", API.policyPreview);

      const url = `${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/policy/evaluations?${params.toString()}`;
      const json = await adoFetchJson<unknown>(url);
      const arr = asArray(json);
      if (!Array.isArray(arr)) throw new Error("Invalid PolicyEvaluations response shape");
      return (arr as unknown[]).map((it) => ZPolicyEvaluation.parse(it));
    });
  }

  /**
   * List all Graph users in the organization.
   * - Base URL: vssps.dev.azure.com (Graph)
   * - Handles paging via continuationToken
   * - Validates each user with ZGraphUser
   * - Normalizes fields and marks service accounts using configured regex/list
   * - Cached under key "graphUsers"
   */
  async listGraphUsers(): Promise<
    Array<{
      id: string;
      displayName?: string;
      uniqueName?: string;
      descriptor?: string;
      isServiceAccount: boolean;
    }>
  > {
    const cacheKey = `graphUsers`;
    return getOrSet(cacheKey, this.ttlMs, async () => {
      const users: Array<{
        id: string;
        displayName?: string;
        uniqueName?: string;
        descriptor?: string;
        isServiceAccount: boolean;
      }> = [];

      // Build exclude matchers from env configuration (optional)
      const regexStr =
        process.env.EXCLUDE_USERS_REGEX || process.env.ADO_EXCLUDE_USERS_REGEX || process.env.APP_EXCLUDE_USERS_REGEX || "";
      let excludeRe: RegExp | undefined;
      if (regexStr) {
        try {
          excludeRe = new RegExp(regexStr, "i");
        } catch {
          // ignore invalid regex
        }
      }
      const extrasStr =
        process.env.EXCLUDE_USERS_EXTRA || process.env.ADO_EXCLUDE_USERS_EXTRA || process.env.APP_EXCLUDE_USERS_EXTRA || "";
      const extraList = extrasStr
        .split(/[\n,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

      const isServiceAccount = (u: { uniqueName?: string; mailAddress?: string; displayName?: string; descriptor?: string }) => {
        const candidates = [u.uniqueName, u.mailAddress, u.displayName, u.descriptor].filter(
          (v): v is string => typeof v === "string" && v.length > 0
        );
        if (excludeRe && candidates.some((c) => excludeRe!.test(c))) return true;
        if (extraList.length && candidates.some((c) => extraList.includes(c.toLowerCase()))) return true;
        return false;
      };

      let continuationToken: string | undefined;
      let safety = 0;
      do {
        let url = `${this.graphBaseUrl}/_apis/graph/users?api-version=${API.graph}`;
        if (continuationToken) url += `&continuationToken=${encodeURIComponent(continuationToken)}`;

        const json = await adoFetchJson<unknown>(url);
        const arr = asArray(json);
        if (!Array.isArray(arr)) throw new Error("Invalid GraphUsers response shape");

        for (const it of arr as unknown[]) {
          const gu = ZGraphUser.parse(it) as {
            id: string;
            displayName?: string;
            uniqueName?: string;
            mailAddress?: string;
            descriptor?: string;
          };
          const uniqueName = gu.uniqueName ?? gu.mailAddress;
          users.push({
            id: gu.id,
            displayName: gu.displayName,
            uniqueName,
            descriptor: gu.descriptor,
            isServiceAccount: isServiceAccount(gu),
          });
        }

        const token = (json as any)?.continuationToken;
        continuationToken = typeof token === "string" && token.length > 0 ? token : undefined;

        safety++;
        if (safety > 200) throw new Error("Graph users paging exceeded safety limit");
      } while (continuationToken);

      return users;
    });
  }

  /**
   * List Area Paths tree for the project.
   * - GET /{project}/_apis/wit/classificationnodes/Areas?$depth=depth&api-version=7.1
   * - Validates with ZAreaNode
   * - Caches under key `areas:$depth`
   */
  async listAreaPaths(depth = 5): Promise<AreaNode> {
    const d = Math.max(1, Math.floor(depth));
    const cacheKey = `areas:${d}`;
    return getOrSet<AreaNode>(cacheKey, this.ttlMs, async () => {
      const params = new URLSearchParams();
      params.set("$depth", String(d));
      params.set("api-version", API.wit);
      const url = `${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/wit/classificationnodes/Areas?${params.toString()}`;
      const json = await adoFetchJson<unknown>(url);
      return ZAreaNode.parse(json);
    });
  }
}
