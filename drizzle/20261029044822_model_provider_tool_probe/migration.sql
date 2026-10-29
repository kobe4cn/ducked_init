ALTER TABLE "platform"."model_providers" ADD COLUMN "tools_supported" boolean;--> statement-breakpoint
ALTER TABLE "platform"."model_providers" ADD COLUMN "tools_probed_base_url" text;--> statement-breakpoint
ALTER TABLE "platform"."model_providers" ADD COLUMN "tools_probed_model" text;