ALTER TABLE "platform"."tenant_lakes" ADD COLUMN "ro_db_role" text;--> statement-breakpoint
ALTER TABLE "platform"."tenant_lakes" ADD COLUMN "ro_db_password" text;--> statement-breakpoint
ALTER TABLE "platform"."tenant_lakes" ADD COLUMN "ro_s3_access_key" text;--> statement-breakpoint
ALTER TABLE "platform"."tenant_lakes" ADD COLUMN "ro_s3_secret_key" text;--> statement-breakpoint
ALTER TABLE "platform"."tenant_lakes" ADD CONSTRAINT "tenant_lakes_ro_db_role_key" UNIQUE("ro_db_role");