CREATE TABLE "platform"."snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"template" text NOT NULL,
	"definition_version" integer,
	"task_id" uuid NOT NULL,
	"table" text NOT NULL,
	"params" jsonb NOT NULL,
	"row_count" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"expired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "snapshots_tenant_created_idx" ON "platform"."snapshots" ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "snapshots_task_uq" ON "platform"."snapshots" ("task_id");--> statement-breakpoint
ALTER TABLE "platform"."snapshots" ADD CONSTRAINT "snapshots_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."snapshots" ADD CONSTRAINT "snapshots_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "platform"."tasks"("id") ON DELETE CASCADE;