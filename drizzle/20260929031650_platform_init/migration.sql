CREATE SCHEMA "platform";
--> statement-breakpoint
CREATE TYPE "platform"."member_role" AS ENUM('admin', 'data_engineer', 'analyst', 'viewer');--> statement-breakpoint
CREATE TABLE "platform"."magic_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"member_id" uuid NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "platform"."member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"member_id" uuid NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"slug" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "members_tenant_email_uq" ON "platform"."members" ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "members_email_idx" ON "platform"."members" ("email");--> statement-breakpoint
CREATE INDEX "spaces_tenant_idx" ON "platform"."spaces" ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_one_default_uq" ON "platform"."spaces" ("tenant_id") WHERE is_default;--> statement-breakpoint
ALTER TABLE "platform"."magic_links" ADD CONSTRAINT "magic_links_member_id_members_id_fkey" FOREIGN KEY ("member_id") REFERENCES "platform"."members"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."members" ADD CONSTRAINT "members_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."sessions" ADD CONSTRAINT "sessions_member_id_members_id_fkey" FOREIGN KEY ("member_id") REFERENCES "platform"."members"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."spaces" ADD CONSTRAINT "spaces_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;