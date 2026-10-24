CREATE TABLE `seatly_bookings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sandbox_key` text NOT NULL,
	`space_id` integer NOT NULL,
	`guest_name` text NOT NULL,
	`guest_email` text NOT NULL,
	`booking_date` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`guests` integer NOT NULL,
	`total_price` integer NOT NULL,
	`status` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`sandbox_key`) REFERENCES `seatly_profiles`(`sandbox_key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `seatly_slots` ON `seatly_bookings` (`sandbox_key`,`space_id`,`booking_date`,`status`);--> statement-breakpoint
CREATE TABLE `seatly_profiles` (
	`sandbox_key` text PRIMARY KEY NOT NULL,
	`role` text DEFAULT 'guest' NOT NULL
);

--> statement-breakpoint
CREATE TRIGGER seatly_no_overlap_insert BEFORE INSERT ON seatly_bookings
WHEN NEW.status IN ('pending','confirmed') AND EXISTS(SELECT 1 FROM seatly_bookings WHERE sandbox_key=NEW.sandbox_key AND space_id=NEW.space_id AND booking_date=NEW.booking_date AND status IN ('pending','confirmed') AND start_time<NEW.end_time AND end_time>NEW.start_time)
BEGIN SELECT RAISE(ABORT,'booking_overlap'); END;
--> statement-breakpoint
CREATE TRIGGER seatly_no_overlap_update BEFORE UPDATE ON seatly_bookings
WHEN NEW.status IN ('pending','confirmed') AND EXISTS(SELECT 1 FROM seatly_bookings WHERE id!=NEW.id AND sandbox_key=NEW.sandbox_key AND space_id=NEW.space_id AND booking_date=NEW.booking_date AND status IN ('pending','confirmed') AND start_time<NEW.end_time AND end_time>NEW.start_time)
BEGIN SELECT RAISE(ABORT,'booking_overlap'); END;
