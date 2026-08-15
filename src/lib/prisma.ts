import { PrismaClient } from "@prisma/client";

// Lazily instantiated so importing this module (even transitively, e.g.
// via accessControl.ts) doesn't require a working Prisma client at import
// time — this matters for unit tests that only exercise pure logic and
// never actually touch the database.
let client: PrismaClient | undefined;

function getClient(): PrismaClient {
  if (!client) {
    client = new PrismaClient();
  }
  return client;
}

// Proxy so existing call sites (`prisma.deployment.findMany(...)`, etc.)
// keep working unchanged — the underlying PrismaClient is only actually
// constructed the first time a property is accessed.
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getClient() as object, prop, receiver);
  },
});
