CREATE TABLE "platform"."llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"duration_ms" integer NOT NULL,
	"schema_valid" boolean,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."model_providers" (
	"tenant_id" uuid PRIMARY KEY,
	"base_url" text,
	"model" text,
	"api_key" text,
	"allow_samples" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "llm_calls_tenant_created_idx" ON "platform"."llm_calls" ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "platform"."llm_calls" ADD CONSTRAINT "llm_calls_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."model_providers" ADD CONSTRAINT "model_providers_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;