CREATE TABLE "agent_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"url" text NOT NULL,
	"name" text NOT NULL,
	"method" text DEFAULT 'tailscale' NOT NULL,
	"is_cloud" boolean DEFAULT false,
	"cloud_agent_id" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "idx_agent_connection_user" ON "agent_connection" USING btree ("user_id");