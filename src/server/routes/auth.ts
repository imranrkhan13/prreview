import { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { env, resolvedSessionSecret } from "../../lib/env.js";
import { createOAuthState, verifyOAuthState } from "../../lib/auth/oauthState.js";
import { createSessionToken, verifySessionToken } from "../../lib/auth/session.js";
import { createGitHubOAuthClient } from "../../lib/auth/githubOAuthClient.js";
import { AuthedRequest2 } from "./middleware.js";

const EXCHANGE_CODE_TTL_SECONDS = 60;

function requireOAuthConfig() {
  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) {
    throw new Error(
      "GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET must be set to enable Sign in with GitHub."
    );
  }
  return createGitHubOAuthClient({
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    redirectUri: env.GITHUB_OAUTH_CALLBACK_URL,
  });
}

export async function registerAuthRoutes(app: FastifyInstance) {
  // GET /api/auth/github/login -- redirects to GitHub's OAuth authorize
  // page with a signed, short-lived CSRF state param.
  app.get("/api/auth/github/login", async (request, reply) => {
    let client;
    try {
      client = requireOAuthConfig();
    } catch (err) {
      return reply.code(503).send({ error: "GitHub sign-in is not configured on this server." });
    }
    const state = createOAuthState(resolvedSessionSecret);
    return reply.redirect(client.getAuthorizeUrl(state));
  });

  // GET /api/auth/github/callback -- GitHub redirects here after the user
  // approves. Exchanges the code, upserts the User row, mints a session,
  // stores a SHORT-LIVED one-time exchange code, and redirects to the
  // DASHBOARD (a different origin) with that code -- never the real
  // session token -- in the URL. The dashboard immediately exchanges it
  // via POST /api/auth/exchange, keeping the actual bearer token out of
  // browser history/referrer headers.
  app.get("/api/auth/github/callback", async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };

    if (!code || !state || !verifyOAuthState(state, resolvedSessionSecret)) {
      request.log.warn("Rejected GitHub OAuth callback: missing or invalid state (possible CSRF attempt)");
      return reply.code(400).send({ error: "Invalid or expired login attempt. Please try signing in again." });
    }

    let client;
    try {
      client = requireOAuthConfig();
    } catch {
      return reply.code(503).send({ error: "GitHub sign-in is not configured on this server." });
    }

    try {
      const { accessToken } = await client.exchangeCodeForToken(code);
      const profile = await client.fetchUserProfile(accessToken);

      const user = await prisma.user.upsert({
        where: { githubUserId: BigInt(profile.githubUserId) },
        create: {
          githubUserId: BigInt(profile.githubUserId),
          login: profile.login,
          avatarUrl: profile.avatarUrl,
        },
        update: { login: profile.login, avatarUrl: profile.avatarUrl },
      });

      const exchangeCode = randomBytes(24).toString("hex");
      await prisma.oneTimeExchangeCode.create({
        data: {
          code: exchangeCode,
          userId: user.id,
          expiresAt: new Date(Date.now() + EXCHANGE_CODE_TTL_SECONDS * 1000),
        },
      });

      const redirectUrl = new URL("/auth/callback", env.DASHBOARD_ORIGIN);
      redirectUrl.searchParams.set("code", exchangeCode);
      return reply.redirect(redirectUrl.toString());
    } catch (err) {
      request.log.error({ err }, "GitHub OAuth callback failed");
      const failUrl = new URL("/auth/callback", env.DASHBOARD_ORIGIN);
      failUrl.searchParams.set("error", "oauth_failed");
      return reply.redirect(failUrl.toString());
    }
  });

  // POST /api/auth/exchange -- the dashboard calls this immediately after
  // the OAuth redirect, trading the one-time code for the real session
  // token. Single-use and short-lived, checked here.
  app.post("/api/auth/exchange", async (request, reply) => {
    const { code } = (request.body ?? {}) as { code?: string };
    if (!code) return reply.code(400).send({ error: "Missing exchange code" });

    const record = await prisma.oneTimeExchangeCode.findUnique({ where: { code } });

    if (!record || record.usedAt || record.expiresAt < new Date()) {
      return reply.code(401).send({ error: "Exchange code is invalid, expired, or already used" });
    }

    await prisma.oneTimeExchangeCode.update({ where: { code }, data: { usedAt: new Date() } });

    const session = createSessionToken({
      userId: record.userId,
      secret: resolvedSessionSecret,
      ttlSeconds: env.SESSION_TTL_SECONDS,
    });

    return { token: session.token, expiresAt: new Date(session.exp * 1000).toISOString() };
  });

  // POST /api/auth/logout -- revokes THIS session (by sid), so the
  // presented token can never be used again even though it's still
  // signature-valid until its own expiry.
  app.post("/api/auth/logout", async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      const verified = verifySessionToken(authHeader.slice("Bearer ".length), resolvedSessionSecret);
      if (verified.valid) {
        await prisma.revokedSession.upsert({
          where: { sid: verified.payload.sid },
          create: { sid: verified.payload.sid, expiresAt: new Date(verified.payload.exp * 1000) },
          update: {},
        });
      }
    }
    return { status: "signed_out" };
  });

  // GET /api/me -- current user + org memberships. Requires auth (session
  // or API key), same as every other /api/* route.
  app.get("/api/me", async (request, reply) => {
    const auth = (request as AuthedRequest2).auth!;
    if (auth.mode !== "session" || !auth.userId) {
      return reply.code(400).send({ error: "GET /api/me requires a session token, not an API key" });
    }

    const user = await prisma.user.findUnique({ where: { id: auth.userId } });
    if (!user) return reply.code(404).send({ error: "User not found" });

    const memberships = await prisma.membership.findMany({
      where: { userId: auth.userId },
      include: { org: true },
    });

    return {
      id: user.id,
      login: user.login,
      avatarUrl: user.avatarUrl,
      organizations: memberships.map((m: { role: string; org: { id: string; name: string } }) => ({
        id: m.org.id,
        name: m.org.name,
        role: m.role,
      })),
    };
  });
}
