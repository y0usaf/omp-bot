--!strict
-- Turns `omp-bot-ctl board` JSON into board items: the decisions waiting on you, the work in progress and
-- the newest finished tasks, straight from omp-botd's queue.
local M = {}

export type Item = {
	id: string,
	bot: string,
	-- waiting: a decision, the only kind the board asks you for; at work: queued, running, jobs (waiting on
	-- its own jobs); finished: done, failed
	state: string,
	attempt: number,
	-- seconds: when the task last changed
	at: number,
	title: string,
	-- the text after its first sentence, which is the title
	rest: string,
	project: string,
	-- "cu" (CU-Bot, y0usaf's job) or "exp": its colour, and CU work starts above experiments
	lane: string,
	-- a finished task you answered: approve, deny or handle
	answer: string?,
	note: string?,
	-- net places bumped up (positive) or down
	bumped: number?,
	-- a bot's subagent: its own name, its dotted path under the bot (one dot per level) and when it started
	sub: { name: string, path: string, depth: number, started: number }?,
}

export type Board = { decisions: { Item }, working: { Item }, subagents: { Item }, finished: { Item } }

local PROJECTS = {
	{ "Kaizen", "Kaizen" },
	{ "STS2", "STS2 solver" },
	{ "Strictix", "Strictix" },
	{ "Mana", "Mana" },
	{ "Crest", "Crest" },
	{ "finix", "finix" },
	{ "omp%-bot", "omp-bot" },
	{ "LPS", "LPS" },
	{ "Domo", "Domo" },
	{ "Slack", "Slack" },
	{ "[Cc]heck%-in", "Check-in" },
}

local function clean(s: string): string
	s = s:gsub("{{(.-)|.-}}", "%1")
	s = s:gsub("%*%*", ""):gsub("`", "")
	s = s:gsub("%s+", " ")
	return (s:match("^%s*(.-)%s*$") :: string)
end

-- The first sentence, cut at a word to fit one line.
function M.title(body: string): string
	local text = clean(body)
	local first = text:match("^(.-[%.!?])%s") or text
	first = first:gsub("[%.]$", "")
	if #first > 92 then
		first = (first:sub(1, 90):match("^(.*)%s") or first:sub(1, 90)) .. "…"
	end
	if first == "" then
		return "(no text)"
	end
	return first:sub(1, 1):upper() .. first:sub(2)
end

-- What the body says after the sentence the title shows; all of it when the title had to be cut.
function M.rest(body: string): string
	local title = M.title(body)
	if title:sub(-3) == "…" then
		return body
	end
	local stop = body:find("[%.!?]%s")
	return if stop then (body:sub(stop + 1):match("^%s*(.-)%s*$") :: string) else ""
end

function M.project(bot: string, text: string): string
	for _, p in PROJECTS do
		if text:find(p[1]) then
			return p[2]
		end
	end
	return if bot == "CU-Bot" then "CU" else "General"
end

local function str(v: any): string
	return if type(v) == "string" then v else ""
end

-- A decision reads as its question, then where the bot left things; a finished task as its result or
-- error; work in progress as its brief.
local function item(t: any): Item
	local state = str(t.state)
	local body
	if state == "waiting" and t.wait == "decision" then
		local result = str(t.result):match("^%s*(.-)%s*$") :: string
		body = str(t.question) .. (if result ~= "" then "\n\n" .. result else "")
	elseif state == "waiting" then
		state = "jobs"
		body = str(t.text)
	elseif state == "done" then
		body = str(t.result)
	elseif state == "failed" then
		body = str(t.error)
	else
		body = str(t.text)
	end
	local bot = str(t.bot)
	local answer = if type(t.answer) == "table" then t.answer else nil
	return {
		id = str(t.id),
		bot = bot,
		state = state,
		attempt = tonumber(t.attempts) or 1,
		at = math.floor((tonumber(t.updated) or 0) / 1000),
		title = M.title(body),
		rest = M.rest(body),
		project = M.project(bot, body .. " " .. str(t.text)),
		lane = if bot == "CU-Bot" then "cu" else "exp",
		answer = if answer and type(answer.action) == "string" then answer.action else nil,
		note = if answer and type(answer.note) == "string" then answer.note else nil,
	}
end

-- A subagent reads as its goal: what the bot gave it to do. Running ones are at work; ended ones are
-- finished: done, failed or stopped.
local function subagent(t: any): Item
	local path = str(t.id)
	local bot = str(t.bot)
	local goal = str(t.description)
	local started = math.floor((tonumber(t.started) or 0) / 1000)
	local _, dots = path:gsub("%.", "")
	return {
		id = "sub:" .. bot .. ":" .. path .. ":" .. tostring(started),
		bot = bot,
		state = if t.status == "running" then "sub" else str(t.status),
		attempt = 1,
		at = if t.ended then math.floor((tonumber(t.ended) or 0) / 1000) else started,
		title = if goal ~= "" then M.title(goal) else "(no goal given)",
		rest = "",
		project = M.project(bot, goal),
		lane = if bot == "CU-Bot" then "cu" else "exp",
		sub = { name = path:match("([^%.]+)$") or path, path = path, depth = dots + 1, started = started },
	}
end

function M.parse(json: string): Board
	local data = tern.json.decode(json) :: any
	local out: Board = { decisions = {}, working = {}, subagents = {}, finished = {} }
	local function list(v: any): { any }
		return if type(v) == "table" then v else {}
	end
	if type(data) ~= "table" then
		return out
	end
	for _, key in { "decisions", "working", "finished" } do
		for _, t in list(data[key]) do
			table.insert((out :: any)[key], item(t))
		end
	end
	local subs = if type(data.subagents) == "table" then data.subagents else {}
	for _, t in list(subs.running) do
		table.insert(out.subagents, subagent(t))
	end
	for _, t in list(subs.finished) do
		table.insert(out.finished, subagent(t))
	end
	table.sort(out.finished, function(a: Item, b: Item)
		return a.at > b.at
	end)
	return out
end

return M
