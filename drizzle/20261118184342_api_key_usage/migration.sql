CREATE TABLE "platform"."api_key_usage" (
	"tenant_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"day" date NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_usage_key_day_idx" ON "platform"."api_key_usage" ("tenant_id","api_key_id","endpoint","day");--> statement-breakpoint
ALTER TABLE "platform"."api_key_usage" ADD CONSTRAINT "api_key_usage_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."api_key_usage" ADD CONSTRAINT "api_key_usage_api_key_id_api_keys_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "platform"."api_keys"("id") ON DELETE CASCADE;