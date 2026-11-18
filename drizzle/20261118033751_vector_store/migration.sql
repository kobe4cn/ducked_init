ALTER TABLE "platform"."model_providers" ADD COLUMN "vector_store" text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."model_providers" ADD COLUMN "vector_store_url" text;--> statement-breakpoint
ALTER TABLE "platform"."model_providers" ADD COLUMN "vector_store_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."model_providers" ADD COLUMN "vector_store_error" text;--> statement-breakpoint
ALTER TABLE "platform"."model_providers" ADD CONSTRAINT "model_providers_vector_store" CHECK ("vector_store" in ('platform', 'pgvector'));