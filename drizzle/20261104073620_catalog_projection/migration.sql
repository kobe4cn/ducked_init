CREATE TABLE "platform"."catalog_projection" (
	"tenant_id" uuid NOT NULL,
	"visibility_class" text NOT NULL,
	"entry_id" text NOT NULL,
	"text" text NOT NULL,
	"text_hash" text NOT NULL,
	"subjects" jsonb NOT NULL,
	"aliases" jsonb NOT NULL,
	"space_id" uuid,
	"catalog_version" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_projection_tenant_class_entry_uq" ON "platform"."catalog_projection" ("tenant_id","visibility_class","entry_id");--> statement-breakpoint
ALTER TABLE "platform"."catalog_projection" ADD CONSTRAINT "catalog_projection_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;