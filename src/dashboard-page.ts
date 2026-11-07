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
  .source { margin: 0 0 8px; font-size: .85rem; }
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
  #logsSection, #uploadSection, #tokensSection { margin-top: 24px; padding-top: 12px; border-top: 1px solid var(--line); }
  #clipFolder { width: 100%; box-sizing: border-box; margin-top: 8px; }
  #uploadStatus { margin: 8px 0 0; font-weight: 600; overflow-wrap: anywhere; }
  h2 { font-size: 1.1rem; margin: 0 0 4px; }
  #clipCount { margin: 0 0 8px; font-weight: 600; }
  #clipCount.none { color: var(--error); }
  #logs { max-height: 50vh; overflow-y: auto; font: 13px/1.4 ui-monospace, monospace; }
  .log { padding: 6px 0; border-top: 1px solid var(--line); white-space: pre-wrap; overflow-wrap: anywhere; }
  .log.bad { color: var(--error); }
  .log time { display: block; color: var(--muted); }
  #tokenForm { display: flex; gap: 8px; margin-top: 8px; }
  #tokenName { flex: 1; min-width: 0; }
  #newToken { margin-top: 12px; padding: 12px 0; border-top: 1px solid var(--line); }
  #newToken > div { display: flex; gap: 8px; margin-top: 4px; }
  #newTokenValue { flex: 1; min-width: 0; }
  #copyStatus { margin: 8px 0 0; color: var(--accent); font-weight: 600; }
  #copyStatus:empty, #tokenError:empty { display: none; }
  #tokenError { margin: 8px 0 0; color: var(--error); }
  #tokenList { margin-top: 12px; }
  .token { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 0; border-top: 1px solid var(--line); }
  .token > div { min-width: 0; overflow-wrap: anywhere; }
  .token strong { display: block; }
</style>
<p class="source"><a href="https://github.com/erkantaylan/Domex" target="_blank" rel="noopener">GitHub</a></p>
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
  <p><a href="/dashboard/testing">Testing page</a></p>
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
<section id="uploadSection">
  <h2>Upload clips</h2>
  <p class="hint">Pick a folder that has one folder per language, with MP3 files inside. Clips already on the server are skipped, so you can run it again if it stops. Keep this page open while it runs.</p>
  <input id="clipFolder" type="file" webkitdirectory multiple aria-label="Clips folder">
  <p id="uploadStatus" role="status"></p>
</section>
<section id="tokensSection">
  <h2>Tokens</h2>
  <p class="hint">A token lets an agent use the admin API for 7 days: game timings, the log and clips. It can't make tokens, post as the bot or use voice.</p>
  <form id="tokenForm" novalidate>
    <input id="tokenName" maxlength="40" autocomplete="off" placeholder="Name, like my laptop agent" aria-label="Token name">
    <button id="makeToken">Make a token</button>
  </form>
  <p id="tokenError" role="alert"></p>
  <div id="newToken" hidden>
    <span class="hint">Your new token. It won't be shown again, so copy it now.</span>
    <div>
      <input id="newTokenValue" type="password" readonly autocomplete="off" aria-label="New token">
      <button type="button" id="copyToken">Copy</button>
    </div>
    <p id="copyStatus" role="status"></p>
  </div>
  <div id="tokenList"></div>
</section>
<section id="logsSection">
  <h2>What happened</h2>
  <p id="clipCount" role="status"></p>
  <p class="hint">The bot's recent log, newest first. It starts again when the bot restarts.</p>
  <div id="logs"></div>
</section>
<script>
  const clipCount = document.getElementById("clipCount");
  const logsBox = document.getElementById("logs");

  async function loadLogs() {
    const response = await fetch("/api/admin/logs").catch(() => null);
    if (!response?.ok) {
      clipCount.textContent = "Couldn't load the log.";
      return;
    }
    const { logs, languages, clips } = await response.json();
    clipCount.textContent = clips === 0
      ? "No clips imported, so games can't start."
      : clips + " clips in " + languages + " languages.";
    clipCount.className = clips === 0 ? "none" : "";
    logsBox.replaceChildren(...logs.reverse().map((entry) => {
      const row = document.createElement("div");
      row.className = entry.level === "error" ? "log bad" : "log";
      const time = document.createElement("time");
      time.textContent = new Date(entry.time).toLocaleString();
      row.append(time, entry.text);
      return row;
    }));
  }

  loadLogs();
  setInterval(loadLogs, 5000);

  const clipFolder = document.getElementById("clipFolder");
  const uploadStatus = document.getElementById("uploadStatus");

  // Sends one clip, trying again if the connection drops. Returns whether it worked.
  async function uploadClip({ file, language, name }) {
    const query = "?language=" + encodeURIComponent(language) + "&name=" + encodeURIComponent(name);
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch("/api/admin/clips" + query, { method: "POST", body: file }).catch(() => null);
      if (response?.ok) return true;
      if (response?.status === 401) return false;
      if (response && response.status < 500) return false;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
    return false;
  }

  clipFolder.addEventListener("change", async () => {
    clipFolder.disabled = true;
    uploadStatus.textContent = "Checking what's already on the server...";
    const existing = await fetch("/api/admin/clips").then((r) => r.ok ? r.json() : null).catch(() => null);
    if (!existing) {
      uploadStatus.textContent = "Couldn't check the server. Reload the page and try again.";
      clipFolder.disabled = false;
      return;
    }
    const known = new Set(existing.paths);

    const picked = [...clipFolder.files].flatMap((file) => {
      const parts = file.webkitRelativePath.split("/");
      const name = parts.at(-1);
      const language = parts.at(-2);
      if (parts.length < 3 || !name.toLowerCase().endsWith(".mp3") || language === "The apple is red") return [];
      return [{ file, language, name }];
    });
    const queue = picked.filter((clip) => !known.has("assets/" + clip.language + "/" + clip.name));
    const skipped = picked.length - queue.length;
    let sent = 0;
    const failed = [];

    function show(done) {
      uploadStatus.textContent = (done ? "Finished: " : "Uploading: ")
        + sent + " of " + queue.length + " sent, " + skipped + " already there, " + failed.length + " failed."
        + (failed.length ? " Failed: " + failed.slice(0, 5).join(", ") + (failed.length > 5 ? "..." : "") : "");
    }

    // Three at a time keeps it quick without flooding the server.
    async function worker() {
      for (let clip = remaining.shift(); clip; clip = remaining.shift()) {
        if (await uploadClip(clip)) sent++;
        else failed.push(clip.name);
        show(false);
      }
    }
    const remaining = [...queue];
    show(false);
    await Promise.all([worker(), worker(), worker()]);
    show(true);
    clipFolder.value = "";
    clipFolder.disabled = false;
    loadLogs();
  });

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

  const tokenForm = document.getElementById("tokenForm");
  const tokenName = document.getElementById("tokenName");
  const makeToken = document.getElementById("makeToken");
  const tokenError = document.getElementById("tokenError");
  const newToken = document.getElementById("newToken");
  const newTokenValue = document.getElementById("newTokenValue");
  const copyStatus = document.getElementById("copyStatus");
  const tokenList = document.getElementById("tokenList");

  // Describes one token in plain words: when it was made, last used and ends.
  function tokenLine(token) {
    const made = "Made " + new Date(token.createdAt).toLocaleString();
    const used = "last used " + (token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : "never");
    if (token.status === "revoked") return made + ", " + used + ". Revoked.";
    if (token.status === "expired") return made + ", " + used + ". Expired.";
    return made + ", " + used + ", ends " + new Date(token.expiresAt).toLocaleString() + ".";
  }

  async function loadTokens() {
    const response = await fetch("/api/admin/tokens").catch(() => null);
    if (response?.status === 401) return loggedOut();
    if (!response?.ok) {
      tokenError.textContent = "Couldn't load the tokens. Reload the page to try again.";
      return;
    }
    const { tokens } = await response.json();
    if (tokens.length === 0) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "No tokens yet.";
      tokenList.replaceChildren(empty);
      return;
    }
    tokenList.replaceChildren(...tokens.map((token) => {
      const row = document.createElement("div");
      row.className = "token";
      const text = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = token.name;
      const line = document.createElement("span");
      line.className = "hint";
      line.textContent = tokenLine(token);
      text.append(name, line);
      row.append(text);
      if (token.status === "active") {
        const revoke = document.createElement("button");
        revoke.type = "button";
        revoke.textContent = "Revoke";
        revoke.addEventListener("click", () => revokeToken(token.id, revoke));
        row.append(revoke);
      }
      return row;
    }));
  }

  async function revokeToken(id, button) {
    button.disabled = true;
    tokenError.textContent = "";
    const response = await fetch("/api/admin/tokens/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => null);
    button.disabled = false;
    if (response?.status === 401) return loggedOut();
    if (response?.status === 404) {
      const body = await response.json().catch(() => ({}));
      tokenError.textContent = body.error ?? "That token wasn't found.";
    } else if (!response?.ok) {
      tokenError.textContent = "Couldn't revoke the token. Please try again.";
      return;
    }
    loadTokens();
    loadLogs();
  }

  tokenForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    tokenError.textContent = "";
    makeToken.disabled = true;
    const response = await fetch("/api/admin/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: tokenName.value.trim() }),
    }).catch(() => null);
    makeToken.disabled = false;
    if (response?.status === 401) return loggedOut();
    if (response?.status === 400) {
      const body = await response.json().catch(() => ({}));
      tokenError.textContent = body.error ?? "That name wasn't accepted.";
      return;
    }
    if (!response?.ok) {
      tokenError.textContent = "Couldn't make a token. Please try again.";
      return;
    }
    const made = await response.json();
    newTokenValue.value = made.token;
    copyStatus.textContent = "";
    newToken.hidden = false;
    tokenName.value = "";
    loadTokens();
    loadLogs();
  });

  document.getElementById("copyToken").addEventListener("click", async () => {
    if (!navigator.clipboard) {
      copyStatus.textContent = "Copying needs https. Open the dashboard through its https address and make a new token.";
      return;
    }
    const copied = await navigator.clipboard.writeText(newTokenValue.value).then(() => true, () => false);
    copyStatus.textContent = copied ? "Copied." : "Couldn't copy. Please try again.";
  });

  loadTokens();
  load();
</script>
</html>`;
