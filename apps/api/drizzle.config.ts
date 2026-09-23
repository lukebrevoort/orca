import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: ["./src/db/schema.ts", "./src/auth/mobile/schema.ts", "./src/mobile-push/schema.ts"],
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? "./data/orca.sqlite",
  },
  strict: true,
  verbose: true,
});
