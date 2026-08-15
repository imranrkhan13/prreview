import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { env } from "../lib/env.js";
import { prisma } from "../lib/prisma.js";
import { registerWebhookRoute } from "./routes/webhook.js";
import { registerDashboardApiRoutes } from "./routes/dashboardApi.js";
import { registerAuthRoutes } from "./routes/auth.js";

async function main() {
  const app = Fastify({
    logger: {
      transport: { target: "pino-pretty" },
      // Never log full request bodies/headers by default — webhook payloads
      // can contain repo metadata and headers include the signature. Keep
      // logs to structured, minimal fields set explicitly at call sites.
      redact: ["req.headers.authorization", "req.headers['x-hub-signature-256']", "req.headers['x-api-key']"],
    },
  });

  // Never leak internal error details (stack traces, DB error text, etc.)
  // to clients. Fastify logs the full error server-side via app.log
  // automatically; this handler controls only what the CLIENT sees.
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "Unhandled request error");

    // Fastify's own validation errors carry a statusCode we can trust to
    // describe a genuine client mistake (bad JSON, schema violation, etc).
    const statusCode = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;

    if (statusCode >= 500) {
      reply.code(statusCode).send({ error: "Internal server error" });
    } else {
      reply.code(statusCode).send({ error: error.message });
    }
  });

  await app.register(cors, { origin: env.DASHBOARD_ORIGIN });
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });

  // Preserve the raw request body BEFORE JSON parsing so webhook signature
  // verification is byte-exact against what GitHub actually signed.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body: Buffer, done) => {
      (req as unknown as { rawBody: Buffer }).rawBody = body;
      try {
        const json = body.length ? JSON.parse(body.toString("utf8")) : {};
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  // Liveness: process is up and answering HTTP requests. No dependency
  // checks — this should return fast even if the DB is briefly unreachable,
  // since that's what /ready is for.
  app.get("/health", async () => ({ status: "ok" }));

  // Kept for backwards compatibility with any existing Railway health-check
  // configuration pointed at /healthz.
  app.get("/healthz", async () => ({ ok: true, mode: env.APP_MODE }));

  // Readiness: process is up AND its required dependencies (currently just
  // the database) are reachable. Never includes connection strings, error
  // internals, or any other secret in the response.
  app.get("/ready", async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: "ready", database: "connected" };
    } catch {
      reply.code(503);
      return { status: "not_ready", database: "unreachable" };
    }
  });

  await registerWebhookRoute(app);
  await registerAuthRoutes(app);
  await registerDashboardApiRoutes(app);

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error:", err);
  process.exit(1);
});
