# AGENTS.md: instructions for sessions on the А-11 schedule bot repo

## Owner and communication
- The owner does not write code (this bot was built with AI help). Reply in Russian, in plain words, short: what changed, why, result. Go deeper only when asked. Explain a technical term in a phrase.
- No emojis and no heavy markdown in replies to the owner.
- Start every conversational reply with "SilverElixir," (a canary: when it disappears, the owner restarts the session). Never put it in code, project files, commit messages or reports; the chat final report still starts with it.
- Explicit instructions in the owner's task override this file, except Approvals and Secrets.
- If a requirement is ambiguous, ask one short question instead of guessing. If the answer changes little, take the simpler option and state the assumption in the report.

## Working style
- One incremental change at a time; do not bundle unrelated fixes.
- Turn each task into a verifiable result (a gate run, a printed message) before reporting.
- Prefer the smallest change that solves the problem: no speculative abstractions, config or features.

## Approvals
- Small requested fixes: do them right away.
- Large changes (a new dependency, a change of message formats or behavior, restructuring, `run.py`, `wheels/`, `.github/workflows/`): short plan first, wait for approval.
- Protected files: `.github/workflows/*`, `run.py`, `wheels/*`. Change them only after a plan is approved, even for a one-line fix. `.env` is never edited by an agent.
- Commit to `main` yourself in small logical steps, one line in Russian saying what and why, in the style of the recent `git log`. Push only when the owner asks in that task: a push to `main` restarts the live bot.
- One confirmation per task covers its related steps; a new, unrelated action needs its own.

## Secrets
- Never read, print or copy `.env` or any value from it (`BOT_TOKEN`, `MY_TELEGRAM_ID`, `FPSMS_API_KEY`, `FPSMS_SERVER_UUID`). Some free model tiers are trained on prompts.
- Never paste a URL that carries the token into a report, commit, log or issue. Use the gate script for prod checks: it reads `.env` itself.
- If a secret leaks into a file, a log or a commit: stop, tell the owner to rotate it, do not rewrite git history without asking.
- `.env` and `__pycache__` never enter the repo; check `git status` before every commit.

## What this repo is
- A personal Telegram schedule bot for group А-11 of БТЭУ (Gomel). One user: the owner. Everyone else gets silence, no reply and no reaction. Bot text is Russian and restrained.
- It runs 24/7 in a free fps.ms container with a hard 128 MB RAM limit and must be renewed by hand once a day.
- `bot.py` is the whole bot: aiohttp transport (class `Telegram`) with long polling, render functions that never touch the network (`day_text`, `now_text`, `week_text`, `bells_text`, `morning_text`, `calendar_kb`, `ics_for_week`), handlers (`on_message`, `on_callback`), background tasks (`renewal_watchdog`, `morning_summary`), poll loop in `main()`.
- `schedule_data.py` is the single source of schedule facts: `SCHEDULE`, `KIND`, `BELLS`, `SEMESTER_START`, `SEMESTER_END`, `ANCHOR_MONDAY`, `week_mark()`. The 7-field record format is documented in its docstring.
- `SPEC.md` is the external behavior contract: message templates, statuses, calendar, `.ics`, watchdog, morning summary. Any change of text, format, buttons or reply logic edits the matching SPEC item in the same commit; never change a format "just because". A new environment variable goes into `.env.example` and `SPEC.md` section 9 in the same commit.
- `run.py` is the host bootstrap: it clones the repo only on a first start (the host does the `git pull` before it), installs from `wheels/` offline and execs `bot.py`; `.agents/skills/verify-bot/` is the verification skill; `.github/workflows/` holds deploy and healthcheck.
- No database, no state files, no web server: state lives in memory, so a restart is safe and loses only the reminder and summary de-duplication.

## Hard constraints
- **aiohttp only.** No aiogram, pyTelegramBotAPI or any other framework, in any form: an aiogram 3 import (with pydantic) stalls the container at 127.9 MB against the 128 MB ceiling, so the bot never starts. The transport is the hand-rolled `Telegram` class over aiohttp plus long polling.
- **A new dependency needs all three:** a real reason, a cp311 manylinux wheel placed in `wheels/` (a network `pip install` on the host dies by OOM; only `pip install --no-index --find-links wheels` works), and a memory measurement before and after.
- **Polling only, no webhooks.** The host and the spec do not support them; `deleteWebhook` at startup only clears leftovers.
- **Fixed UTC+3:** `timezone(timedelta(hours=3))`. No pytz or zoneinfo, so nothing depends on the host tz database.
- **No emojis in bot strings** (messages, buttons, calendar, `.ics` names). Formatting is Telegram HTML (`<b>`, `<i>`, `<code>`, `<blockquote>`), `parse_mode="HTML"`.
- **Every dynamic string that reaches HTML goes through `html.escape`:** subjects, teachers, rooms, suffixes.
- **The bot answers only the owner.** Never weaken the `OWNER_ID` filter in `on_message` and `on_callback`, never add public commands.
- **`schedule_data.py` owns every schedule fact.** `bot.py` only renders and serves it: no subject names, times or rooms hardcoded there. The only schedule dates in `bot.py` are the two in the import-time sanity assert.

## Commands
Run from the repo root.
```powershell
# setup once per machine
pip install -r requirements.txt

# run locally (needs .env with BOT_TOKEN and MY_TELEGRAM_ID)
python -X utf8 bot.py

# gate, offline: syntax, data, 13 render calls (tag balance, no emoji), static rules, memory probe (about a second)
python -X utf8 .agents/skills/verify-bot/scripts/verify_bot.py --local

# gate, full: the above plus prod liveness (409), last deploy via gh, container state via panel
python -X utf8 .agents/skills/verify-bot/scripts/verify_bot.py

# week alternation anchor alone
python -c "import schedule_data as sd; from datetime import date; assert (sd.week_mark(date(2026,9,21)), sd.week_mark(date(2026,10,26))) == ('под','над'); print('week_mark ok')"

# deploy: push to main -> deploy.yml restarts the container -> AUTO_UPDATE pulls -> run.py
# (downtime 30-40 s; this is a live restart, see Approvals)
git push origin main

# deploy status without the gate
gh run list --workflow=deploy.yml --limit 1
```
- The shell is PowerShell: there is no `grep` or `tail`, and a glob like `*.py` does not expand for a command. Read and search with the read/glob/grep tools; in the shell use `Select-String`, `Get-Content`, `Get-ChildItem`.
- The gate prints `ЛОКАЛЬНО` and `ПРОД` sections of `[OK]/[WARN]/[FAIL]` and exits 1 on any FAIL. Without `.env` it cannot import `bot`: renders and the memory probe become a WARN and the prod checks are skipped, which is normal for a fresh clone.
- A local `bot.py` with the production token competes with the server over 409. For a live message test use a separate test bot's token or stop the container first.
- There is no pytest and no test suite: the gate script is the test suite. Extend `verify_bot.py` instead of adding a framework.

## Gate
- Run the gate (`--local`) before the first change (green baseline) and after each batch of changes; run the full gate when the change touches deploy, prod behavior, or the owner asks for a health check.
- If the gate is red before your changes, stop and report which checks fail. Do not start the task and do not fix unrelated failures unless the owner says to continue.
- Done means the gate actually ran and is green and the final report is written. Never say "works" or "tests pass" without that output.
- For a schedule or `KIND` change also print one real message for today, so the owner sees the result in chat.
- A red check is fixed at the cause. Do not loosen a check to make it pass; if a check itself is wrong, say so and change it deliberately.
- `verify_bot.py` pins six absolute 2026 dates. The gate only turns red when a new anchor flips week parity, so compare those six dates with the official table by hand on every semester change and update them.

## Gotchas
- **The 409 test needs `timeout>=5`.** With `timeout=0` or `1` Telegram answers `OK` and the check lies. The gate tests the HTTP status; `healthcheck.yml` greps the body for `"error_code":409` and must stay strict there, because a bare `409` can match an `update_id`.
- **The fps.ms panel API sits behind Cloudflare:** requests from python's urllib are rejected even with a valid key, so use curl; the healthcheck and the gate also send a browser User-Agent. Startup variables change only with PUT `/api/client/servers/{uuid}/startup/variable` (PATCH gives 405). Restart is POST `/api/client/servers/{uuid}/power` with `{"signal":"restart"}`.
- **The server UUID is hardcoded in both workflows** (`deploy.yml`, `healthcheck.yml`), while the watchdog reads `FPSMS_SERVER_UUID` from `.env`. If the server is ever recreated, update both files and `.env` together, otherwise deploy and healthcheck keep restarting the dead one.
- **There is no HTTP endpoint for the container console.** The live log is a websocket: `GET /api/client/servers/{uuid}/websocket`, then auth, then `console output` events.
- **Renewal is manual:** "Add 24 hours" in the panel, protected by reCAPTCHA; without renewals for 28 days in a row the server is deleted. `renewal_watchdog` reminds the owner at under 30 h and under 6 h. Do not remove it and do not automate the renewal.
- **The import-time assert in `bot.py` catches only a parity flip:** `week_mark(22.10.2026)=="под"` and `15.10.2026=="над"`. An anchor shifted by 14 or 28 days keeps the parity, passes both the assert and the gate, and ships wrong weeks. Change the anchor, those two dates and the six dates in `verify_bot.py` together, and re-check them against the official table.
- **`SEMESTER_START`/`SEMESTER_END` cut everything:** days outside them are "пар нет", calendar cells outside them are inactive, and the month arrows are hidden when a neighbouring month does not intersect the semester. The morning summary is not sent outside them.
- **`.ics` is RFC 5545 on purpose:** floating local time, UTC `DTSTAMP`, escaping, folding at 75 octets, CRLF. Once it was dead in production while the checks were green (a bad `FormData` kwarg), so do not "simplify" it.
- **`_ScrubFormatter` hides `BOT_TOKEN` in logs** because aiohttp exception text contains the request URL and the container console is visible in the panel. Do not log token-bearing URLs.
- **The host runs Python 3.11** (wheels are cp311) while this machine has 3.13. A 3.12+ only syntax error passes the local gate and kills prod at import.
- **`healthcheck.yml` has two cron slots** (17 and 43 minutes) because the GitHub scheduler skips runs; on failure it alerts the owner and tries a restart. Do not cut it to one slot or weaken the 409 match.

## Semester change (rare, follow the order)
1. bteu.by -> «Студенту» -> «Расписание занятий» -> «Формирование учебных недель»: take the official over/under-the-line table. The site publishes it late, so do not change data before it appears.
2. Set `ANCHOR_MONDAY` (a Monday of a week with a known mark; now 21.09.2026 = «под»), `SEMESTER_START`, `SEMESTER_END`, and the two dates in the import assert.
3. Download the faculty's stable schedule («Стабильное расписание», the group's `.xls`) and rewrite `SCHEDULE`. Week variants are marked «над»/«под»/«both»; the record format is in the `schedule_data.py` docstring.
4. Update `KIND` for new subjects. The site does not publish types: the sources are screenshots of the original @bteusupbot bot and the file structure (two rooms or two teachers = subgroups = practice; «1-2» = both subgroups = lecture).
5. Check `week_mark` against the official table (anchor command above), update the hardcoded dates in `verify_bot.py`, run the gate.
6. Update `SPEC.md` in the same commit.

## Code style
- Russian comments, docstrings and bot strings; match the density of the existing files. Comments explain why, never restate the code.
- Render in functions that build text without sending it and without touching the network, so the gate can check every view.
- Copy data strings verbatim from the source: rooms «3-27,3-30», teachers with their position «доц. Кузьменкова И.А.». The position is part of the teacher string.
- Verify teacher surnames against the department site when in doubt: the `.xls` has typos (example: «Кузменкова» in the file vs the correct «Кузьменкова»).
- Targeted edits on existing files. No refactors, no reformatting of untouched code, no commented-out code.
- Banned in code, comments and docs: emojis, filler («Важно», «Здесь мы», «Следует отметить»), restating the code.
- Runtime is the standard library plus aiohttp and python-dotenv. No new infrastructure dependencies without the wheel and measurement above.

## Final report
- Short, in this order: what changed and why; changed files; gate result with FAIL/WARN counts (say whether it was the local or the full gate); what was not verified; what the owner must check by hand.
- Say explicitly if the commit is not pushed, so the owner knows the prod bot still runs the old code.
- If nothing is unverified or risky, say so in one phrase instead of padding.

## This file
- Keep it under ~150 lines: add a rule after the same mistake repeats, fix a wrong claim right away, delete rules that no longer change behavior, and re-check every command you edit.
