// The dashboard's pages. They're kept apart from the public main page: the settings
// form is only ever sent to a logged-in admin, and its values come from the settings API.
const head = (title: string) => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f4; --text: #1d1d1b; --muted: #6b6b66; --line: #ddddd8; --accent: #2f7d4f; --error: #c0392b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1b1c1a; --text: #ecece8; --muted: #a0a09a; --line: #333431; --accent: #6cc48f; --error: #e8796c; } }
  body { margin: 0 auto; max-width: 480px; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.45 system-ui, sans-serif; }
  h1 { font-size: 1.3rem; margin: 0 0 12px; }
  #top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
  #top h1 { margin: 0; }
  .field { display: block; padding: 12px 0; border-top: 1px solid var(--line); }
  .field > span:first-child { display: block; font-weight: 600; }
  .hint { display: block; font-size: .85rem; color: var(--muted); }
  .problem { display: block; color: var(--error); }
  .problem:empty { display: none; }
  select, input, button { font: inherit; padding: 8px; color: var(--text); background: transparent; border: 1px solid var(--line); border-radius: 6px; }
  option { color: #1d1d1b; background: #fff; }
  .field select, .field input { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; }
  button { cursor: pointer; border-color: var(--accent); color: var(--accent); font-weight: 600; }
  button:disabled { cursor: default; opacity: .6; }
  [hidden] { display: none !important; }
  #note { margin: 0 0 12px; color: var(--muted); }
  #summary { padding: 12px 0; border-top: 1px solid var(--line); }
  #status { margin: 8px 0 0; color: var(--accent); font-weight: 600; }
  #error { margin: 8px 0 0; color: var(--error); }
</style>
`;

export const lockedPage = `${head("Dashboard")}<h1>Dashboard</h1>
<p>Admin login isn't set up, so the dashboard is locked.</p>
</html>`;

export const loginPage = `${head("Dashboard login")}<h1>Dashboard login</h1>
<form id="form" novalidate>
  <label class="field"><span>Username</span><input id="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="200"></label>
  <label class="field"><span>Password</span><input id="password" type="password" autocomplete="current-password" maxlength="200"></label>
  <button id="submit">Log in</button>
  <p id="error" role="alert" hidden></p>
</form>
<script>
  const form = document.getElementById("form");
  const submit = document.getElementById("submit");
  const errorBox = document.getElementById("error");
  const password = document.getElementById("password");

  function showError(text) {
    errorBox.textContent = text;
    errorBox.hidden = false;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    submit.disabled = true;
    const response = await fetch("/dashboard/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: document.getElementById("username").value, password: password.value }),
    }).catch(() => null);
    submit.disabled = false;
    if (response?.ok) return location.reload();
    password.value = "";
    if (response?.status === 401) showError("Wrong username or password.");
    else if (response?.status === 429) showError("Too many wrong tries. Please wait a few minutes and try again.");
    else if (response?.status === 503) location.reload();
    else showError("Couldn't log in. Please try again.");
  });
</script>
</html>`;

export const dashboardPage = `${head("Dashboard")}<div id="top">
  <h1>Dashboard</h1>
  <button type="button" id="logout">Log out</button>
</div>
<p id="note">Changes apply from the next game. A game that's already running keeps the settings it started with.</p>
<p id="loading" role="status">Loading...</p>
<form id="form" novalidate hidden>
  <label class="field"><span>Countdown before each round (seconds)</span>
    <span class="hint">Before every round, including the first. 0 to 60.</span>
    <input id="countdownSeconds" type="number" inputmode="numeric" min="0" max="60" step="1">
    <span class="problem" id="countdownSeconds-problem" role="alert"></span></label>
  <label class="field"><span>When answers open</span>
    <select id="answersOpen">
      <option value="during">The moment the clip starts</option>
      <option value="after">When the clip ends</option>
    </select>
    <span class="problem" id="answersOpen-problem" role="alert"></span></label>
  <label class="field"><span>Answer time (seconds)</span>
    <span class="hint">5 to 300.</span>
    <input id="answerSeconds" type="number" inputmode="numeric" min="5" max="300" step="1">
    <span class="problem" id="answerSeconds-problem" role="alert"></span></label>
  <label class="field"><span>When the answer time starts</span>
    <select id="timerStart">
      <option value="answers-open">The moment answers open</option>
      <option value="clip-end">When the clip ends</option>
    </select>
    <span class="problem" id="timerStart-problem" role="alert"></span></label>
  <p id="summary"></p>
  <button id="save">Save</button>
  <p id="status" role="status" hidden></p>
  <p id="error" role="alert" hidden></p>
</form>
<script>
  const form = document.getElementById("form");
  const loading = document.getElementById("loading");
  const save = document.getElementById("save");
  const statusBox = document.getElementById("status");
  const errorBox = document.getElementById("error");
  const summary = document.getElementById("summary");
  const fields = {
    countdownSeconds: document.getElementById("countdownSeconds"),
    answersOpen: document.getElementById("answersOpen"),
    answerSeconds: document.getElementById("answerSeconds"),
    timerStart: document.getElementById("timerStart"),
  };

  function showError(text) {
    statusBox.hidden = true;
    errorBox.textContent = text;
    errorBox.hidden = false;
  }

  function showProblems(problems) {
    for (const name of Object.keys(fields)) {
      document.getElementById(name + "-problem").textContent = problems[name] ?? "";
    }
  }

  function loggedOut() {
    showError("Your admin login has ended. Reloading...");
    setTimeout(() => location.reload(), 1500);
  }

  // Says in plain words what the chosen settings do.
  function describe() {
    const after = fields.answersOpen.value === "after";
    fields.timerStart.disabled = after;
    if (after) {
      summary.textContent = "Guesses during the clip are ignored. Answers open and the answer time starts when the clip ends.";
    } else if (fields.timerStart.value === "clip-end") {
      summary.textContent = "Guesses count from the moment the clip starts. The answer time starts when the clip ends.";
    } else {
      summary.textContent = "Guesses count and the answer time runs from the moment the clip starts. If the time runs out first, the clip is cut off and the round ends.";
    }
  }

  function wholeNumber(text, low, high) {
    if (!/^[0-9]+$/.test(text.trim())) return null;
    const value = Number(text);
    return value >= low && value <= high ? value : null;
  }

  function fill(settings) {
    for (const [name, box] of Object.entries(fields)) box.value = settings[name];
    describe();
  }

  form.addEventListener("input", () => {
    statusBox.hidden = true;
    describe();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    statusBox.hidden = true;
    const countdownSeconds = wholeNumber(fields.countdownSeconds.value, 0, 60);
    const answerSeconds = wholeNumber(fields.answerSeconds.value, 5, 300);
    const problems = {};
    if (countdownSeconds === null) problems.countdownSeconds = "Use a whole number from 0 to 60.";
    if (answerSeconds === null) problems.answerSeconds = "Use a whole number from 5 to 300.";
    showProblems(problems);
    if (Object.keys(problems).length > 0) return;

    save.disabled = true;
    const response = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        countdownSeconds,
        answersOpen: fields.answersOpen.value,
        answerSeconds,
        timerStart: fields.timerStart.value,
      }),
    }).catch(() => null);
    save.disabled = false;

    if (response?.status === 401) return loggedOut();
    if (response?.status === 400) {
      const body = await response.json().catch(() => ({}));
      showProblems(body.errors ?? {});
      return showError(body.errors?.form ?? "Some settings weren't accepted, so nothing was saved.");
    }
    if (!response?.ok) return showError("Couldn't save. Nothing has changed, so please try again.");
    fill((await response.json()).settings);
    statusBox.textContent = "Saved. Changes apply from the next game.";
    statusBox.hidden = false;
  });

  document.getElementById("logout").addEventListener("click", async (event) => {
    event.target.disabled = true;
    const response = await fetch("/dashboard/logout", { method: "POST" }).catch(() => null);
    event.target.disabled = false;
    if (response?.ok) location.reload();
    else showError("Couldn't log out. Please try again.");
  });

  async function load() {
    const response = await fetch("/api/admin/settings").catch(() => null);
    if (response?.status === 401) return location.reload();
    if (!response?.ok) {
      loading.textContent = "Couldn't load the settings. Reload the page to try again.";
      return;
    }
    fill((await response.json()).settings);
    loading.hidden = true;
    form.hidden = false;
  }

  load();
</script>
</html>`;
