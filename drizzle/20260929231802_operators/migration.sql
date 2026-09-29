CREATE TABLE "platform"."operator_magic_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"operator_id" uuid NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."operator_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"operator_id" uuid NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"expires_at" timestamp with time zone NOT NULL,
	"totp_verified_at" timestamp with time zone,
	"totp_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"email" text NOT NULL UNIQUE,
	"totp_secret" text,
	"totp_confirmed_at" timestamp with time zone,
	"totp_last_step" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform"."audit_logs" ADD COLUMN "actor_type" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."audit_logs" ADD COLUMN "actor_operator_id" uuid;--> statement-breakpoint
-- 此前操作者为空的记录都来自运营命令
UPDATE "platform"."audit_logs" SET "actor_type" = 'operator' WHERE "actor_member_id" IS NULL AND "actor_email" IS NULL;--> statement-breakpoint
ALTER TABLE "platform"."audit_logs" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_logs_operator_created_idx" ON "platform"."audit_logs" ("created_at") WHERE actor_type = 'operator';--> statement-breakpoint
ALTER TABLE "platform"."audit_logs" ADD CONSTRAINT "audit_logs_actor_operator_id_operators_id_fkey" FOREIGN KEY ("actor_operator_id") REFERENCES "platform"."operators"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "platform"."operator_magic_links" ADD CONSTRAINT "operator_magic_links_operator_id_operators_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "platform"."operators"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."operator_sessions" ADD CONSTRAINT "operator_sessions_operator_id_operators_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "platform"."operators"("id") ON DELETE CASCADE;