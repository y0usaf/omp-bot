import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const STATE = process.env.OMP_BOT_STATE || join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "omp-bot");
export const SOCKET = process.env.OMP_BOT_SOCKET || join(STATE, "botd.sock");
export const ROSTER = join(STATE, "bots.json");

mkdirSync(STATE, { recursive: true });
if (!existsSync(ROSTER)) copyFileSync(join(ROOT, "bots.json"), ROSTER);
