# omp-bot

omp-bot opens named omp sessions ("bots") in your Tern tabs, each drawn as a Chao avatar with its own persona, folder, model and OptChat memory.

A bot is an ordinary omp session with a few extensions from this repo loaded. It runs while its tab is open, keeps one conversation for good, and reads its memory as a summary tree rather than the whole transcript.

![A bot chat in Tern under the Grok look](docs/chat.png)
*Lloyd's chat in Tern under the Grok look, with the bot roster on the left and Ekko's system rail on the right.*

![Picking the Grok look](docs/looks.png)
*Ctrl+Alt+, opens the Settings menu; Look › Grok restyles the chat. Both show demo bots and conversations.*

## Run

| Command | Does |
| --- | --- |
| `bin/omp-bot NAME [--create TINT] [omp args...]` | Open a bot in any terminal. `--create TINT` adds it to the roster first. |
| `bin/omp-bot-remove NAME [--purge]` | Take a bot off the roster and archive its conversation; `--purge` also deletes its persisted folders. |
| `bin/omp-bot-ctl restart BOT` | Restart a bot once its turn ends; its tab reopens the same conversation. |
| `bin/omp-bot-avatar NAME JSON` / `--name` | Write or clear a bot's `avatar` parts. |
| `bin/omp-bot-memory NAME` | Run that bot's OptChat summariser. |
| `bin/omp-bot-demo [--headless\\|--stop]` | Open a separate Tern window with only the bots. |
| `bin/omp-bot-health` | Report whether a boxed bot's box answers over ssh. |
| `bin/omp-bot-box` | Run a boxed bot's omp inside omp-box; `bin/omp-bot` calls it. |

In Tern, the `tern/` plugin adds **Bots: Open all**, **Bots: Open bot**, **Bots: Remove bot** and **Bots: Change avatar** to the palette, plus each bot's avatar in its tab, header, messages and Tern's own notification card under every look (`tern/avatars.css`), and the base style of the chat's own cards and working row (`tern/chat.css`).

To try prompts safely, set `OMP_BOT_NO_TOOLS=1` and a throwaway `OMP_BOT_STATE`. A separate state folder isolates memory, not access to the machine.

## Dependencies

omp, jq and flock on `PATH`, and Tern for tabs. A boxed bot also needs bash, ssh, tar and finix's `omp-box`. Bot memory needs OptChat (from finix's `modules/dev/ai/omp/optchat`).

## Roster

`bots.json` in the state folder, copied from this repo's `bots.json` on first run. One object per bot:

| Field | Meaning |
| --- | --- |
| `name` | Letters, digits, space, `.`, `_`, `-`; up to 40 characters. |
| `tint` | red, orange, yellow, green, teal, blue, purple or pink. |
| `cwd` | Where the bot starts. `/move DIR` in the bot updates it. |
| `persona` | Extra instructions: the bot's voice and lane. |
| `model` | Model for this bot (else `OMP_BOT_MODEL`, else omp's default). |
| `extensions` | `true` loads the extensions your omp config lists. |
| `memory` | `optchat` (default) or `none` for omp's own compaction. |
| `persist` | Folders under `~` that must survive a reboot. |
| `box` | `true` runs the bot's omp inside omp-box. |
| `work` | `true` gives the bot an open-work list, `bots/NAME/work.txt`: one `todo` or `wait` line per unfinished ask. When a turn ends with `todo` lines left, the bot is sent them and keeps going, until the list has none, a nudged turn makes no tool call, or `OMP_BOT_WORK_NUDGES` (6) nudges in a row. |
| `avatar` | Parts overriding the ones the name picks: `{"body": "ghost", "color": "#ff8800", "eyes": "happy", "accessory": "halo", "motion": "hop"}`. |
| | Part names are in `tern/avatars.json`; `body` may also name a drawn sprite in `tern/avatars/` (`lloyd`, `sol`, ...). **Bots: Change avatar** in Tern's palette writes this field, a pick part at a time, with the bot redrawn straight away; its **From name** row deletes it. |

A bot's own `bots/NAME/config.yml`, if present, is layered over `omp/demo.yml`. `bots/NAME/rules.md` holds standing rules given to the bot word for word; its `pin_rule` tool appends to it. `tools/NAME/bin/` goes on that bot's `PATH` only.

## Environment

`~/.config/omp-bot/env` is sourced before a bot starts, and `~/.config/omp-bot/box.env` after it for a boxed bot. finix writes both.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMP_BOT_STATE` | `$XDG_STATE_HOME/omp-bot` | State folder. |
| `OMP_BIN` | `omp` | omp to run. |
| `OMP_BOT_MODEL` | omp's default | Model for bots without `model`. |
| `OMP_BOT_OPTCHAT` | (required for memory) | OptChat directory. |
| `OMP_BOT_PERSIST` | none | Hook run as `HOOK mount PATH` / `HOOK purge PATH` for `persist` folders. |
| `OMP_BOT_EXTENSION`, `OMP_BOT_CWD_EXTENSION`, `OMP_BOT_SECRETS_EXTENSION`, `OMP_BOT_WORK_FOLD_EXTENSION`, `OMP_BOT_CHAT_LOOK_EXTENSION` | none | Extra omp extensions every bot loads. |
| `OMP_BOT_NO_TOOLS` | unset | `1` starts bots with `--no-tools`. |
| `OMP_BOT_NAP_MS` | 45000 | Idle time before the Chao curls up for a nap. |

Boxed bots also read `OMP_BOT_BOX_SSH_CONFIG`, `OMP_BOT_BOX_STATUS`, `OMP_BOT_BOX_EXT` and `OMP_BOT_BOX_PATH` from `box.env`; see `bin/omp-bot-box`.

## How it works

- **One process per bot.** `bots/NAME/lock` keeps a bot from running twice. A bot runs while its tab is open and stops when the tab closes.
- **One conversation.** Each start resumes the bot's latest session. The bot exits with code 76 to restart; finix's Agent Tabs plugin reopens it in the same tab.
- **Memory.** The model never gets the whole transcript. It gets the pinned rules, an OptChat summary tree of the conversation, and the latest turns raw. `zoom`, `date` and `recent` read any part back, also for another bot's memory, read-only.
- **Avatar.** `omp/omp-bot.ts` redraws the transcript and composer around a Chao: replies and prompts get its tint, the working row shows what the turn is doing, and `omp/chao.ts` draws the face. `/bot` toggles it, `/bot name NAME` renames it.
- **Tabs.** The Tern plugin registers each bot as an agent tab, colours its tab by tint, and draws avatars from `tern/avatars.json` and the PNG sprites.

## Persistence

On a machine whose home resets at boot, `OMP_BOT_PERSIST` keeps a bot's `persist` folders. Stopping, crashing or removing a bot never deletes them; removal only stops mounting them from the next boot. Only `omp-bot-remove NAME --purge` deletes them, skipping any folder another bot still lists.

## Boxed bots

`"box": true` runs the bot's omp inside omp-box, finix's microVM, over ssh. Its tab and memory stay on the host. `bin/omp-bot-box` shares the bot's folder and `persist` folders into the box at the same paths. Secrets stay in `bots/NAME/secrets`, encrypted, and are decrypted only inside the box.

If the box goes away, the tab waits for it and resumes. Five quick cut-offs in a row close the tab instead.

## State

Everything lives in `$OMP_BOT_STATE`:

| Path | Holds |
| --- | --- |
| `bots.json` | Roster. |
| `bots/NAME/` | `sessions/`, `optchat/`, `rules.md`, `config.yml`, `secrets/` (boxed). |
| `archive/NAME-DATE/` | Removed bots' conversations and roster entries. |
