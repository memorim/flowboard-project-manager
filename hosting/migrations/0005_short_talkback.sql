CREATE TABLE `task_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`member_id` integer,
	`action` text NOT NULL,
	`before_json` text,
	`after_json` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_history_workspace` ON `task_history` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_history_version` ON `task_history` (`task_id`,`version`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `changed_by` integer REFERENCES members(id);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS task_history_created AFTER INSERT ON tasks WHEN NEW.changed_by IS NOT NULL
BEGIN INSERT INTO task_history(task_id,workspace_id,member_id,action,before_json,after_json,version,created_at) VALUES (NEW.id,(SELECT workspace_id FROM projects WHERE id=NEW.project_id),NEW.changed_by,'created',NULL,json_object('title',NEW.title,'description',NEW.description,'status',NEW.status,'priority',NEW.priority,'projectId',NEW.project_id,'assigneeId',NEW.assignee_id,'dueDate',NEW.due_date,'deletedAt',NEW.deleted_at),NEW.version,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS task_history_updated AFTER UPDATE OF title,description,status,priority,project_id,assignee_id,due_date,deleted_at ON tasks WHEN NEW.changed_by IS NOT NULL AND NEW.version>OLD.version
BEGIN INSERT INTO task_history(task_id,workspace_id,member_id,action,before_json,after_json,version,created_at) VALUES (NEW.id,(SELECT workspace_id FROM projects WHERE id=NEW.project_id),NEW.changed_by,CASE WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN 'deleted' WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN 'restored' ELSE 'updated' END,json_object('title',OLD.title,'description',OLD.description,'status',OLD.status,'priority',OLD.priority,'projectId',OLD.project_id,'assigneeId',OLD.assignee_id,'dueDate',OLD.due_date,'deletedAt',OLD.deleted_at),json_object('title',NEW.title,'description',NEW.description,'status',NEW.status,'priority',NEW.priority,'projectId',NEW.project_id,'assigneeId',NEW.assignee_id,'dueDate',NEW.due_date,'deletedAt',NEW.deleted_at),NEW.version,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
