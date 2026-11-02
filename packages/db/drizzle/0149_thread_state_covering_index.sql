DROP INDEX `events_thread_state_thread_sequence_idx`;--> statement-breakpoint
CREATE INDEX `events_thread_state_thread_sequence_idx` ON `events` (`thread_id`,`sequence`,`type`,json_extract(`data`, '$.kind')) WHERE "events"."type" IN ('thread/goal/updated', 'thread/goal/cleared', 'thread/extensionState/updated');
