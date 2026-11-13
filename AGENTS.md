# AGENTS.md: instructions for sessions on the А-11 schedule bot repo

## What this repo is
- A personal Telegram schedule bot for group А-11 of БТЭУ (Gomel). One user, the owner; everyone else gets silence. Bot text is Russian and restrained.
- Production is the Cloudflare Worker `a11-bot` (webhook, cron 04:30/04:50 UTC, KV dedup): deployed by hand with `npx wrangler deploy` from `workers/`. It answers at https://a11-bot.egor-kuzko-04.workers.dev.
- `workers/` is the whole live bot in plain TypeScript, no runtime dependencies; tests run on `node --test` with Node's type stripping (no enums, no parameter properties in `workers/src`).
- `rust/` is the frozen fallback: the same bot byte-exact (dual parity). CI still builds `rust/bin/a11-bot` on `rust/**` pushes and publishes it in the `rust-latest` release; nothing restarts anything anywhere.
- The old fps.ms container is suspended (manual renewal expired after the switch). `run.py` (protected) and the panel scripts exist only for a rollback; renewal is manual in the panel and the server is deleted if it lapses.
- Both implementations share frozen fixtures: `rust/tests/fixtures/views.json` (7600 views) and `handlers.json` (70 handler calls) — the port may not diverge from Rust.
- `rust/src/schedule.rs` + `workers/src/schedule.ts` are the sources of schedule facts (`SCHEDULE`, `SUBSTITUTIONS`, `KIND`, `BELLS`, `SEMESTER_START`/`END`, `ANCHOR_MONDAY`, `week_mark`; the record format and the source of every claim are in the module comment). A dated `Sub` overrides the slot with that number on that day; a `Sub` with empty times cancels it and the day view marks it «N-я пара отменена».
- `SPEC.md` is the behavior contract. It wins on behavior, this file wins on process; the owner's task overrides both, except Approvals, Secrets and Hard constraints.
- No database, no web server beyond the worker: state is KV only (morning-summary dedup).
- `.agents/skills/verify-bot/` holds the checks. A skill grants no permissions: Approvals apply anyway.
- A scheduled Qoder task (`Проверка замен в расписании А-11`, daily 08:30) runs `check_site.py`, and when the site published a substitution it writes it into the data, re-shots the views, runs the gate and commits locally. It never pushes.

## Owner and communication
- The owner does not write code: no code, diffs or tracebacks in replies; describe the effect in plain Russian.
- Short and concrete: what changed, why, result. No emojis, no heavy markdown. Go deeper only when asked; explain a term in a phrase.
- Start every conversational reply with "SilverElixir," (a canary: when it disappears, the owner restarts the session). Never put it in code, project files, commit messages or reports; the chat final report still starts with it.
- If two readings would change bot text, data or files, ask one short question. Otherwise take the simpler option and state the assumption in the report.

## Approvals
- Requested fixes that change no bot text, format or reply logic: do them right away.
- A change of text, format, buttons or reply logic, a new dependency, restructuring, or a protected file: short plan first, wait for approval.
- Protected files: `.github/workflows/*`, `run.py`.
- Live actions need a direct request in this task: `git push`, `npx wrangler deploy` / secret changes, panel power scripts, anything that sends with the production token.
- Commit to `main` yourself after a green gate, in small steps, one Russian line saying what and why, like the recent `git log`. Never force-push or rewrite history. Push only when the request says so; an earlier permission does not carry over.

## Secrets
- Never read, print or copy `.env` or any value from it (`BOT_TOKEN`, `MY_TELEGRAM_ID`, `FPSMS_API_KEY`, `FPSMS_SERVER_UUID`): some free model tiers are trained on prompts. Never edit `.env`; tell the owner what to put there.
- Worker secrets live in Cloudflare (`BOT_TOKEN`, `MY_TELEGRAM_ID`, `WEBHOOK_SECRET`) and are set only by `workers/tools/set_secrets.mjs`, which never echoes values; the webhook secret it generates must immediately go into `set_webhook.mjs`, or Telegram deliveries start failing 401 while healthcheck stays green.
- Never put a token in a URL that lands in a report, commit, log or issue. For prod checks use the gate, which reads `.env` itself.
- On a leak, tell the owner to rotate in BotFather, then `set_secrets.mjs` + `set_webhook.mjs` with the new values, then the GitHub secrets.
- `.env` and `__pycache__` never enter the repo; check `git status` before every commit.

## Hard constraints
- **Webhook only, secret fail-closed.** The worker rejects every POST without a valid `X-Telegram-Bot-Api-Secret-Token` (constant-time, SHA-256); a missing secret env means 401 on everything. The Rust fallback polls and calls `deleteWebhook` on start — never start that container while prod lives on Workers.
- **Worker stays dependency-free plain TS** that Node strips and Workers runs: no npm runtime packages, no enums/parameter properties. New deps need a real reason plus the dual-parity story.
- **Time:** fixed UTC+3 as `TZ_OFFSET_SECS`, no chrono, pytz or zoneinfo in either implementation. Read the clock only through `nowLocal()`/`Now::local()`; a local day taken from a raw UTC timestamp is a bug.
- **No emojis in bot strings** (messages, buttons, calendar, `.ics` names). Formatting is Telegram HTML (`<b>`, `<i>`, `<code>`, `<blockquote>`), `parse_mode="HTML"`; every dynamic value goes through `esc`.
- **The reply keyboard rides on every message** that does not already carry an inline keyboard: Desktop hides the keyboard when the newest bot message has none, the phone keeps it (SPEC п.7).
- **The bot answers only the owner.** Never weaken the `owner_id` guards, the `chatId !== ownerId` belt, or the webhook secret check; never add public commands beyond /start and /help.

## Commands
Run from the repo root.
```powershell
cd workers; npx wrangler deploy                  # deploy the worker (live action, needs a request)
node workers/tools/set_secrets.mjs               # three worker secrets from .env, never printed
node workers/tools/bot_profile.mjs               # avatar, description, commands, menu button
python -X utf8 rust/tools/check_site.py          # сверка с bteu.by: замены, недели, таблица
python -X utf8 .agents/skills/verify-bot/scripts/verify_bot.py --local   # gate, offline
python -X utf8 .agents/skills/verify-bot/scripts/verify_bot.py           # gate + prod checks
cd workers; npm test; npm run typecheck          # node --test (7600/70 parity inside) + tsc
cd rust; cargo test                              # the Rust fallback tests
gh run list --limit 3                            # CI status
git push origin main                             # only when the owner asked in this task
```
- The shell is PowerShell: no `grep`, no `tail`, no `*.py` glob expansion for commands. Search with the read/glob/grep tools, or `Select-String`/`Get-Content` in the shell.
- The gate prints `ЛОКАЛЬНО` and `ПРОД` sections of `[OK]/[WARN]/[FAIL]` and exits 1 on any FAIL; the prod part needs `.env`.
- The test path is the pure render functions and a recording stub of the API, never a live send into the owner's chat.
- Library and framework docs (Rust crates, anything else this repo starts using) come from the context7 connector: `resolve-library-id`, then `query-docs`.

## Code layout
- `workers/src`: `index.ts` (webhook entry, fail-closed secret, cron), `bot.ts` (handlers), `render.ts`/`ics.ts` (pure), `telegram.ts` (transport), `date.ts` (hand-rolled calendar), `schedule.ts` (data), `log.ts` (token scrubbed in every line), `snapshot.ts` (view enumerator). `workers/test` mirrors the Rust unit tests plus parity/handlers/index.
- `rust/src` mirrors the same modules for the fallback; keep both implementations byte-equal — every text change lands in both, fixtures are re-shot from Rust (`a11-bot --dump-views rust/tests/fixtures/views.json`), handler snapshots are recomputed and reviewed with the full diff in front of you.
- Parity is byte-exact: `views.json` (7600 views) and `handlers.json` (70 handler calls). Never edit a test or a text to make a fixture pass; a deliberate behavior change updates data, texts and fixtures in one commit.
- `cargo test` green, `npm test` + `tsc --noEmit` clean, and the gate printing `ИТОГ: FAIL=0` are required before any commit.
- `a11-bot --selftest 2` prints a deterministic hash and peak memory (Rust fallback only). Never run the bot itself live without a direct request.
- Deploy is manual: `npx wrangler deploy` prints the URL and triggers; CI only rebuilds the Rust backup binary on `rust/**` pushes (counter-commit from the CI bot is normal — pull before the next push).

## Gate
- Run `--local` before the first change and after each batch; run the full gate before a push and when the owner asks for a health check.
- If it is red before your changes, stop and report which checks fail; do not fix unrelated failures unless told to continue.
- **Green is weak:** the static rules are substring matches, and fixtures never cover the live cron path end-to-end (KV dedup is unit-tested, the first real fire is the proof). Say so when it matters.
- Done means you paste the `ИТОГ: FAIL=…, WARN=…` line and mark every skipped check as unverified. Never say "works" or "tests pass" without it.
- A red check is fixed at the cause; never loosen a check to make it pass.
- For a schedule or `KIND` change, paste today's exact `day_text` output into the reply.
- The panel/worker prod checks go through Cloudflare: `curl` with a browser User-Agent works, python's urllib gets 403 (workers.dev included) — keep the curl form.

## Gotchas
- **The 409 test needs `timeout>=5`**: with `timeout=0` or `1` Telegram answers `OK` and the check lies. An active webhook answers getUpdates with 409 too, so the same check covers both platforms; `healthcheck.yml` greps the body for `"error_code":409` and must stay that strict, because a bare `409` can match an `update_id`.
- **Re-running `set_secrets.mjs` invalidates the webhook secret**: deliveries start failing 401 while the 409 check stays green. Always re-run `set_webhook.mjs` with the fresh secret file right after.
- **`getWebhookInfo.last_error_message` is sticky** — it survives recovery; compare `last_error_date` freshness before calling it a live failure.
- **KV is eventually consistent and cron is at-least-once**: a rare parallel double fire can send the morning summary twice; the two cron slots exist so a failed first fire retries at 07:50.
- **The panel API sits behind Cloudflare** and refuses urllib; a suspended server answers `ServerStateConflictException` on power/resources — for the panel check that is a warn, not a fail.
- **Renewal is manual** ("Add 24 hours", reCAPTCHA) and there is no grace period: the fps.ms server is suspended now and will be deleted if never renewed — say plainly that the rollback path dies with it.
- **`week_mark` is parity only:** an anchor moved by an even number of weeks changes no label, an odd shift flips every label. The six dates in `schedule.rs`'s test and the six in `verify_bot.py` are fixed facts from the official table — never retype them to make a check pass. If they fail after a new anchor, the anchor is wrong.
- **A substitution is matched by slot number, not by subject:** `Sub { num: 3 }` replaces whatever pair 3 is that day, so a wrong number silently moves the wrong class. `check_site.py --emit` prints the site row next to each candidate — the dean writes subjects in CAPS and teachers without a space («ст.пр.Игнатьев»), so fix the wording by hand before committing.
- **The over/under line is read from the source table by geometry:** in `a-1.xls` the dash row sits inside a slot and splits it in half; an entry above an empty dash exists only «над», an entry below the dash only «под». Three pairs are над-only: Monday 14:40, Thursday 09:00, Friday 14:40.
- **`SEMESTER_START`/`SEMESTER_END` cut everything:** outside them every screen says "пар нет", calendar cells are inactive, month arrows disappear, the morning summary stops. Past `SEMESTER_END` the gate still goes green, so put "the data ended on …" in the first line instead of reporting done.
- **`.ics` is RFC 5545 on purpose:** floating local time, UTC `DTSTAMP`, escaping, folding at 75 octets, CRLF. It was once dead in production while the checks were green, so do not simplify it.

## Semester change (rare, follow the order)
1. bteu.by -> «Студенту» -> «Расписание занятий» -> «Формирование учебных недель»: the official over/under-the-line table. The site publishes it late; do not change data before it appears.
2. Set `ANCHOR_MONDAY` (a Monday from that table; now 21.09.2026 = «под»), `SEMESTER_START`, `SEMESTER_END` in `rust/src/schedule.rs` AND mirror them in `workers/src/schedule.ts`. Leave the dated checks alone: if they now fail, the anchor is wrong.
3. Rewrite `SCHEDULE` from the group's `.xls` on the faculty's «Стабильное расписание» page in both implementations; week variants are `Over`/`Under`/`Both`, the record format and the dash rule are in the module comment.
4. Update `KIND` for new subjects: the site publishes no types, and the provenance of the current values is next to the table.
5. Run `rust/tools/check_site.py`, run the gate, refresh the fixtures with `--dump-views`, then update `SPEC.md` in the same commit.

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
