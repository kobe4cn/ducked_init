CREATE TABLE "platform"."model_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"model" text NOT NULL UNIQUE,
	"input_per_m_tok" numeric(12,4) NOT NULL,
	"output_per_m_tok" numeric(12,4) NOT NULL,
	"currency" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "model_prices_currency" CHECK ("currency" in ('CNY', 'USD'))
);
