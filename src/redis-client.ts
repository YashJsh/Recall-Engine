import { createClient } from "redis";

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

/** Create and connect the shared Redis client used by the application. */
export async function connectRedis(url = process.env.REDIS_URL ?? DEFAULT_REDIS_URL) {
  const client = createClient({ url });
  client.on("error", (error) => {
    console.error("Redis client error:", error.message);
  });

  try {
    await client.connect();
    return client;
  } catch (error) {
    client.destroy();
    throw error;
  }
}
