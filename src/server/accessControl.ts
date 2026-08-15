import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../lib/prisma.js";
import { hashKey } from "../lib/auth/apiKey.js";

export { hashKey };

/**
 * MVP-level access control: each Organization has one or more API keys
 * (stored hashed) that scope every dashboard API request to that org's
 * data only. This is intentionally NOT full SSO/SAML — that's explicitly
 * out of MVP scope (see product plan). It does satisfy the "no cross-org
 * data leakage" requirement, which is the part that actually matters for
 * the MVP's security posture.
 *
 * Real orgs are provisioned via the GitHub App install flow; for local/demo
 * use, `scripts/seed-demo-org.ts` creates one org + prints its API key.
 */
export interface AuthedRequest extends FastifyRequest {
  orgId?: string;
}

export interface OrgLookupClient {
  organization: {
    findFirst(args: { where: { apiKeyHash: string } }): Promise<{ id: string } | null>;
  };
}

export type AuthResult = { authorized: true; orgId: string } | { authorized: false; status: 401; reason: string };

/**
 * Pure-ish authorization core, separated from the Fastify request/reply
 * plumbing so the actual decision — "does this key resolve to exactly one
 * org, and only that org's data is ever scoped to it" — is unit-testable
 * against a mock DB client instead of requiring a live Postgres + Fastify
 * server. This is the boundary every dashboard route's cross-org isolation
 * depends on.
 */
export async function resolveOrgAuth(
  client: OrgLookupClient,
  apiKeyHeader: string | string[] | undefined
): Promise<AuthResult> {
  if (typeof apiKeyHeader !== "string" || apiKeyHeader.length < 20) {
    return { authorized: false, status: 401, reason: "Missing or malformed X-API-Key header" };
  }

  const org = await client.organization.findFirst({ where: { apiKeyHash: hashKey(apiKeyHeader) } });

  if (!org) {
    return { authorized: false, status: 401, reason: "Invalid API key" };
  }

  return { authorized: true, orgId: org.id };
}

export async function requireOrgAuth(request: AuthedRequest, reply: FastifyReply): Promise<void> {
  const result = await resolveOrgAuth(prisma, request.headers["x-api-key"]);

  if (!result.authorized) {
    reply.code(result.status).send({ error: result.reason });
    return;
  }

  request.orgId = result.orgId;
}
