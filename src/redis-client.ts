import { createClient, type RedisClientType } from "redis";

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

/** Create and connect the shared Redis client used by the application. */
export async function connectRedis(
  url = process.env.REDIS_URL ?? DEFAULT_REDIS_URL,
  clientName?: string,
): Promise<RedisClientType> {
  let hasConnectedOnce = false;
  const client = createClient({
    url,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy(retries, cause) {
        if (!hasConnectedOnce && retries >= 2) {
          return new Error("Redis did not become available during startup", { cause });
        }
        return Math.min((retries + 1) * 50, 500);
      },
    },
  });
  client.on("error", (error) => {
    console.error("Redis client error:", error.message);
  });

  try {
    await client.connect();
    hasConnectedOnce = true;
    if (clientName) await client.clientSetName(clientName);
    return client as RedisClientType;
  } catch (error) {
    client.destroy();
    throw error;
  }
}
