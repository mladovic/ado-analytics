import { getServerEnv } from "../env.server";
import { AdoClient } from "./ado.server";

let _instance: AdoClient | null = null;

export function getAdoClient(): AdoClient {
  if (_instance) return _instance;
  // Validate/load environment once at creation time
  getServerEnv();
  _instance = new AdoClient();
  return _instance;
}

