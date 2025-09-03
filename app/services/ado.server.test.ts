import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setupServer } from "msw/node";
import { defaultAdoHandlers, malformedReviewersHandler } from "../../test/msw/ado-handlers";

// Ensure required env exists before importing modules under test
function setEnv() {
  process.env.ADO_ORG = "test-org";
  process.env.ADO_PROJECT = "test-project";
  process.env.ADO_REPO_ID = "test-repo";
  process.env.ADO_PAT = "fake-pat";
  process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
  process.env.APP_REQUEST_TIMEOUT_MS = "60000";
  process.env.APP_MAX_CONCURRENCY = "6";
  process.env.APP_CACHE_TTL_MS = "60000"; // short TTL to avoid long-lived cache in tests
  process.env.EXCLUDE_USERS_REGEX = "^svc-"; // mark service accounts
}

setEnv();

const server = setupServer(...defaultAdoHandlers());

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("AdoClient contract tests (MSW)", () => {
  it("queryByWiql returns IDs", async () => {
    const { AdoClient } = await import("./ado.server");
    const client = new AdoClient();
    const ids = await client.queryByWiql("Select [System.Id] From WorkItems");
    expect(ids).toEqual([101, 202]);
  });

  it("getWorkItemsBatch returns items for requested ids", async () => {
    const { AdoClient } = await import("./ado.server");
    const client = new AdoClient();
    const ids = [202, 101, 303];
    const items = await client.getWorkItemsBatch(ids, ["System.Title"]);
    expect(items.map((w) => w.id)).toEqual([202, 101, 303]);
    expect(items[0].fields["System.Title"]).toBe("WI 202");
  });

  it("listWorkItemUpdatesPaged merges pages and sorts by date", async () => {
    const { AdoClient } = await import("./ado.server");
    const client = new AdoClient();
    const updates = await client.listWorkItemUpdatesPaged(999);
    expect(updates.length).toBe(2);
    expect(updates[0].revisedDate).toBe("2020-01-01T00:00:00Z");
    expect(updates[1].revisedDate).toBe("2020-01-02T00:00:00Z");
  });

  it("listPullRequests returns PRs", async () => {
    const { AdoClient } = await import("./ado.server");
    const client = new AdoClient();
    const prs = await client.listPullRequests({ from: "2020-01-01", to: "2030-01-01" });
    expect(prs.length).toBeGreaterThan(0);
    expect(prs[0].id).toBe(555);
  });

  it("listPRThreads returns threads with comments", async () => {
    const { AdoClient } = await import("./ado.server");
    const client = new AdoClient();
    const threads = await client.listPRThreads(555);
    expect(threads.length).toBe(1);
    expect(threads[0].comments?.[0]?.publishedDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("listPRReviewers returns reviewers (happy path)", async () => {
    const { AdoClient } = await import("./ado.server");
    const client = new AdoClient();
    const reviewers = await client.listPRReviewers(555);
    expect(reviewers.length).toBe(1);
    expect(reviewers[0].id).toBe("r1");
    expect(typeof reviewers[0].vote).toBe("number");
  });

  it("listPRReviewers throws on malformed fixture (Zod)", async () => {
    server.use(malformedReviewersHandler);
    const { AdoClient } = await import("./ado.server");
    const client = new AdoClient();
    await expect(client.listPRReviewers(777)).rejects.toBeInstanceOf(Error);
  });

  it("listPRIterations returns iterations", async () => {
    const { AdoClient } = await import("./ado.server");
    const client = new AdoClient();
    const iterations = await client.listPRIterations(555);
    expect(iterations[0].id).toBe(1);
  });

  it("listPolicyEvaluations returns policies", async () => {
    const { AdoClient } = await import("./ado.server");
    const client = new AdoClient();
    const policies = await client.listPolicyEvaluations("project-id-123", 555);
    expect(policies[0].configuration.type.displayName).toMatch(/Build/);
    expect(typeof policies[0].status).toBe("string");
  });

  it("listGraphUsers normalizes and marks service accounts", async () => {
    const { AdoClient } = await import("./ado.server");
    const client = new AdoClient();
    const users = await client.listGraphUsers({ bypass: true });
    expect(users.length).toBeGreaterThanOrEqual(2);
    const john = users.find((u) => u.id === "g1");
    const bot = users.find((u) => u.id === "g2");
    expect(john?.isServiceAccount).toBe(false);
    expect(bot?.isServiceAccount).toBe(true);
  });

  it("listAreaPaths returns tree", async () => {
    const { AdoClient } = await import("./ado.server");
    const client = new AdoClient();
    const root = await client.listAreaPaths(3);
    expect(root.name).toBe("Areas");
    expect(root.children?.[0]?.name).toBe("Team A");
  });
});

