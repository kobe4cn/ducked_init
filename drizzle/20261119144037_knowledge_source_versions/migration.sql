CREATE TABLE "platform"."knowledge_source_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"body_hash" text NOT NULL,
	"created_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_source_versions_source_version_uq" ON "platform"."knowledge_source_versions" ("source_id","version");--> statement-breakpoint
ALTER TABLE "platform"."knowledge_source_versions" ADD CONSTRAINT "knowledge_source_versions_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."knowledge_source_versions" ADD CONSTRAINT "knowledge_source_versions_source_id_knowledge_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "platform"."knowledge_sources"("id") ON DELETE CASCADE;--> statement-breakpoint
-- 回填：现有来源的当前正文补成它当前 version 的一行。created_by_email 只能取来源行的首存者（旧数据没有每一版的保存人，这是已知近似），
-- created_at 取来源行的 updated_at（最后一次正文变化的时刻）
INSERT INTO "platform"."knowledge_source_versions" (tenant_id, source_id, version, kind, body, body_hash, created_by_email, created_at)
SELECT tenant_id, id, version, kind, body, body_hash, created_by_email, updated_at FROM "platform"."knowledge_sources";