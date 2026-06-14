CREATE TABLE `agent_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`machine_id` text,
	`url` text NOT NULL,
	`name` text NOT NULL,
	`method` text DEFAULT 'tailscale' NOT NULL,
	`is_cloud` integer DEFAULT false,
	`cloud_agent_id` text,
	`color` text,
	`created_at` integer,
	`updated_at` integer,
	`token` text
);
--> statement-breakpoint
CREATE INDEX `idx_agent_connection_user` ON `agent_connection` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_connection_machine` ON `agent_connection` (`machine_id`);--> statement-breakpoint
CREATE TABLE `push_subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_push_subscription_user` ON `push_subscription` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_push_subscription_endpoint` ON `push_subscription` (`endpoint`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_session_user` ON `session` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_token_hash` ON `session` (`token_hash`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`email` text,
	`password_hash` text,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `user_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_user_settings_user` ON `user_settings` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_user_settings_user_key` ON `user_settings` (`user_id`,`key`);