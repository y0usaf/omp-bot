omp-bot turns an omp session in Tern into a named, animated bot you chat with, pet and run alongside other bots.

## Run

Needs Tern, omp and jq on `PATH` (`OMP_BIN` picks another omp, `OMP_BOT_MODEL` another model; default `smol`).

- `bin/omp-bot-demo` opens a Tern window with one tab per bot in `bots.json`, named and coloured, with a flat chat and a roster rail. It runs apart from your own Tern: config, daemon, temp and state live under `${XDG_STATE_HOME:-~/.local/state}/omp-bot-demo`, sharing only your Tern sign-in. `--headless` starts `tern serve` instead and prints its control socket for `tern ctl --control SOCKET shot NAME`; `--stop` ends either.
- `bin/omp-bot NAME [omp args...]` runs the bot `NAME` from `bots.json` in any terminal.
- In Tern, the palette's **Bots: Open all** opens every bot not yet open; **Bots: New bot** opens one, or names a new one and adds it to `bots.json`.

Add a bot by adding a line to `bots.json`: `name`, a one-line `role`, a `tint` (red, orange, yellow, green, teal, blue, purple or pink), the `cwd` it starts in, and optionally a `persona` with extra instructions.

Initially drafted by Claude AI.
