CREATE TABLE "platform"."serving_stores" (
	"tenant_id" uuid PRIMARY KEY,
	"version" integer NOT NULL,
	"path" text NOT NULL,
	"snapshots" jsonb NOT NULL,
	"built_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform"."serving_stores" ADD CONSTRAINT "serving_stores_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;