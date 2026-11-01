CREATE TABLE `thread_prompt_suggestion_preferences` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
