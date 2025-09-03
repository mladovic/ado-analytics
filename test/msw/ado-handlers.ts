import { http, HttpResponse, type HttpHandler } from "msw";

// Default fixtures used across tests
const now = new Date().toISOString();

export function defaultAdoHandlers(): HttpHandler[] {
  return [
    // WIQL: return two IDs
    http.post("https://dev.azure.com/:org/:project/_apis/wit/wiql", async () => {
      return HttpResponse.json({ workItems: [{ id: 101 }, { id: 202 }] });
    }),

    // Work items batch: echo back minimal items for requested ids
    http.post(
      "https://dev.azure.com/:org/:project/_apis/wit/workitemsbatch",
      async ({ request }) => {
        const body = (await request.json()) as { ids?: number[] };
        const items = (body.ids ?? []).map((id) => ({ id, fields: { "System.Title": `WI ${id}` } }));
        return HttpResponse.json({ value: items });
      }
    ),

    // Work item updates: two pages via continuationToken
    http.get(
      "https://dev.azure.com/:org/:project/_apis/wit/workitems/:id/updates",
      ({ request }) => {
        const url = new URL(request.url);
        const token = url.searchParams.get("continuationToken");
        if (!token) {
          return HttpResponse.json({
            value: [
              { id: 1, rev: 1, revisedDate: "2020-01-01T00:00:00Z", fields: {} },
            ],
            continuationToken: "next",
          });
        }
        return HttpResponse.json({
          value: [{ id: 2, rev: 2, revisedDate: "2020-01-02T00:00:00Z", fields: {} }],
        });
      }
    ),

    // Pull requests search
    http.get(
      "https://dev.azure.com/:org/:project/_apis/git/repositories/:repoId/pullrequests",
      () => {
        return HttpResponse.json({
          value: [
            {
              id: 555,
              createdBy: { id: "u1", displayName: "Alice" },
              creationDate: now,
              status: "active",
              targetRefName: "refs/heads/main",
              sourceRefName: "refs/heads/feature",
            },
          ],
        });
      }
    ),

    // PR threads
    http.get(
      "https://dev.azure.com/:org/:project/_apis/git/repositories/:repoId/pullRequests/:prId/threads",
      () =>
        HttpResponse.json({
          value: [
            {
              id: 1,
              comments: [{ id: 10, content: "hi", publishedDate: now }],
            },
          ],
        })
    ),

    // PR reviewers
    http.get(
      "https://dev.azure.com/:org/:project/_apis/git/repositories/:repoId/pullRequests/:prId/reviewers",
      () =>
        HttpResponse.json({
          value: [
            { id: "r1", displayName: "Bob", vote: 10, uniqueName: "bob@example.com" },
          ],
        })
    ),

    // PR iterations
    http.get(
      "https://dev.azure.com/:org/:project/_apis/git/repositories/:repoId/pullRequests/:prId/iterations",
      () => HttpResponse.json({ value: [{ id: 1, createdDate: now }] })
    ),

    // Policy evaluations
    http.get(
      "https://dev.azure.com/:org/:project/_apis/policy/evaluations",
      ({ request }) => {
        const url = new URL(request.url);
        const artifactId = url.searchParams.get("artifactId");
        if (!artifactId) return HttpResponse.json({ value: [] });
        return HttpResponse.json({
          value: [
            {
              configuration: { type: { displayName: "Build Validation" } },
              status: "approved",
              startedDate: now,
            },
          ],
        });
      }
    ),

    // Graph users (single page)
    http.get("https://vssps.dev.azure.com/:org/_apis/graph/users", () => {
      return HttpResponse.json({
        value: [
          {
            id: "g1",
            displayName: "John Doe",
            uniqueName: "john@example.com",
            descriptor: "vssgp.MTIz",
          },
          {
            id: "g2",
            displayName: "Svc Bot",
            uniqueName: "svc-bot@example.com",
            descriptor: "vssgp.NDU2",
          },
        ],
      });
    }),

    // Areas
    http.get(
      "https://dev.azure.com/:org/:project/_apis/wit/classificationnodes/Areas",
      () =>
        HttpResponse.json({
          name: "Areas",
          children: [
            { name: "Team A", children: [{ name: "Sub A1" }, { name: "Sub A2" }] },
            { name: "Team B" },
          ],
        })
    ),
  ];
}

// Malformed reviewers handler (for negative test)
export const malformedReviewersHandler = http.get(
  "https://dev.azure.com/:org/:project/_apis/git/repositories/:repoId/pullRequests/:prId/reviewers",
  () => HttpResponse.json({ value: [{ id: 123, displayName: "Bad" }] }) // id wrong type and missing vote
);

