# Lesson 2 plan: admin tokens, easy mode and tidier code

The things we build in class tonight, in order. Each step is small enough to build, test and commit on its own.

## Where we start

- The bot runs on the server with 1,395 clips in 167 languages, and `/game start` plays a three-round game in voice.
- The dashboard has an admin login (username and password from the server settings), game timings, clip upload and the recent log.
- Normal mode is the game as it is today: players type the language in the chat.

## Part 1: admin tokens

Goal: an agent can do admin work over the dashboard's API, using a token the admin made on the dashboard.

### Rules

- The admin creates tokens on the dashboard. There can be several at once.
- A new token is shown once, hidden behind dots, with a Copy button.
- The database keeps only a hash of each token, never the token itself.
- A token works only on the admin API (`/api/admin/...`): settings, logs and clips. It can't send messages as the bot or use voice, and it can't create or revoke tokens. Only the password login can do those.
- Tokens expire after 7 days. The admin can revoke one earlier. A revoked token stays in the list, marked as revoked.
- Every change made with a token goes in the dashboard's log, with the token's name.
- In class, the teacher pastes the token into the agent's chat, on the shared screen. That's fine for this lesson.

### Steps

1. Add an `admin_tokens` table: name, token hash, created, last used, expires, revoked.
2. Put every "is this the admin?" check in one place. It accepts the login cookie or `Authorization: Bearer <token>`, says which one it was, and knows which routes a token may use.
3. Add a "Tokens" section to the dashboard: create a token with a name, see the list, and revoke one.
4. Let the admin API accept tokens through that check. Refuse expired, revoked and unknown tokens. Update "last used" on each request.
5. Make sure the token routes, sending messages and voice only work with the login cookie, never with a token.
6. Write a log line for each change made with a token, with the token's name.
7. Test it end to end: create a token on the dashboard, paste it to the agent, and have the agent read the clip list with it.

## Part 2: the bot marks each guess

Goal: players can see the bot read their typed guess.

### Rules

- When the game counts a typed guess, the bot reacts to that message: ✅ if it's right, ❌ if it's wrong.
- Messages that don't count as a guess get no reaction.
- If the bot can't add the reaction, the game carries on as normal.

## Part 3: easy mode

Goal: `/game start difficulty:easy` plays the game with five buttons instead of typing.

### Rules

- `/game start` gets a difficulty option: easy or normal. Normal is the default.
- Each easy round shows 5 buttons: the right language and 4 random wrong ones. Smarter wrong options can come later, from the mix-up data.
- The player list is fixed when `/game start` runs: the people in the voice channel, not counting bots. It stays the same for the whole game.
- A click counts only if the player is on that list and is in the voice channel when they click. A player who leaves and comes back can play again.
- Anyone else who clicks gets a private note: "Only players who were in voice when the game started can answer."
- One click per player per round. "You picked X" is shown only to the player who clicked.
- Typing doesn't count in easy mode.
- While a round runs, the message shows how many have picked, like "4/6 picked". The total doesn't change when someone leaves.
- The round ends when everyone on the list has picked or the timer runs out. Then the buttons switch off and the right answer is shown.
- Easy and normal scores are kept apart, so leaderboards can be split by difficulty later.

### Steps

1. Add a difficulty to `games`, and a place to save the 5 options shown in each easy round.
2. Add the `difficulty` option to `/game start` and fix the player list at the start.
3. Play an easy round: post the 5 buttons, take one click per player, reply privately, and update the "picked" count.
4. End the round on "everyone picked" or the timer, switch off the buttons and show the answer.
5. Save each click as a guess, like typed guesses, and keep the end-of-game scoreboard separate per difficulty.
6. Play a full easy game with the class in voice.

## Part 4: tidy the code into layers

Goal: the bot, the website and the game rules live in separate places, with clear rules about who uses whom. Nothing changes for players. The tests pass at every step.

### Rules

- It stays one program, so the bot and the website keep sharing memory: the chat log, recent logs, running games and the voice connection.
- `core/` holds the game rules, database, clips and settings. It knows nothing about Discord or the web.
- `bot/` holds the Discord client, slash commands, voice and buttons.
- `server/` holds the web routes, login, tokens and the admin API.
- `web/` holds the pages: HTML, CSS and browser code.
- `bot/` and `server/` both use `core/`, but never each other. They talk through one interface that the program sets up at start.
- `web/` only shares types with the rest.

### Steps

1. Move the game rules, database, clips and settings into `core/`. Run the tests.
2. Move the Discord code into `bot/`. Run the tests.
3. Split `chat-page.ts`: the chat log, the web server and its routes go into `server/`, grouped by topic (voice, chat, languages, admin).
4. Keep the list of admin-only routes in one place, next to the single admin check from Part 1.
5. Turn the bot actions the website uses (send a message, join voice, play a clip) into one interface between `bot/` and `server/`.
6. Add a check that fails when a file imports across the rules above.
7. Move the pages out of strings into real files under `web/`, with one shared stylesheet.

### For the class to decide

- Pages as plain TypeScript bundled by Bun, or a frontend framework. A framework starts to pay off around the stats and leaderboards lesson.
- Whether the dashboard keeps choosing between the login page and the dashboard on the server, or the page asks the API and shows the login form itself.

## Survey ideas

- What should the bot say when someone picks the right answer?
- Should easy mode also have a "hard" sibling later, and what would make it hard?
- Which part should we build first tonight: tokens or easy mode?

## Not tonight

- Smarter wrong options from the mix-up data.
- Managing languages and clips with a token: hiding, renaming and moving them.
- Leaderboards (lesson 5), apart from saving the difficulty so they can be split later.
- Teams and the button lobby (lesson 3).
