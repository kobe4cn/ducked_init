CREATE TABLE "platform"."source_comments" (
	"tenant_id" uuid NOT NULL,
	"source_id" uuid,
	"table_schema" text,
	"table_name" text,
	"column_name" text DEFAULT '',
	"comment_text" text NOT NULL,
	"version" integer NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"gone_at" timestamp with time zone,
	CONSTRAINT "source_comments_pkey" PRIMARY KEY("source_id","table_schema","table_name","column_name")
);
--> statement-breakpoint
ALTER TABLE "platform"."source_comments" ADD CONSTRAINT "source_comments_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."source_comments" ADD CONSTRAINT "source_comments_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "platform"."sources"("id") ON DELETE CASCADE;