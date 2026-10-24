CREATE INDEX `seatly_status_date` ON `seatly_bookings` (`sandbox_key`,`status`,`booking_date`,`id`);--> statement-breakpoint
CREATE INDEX `seatly_expiry` ON `seatly_bookings` (`sandbox_key`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `tasks_project_state_due` ON `tasks` (`project_id`,`status`,`due_date`,`id`);--> statement-breakpoint
CREATE INDEX `tasks_project_due` ON `tasks` (`project_id`,`due_date`,`id`);