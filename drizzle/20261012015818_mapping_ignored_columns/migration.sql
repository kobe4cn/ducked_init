CREATE TABLE "platform"."mapping_ignored_columns" (
	"mapping_id" uuid,
	"column" text,
	"ignored_by_email" text NOT NULL,
	"ignored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mapping_ignored_columns_pkey" PRIMARY KEY("mapping_id","column")
);
--> statement-breakpoint
ALTER TABLE "platform"."mapping_ignored_columns" ADD CONSTRAINT "mapping_ignored_columns_mapping_id_mappings_id_fkey" FOREIGN KEY ("mapping_id") REFERENCES "platform"."mappings"("id") ON DELETE CASCADE;