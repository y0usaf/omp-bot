import { homedir } from "node:os";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const ROSTER = join(ROOT, "bots.json");
export const STATE = process.env.OMP_BOT_STATE || join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "omp-bot");
export const SOCKET = process.env.OMP_BOT_SOCKET || join(STATE, "botd.sock");
