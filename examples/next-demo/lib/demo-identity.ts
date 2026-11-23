import { Pool } from "pg";
import type { RecallMemoryScope } from "recall-engine";

const DEMO_TENANT_NAME = "Recall Engine Local Demo";
const DEMO_USER_EXTERNAL_ID = "recall-engine-next-demo-user";
const DEMO_SESSION_EXTERNAL_ID = "recall-engine-next-demo-session";

type DemoRuntime = typeof globalThis & {
  __recallDemoPool?: Pool;
  __recallDemoScopePromise?: Promise<RecallMemoryScope>;
};

const demoRuntime = globalThis as DemoRuntime;

function getPool(): Pool {
  if (demoRuntime.__recallDemoPool) return demoRuntime.__recallDemoPool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL must be configured for the local demo");
  demoRuntime.__recallDemoPool = new Pool({ connectionString, max: 2 });
  return demoRuntime.__recallDemoPool;
}

/** Creates or finds the one identity owned by this local host application. */
export function getDemoScope(): Promise<RecallMemoryScope> {
  demoRuntime.__recallDemoScopePromise ??= createOrFindDemoScope();
  return demoRuntime.__recallDemoScopePromise;
}

async function createOrFindDemoScope(): Promise<RecallMemoryScope> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const tenant = await client.query<{ id: string }>(
      'SELECT "id" FROM "Tenant" WHERE "name" = $1 ORDER BY "createdAt" LIMIT 1',
      [DEMO_TENANT_NAME],
    );
    const tenantId = tenant.rows[0]?.id ?? (await client.query<{ id: string }>(
      'INSERT INTO "Tenant" ("id", "name") VALUES (gen_random_uuid(), $1) RETURNING "id"',
      [DEMO_TENANT_NAME],
    )).rows[0]?.id;
    if (!tenantId) throw new Error("Could not create the local demo tenant");

    const user = await client.query<{ id: string }>(
      'SELECT "id" FROM "User" WHERE "tenantId" = $1 AND "externalId" = $2 LIMIT 1',
      [tenantId, DEMO_USER_EXTERNAL_ID],
    );
    const userId = user.rows[0]?.id ?? (await client.query<{ id: string }>(
      'INSERT INTO "User" ("id", "tenantId", "externalId") VALUES (gen_random_uuid(), $1, $2) RETURNING "id"',
      [tenantId, DEMO_USER_EXTERNAL_ID],
    )).rows[0]?.id;
    if (!userId) throw new Error("Could not create the local demo user");

    const session = await client.query<{ id: string }>(
      'SELECT "id" FROM "Session" WHERE "tenantId" = $1 AND "userId" = $2 AND "externalId" = $3 LIMIT 1',
      [tenantId, userId, DEMO_SESSION_EXTERNAL_ID],
    );
    const sessionId = session.rows[0]?.id ?? (await client.query<{ id: string }>(
      'INSERT INTO "Session" ("id", "tenantId", "userId", "externalId") VALUES (gen_random_uuid(), $1, $2, $3) RETURNING "id"',
      [tenantId, userId, DEMO_SESSION_EXTERNAL_ID],
    )).rows[0]?.id;
    if (!sessionId) throw new Error("Could not create the local demo session");

    await client.query("COMMIT");
    return { tenantId, userId, sessionId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
