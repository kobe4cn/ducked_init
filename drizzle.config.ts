// drizzle.config.ts —— drizzle-kit 配置：平台元数据结构在 app/.server/db/schema.ts，迁移生成到 drizzle/
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './app/.server/db/schema.ts',
  out: './drizzle',
  schemaFilter: ['platform'],
  dbCredentials: { url: process.env.PLATFORM_DATABASE_URL ?? '' },
});
