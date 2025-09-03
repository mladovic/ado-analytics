import "./load-dotenv";
import { z } from "zod";

export const ServerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5173),

  // Azure DevOps (server only)
  ADO_ORG: z.string().min(1, "ADO_ORG is required"),
  ADO_PROJECT: z.string().min(1, "ADO_PROJECT is required"),
  ADO_REPO_ID: z.string().min(1, "ADO_REPO_ID is required"),
  ADO_PAT: z.string().min(1, "ADO_PAT (server secret) is required"),

  // App tuning
  APP_MAX_CONCURRENCY: z.coerce.number().int().positive().max(32).default(6),
  APP_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  APP_CACHE_TTL_MS: z.coerce.number().int().positive().default(86_400_000),

  // Session/cookies
  SESSION_SECRET: z
    .string()
    .min(10, "SESSION_SECRET should be a long random string"),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let cached: ServerEnv | null = null;

export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = ServerEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `- ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    const hint = [
      "Environment validation failed.",
      issues,
      "",
      "Create/update your .env or environment and re-run.",
      "See .env.example for the required variables.",
    ].join("\n");
    throw new Error(hint);
  }
  cached = parsed.data;
  return cached;
}

