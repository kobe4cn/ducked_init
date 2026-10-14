CREATE TYPE "platform"."merge_group_version_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TABLE "platform"."merge_group_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"group_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "platform"."merge_group_version_status" DEFAULT 'draft'::"platform"."merge_group_version_status" NOT NULL,
	"members" jsonb NOT NULL,
	"rule" jsonb NOT NULL,
	"authors" text[] NOT NULL,
	"last_editor" text NOT NULL,
	"published_by_email" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."merge_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "merge_group_versions_group_version_uq" ON "platform"."merge_group_versions" ("group_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_group_versions_one_draft_uq" ON "platform"."merge_group_versions" ("group_id") WHERE status = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "merge_groups_tenant_entity_uq" ON "platform"."merge_groups" ("tenant_id","entity");--> statement-breakpoint
ALTER TABLE "platform"."merge_group_versions" ADD CONSTRAINT "merge_group_versions_group_id_merge_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "platform"."merge_groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."merge_groups" ADD CONSTRAINT "merge_groups_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;