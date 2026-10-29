CREATE TABLE "platform"."assistant_conversation_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"conversation_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."assistant_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"sealed" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_conversation_shares_conversation_member_uq" ON "platform"."assistant_conversation_shares" ("conversation_id","member_id");--> statement-breakpoint
CREATE INDEX "assistant_conversation_shares_member_idx" ON "platform"."assistant_conversation_shares" ("member_id");--> statement-breakpoint
CREATE INDEX "assistant_conversations_member_updated_idx" ON "platform"."assistant_conversations" ("tenant_id","member_id","updated_at");--> statement-breakpoint
ALTER TABLE "platform"."assistant_conversation_shares" ADD CONSTRAINT "assistant_conversation_shares_jBATPbfEEzg7_fkey" FOREIGN KEY ("conversation_id") REFERENCES "platform"."assistant_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."assistant_conversation_shares" ADD CONSTRAINT "assistant_conversation_shares_member_id_members_id_fkey" FOREIGN KEY ("member_id") REFERENCES "platform"."members"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."assistant_conversations" ADD CONSTRAINT "assistant_conversations_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."assistant_conversations" ADD CONSTRAINT "assistant_conversations_member_id_members_id_fkey" FOREIGN KEY ("member_id") REFERENCES "platform"."members"("id") ON DELETE CASCADE;