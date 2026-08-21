import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

/** Tests read the same .env.local the dev server does. */
function loadLocalEnv(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

export default defineConfig({
  test: { env: loadLocalEnv(), include: ["tests/**/*.test.ts"] },
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
});
