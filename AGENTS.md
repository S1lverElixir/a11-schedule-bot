# AGENTS.md: instructions for sessions on the А-11 schedule bot repo

## What this repo is
- A personal Telegram schedule bot for group А-11 of БТЭУ (Gomel). One user, the owner; everyone else gets silence. Bot text is Russian and restrained.
- It runs 24/7 in a free fps.ms container with a hard 128 MB RAM limit and is renewed by hand every day.
- `bot.py` is the whole bot: aiohttp transport with long polling, render functions that never touch the network, handlers, two background tasks (`renewal_watchdog`, `morning_summary`), the poll loop.
- `rust/` is the same bot rewritten in Rust (same texts byte for byte, 5–8 MB instead of 40). `bot.py` stays the running bot and the reference until the host is switched; the switch is an owner decision, not a refactor.
- `schedule_data.py` is the only source of schedule facts (`SCHEDULE`, `KIND`, `BELLS`, `SEMESTER_START`/`END`, `ANCHOR_MONDAY`, `week_mark`; the record format is in its docstring). `bot.py` only renders and serves it.
- `SPEC.md` is the behavior contract. It wins on behavior, this file wins on process; the owner's task overrides both, except Approvals, Secrets and Hard constraints.
- `run.py` (protected) bootstraps the host: on a container without `.git` it does init + fetch + reset, installs from `wheels/` offline when the packages are missing, then execs `bot.py`. The `git pull` on normal starts is the host's.
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
- Protected files: `.github/workflows/*`, `run.py`, `wheels/*`.
- Live actions need a direct request in this task: `git push`, anything that restarts or stops the container, running `bot.py` with the production token.
- Commit to `main` yourself after a green gate, in small steps, one Russian line saying what and why, like the recent `git log`. Never force-push or rewrite history. Push only when the request says so; an earlier permission does not carry over.

## Secrets
- Never read, print or copy `.env` or any value from it (`BOT_TOKEN`, `MY_TELEGRAM_ID`, `FPSMS_API_KEY`, `FPSMS_SERVER_UUID`): some free model tiers are trained on prompts. Never edit `.env`; tell the owner what to put there.
- Never put a token in a URL that lands in a report, commit, log or issue. For prod checks use the gate, which reads `.env` itself.
- On a leak, tell the owner to rotate in BotFather, then in the host's environment, then in the GitHub secrets.
- `.env` and `__pycache__` never enter the repo; check `git status` before every commit.

## Hard constraints
- **aiohttp only.** No aiogram or any other framework: an aiogram 3 import with pydantic does not fit the 128 MB limit and the bot never starts. Transport is the hand-rolled `Telegram` class.
- **A new dependency needs four things:** a real reason, a wheel that installs on the host's cp311 Linux (cp311 manylinux for compiled code, `py3-none-any` for pure Python), its module added to the `import` guard in `run.py` (otherwise the host never installs it), and a memory measurement before and after.
- **Polling only, no webhooks**; `deleteWebhook` at startup only clears leftovers.
- **Time:** fixed UTC+3, `timezone(timedelta(hours=3))`, no pytz or zoneinfo. Read the clock only as `datetime.now(TZ)`; `date.today()` and naive `datetime.now()` are bugs.
- **No emojis in bot strings** (messages, buttons, calendar, `.ics` names). Formatting is Telegram HTML (`<b>`, `<i>`, `<code>`, `<blockquote>`), `parse_mode="HTML"`; every dynamic value goes through `html.escape`.
- **The bot answers only the owner.** Never weaken the `OWNER_ID` guards in `on_message` and `on_callback`, never add public commands.

## Commands
Run from the repo root.
```powershell
pip install -r requirements.txt        # once per machine
python -X utf8 bot.py                  # local run; never with the production token
python -X utf8 .agents/skills/verify-bot/scripts/verify_bot.py --local   # gate, offline
python -X utf8 .agents/skills/verify-bot/scripts/verify_bot.py           # gate plus prod checks
python -X utf8 rust/tools/check.py                                       # Rust gate: build, parity, memory
cd rust; cargo test                                                      # the same without the Python wrapper
gh run list --workflow=deploy.yml --limit 1                              # last deploy
git push origin main                   # only when the owner asked in this task
```
- The shell is PowerShell: no `grep`, no `tail`, no `*.py` glob expansion for commands. Search with the read/glob/grep tools, or `Select-String`/`Get-Content` in the shell.
- The gate prints `ЛОКАЛЬНО` and `ПРОД` sections of `[OK]/[WARN]/[FAIL]` and exits 1 on any FAIL.
- The test path is the render functions, never a live send into the owner's chat.

## Rust port (`rust/`)
- `rust/` mirrors `bot.py` feature for feature: `render.rs`/`ics.rs` are pure and never touch the network, `telegram.rs` is the transport (blocking ureq + rustls, no async runtime), `bot.rs` holds handlers and both background tasks.
- Parity is byte-exact against two fixtures: `views.json` (7599 frozen views) and `handlers.json` (69 frozen handler calls, checked through a recording stub of the API). If a fixture and the Python bot disagree, regenerate the fixture (`gen_views.py` / `gen_handlers.py`) — never edit the test or the texts to match.
- Data lives in `rust/src/schedule.rs`; a semester change touches it as well, and the fixture is regenerated in the same commit.
- `cargo test` green and `check.py` printing `ИТОГ: FAIL=0` are required before a Rust commit; the Python gate says nothing about Rust.
- `a11-bot --selftest 2` prints a deterministic hash and peak memory, `--check-net` only calls `getMe` (no message is sent). Never run either with the production token in a report, and never run the bot itself live without a direct request.

## Gate
- Run `--local` before the first change and after each batch; run the full gate before a push and when the owner asks for a health check.
- If it is red before your changes, stop and report which checks fail; do not fix unrelated failures unless told to continue.
- **Green is weak:** the static rules are substring matches, the reply keyboards and handlers are never called, and a crashed `import bot` is only a WARN. Green proves the rendered views and the data, not that the bot answers.
- Done means you paste the `ИТОГ: FAIL=…, WARN=…` line and mark every skipped check as unverified. Never say "works" or "tests pass" without it.
- A red check is fixed at the cause; never loosen a check to make it pass.
- For a schedule or `KIND` change, paste today's exact `day_text` output into the reply.
- A prod FAIL right after a push is a restart in progress: wait for a fresh container uptime and retry for a few minutes; restart nothing yourself.

## Gotchas
- **The 409 test needs `timeout>=5`**: with `timeout=0` or `1` Telegram answers `OK` and the check lies. The gate tests the HTTP status; `healthcheck.yml` greps the body for `"error_code":409` and must stay that strict, because a bare `409` can match an `update_id`.
- **A push only requests a restart.** `deploy.yml` is green when the panel accepts it; nothing checks which commit the container runs. Say "deployed" only after a fresh uptime and a 409; otherwise say "pushed, live version not confirmed".
- **The panel API sits behind Cloudflare:** curl works, python's urllib gets rejected. `bot.py`'s watchdog exits silently when `FPSMS_API_KEY`/`FPSMS_SERVER_UUID` are unset, so the renewal reminder may never arrive; if the panel check was skipped, say that.
- **The server UUID is hardcoded in both workflows**, while the watchdog reads it from the environment. If the server is recreated, update the two workflows and tell the owner where to change the value.
- **Renewal is manual** ("Add 24 hours", reCAPTCHA) and there is no grace period to rely on: stop renewing and the server is deleted. Do not remove the watchdog and do not automate the renewal.
- **`week_mark` is parity only:** an anchor moved by an even number of weeks changes no label, an odd shift flips every label. The two dates in the `bot.py` assert and the six in `verify_bot.py` are fixed facts from the official table — never retype them to make a check pass. If they fail after a new anchor, the anchor is wrong.
- **`SEMESTER_START`/`SEMESTER_END` cut everything:** outside them every screen says "пар нет", calendar cells are inactive, month arrows disappear, the morning summary stops. Past `SEMESTER_END` the gate still goes green, so put "the data ended on …" in the first line instead of reporting done.
- **`.ics` is RFC 5545 on purpose:** floating local time, UTC `DTSTAMP`, escaping, folding at 75 octets, CRLF. It was once dead in production while the checks were green, so do not simplify it.
- **`_ScrubFormatter` hides `BOT_TOKEN` in logs** because aiohttp exception text carries the request URL and the console is visible in the panel. `run.py` builds a token URL too and does not scrub it.
- **The host runs Python 3.11** (wheels are cp311) while this machine has 3.13: 3.12+ syntax passes the local gate and kills prod at import.

## Semester change (rare, follow the order)
1. bteu.by -> «Студенту» -> «Расписание занятий» -> «Формирование учебных недель»: the official over/under-the-line table. The site publishes it late; do not change data before it appears.
2. Set `ANCHOR_MONDAY` (a Monday from that table; now 21.09.2026 = «под»), `SEMESTER_START`, `SEMESTER_END`. Leave the dated checks alone: if they now fail, the anchor is wrong.
3. Rewrite `SCHEDULE` from the group's `.xls` on the faculty's «Стабильное расписание» page; week variants are «над»/«под»/«both», the record format is in the docstring.
4. Update `KIND` for new subjects: the site publishes no types, and the provenance of the current values is in the `KIND` comment.
5. Run the gate, then update `SPEC.md` in the same commit.

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
