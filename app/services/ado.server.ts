import { getServerEnv } from "~/env.server";
import { adoFetchJson } from "~/services/http.server";
import { getOrSet } from "~/services/cache.server";
import { WiqlResponseSchema as ZWiqlResponse } from "~/models/zod-ado";

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
  private ttlMs: number;
  private baseUrl: string;

  constructor() {
    const { ADO_ORG, ADO_PROJECT, APP_CACHE_TTL_MS } = getServerEnv();
    this.org = ADO_ORG;
    this.project = ADO_PROJECT;
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
}

