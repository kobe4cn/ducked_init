ALTER TABLE "platform"."tenants" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."tenants" ADD COLUMN "suspension_reason" text;