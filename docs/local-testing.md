# Local acceptance testing (Windows)

A step-by-step guide for testing the application yourself before approving commits and deployment. Commands are
for **PowerShell** unless stated. Nothing here deploys, commits or pushes. Where a step uses your real model key it
says so: generation then makes **live requests** that use your quota.

How to read it: every step gives a command and what **success looks like**. If what you see differs, stop and go to
section 9 (reporting).

> **Shortcut with make.** Once GNU Make is installed (`winget install ezwinports.make`, then a new terminal),
> `make dev` does sections 2 to 4 in one go (MongoDB, API, web), `make status` is the check in section 4, and
> `make check`, `make test-integration` and `make verify` are the checks in section 7. The commands below remain
> valid when you want to see each step.

## 1. Prerequisites

Open PowerShell in the repository root (`cd C:\ai-interview-prep`) and run:

```powershell
node -v          # v20.19 or newer (this machine was developed on v24)
pnpm -v          # 10.x (the repo pins 10.34.7)
docker --version # any recent Docker
docker info --format "{{.ServerVersion}}"   # prints a version; an error means Docker Desktop is not running
git --version
```

Success: versions as above, and `docker info` prints a version number. If `pnpm` is missing: `npm i -g pnpm@10`.
If dependencies are missing (`node_modules` absent): `pnpm install --frozen-lockfile` (this installs only what is
already in the lockfile).

## 2. Start MongoDB

```powershell
make status                        # is the mongo service already running?
make db                            # start it and wait until healthy (needs MONGO_ROOT_USER and MONGO_ROOT_PASSWORD in .env)
make status                        # State should be "running" / "healthy"
docker compose -p ai-interview-prep -f docker/compose.yaml exec mongo mongosh --quiet --eval "db.adminCommand('ping').ok"
```

Success: `make status` shows the mongo service healthy, and the last command prints `1`.

**Port.** `docker/compose.yaml` publishes MongoDB on `127.0.0.1:${MONGO_PORT:-27017}`. A container named
`ai-interview-prep-mongo-1` was seen on host port **27018** on this machine, so your `.env` probably has
`MONGO_PORT=27018`. Whatever the port is, `MONGODB_URI` and `TEST_MONGODB_URI` in `.env` must use the same one. To see
the port without printing credentials:

```powershell
docker compose -p ai-interview-prep -f docker/compose.yaml port mongo 27017
```

## 3. Configure the environment without exposing secrets

The API reads `.env` in the repository root (git-ignored). **Do not print or paste it.** To check which variables are
set **without showing values**:

```powershell
Test-Path .env
Get-Content .env | Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=' } |
  ForEach-Object { $name,$val = $_ -split '=',2; "{0} = {1}" -f $name.Trim(), $(if ($val.Trim()) {'<set>'} else {'<empty>'}) }
```

Success: `.env` exists and these are `<set>`: `NODE_ENV`, `PORT`, `WEB_ORIGIN`, `MONGODB_URI`, `SESSION_SECRET`,
`MONGO_ROOT_USER`, `MONGO_ROOT_PASSWORD`. `LLM_API_KEY` is `<set>` only if you want real generation.

Local values that matter:

| Variable              | Local value                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `NODE_ENV`            | `development` (do not use `production` locally: it needs Secure cookies over https)        |
| `WEB_ORIGIN`          | `http://localhost:3000` exactly. Opening the site as `127.0.0.1:3000` breaks cookie/CORS   |
| `SESSION_SECRET`      | Any long random string locally                                                             |
| `NEXT_PUBLIC_API_URL` | Leave unset locally: the web app then uses `http://localhost:4000` (only on localhost)     |
| `ALLOW_PRIVATE_HOSTS` | `false` is fine; local fixture sites are allowed for the batch command regardless          |
| `LLM_API_KEY`         | Your key, **only in `.env`**. Empty = generation fails with a clear "not configured" error |

Privacy: on a free model tier, prompts may be read by the provider. Use only a public job description and a public
company site for testing, never real personal data.

## 4. Start the application and verify each service

```powershell
pnpm dev
```

Leave it running; it starts the API and the web app in one window. Success in the output: a line containing
`api listening` with `port: 4000`, and Next.js reporting `Local: http://localhost:3000`.

In a **second** PowerShell window:

```powershell
curl.exe -s http://localhost:4000/health   # {"status":"ok"} or similar
curl.exe -s http://localhost:4000/ready    # {"status":"ready"}  (database reachable)
curl.exe -s -o NUL -w "%{http_code}`n" http://localhost:3000/login   # 200
```

| Service | URL                      | Healthy means                             |
| ------- | ------------------------ | ----------------------------------------- |
| Web     | `http://localhost:3000`  | the sign-in page loads in the browser     |
| API     | `http://localhost:4000`  | `/health` responds, `/ready` says `ready` |
| MongoDB | host port from section 2 | `/ready` is `ready`                       |

`/ready` failing while `/health` works means the API cannot reach MongoDB: check section 2 and `MONGODB_URI`.

Use **Chrome or Edge at `http://localhost:3000`** (not `127.0.0.1`). Keep DevTools open (F12) on the Network and
Console tabs while testing.

## 5. Manual acceptance checklist

Tick each line; note anything unexpected. Use throwaway accounts (for example `tester1@example.com`).

### 5.1 Registration, login, logout, sessions

- [ ] `/register`: an invalid email or short password is refused with a readable message, and no account is made.
- [ ] Register `tester1@example.com` with a valid password: you land in the app (`/kits`), which is empty with an
      empty-state message.
- [ ] Reload the page: you stay signed in (the session cookie persists).
- [ ] DevTools > Application > Cookies > `http://localhost:3000` (or `localhost`): a session cookie exists, is
      **HttpOnly**, and `document.cookie` in the Console does **not** show it.
- [ ] **Sign out** (top navigation): you return to `/login`; pressing Back and reloading `/kits` sends you to
      `/login` again.
- [ ] Log in with the wrong password: a generic failure message (no hint about whether the email exists).
- [ ] Log in correctly: you are back at `/kits`.
- [ ] Open a second private window, register `tester2@example.com`: it sees **none** of tester1's kits. Paste
      tester1's kit URL into tester2's window: not found / no access, no kit data.
- [ ] Visit `/kits` while signed out: redirected to `/login`.

### 5.2 Kit creation, research and generation (uses your real key and quota)

Skip to 5.9 if you have no key. Without a key, creating a kit should fail with a clear "model not configured"
style message and no crash: tick that instead.

- [ ] `/kits/new`: empty fields show validation messages; days outside 1-60 are refused.
- [ ] Enter a public job description (a few paragraphs), a public company URL that allows crawling, and 5 days.
      Submit.
- [ ] Progress is shown from the server (stages). Reload mid-way: the address contains `?job=...` and the progress
      comes back.
- [ ] On success you reach the kit: company brief, requirements, questions by category, flashcards, a 5-day schedule,
      coverage. The schedule has exactly 5 days.
- [ ] Every must-have requirement shows coverage, or an honestly listed gap.
- [ ] A company URL that is unreachable or blocked produces a readable error, not a stuck spinner.
- [ ] Optional: create from a JSON file (Appendix B format, at most 10 cases); an invalid case is listed with a reason.

### 5.3 Builder edits and autosave

- [ ] Edit a question's text: it changes at once and is marked as edited; a "saved" indication follows.
- [ ] Add a question (pick a requirement and category), delete a generated question, reorder two questions, pin one.
- [ ] Move or change a schedule item; the number of days stays 5.
- [ ] Reload: all edits are still there.
- [ ] Delete the last question for a must-have: coverage shows a gap instead of hiding it.
- [ ] DevTools Network > set **Offline**, make an edit: a failure notice with **Retry saving** appears and your edit
      stays. Go back online, press Retry saving: it saves.

### 5.4 Conflict handling

- [ ] Open the same kit in two tabs (A and B), signed in as the same user.
- [ ] In A, edit a question and wait for it to save.
- [ ] In B (still on the old version), edit a different question.
- [ ] B shows a conflict state and keeps your edit. Choose **Reapply my edits to the new version**: both changes are
      present. Repeat and choose **Discard my edits and use the new version**: B's edit is gone, A's remains.
- [ ] Nothing was overwritten silently.

### 5.5 Regeneration (live requests)

- [ ] Edit and pin one question in a category. Regenerate that category.
- [ ] A report shows what was kept, replaced, added and skipped. Your edited and pinned items are unchanged, a
      question you deleted earlier did not come back.
- [ ] Regenerate the schedule: items on a pinned day are kept; the day count is unchanged.
- [ ] Regenerate the company brief; if you pinned it, it is kept.

### 5.6 Flashcard practice and persisted progress

- [ ] `/kits/<id>/practice`: one card at a time; reveal the answer; rate confidence 1 to 3.
- [ ] A coverage / progress summary updates.
- [ ] Leave and come back (or reload): your ratings are still there, and the next session starts with the cards you
      were least sure about.
- [ ] Sign out and in again: progress is still there. As tester2, the same kit URL gives no access.

### 5.7 Reset

- [ ] In practice mode choose the reset control and **confirm** the prompt: progress is cleared for that kit only
      (another kit's progress is unchanged). Cancelling leaves progress untouched.
- [ ] In the builder, the brief editor's **Reset** button restores the text to the saved version (unsaved changes
      only).

### 5.8 Session expiry and robustness

- [ ] DevTools > Application > Cookies: delete the session cookie, then click something in the app: you are sent to
      `/login` with a "session expired" style message; unsaved builder edits are offered back after signing in.
- [ ] Stop the API (Ctrl+C in the dev window) and use the app: the pages show an error with retry, not a blank page.
      Restart `pnpm dev`: retry works. Any generation that was running when you stopped it is marked failed after
      restart (jobs live in the API process).

### 5.9 Batch evaluation

Create `cases-test.json` **outside the repo** (for example in `%TEMP%`) or inside the repo knowing `kits.json` and
`/out/` are git-ignored:

```json
[
  {
    "id": "c1",
    "jd": "Backend engineer. Must know Node.js, TypeScript and MongoDB.",
    "company_url": "https://example.com",
    "days": 3
  },
  {
    "id": "c2",
    "jd": "Too many days on purpose.",
    "company_url": "https://example.com",
    "days": 61
  }
]
```

```powershell
npm run evaluate -- --input $env:TEMP\cases-test.json --output $env:TEMP\kits-test.json
echo "exit=$LASTEXITCODE"
```

Success **without** a key: exit code `4` (configuration problem) and no output file; nothing is sent anywhere.
Success **with** a key (live requests): exit `0`, the output file exists, case `c2` is `status: "failed"` with
`error.code: "INVALID_CASE"`, and `c1` is `ok` (or failed with a stable code such as a quota or robots code). Check
without printing the whole file:

```powershell
node -e "const r=JSON.parse(require('fs').readFileSync(process.env.TEMP+'/kits-test.json','utf8'));console.log(r.version, JSON.stringify(r.kits.map(x=>[x.id,x.status,x.error?.code??null])))"
```

## 6. Logs and common errors

- **API logs** are the `pnpm dev` window (structured JSON, one line per event; secrets are redacted). Set
  `LOG_LEVEL=debug` in `.env` and restart for more detail.
- **Web logs**: the same window (Next.js) and the browser Console/Network tabs.
- **MongoDB logs**: `make db-logs`.

| Symptom                                                         | Likely cause and check                                                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| API exits at start, mentions the database                       | MongoDB not running or wrong port/credentials in `MONGODB_URI`. `docker compose ps`; section 2             |
| `/ready` not ready                                              | Same as above                                                                                              |
| Port 4000 or 3000 in use (`EADDRINUSE`)                         | `Get-NetTCPConnection -LocalPort 4000 -State Listen` shows the owning process id; stop that process        |
| Login succeeds but you are signed out on reload, or CORS errors | You opened `127.0.0.1` or another port. Use `http://localhost:3000` and `WEB_ORIGIN=http://localhost:3000` |
| "This site is not set up correctly" on localhost                | Should not happen locally. Check `NEXT_PUBLIC_API_URL` is unset or an http(s) address; report it           |
| 403 on a write request                                          | Origin check: the page origin does not equal `WEB_ORIGIN`                                                  |
| 429 Too many requests                                           | Rate limit (10 sign-in attempts per 15 minutes per IP); wait or restart the API (limits are in memory)     |
| Generation fails: not configured                                | `LLM_API_KEY` empty. Expected without a key                                                                |
| Generation fails: quota / rate limited / model not found        | Provider side (`LLM_QUOTA_EXHAUSTED`, `LLM_RATE_LIMITED`, `LLM_MODEL_NOT_FOUND`); free quota is small      |
| Company site blocked or unreachable                             | `COMPANY_BLOCKED_BY_ROBOTS` or `COMPANY_UNREACHABLE`: try another public site                              |
| Integration tests fail to connect                               | `TEST_MONGODB_URI` port differs from the running container (default in code is 27018)                      |
| `pnpm` script not found / module not found                      | Run `pnpm install --frozen-lockfile` in the repo root                                                      |

## 7. Automated checks

Run from the repository root. Stop the dev server first if the build misbehaves (Windows can lock `.next`).

```powershell
pnpm test                 # unit tests, no database. Success: "Tests  1717 passed (1717)"
pnpm test:integration     # needs MongoDB up. Success: "Tests  213 passed (213)"
pnpm typecheck            # success: every package prints "Done" and no "error TS"
pnpm lint                 # success: no output after "> eslint ." and exit 0
pnpm format:check         # success: "All matched files use Prettier code style!"
pnpm build                # success: Next.js lists the routes, exit 0 (a localhost API-URL warning is expected)
$env:NEXT_PUBLIC_API_URL='https://api.example.com'; pnpm build:production; Remove-Item Env:NEXT_PUBLIC_API_URL
                          # success: "production environment check: ok", then a successful build
pnpm build:production     # with the variable UNSET it must FAIL with a message naming NEXT_PUBLIC_API_URL
```

After each command run `echo $LASTEXITCODE` (PowerShell) if you want the exit code: `0` is success.
Test counts will change if tests are added; "all passed, none failed or skipped" is what matters. Do **not** run
the tests with a JSON reporter: `.vitest/json/output.json` is tracked in Git and must not change.
`pnpm test:e2e` fails on purpose (no browser tests exist).

## 8. Verify nothing unwanted can enter Git

```powershell
git status --short                      # review every line: only files you recognise
git status --short --ignored | Select-String '\.env|out/|kits'   # .env and out/ must show as "!!" (ignored)
git check-ignore -v .env out kits.json  # each prints the .gitignore rule that ignores it
git diff --stat -- .vitest              # must print nothing (the tracked evidence file is unchanged)
git ls-files .env out kits.json         # must print nothing (none tracked)
git diff --cached --name-only           # nothing staged yet; after you stage, review this list
```

Look for secrets in files that would be committed, **printing file names only, never matching text**:

```powershell
git grep -I -l -E "AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}|BEGIN (RSA |EC )?PRIVATE KEY"
(git ls-files --others --exclude-standard) | ForEach-Object { Select-String -Path $_ -Pattern 'AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}|BEGIN (RSA |EC )?PRIVATE KEY' -List } | Select-Object -ExpandProperty Path
```

Success: both print nothing. A file name printed means: do not commit; tell me the file name only. Also check for
generated artifacts: no `*.log`, no `kits.json`, no `.next/`, no `node_modules/` in `git status`. The placeholder
`change-me-local-only` in `.env.example` and the docs is intentional and is not a secret.

## 9. Reporting a failure to me

Send, for each failure:

1. **What you did** (the checklist number, for example "5.4 conflict handling").
2. **Expected vs actual** in one sentence each.
3. **The command** you ran and its **exit code**, or the exact steps in the browser (URL, buttons, data typed;
   use made-up data).
4. **The error output**: the last 20 to 40 lines of the relevant window or `make db-logs`,
   and for browser problems the red Console lines and the failing request's **method, URL and status** from the
   Network tab (not its headers or cookies).
5. **Environment**: `node -v`, `pnpm -v`, browser and version, whether MongoDB is the compose container.

**Redact before pasting:** `LLM_API_KEY` or anything starting `AIza`/`sk-`, `SESSION_SECRET`, passwords and database
URIs (replace with `<redacted>`), cookie values, `Authorization` headers, and any real personal data. Never paste
`.env`. If you are unsure whether something is sensitive, redact it. Screenshots: crop out the address bar if it
contains a token, and never show DevTools Application > Cookies values.

## 10. Final pre-commit checklist

- [ ] Sections 5.1 to 5.9 completed; every failure reported and resolved or accepted
- [ ] `pnpm test`, `pnpm test:integration`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build` all
      pass, and `build:production` passes with a https URL and fails without one
- [ ] `git status` reviewed line by line; `.env`, `out/`, `kits.json`, logs are ignored and untracked
- [ ] `git diff --stat -- .vitest` is empty
- [ ] Secret scans in section 8 print nothing
- [ ] You have decided how to split commits (the work from Phase 7 onward is uncommitted; the README and
      `docs/requirements-traceability.md` say what is and is not verified)
- [ ] Remember what is still not verified: real browser automation, real-provider five-case timing, a real clone,
      deployment
- [ ] Only then approve committing; pushing and deploying are separate approvals
