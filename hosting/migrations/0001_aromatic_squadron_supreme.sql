CREATE TABLE `invitations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`role` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_by` integer NOT NULL,
	`accepted_by` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`accepted_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_hash_unique` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`workspace_id` integer NOT NULL,
	`member_id` integer NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `member_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`is_public` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `activity` ADD `workspace_id` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `activity_workspace` ON `activity` (`workspace_id`,`id`);--> statement-breakpoint
ALTER TABLE `projects` ADD `progress` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `workspace_id` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `projects_workspace` ON `projects` (`workspace_id`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `version` integer DEFAULT 1 NOT NULL;