CREATE TABLE "platform"."knowledge_term_defaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"term" text NOT NULL,
	"target_id" text NOT NULL,
	"based_on" jsonb DEFAULT '[]' NOT NULL,
	"created_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_term_defaults_active_uq" ON "platform"."knowledge_term_defaults" ("tenant_id",lower("term")) WHERE retired_at is null;--> statement-breakpoint
ALTER TABLE "platform"."knowledge_term_defaults" ADD CONSTRAINT "knowledge_term_defaults_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;