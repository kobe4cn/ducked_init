CREATE TABLE "platform"."magic_link_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"email_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "magic_link_requests_email_idx" ON "platform"."magic_link_requests" ("email_hash","created_at");