import * as dotenv from "dotenv";
import { expand } from "dotenv-expand";

// Load and expand once, as early as possible on the server.
if (!process.env.__DOTENV_LOADED__) {
  const env = dotenv.config();
  expand(env);
  process.env.__DOTENV_LOADED__ = "true";
}

declare global {
  // eslint-disable-next-line no-var
  var __DOTENV_LOADED__: string | undefined;
}

