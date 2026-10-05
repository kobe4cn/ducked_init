CREATE TYPE "platform"."source_view_version_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TABLE "platform"."source_view_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"view_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "platform"."source_view_version_status" DEFAULT 'draft'::"platform"."source_view_version_status" NOT NULL,
	"sql" text NOT NULL,
	"authors" text[] NOT NULL,
	"last_editor" text NOT NULL,
	"published_by_email" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."source_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "source_view_versions_view_version_uq" ON "platform"."source_view_versions" ("view_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "source_view_versions_one_draft_uq" ON "platform"."source_view_versions" ("view_id") WHERE status = 'draft';--> statement-breakpoint
CREATE INDEX "source_views_tenant_idx" ON "platform"."source_views" ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_views_source_name_uq" ON "platform"."source_views" ("source_id","name");--> statement-breakpoint
ALTER TABLE "platform"."source_view_versions" ADD CONSTRAINT "source_view_versions_view_id_source_views_id_fkey" FOREIGN KEY ("view_id") REFERENCES "platform"."source_views"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."source_views" ADD CONSTRAINT "source_views_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."source_views" ADD CONSTRAINT "source_views_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "platform"."sources"("id") ON DELETE CASCADE;