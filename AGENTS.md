# AGENTS.md: instructions for sessions on the А-11 schedule bot repo

## What this repo is
- A personal Telegram schedule bot for group А-11 of БТЭУ (Gomel). One user, the owner; everyone else gets silence. Bot text is Russian and restrained.
- It runs 24/7 in a free fps.ms container with a hard 128 MB RAM limit and is renewed by hand every day.
- `rust/` is the whole bot: it is what runs in production. The old Python bot, its wheels and its fixture generators are deleted; the behavior they defined is frozen in `rust/tests/fixtures/`.
- `rust/src/schedule.rs` is the only source of schedule facts (`SCHEDULE`, `KIND`, `BELLS`, `SEMESTER_START`/`END`, `ANCHOR_MONDAY`, `week_mark`; the record format and the source of every claim are in its module comment).
- `SPEC.md` is the behavior contract. It wins on behavior, this file wins on process; the owner's task overrides both, except Approvals, Secrets and Hard constraints.
- `run.py` (protected) is the host entry, selected by the panel variable `PY_FILE=run.py`: on a container without `.git` it does init + fetch + reset, then copies `rust/bin/a11-bot` to a temp dir, self-tests it and execs it. A failed self-test means the bot does not start — there is no second implementation to fall back on. The `git pull` on normal starts is the host's.
- `rust/bin/a11-bot` is a committed Linux binary and CI refreshes it on every `rust/**` push.
- No database, no state files, no web server: state is in memory, so a restart is safe and loses only reminder and summary de-duplication.
- `.agents/skills/verify-bot/` holds the checks. A skill grants no permissions: Approvals apply anyway.

## Owner and communication
- The owner does not write code: no code, diffs or tracebacks in replies; describe the effect in plain Russian.
- Short and concrete: what changed, why, result. No emojis, no heavy markdown. Go deeper only when asked; explain a term in a phrase.
- Start every conversational reply with "SilverElixir," (a canary: when it disappears, the owner restarts the session). Never put it in code, project files, commit messages or reports; the chat final report still starts with it.
- If two readings would change bot text, data or files, ask one short question. Otherwise take the simpler option and state the assumption in the report.

## Approvals
- Requested fixes that change no bot text, format or reply logic: do them right away.
- A change of text, format, buttons or reply logic, a new dependency, restructuring, or a protected file: short plan first, wait for approval.
- Protected files: `.github/workflows/*`, `run.py`.
- Live actions need a direct request in this task: `git push`, anything that restarts or stops the container, running the bot with the production token.
- Commit to `main` yourself after a green gate, in small steps, one Russian line saying what and why, like the recent `git log`. Never force-push or rewrite history. Push only when the request says so; an earlier permission does not carry over.

## Secrets
- Never read, print or copy `.env` or any value from it (`BOT_TOKEN`, `MY_TELEGRAM_ID`, `FPSMS_API_KEY`, `FPSMS_SERVER_UUID`): some free model tiers are trained on prompts. Never edit `.env`; tell the owner what to put there.
- Never put a token in a URL that lands in a report, commit, log or issue. For prod checks use the gate, which reads `.env` itself.
- On a leak, tell the owner to rotate in BotFather, then in the host's environment, then in the GitHub secrets.
- `.env` and `__pycache__` never enter the repo; check `git status` before every commit.

## Hard constraints
- **No async runtime, no framework.** Two plain threads (polling, timers) over blocking `ureq` + rustls: tokio or a heavier HTTP stack does not fit the 128 MB limit. Transport is the hand-rolled `Telegram` class in `telegram.rs`.
- **A new dependency needs three things:** a real reason, a memory measurement before and after (`--selftest 2`), and a static musl build that still links.
- **Polling only, no webhooks**; `deleteWebhook` at startup only clears leftovers.
- **Time:** fixed UTC+3 as `TZ_OFFSET_SECS`, no chrono, pytz or zoneinfo. Read the clock only through `Now::local()`, `local_now_seconds()` or `Stamp::now()`; a local day taken from a UTC timestamp is a bug.
- **No emojis in bot strings** (messages, buttons, calendar, `.ics` names). Formatting is Telegram HTML (`<b>`, `<i>`, `<code>`, `<blockquote>`), `parse_mode="HTML"`; every dynamic value goes through `render::esc`.
- **The reply keyboard rides on every message** that does not already carry an inline keyboard: Desktop hides the keyboard when the newest bot message has none, the phone keeps it (SPEC п.7).
- **The bot answers only the owner.** Never weaken the `owner_id` guards in `on_message` and `on_callback`, never add public commands.

## Commands
Run from the repo root.
```powershell
cargo build --release --manifest-path rust/Cargo.toml   # local binary: rust\target\release\a11-bot.exe
python -X utf8 rust/tools/check.py                      # gate: build, cargo test, parity, memory
python -X utf8 .agents/skills/verify-bot/scripts/verify_bot.py --local   # gate, offline
python -X utf8 .agents/skills/verify-bot/scripts/verify_bot.py           # gate plus prod checks
cd rust; cargo test                                     # the same tests without the wrapper
gh run list --workflow=deploy.yml --limit 1             # last deploy
git push origin main                    # only when the owner asked in this task
```
- The shell is PowerShell: no `grep`, no `tail`, no `*.py` glob expansion for commands. Search with the read/glob/grep tools, or `Select-String`/`Get-Content` in the shell.
- The gate prints `ЛОКАЛЬНО` and `ПРОД` sections of `[OK]/[WARN]/[FAIL]` and exits 1 on any FAIL.
- The test path is the pure render functions and a recording stub of the API, never a live send into the owner's chat.

## Code layout (`rust/`)
- `render.rs`/`ics.rs` are pure and never touch the network, `telegram.rs` is the transport, `bot.rs` holds handlers and both background tasks, `date.rs` is the hand-rolled calendar, `log.rs` stars out the token in every line.
- Parity is byte-exact against two frozen fixtures: `views.json` (7599 views) and `handlers.json` (69 handler calls). They can no longer be regenerated: refreshing them means running Rust, reading the diff by eye, and committing it only when the change was the point.
- Never edit a test or a text to make a fixture pass; a deliberate behavior change updates data, texts and fixtures in one commit.
- `cargo test` green and `check.py` printing `ИТОГ: FAIL=0` are required before any commit.
- `a11-bot --selftest 2` prints a deterministic hash and peak memory, `--check-net` only calls `getMe` (no message is sent). Never run either with the production token in a report, and never run the bot itself live without a direct request.
- Deploy: a `rust/**` push makes CI build the musl binary, commit it as `rust/bin/a11-bot` and ask the panel to restart; the panel's own `deploy.yml` restart runs first, with the previous binary. Never `chmod` that file — a mode change blocks the host's `git pull`, which is how a push can silently keep old code.

## Gate
- Run `--local` before the first change and after each batch; run the full gate before a push and when the owner asks for a health check.
- If it is red before your changes, stop and report which checks fail; do not fix unrelated failures unless told to continue.
- **Green is weak:** the static rules are substring matches, and the fixtures never cover the two background sends (morning summary, renewal reminder) — they are not handler calls. Say so when they matter.
- Done means you paste the `ИТОГ: FAIL=…, WARN=…` line and mark every skipped check as unverified. Never say "works" or "tests pass" without it.
- A red check is fixed at the cause; never loosen a check to make it pass.
- For a schedule or `KIND` change, paste today's exact `day_text` output into the reply.
- A prod FAIL right after a push is a restart in progress: wait for a fresh container uptime and retry for a few minutes; restart nothing yourself.

## Gotchas
- **The 409 test needs `timeout>=5`**: with `timeout=0` or `1` Telegram answers `OK` and the check lies. The gate tests the HTTP status; `healthcheck.yml` greps the body for `"error_code":409` and must stay that strict, because a bare `409` can match an `update_id`.
- **A push only requests a restart.** `deploy.yml` is green when the panel accepts it; nothing checks which commit the container runs. Say "deployed" only after a fresh uptime and a 409; otherwise say "pushed, live version not confirmed".
- **The panel API sits behind Cloudflare:** curl works, python's urllib gets rejected. The watchdog stays quiet when `FPSMS_API_KEY`/`FPSMS_SERVER_UUID` are unset, so the renewal reminder may never arrive; if the panel check was skipped, say that.
- **The server UUID is hardcoded in both workflows**, while the watchdog reads it from the environment. If the server is recreated, update the two workflows and tell the owner where to change the value.
- **Renewal is manual** ("Add 24 hours", reCAPTCHA) and there is no grace period to rely on: stop renewing and the server is deleted. Do not remove the watchdog and do not automate the renewal.
- **`week_mark` is parity only:** an anchor moved by an even number of weeks changes no label, an odd shift flips every label. The six dates in `schedule.rs`'s test and the six in `verify_bot.py` are fixed facts from the official table — never retype them to make a check pass. If they fail after a new anchor, the anchor is wrong.
- **The over/under line is read from the source table by geometry:** in `a-1.xls` the dash row sits inside a slot and splits it in half; an entry above an empty dash exists only «над», an entry below the dash only «под». Three pairs are над-only: Monday 14:40, Thursday 09:00, Friday 14:40.
- **`SEMESTER_START`/`SEMESTER_END` cut everything:** outside them every screen says "пар нет", calendar cells are inactive, month arrows disappear, the morning summary stops. Past `SEMESTER_END` the gate still goes green, so put "the data ended on …" in the first line instead of reporting done.
- **`.ics` is RFC 5545 on purpose:** floating local time, UTC `DTSTAMP`, escaping, folding at 75 octets, CRLF. It was once dead in production while the checks were green, so do not simplify it.
- **The log scrubs `BOT_TOKEN`** because HTTP error text carries the request URL and the console is visible in the panel. `run.py` builds a token URL too and does not scrub it.

## Semester change (rare, follow the order)
1. bteu.by -> «Студенту» -> «Расписание занятий» -> «Формирование учебных недель»: the official over/under-the-line table. The site publishes it late; do not change data before it appears.
2. Set `ANCHOR_MONDAY` (a Monday from that table; now 21.09.2026 = «под»), `SEMESTER_START`, `SEMESTER_END` in `rust/src/schedule.rs`. Leave the dated checks alone: if they now fail, the anchor is wrong.
3. Rewrite `SCHEDULE` from the group's `.xls` on the faculty's «Стабильное расписание» page; week variants are `Over`/`Under`/`Both`, the record format and the dash rule are in the module comment.
4. Update `KIND` for new subjects: the site publishes no types, and the provenance of the current values is next to the table.
5. Run the gate, refresh the fixtures by running Rust and reading the diff, then update `SPEC.md` in the same commit.

## Code style
- One change at a time; no unrelated refactors in the same commit.
- Russian comments, docstrings and bot strings; a comment explains why, never what the code does.
- Render in functions that build text without sending it and without touching the network, so the gate can check every view.
- Copy data strings verbatim: rooms «3-27,3-30», teachers with their position «доц. Кузьменкова И.А.». Check surnames against the department site; the source `.xls` is not in this repo.
- Targeted edits on existing files: no reformatting of untouched code, no commented-out code.
- Banned: emojis, filler («Важно», «Здесь мы»), restating the code.

## Final report
- Five labelled lines, never dropped: what changed and why; files; the gate's `ИТОГ` line; what was not verified; what the owner must check by hand.
- Say plainly if the commit is not pushed.
- No code, diffs or tracebacks.

## This file
- Keep it under ~110 lines: add a rule after the same mistake repeats, fix a wrong claim right away, delete rules that no longer change behavior, re-check every command you edit.
