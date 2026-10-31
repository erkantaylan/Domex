# Language Jungle

A Discord game: the bot plays a voice clip in a voice channel, and players guess the language. It's being built live in class, starting from this empty folder. The teacher drives Claude Code on a shared screen and students vote through surveys, so explain choices in plain language and keep each step small enough to follow.

## Tonight's goal (lesson 1 of about 6)

By the end of about 2 hours, a player types `/guess`, the bot joins their voice channel and plays one clip, and the bot tells them if their answer is right.

Work in this order:

1. Set up the TypeScript project, with `.env` and `.gitignore` in place first.
2. Get the bot online with one simple slash command, registered to the test server so it appears right away.
3. Test voice before anything else: join a voice channel and play one real clip. This is the riskiest part.
4. Build one guess round using a handful of clips.

Run a survey for the bot's name and personality when the teacher asks. Stop at the goal: everything in the later lessons below stays out of tonight's code.

## Stack

- TypeScript, discord.js and `@discordjs/voice`.
- Bun first. If voice doesn't work on Bun, tell the class what failed and switch to Node.
- Later lessons: Postgres for data, and Docker on Coolify for hosting.

## Roadmap

1. **The bot wakes up and speaks:** tonight's goal.
2. **A real game that remembers:** full singleplayer game with lives, rounds and a 30-second timer, plus Postgres, all clips imported and every guess saved.
3. **Teams and going live:** two-team games with a button lobby, deployed to the server.
4. **The website and Discord login:** a public home page, and players log in to see their own past games.
5. **The dashboard:** stats, mix-ups between languages, and leaderboards.
6. **Tournament night:** an admin page for clips and roles, backups, and a final tournament.

Lessons can split or merge as the class goes.

## Design rules

- Audio stays as files on the server. The database records where each clip is and which language it belongs to.
- Save every game, round and guess, so the dashboard can answer questions later.
- Keep roles in the database, never as user IDs in the code.
- Never add a command that runs code from chat.

## Audio

The clips are in `~/Downloads/Language Jungle-20261031T153043Z-1-001.zip` (686 MB). Inside it, `Language Jungle/Speech/<Language>/` holds the MP3s, about 1,400 clips across 168 languages.

- Tonight, extract only a handful of clips into `assets/`.
- Never commit audio, or anything else from the zip. Add `assets/` to `.gitignore`.
- Don't play the theme song or other audio publicly until the teacher confirms the rights.

## Secrets and the shared screen

- The teacher pastes the bot token into `.env` off-screen. Never open, print or log `.env`.
- Use `.env.example` to show which settings exist, with empty values.
- Stop and tell the teacher if a token ever appears on screen, so it can be reset.
