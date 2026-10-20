CREATE TABLE "platform"."sandbox_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"name" text NOT NULL,
	"row_count" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"expired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_tables_member_name_uq" ON "platform"."sandbox_tables" ("tenant_id","member_id","name");--> statement-breakpoint
ALTER TABLE "platform"."sandbox_tables" ADD CONSTRAINT "sandbox_tables_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."sandbox_tables" ADD CONSTRAINT "sandbox_tables_member_id_members_id_fkey" FOREIGN KEY ("member_id") REFERENCES "platform"."members"("id") ON DELETE CASCADE;