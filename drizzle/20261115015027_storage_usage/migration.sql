ALTER TABLE "platform"."tenant_lakes" ADD COLUMN "storage_used_bytes" bigint;--> statement-breakpoint
ALTER TABLE "platform"."tenant_lakes" ADD COLUMN "storage_measured_at" timestamp with time zone;