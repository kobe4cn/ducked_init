ALTER TABLE "platform"."model_providers" ADD COLUMN "fast_model" text;--> statement-breakpoint
ALTER TABLE "platform"."model_providers" ADD COLUMN "fast_base_url" text;--> statement-breakpoint
ALTER TABLE "platform"."model_providers" ADD COLUMN "fast_api_key" text;--> statement-breakpoint
ALTER TABLE "platform"."model_providers" ADD COLUMN "reasoning_model" text;--> statement-breakpoint
ALTER TABLE "platform"."model_providers" ADD COLUMN "reasoning_base_url" text;--> statement-breakpoint
ALTER TABLE "platform"."model_providers" ADD COLUMN "reasoning_api_key" text;