CREATE TYPE "public"."difficulty" AS ENUM('easy', 'normal');--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "difficulty" "difficulty" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "options" text[];