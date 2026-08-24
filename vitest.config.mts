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
  test: {
    env: loadLocalEnv(),
    /**
     * Two projects, because route-handler tests need the session and `after()` seams
     * installed before any handler module is imported, and the unit and database
     * tests must run without them — a mocked session would hide exactly the bugs
     * the permission matrix exists to find.
     */
    projects: [
      {
        extends: true,
        test: {
          name: "unit-and-db",
          include: ["tests/unit/**/*.test.ts", "tests/db/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "api",
          include: ["tests/api/**/*.test.ts"],
          setupFiles: ["./tests/api/setup.ts"],
        },
      },
    ],
  },
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
});
