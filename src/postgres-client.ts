import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export function createPostgresClient(
  databaseUrl = process.env.DATABASE_URL,
  applicationName?: string,
) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set before connecting to PostgreSQL");
  }

  const connectionString = applicationName
    ? withApplicationName(databaseUrl, applicationName)
    : databaseUrl;
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

function withApplicationName(databaseUrl: string, applicationName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}
