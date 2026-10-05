import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations, INTERNAL_TOKEN: "test-internal-token" } },
    })],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"], testTimeout: 60000 },
  };
});
