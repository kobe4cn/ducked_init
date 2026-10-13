ALTER TABLE "platform"."mappings" ADD COLUMN "disable_requested_by_email" text;--> statement-breakpoint
ALTER TABLE "platform"."mappings" ADD COLUMN "disable_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."mappings" ADD COLUMN "disabled_by_email" text;--> statement-breakpoint
ALTER TABLE "platform"."mappings" ADD COLUMN "disabled_at" timestamp with time zone;