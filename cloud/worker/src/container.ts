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
