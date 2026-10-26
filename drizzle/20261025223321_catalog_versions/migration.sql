CREATE TABLE "platform"."catalog_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"reason" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"diff" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_versions_tenant_version_uq" ON "platform"."catalog_versions" ("tenant_id","version");--> statement-breakpoint
ALTER TABLE "platform"."catalog_versions" ADD CONSTRAINT "catalog_versions_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;