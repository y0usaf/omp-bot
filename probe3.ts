import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { EvalExecutionComponent } from "@oh-my-pi/pi-tui/chat/eval-execution";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { col } from "@oh-my-pi/pi-tui/native/describe";
import { appendFileSync } from "node:fs";

function log(line: string) {
	try {
		appendFileSync("/tmp/probe2.log", `${line}\n`);
	} catch {}
}

log("loaded");

const CLASSES = { BashExecutionComponent, EvalExecutionComponent, ReadToolGroupComponent, ToolExecutionComponent };

for (const [name, cls] of Object.entries(CLASSES)) {
	cls.prototype.describe = function () {
		log(`describe:${name}`);
		return col([]);
	};
}

export default function () {}
