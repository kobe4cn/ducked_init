CREATE TABLE "platform"."knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"body_hash" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_sources_tenant_title_uq" ON "platform"."knowledge_sources" ("tenant_id","title");--> statement-breakpoint
ALTER TABLE "platform"."knowledge_sources" ADD CONSTRAINT "knowledge_sources_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;