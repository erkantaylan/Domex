CREATE TYPE "public"."game_status" AS ENUM('running', 'finished', 'stopped', 'failed');--> statement-breakpoint
CREATE TABLE "clips" (
	"id" serial PRIMARY KEY NOT NULL,
	"language_id" integer NOT NULL,
	"file_path" text NOT NULL,
	CONSTRAINT "clips_file_path_unique" UNIQUE("file_path")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"started_by" text NOT NULL,
	"status" "game_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "guesses" (
	"id" serial PRIMARY KEY NOT NULL,
	"round_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"text" text NOT NULL,
	"correct" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "languages" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "languages_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "rounds" (
	"id" serial PRIMARY KEY NOT NULL,
	"game_id" integer NOT NULL,
	"clip_id" integer NOT NULL,
	"number" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_language_id_languages_id_fk" FOREIGN KEY ("language_id") REFERENCES "public"."languages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guesses" ADD CONSTRAINT "guesses_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_game_number" ON "rounds" USING btree ("game_id","number");