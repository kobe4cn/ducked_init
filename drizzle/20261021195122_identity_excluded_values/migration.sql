CREATE TABLE "platform"."identity_excluded_values" (
	"tenant_id" uuid,
	"hash" text,
	"records" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_excluded_values_pkey" PRIMARY KEY("tenant_id","hash")
);
--> statement-breakpoint
ALTER TABLE "platform"."identity_excluded_values" ADD CONSTRAINT "identity_excluded_values_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."identity_excluded_values" ADD CONSTRAINT "identity_excluded_values_created_by_members_id_fkey" FOREIGN KEY ("created_by") REFERENCES "platform"."members"("id") ON DELETE SET NULL;