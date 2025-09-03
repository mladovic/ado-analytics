import type { Route } from "./+types/resources.meta.people";
import { AdoClient } from "~/services/ado.server";

let _client: AdoClient | null = null;
function getClient(): AdoClient {
  if (_client) return _client;
  _client = new AdoClient();
  return _client;
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const refreshParam = (url.searchParams.get("refresh") || "").toLowerCase();
  const bypass = refreshParam === "1" || refreshParam === "true" || refreshParam === "yes";

  const client = getClient();
  const users = await client.listGraphUsers({ bypass });

  const people = users
    .filter((u) => !u.isServiceAccount)
    .map((u) => ({
      id: u.id,
      email: u.uniqueName ?? "",
      displayName: u.displayName ?? u.uniqueName ?? u.descriptor ?? u.id,
    }));

  const headers = new Headers({ "content-type": "application/json" });
  return new Response(JSON.stringify(people), { headers });
}

