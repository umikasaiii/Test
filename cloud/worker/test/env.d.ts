declare namespace Cloudflare {
  interface Env extends import("../src/env").Env { TEST_MIGRATIONS: import("cloudflare:test").D1Migration[] }
}
