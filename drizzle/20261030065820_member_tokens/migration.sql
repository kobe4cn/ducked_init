CREATE TABLE "platform"."member_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"allow_query" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "member_tokens_member_idx" ON "platform"."member_tokens" ("member_id","created_at");--> statement-breakpoint
ALTER TABLE "platform"."member_tokens" ADD CONSTRAINT "member_tokens_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."member_tokens" ADD CONSTRAINT "member_tokens_member_id_members_id_fkey" FOREIGN KEY ("member_id") REFERENCES "platform"."members"("id") ON DELETE CASCADE;