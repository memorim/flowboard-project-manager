ALTER TABLE `seatly_bookings` ADD `request_key` text;--> statement-breakpoint
ALTER TABLE `seatly_bookings` ADD `request_payload` text;--> statement-breakpoint
ALTER TABLE `seatly_bookings` ADD `create_result` text;--> statement-breakpoint
CREATE UNIQUE INDEX `seatly_bookings_request_key_unique` ON `seatly_bookings` (`request_key`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `request_key` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `request_payload` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `create_result` text;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_request_key_unique` ON `tasks` (`request_key`);