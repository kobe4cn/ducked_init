CREATE TYPE "platform"."source_kind" AS ENUM('postgres', 'mysql', 's3', 'duckdb');--> statement-breakpoint
CREATE TABLE "platform"."source_tables" (
	"source_id" uuid,
	"table_name" text,
	"watermark_column" text,
	"confirmed_by_email" text,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "source_tables_pkey" PRIMARY KEY("source_id","table_name")
);
--> statement-breakpoint
CREATE TABLE "platform"."sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "platform"."source_kind" NOT NULL,
	"config" jsonb NOT NULL,
	"credentials" text NOT NULL,
	"credentials_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."tenant_keys" (
	"tenant_id" uuid PRIMARY KEY,
	"wrapped_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sources_tenant_name_uq" ON "platform"."sources" ("tenant_id","name");--> statement-breakpoint
ALTER TABLE "platform"."source_tables" ADD CONSTRAINT "source_tables_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "platform"."sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."sources" ADD CONSTRAINT "sources_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."sources" ADD CONSTRAINT "sources_space_id_spaces_id_fkey" FOREIGN KEY ("space_id") REFERENCES "platform"."spaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."tenant_keys" ADD CONSTRAINT "tenant_keys_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;