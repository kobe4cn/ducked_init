CREATE TYPE "platform"."lake_migration_status" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "platform"."lake_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"from_path" text NOT NULL,
	"to_path" text NOT NULL,
	"status" "platform"."lake_migration_status" DEFAULT 'pending'::"platform"."lake_migration_status" NOT NULL,
	"claim" uuid,
	"heartbeat_at" timestamp with time zone,
	"inventory" jsonb,
	"result" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "lake_migrations_tenant_created_idx" ON "platform"."lake_migrations" ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lake_migrations_one_active_uq" ON "platform"."lake_migrations" ("tenant_id") WHERE status IN ('pending', 'running');--> statement-breakpoint
ALTER TABLE "platform"."lake_migrations" ADD CONSTRAINT "lake_migrations_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;