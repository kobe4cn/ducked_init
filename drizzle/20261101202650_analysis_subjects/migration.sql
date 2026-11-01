CREATE TABLE "platform"."analysis_subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."subject_memberships" (
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid,
	"target_id" text,
	"created_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subject_memberships_pkey" PRIMARY KEY("subject_id","target_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_subjects_tenant_name_uq" ON "platform"."analysis_subjects" ("tenant_id",lower("name"));--> statement-breakpoint
CREATE INDEX "subject_memberships_tenant_idx" ON "platform"."subject_memberships" ("tenant_id");--> statement-breakpoint
ALTER TABLE "platform"."analysis_subjects" ADD CONSTRAINT "analysis_subjects_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."subject_memberships" ADD CONSTRAINT "subject_memberships_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."subject_memberships" ADD CONSTRAINT "subject_memberships_subject_id_analysis_subjects_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "platform"."analysis_subjects"("id") ON DELETE CASCADE;