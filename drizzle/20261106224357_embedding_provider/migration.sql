ALTER TABLE "platform"."llm_calls" ADD COLUMN "input_count" integer;--> statement-breakpoint
ALTER TABLE "platform"."model_providers" ADD COLUMN "embedding_base_url" text;--> statement-breakpoint
ALTER TABLE "platform"."model_providers" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "platform"."model_providers" ADD COLUMN "embedding_api_key" text;