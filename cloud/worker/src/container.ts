// Cloudflare Container hosting the DSLink Runtime production image (cloud/Dockerfile.runtime).
// One container instance per game session (addressed by the session id). CODED, NOT DEPLOYED: Containers cannot run in miniflare.
import { Container } from "@cloudflare/containers";
import type { Env } from "./env";

export class DSLinkContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";                 // safety net: the session DO destroys the container explicitly on end
  enableInternet = true;              // to pull the session's private content from the Worker with a one-time ticket
  envVars = { DSLINK_BACKEND: "runtime", DSLINK_WORKDIR: "/var/lib/dslink" };
}

export interface SessionHost { start(): Promise<void>; fetch(req: Request): Promise<Response>; destroy(): Promise<void> }

/**
 * Where a session's DSLink Runtime lives.
 *   production: one Cloudflare Container per session (CONTAINER binding)
 *   development/test only: a locally running gateway (DEV_GATEWAY=http://localhost:8080) so the whole path can be exercised without Cloudflare
 */
export async function hostFor(env: Env, sessionId: string): Promise<SessionHost | null> {
  if (env.CONTAINER) {
    const { getContainer } = await import("@cloudflare/containers");
    const c = getContainer(env.CONTAINER as any, sessionId);
    return { start: () => c.startAndWaitForPorts().then(() => undefined), fetch: (r) => c.fetch(r), destroy: () => c.destroy().then(() => undefined) };
  }
  if (env.DEV_GATEWAY && (env.ENVIRONMENT === "dev" || env.ENVIRONMENT === "test")) {
    const base = env.DEV_GATEWAY.replace(/\/$/, "");
    return { start: async () => undefined, destroy: async () => undefined,
      fetch: (r) => { const u = new URL(r.url); return fetch(new Request(base + u.pathname + u.search, r)); } };
  }
  return null;
}
