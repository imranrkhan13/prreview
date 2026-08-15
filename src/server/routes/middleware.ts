import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { resolvedSessionSecret } from "../../lib/env.js";
import { resolveAuth as resolveAuthCore, ResolvedAuth } from "../../lib/auth/resolveAuth.js";

export interface AuthedRequest2 extends FastifyRequest {
  auth?: Extract<ResolvedAuth, { authenticated: true }>;
}

/**
 * Fastify preHandler: resolves session-or-API-key auth for every /api/*
 * request and attaches the result to `request.auth`. Route handlers then
 * check `isAuthorizedForOrg(request.auth, resource.orgId)` -- where
 * `resource.orgId` was itself just read from the database, never from a
 * client-supplied path/body param -- before returning any org-scoped data.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await resolveAuthCore(prisma, {
    sessionSecret: resolvedSessionSecret,
    authorizationHeader: request.headers.authorization,
    apiKeyHeader: request.headers["x-api-key"],
  });

  if (!result.authenticated) {
    reply.code(result.status).send({ error: result.reason });
    return;
  }

  (request as AuthedRequest2).auth = result;
}
