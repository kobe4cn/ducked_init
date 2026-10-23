CREATE TABLE "platform"."export_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform"."export_links" ADD CONSTRAINT "export_links_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."export_links" ADD CONSTRAINT "export_links_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "platform"."tasks"("id") ON DELETE CASCADE;