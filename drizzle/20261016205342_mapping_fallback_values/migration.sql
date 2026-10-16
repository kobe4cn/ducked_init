CREATE TABLE "platform"."mapping_fallback_values" (
	"mapping_id" uuid,
	"column" text,
	"value" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"task_id" uuid NOT NULL,
	CONSTRAINT "mapping_fallback_values_pkey" PRIMARY KEY("mapping_id","column","value")
);
--> statement-breakpoint
ALTER TABLE "platform"."mapping_fallback_values" ADD CONSTRAINT "mapping_fallback_values_mapping_id_mappings_id_fkey" FOREIGN KEY ("mapping_id") REFERENCES "platform"."mappings"("id") ON DELETE CASCADE;