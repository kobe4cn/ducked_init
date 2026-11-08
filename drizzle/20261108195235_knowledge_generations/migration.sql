CREATE TABLE "platform"."knowledge_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"generator_version" text NOT NULL,
	"proposal_count" integer NOT NULL,
	"created_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_generations_tenant_subject_hash_version_uq" ON "platform"."knowledge_generations" ("tenant_id","subject_id","input_hash","generator_version");--> statement-breakpoint
ALTER TABLE "platform"."knowledge_generations" ADD CONSTRAINT "knowledge_generations_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."knowledge_generations" ADD CONSTRAINT "knowledge_generations_subject_id_analysis_subjects_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "platform"."analysis_subjects"("id") ON DELETE CASCADE;