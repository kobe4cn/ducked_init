ALTER TABLE "platform"."llm_calls" ADD COLUMN "reasoning_tokens" integer;--> statement-breakpoint
ALTER TABLE "platform"."llm_calls" ADD COLUMN "cached_tokens" integer;--> statement-breakpoint
ALTER TABLE "platform"."llm_calls" ADD COLUMN "turn_id" uuid;--> statement-breakpoint
ALTER TABLE "platform"."llm_calls" ADD COLUMN "actor_email" text;--> statement-breakpoint
ALTER TABLE "platform"."llm_calls" ADD COLUMN "error_kind" text;