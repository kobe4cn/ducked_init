-- 已有的指标、标签、模板定义归入本租户的默认空间（每个租户一个，ADR-0048）：先加可空列，回填后再设非空
ALTER TABLE "platform"."dsl_definitions" ADD COLUMN "space_id" uuid;--> statement-breakpoint
ALTER TABLE "platform"."template_definitions" ADD COLUMN "space_id" uuid;--> statement-breakpoint
UPDATE "platform"."dsl_definitions" d SET "space_id" = (SELECT s."id" FROM "platform"."spaces" s WHERE s."tenant_id" = d."tenant_id" AND s."is_default");--> statement-breakpoint
UPDATE "platform"."template_definitions" d SET "space_id" = (SELECT s."id" FROM "platform"."spaces" s WHERE s."tenant_id" = d."tenant_id" AND s."is_default");--> statement-breakpoint
ALTER TABLE "platform"."dsl_definitions" ALTER COLUMN "space_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."template_definitions" ALTER COLUMN "space_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."dsl_definitions" ADD CONSTRAINT "dsl_definitions_space_id_spaces_id_fkey" FOREIGN KEY ("space_id") REFERENCES "platform"."spaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."template_definitions" ADD CONSTRAINT "template_definitions_space_id_spaces_id_fkey" FOREIGN KEY ("space_id") REFERENCES "platform"."spaces"("id") ON DELETE CASCADE;
