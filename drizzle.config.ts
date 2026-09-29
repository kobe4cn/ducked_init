import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './app/.server/db/schema.ts',
  out: './drizzle',
  schemaFilter: ['platform'],
  dbCredentials: { url: process.env.PLATFORM_DATABASE_URL ?? '' },
});
