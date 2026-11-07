CREATE TABLE "platform"."catalog_embeddings" (
	"tenant_id" uuid,
	"model_id" text,
	"text_hash" text,
	"dimension" integer NOT NULL,
	"vector" real[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_embeddings_pkey" PRIMARY KEY("tenant_id","model_id","text_hash")
);
--> statement-breakpoint
ALTER TABLE "platform"."catalog_embeddings" ADD CONSTRAINT "catalog_embeddings_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;