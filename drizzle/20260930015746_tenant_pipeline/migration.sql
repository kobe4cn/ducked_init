CREATE TYPE "platform"."task_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "platform"."tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb DEFAULT '{}' NOT NULL,
	"status" "platform"."task_status" DEFAULT 'queued'::"platform"."task_status" NOT NULL,
	"result" jsonb,
	"error" text,
	"worker_pid" integer,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."tenant_lakes" (
	"tenant_id" uuid PRIMARY KEY,
	"data_path" text NOT NULL,
	"catalog_schema" text NOT NULL UNIQUE,
	"db_role" text NOT NULL UNIQUE,
	"db_password" text NOT NULL,
	"catalog_initialized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform"."tenants" ADD COLUMN "memory_limit_mb" integer DEFAULT 2048 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."tenants" ADD COLUMN "threads" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."tenants" ADD COLUMN "max_concurrent_tasks" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_tenant_created_idx" ON "platform"."tasks" ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_tenant_started_idx" ON "platform"."tasks" ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "tasks_queued_idx" ON "platform"."tasks" ("tenant_id","created_at") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "tasks_running_idx" ON "platform"."tasks" ("tenant_id") WHERE status = 'running';--> statement-breakpoint
ALTER TABLE "platform"."tasks" ADD CONSTRAINT "tasks_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."tenant_lakes" ADD CONSTRAINT "tenant_lakes_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;