CREATE TABLE "platform"."sandbox_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"table_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_shares_table_member_uq" ON "platform"."sandbox_shares" ("table_id","member_id");--> statement-breakpoint
CREATE INDEX "sandbox_shares_member_idx" ON "platform"."sandbox_shares" ("member_id");--> statement-breakpoint
ALTER TABLE "platform"."sandbox_shares" ADD CONSTRAINT "sandbox_shares_table_id_sandbox_tables_id_fkey" FOREIGN KEY ("table_id") REFERENCES "platform"."sandbox_tables"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."sandbox_shares" ADD CONSTRAINT "sandbox_shares_member_id_members_id_fkey" FOREIGN KEY ("member_id") REFERENCES "platform"."members"("id") ON DELETE CASCADE;