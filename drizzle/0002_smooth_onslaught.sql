CREATE TYPE "public"."answers_open" AS ENUM('during', 'after');--> statement-breakpoint
CREATE TYPE "public"."timer_start" AS ENUM('answers-open', 'clip-end');--> statement-breakpoint
CREATE TABLE "game_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"countdown_seconds" integer DEFAULT 5 NOT NULL,
	"answers_open" "answers_open" DEFAULT 'during' NOT NULL,
	"answer_seconds" integer DEFAULT 30 NOT NULL,
	"timer_start" timer_start DEFAULT 'answers-open' NOT NULL,
	CONSTRAINT "game_settings_single_row" CHECK ("game_settings"."id" = 1)
);
