ALTER TABLE "platform"."llm_calls" ADD COLUMN "route" text;--> statement-breakpoint
ALTER TABLE "platform"."llm_calls" ADD COLUMN "fallback_reason" text;