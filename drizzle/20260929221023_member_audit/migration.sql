CREATE TABLE "platform"."audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"actor_member_id" uuid,
	"actor_email" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"detail" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_created_idx" ON "platform"."audit_logs" ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "platform"."audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."audit_logs" ADD CONSTRAINT "audit_logs_actor_member_id_members_id_fkey" FOREIGN KEY ("actor_member_id") REFERENCES "platform"."members"("id") ON DELETE SET NULL;