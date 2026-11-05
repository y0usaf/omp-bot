--!strict
-- The task board: one ordered list of the decisions omp-botd's queue waits on you for, most important first
-- (CU work above experiments until you bump it). Approve, Deny and Handle answer a task with `omp-bot-ctl
-- approve|deny|handle`, the same `answer` the bots' Tern cards send. Finished tasks file into a quiet
-- history, work in progress is a count, and an ask nobody touched for three days slides onto the Later
-- shelf. The board reads the queue again every few seconds, so a decision answered elsewhere leaves it.
local chao = require("./chao")
local tasks = require("./tasks")
local ui = tern.ui

local ROOT = tern.getenv("OMP_BOT_ROOT") or (tern.plugin.dir .. "/..")
local STATE_DIR = tern.getenv("OMP_BOT_STATE") or ((tern.getenv("XDG_STATE_HOME") or ((tern.getenv("HOME") or "") .. "/.local/state")) .. "/omp-bot")
local CTL = tern.getenv("OMP_BOT_CTL") or (ROOT .. "/bin/omp-bot-ctl")
local TICK = 100
local POLL_MS = 3000
local FX_MS = 1500
local FLY_MS = 520
local REACT_MS = 900
local NOPE_MS = 420
local STREAK_GAP = 20000
local TOP = 3
local LATER_S = 3 * 86400
local HISTORY = 8

type Item = tasks.Item
type Fx = { act: string, id: string, bot: string, verb: string, meta: string, t0: number, n: number }
type Ghost = { act: string, t0: number, it: Item }
type State = {
	cx: BlockCx,
	items: { Item },
	by_id: { [string]: Item },
	-- the decisions, in board order; ids flying off stay until their ghost lands
	order: { string },
	bumped: { [string]: number },
	-- when you last bumped a decision: it keeps an ask off the Later shelf
	touched: { [string]: number },
	-- decisions answered here whose answer omp-botd hasn't confirmed yet
	pending: { [string]: boolean },
	more: boolean,
	history: boolean,
	shelf: boolean,
	sel: string?,
	mode: string,
	typed: string,
	loaded: boolean,
	loading: boolean,
	again: boolean,
	sig: string?,
	error: string?,
	fx: Fx?,
	ghosts: { [string]: Ghost },
	reacts: { [string]: { act: string, t0: number } },
	nope: { id: string, t0: number }?,
	streak: number,
	best: number,
	last_at: number,
	settled: number,
	day: string,
	today: number,
	zero: { t0: number }?,
	started: number,
	blobs: { [string]: string },
	bots: { [string]: { tint: string?, chao: any } },
	tick: TimerHandle?,
	poll: TimerHandle?,
	-- whether a render was asked for, and a view drawn, since the last read: see poll
	asked: boolean,
	viewed: boolean,
	closed: boolean,
	nfx: number,
}

local FINISHED = { done = true, failed = true }
local WORKING = { running = true, queued = true, jobs = true }
local STATE_LABEL = {
	waiting = "waiting on you",
	running = "running",
	queued = "queued",
	jobs = "on its jobs",
	done = "done",
	failed = "failed",
	approve = "approved",
	deny = "denied",
	handle = "handled",
}
local VERB = { approve = "Approved", deny = "Denied" }
local ACTS = { approve = true, deny = true, handle = true }

local function roster(): { [string]: { tint: string?, chao: any } }
	local bots = {}
	for _, path in { ROOT .. "/bots.json", STATE_DIR .. "/bots.json" } do
		local ok, list = pcall(function()
			return tern.json.decode(tern.fs.read(path))
		end)
		if ok and type(list) == "table" then
			for _, b in list :: any do
				if type(b) == "table" and b.name then
					bots[b.name] = { tint = b.tint, chao = b.chao }
				end
			end
		end
	end
	return bots
end

local function needs(state: State, it: Item): boolean
	return it.state == "waiting" and not state.pending[it.id]
end

local function age(at: number): string
	local s = math.max(0, os.time() - at)
	if s < 60 then
		return "now"
	elseif s < 3600 then
		return string.format("%dm", s // 60)
	elseif s < 86400 then
		return string.format("%dh", s // 3600)
	end
	return string.format("%dd", s // 86400)
end

local function later(state: State, it: Item): boolean
	return needs(state, it) and os.time() - math.max(state.touched[it.id] or 0, it.at) > LATER_S
end

local function listed(state: State, it: Item): boolean
	return needs(state, it) and (state.shelf or not later(state, it))
end

-- The list: every decision, in order, Later's excepted unless the shelf is open.
local function rows(state: State): { Item }
	local out = {}
	for _, id in state.order do
		local it = state.by_id[id]
		if it and listed(state, it) then
			table.insert(out, it)
		end
	end
	return out
end

local function first_row(state: State): string?
	local list = rows(state)
	return if list[1] then list[1].id else nil
end

-- Moves a decision one place up (-1) or down (+1) in the list.
local function bump(state: State, id: string, dir: number): boolean
	local i = table.find(state.order, id)
	if not i then
		return false
	end
	local j = i + dir
	while state.order[j] and not (state.by_id[state.order[j]] and listed(state, state.by_id[state.order[j]])) do
		j += dir
	end
	if not state.order[j] then
		return false
	end
	state.order[i], state.order[j] = state.order[j], state.order[i]
	state.bumped[id] = (state.bumped[id] or 0) - dir
	state.by_id[id].bumped = state.bumped[id]
	state.touched[id] = os.time()
	return true
end

-- CU work first, then the newest.
local function before(a: Item, b: Item): boolean
	if a.lane ~= b.lane then
		return a.lane == "cu"
	end
	return a.at > b.at
end

-- Takes in a fresh read of the queue: decisions you already ordered keep their places, new ones go where
-- CU-first-then-newest puts them among those.
local function build(state: State, board: tasks.Board)
	local items: { Item } = {}
	state.by_id = {}
	for _, list in { board.decisions, board.working, board.finished } do
		for _, it in list do
			it.bumped = state.bumped[it.id]
			table.insert(items, it)
			state.by_id[it.id] = it
		end
	end
	state.items = items
	local fresh = table.clone(board.decisions)
	table.sort(fresh, before)
	local rank: { [string]: number } = {}
	for i, it in fresh do
		rank[it.id] = i
	end
	local order: { string } = {}
	local placed: { [string]: boolean } = {}
	for _, id in state.order do
		if (rank[id] or state.ghosts[id]) and not placed[id] then
			table.insert(order, id)
			placed[id] = true
		end
	end
	for i, it in fresh do
		if not placed[it.id] then
			local at = #order + 1
			for k, id in order do
				if rank[id] and rank[id] > i then
					at = k
					break
				end
			end
			table.insert(order, at, it.id)
			placed[it.id] = true
		end
	end
	state.order = order
	local function keep(map: { [string]: any })
		for id in map do
			if not rank[id] then
				map[id] = nil
			end
		end
	end
	keep(state.bumped)
	keep(state.touched)
	keep(state.pending)
	local sel = state.sel and state.by_id[state.sel]
	if not (sel and listed(state, sel)) then
		state.sel = first_row(state)
	end
	if state.zero and #rows(state) > 0 then
		state.zero = nil
	end
end

local function render(state: State)
	state.asked = true
	if not pcall(function()
		state.cx:render()
	end) then
		state.closed = true
	end
end

local function load(state: State)
	if state.loading then
		state.again = true
		return
	end
	state.loading = true
	local function finish(err: string?, out: string?)
		state.loading = false
		state.loaded = true
		if err then
			state.error = err
		elseif out and out ~= state.sig then
			local ok, board = pcall(tasks.parse, out)
			if ok then
				state.sig = out
				state.error = nil
				build(state, board)
			else
				state.error = "omp-bot-ctl board: " .. tostring(board)
			end
		else
			state.error = nil
		end
		render(state)
		if state.again then
			state.again = false
			load(state)
		end
	end
	local ok, err = pcall(tern.process.run, { CTL, "board" }, { timeout_ms = 15000 }, function(res: ProcessResult)
		if res.status == 0 then
			finish(nil, res.stdout)
		else
			finish("omp-bot-ctl board: " .. ((res.stderr or ""):match("[^\n]+") or ("exit " .. tostring(res.status))))
		end
	end)
	if not ok then
		finish("omp-bot-ctl: " .. tostring(err))
	end
end

-- Reads the queue again every POLL_MS while the board is open. A closed block hears of no close, but Tern
-- stops asking it for views: a render since the last read that drew nothing means it is gone.
local function poll(state: State)
	state.poll = tern.timer(POLL_MS, function()
		state.poll = nil
		if state.closed or (state.asked and not state.viewed) then
			return
		end
		state.asked = false
		state.viewed = false
		load(state)
		poll(state)
	end)
end

local function live(state: State): boolean
	local now = tern.now()
	if state.fx and now - state.fx.t0 < FX_MS then
		return true
	end
	if state.nope and now - state.nope.t0 < NOPE_MS then
		return true
	end
	for _, g in state.ghosts do
		if now - g.t0 < FLY_MS then
			return true
		end
	end
	for _, r in state.reacts do
		if now - r.t0 < REACT_MS then
			return true
		end
	end
	return false
end

local function prune(state: State)
	local now = tern.now()
	if state.fx and now - state.fx.t0 >= FX_MS then
		state.fx = nil
	end
	if state.nope and now - state.nope.t0 >= NOPE_MS then
		state.nope = nil
	end
	for id, g in state.ghosts do
		if now - g.t0 >= FLY_MS then
			state.ghosts[id] = nil
			local i = table.find(state.order, id)
			if i and not (state.by_id[id] and state.by_id[id].state == "waiting") then
				table.remove(state.order, i)
			end
		end
	end
	for bot, r in state.reacts do
		if now - r.t0 >= REACT_MS then
			state.reacts[bot] = nil
		end
	end
end

local function ensure_tick(state: State)
	if state.tick == nil and live(state) then
		local function loop()
			state.tick = tern.timer(TICK, function()
				state.tick = nil
				local was = live(state)
				prune(state)
				if was then
					render(state)
				end
				if live(state) and not state.closed then
					loop()
				end
			end)
		end
		loop()
	end
end

local function count_today(state: State, n: number)
	local day = os.date("%Y-%m-%d") :: string
	if state.day ~= day then
		state.day = day
		state.today = 0
	end
	state.today = math.max(0, state.today + n)
end

-- Answers a decision: the row flies off at once, and `omp-bot-ctl` takes the answer to omp-botd. An answer
-- the queue refuses (answered elsewhere meanwhile, say) puts the row back and says why.
local function act(state: State, id: string, what: string, reason: string?)
	local it = state.by_id[id]
	local before_rows = rows(state)
	if not it or not listed(state, it) or not ACTS[what] then
		state.nope = { id = id, t0 = tern.now() }
		return
	end
	local now = tern.now()
	state.streak = if now - state.last_at < STREAK_GAP then state.streak + 1 else 1
	state.best = math.max(state.best, state.streak)
	state.last_at = now
	local note = if reason and reason ~= "" then reason else nil
	it.note = if what == "deny" then (if note then "“" .. note .. "”" else "no reason given") else nil
	state.pending[id] = true
	state.settled += 1
	count_today(state, 1)
	state.ghosts[id] = { act = what, t0 = now, it = it }
	state.nfx += 1
	state.fx = { act = what, id = id, bot = it.bot, verb = VERB[what] or (it.bot .. "'s on it"), meta = it.title, t0 = now, n = state.nfx }
	state.reacts[it.bot] = { act = what, t0 = now }
	-- On to the next item in the list, the one below first.
	local at = table.find(before_rows, it) or 0
	local nxt = before_rows[at + 1] or before_rows[at - 1]
	state.sel = if nxt then nxt.id else nil
	if #rows(state) == 0 and not state.zero then
		state.zero = { t0 = now }
	end
	local argv = { CTL, what, id }
	if note then
		table.insert(argv, note)
	end
	local function refused(why: string)
		state.pending[id] = nil
		state.settled = math.max(0, state.settled - 1)
		count_today(state, -1)
		state.zero = nil
		state.cx:toast("error", "Couldn't " .. what .. " " .. it.bot .. "'s ask", why)
	end
	local ok, err = pcall(tern.process.run, argv, { timeout_ms = 15000 }, function(res: ProcessResult)
		if res.status ~= 0 then
			refused((res.stderr or ""):match("[^\n]+") or ("exit " .. tostring(res.status)))
		end
		state.sig = nil
		load(state)
	end)
	if not ok then
		refused(tostring(err))
	end
end

-- Views ---------------------------------------------------------------------------------------------

local function el(class: string, children: { Node }?, attrs: { [string]: string }?, key: string?, click: string?): Node
	return ui.el("div", { class = class, attrs = attrs, key = key, actions = if click then { click = click } else nil }, children)
end

local function txt(class: string, s: string, attrs: { [string]: string }?, key: string?): Node
	return ui.el("div", { class = class, text = s, attrs = attrs, key = key })
end

local function sprite(state: State, bot: string, px: number): Node
	local b = state.bots[bot] or {}
	local kind = chao.kind(bot, b.chao)
	local key = bot .. "@" .. px
	local id = state.blobs[key]
	if id == nil then
		id = state.cx:blob(chao.svg(kind, chao.tint(bot, b.tint), px), "image/svg+xml")
		state.blobs[key] = id
	end
	return ui.node("image", { blob = id, alt = bot })
end

local EMOTE = { approve = "♥", deny = "✗", handle = "!" }

local function chao_view(state: State, it: Item): Node
	local r = state.reacts[it.bot]
	local react = if r then r.act else nil
	local c: { Node } = { sprite(state, it.bot, 2) }
	local emote = if react then EMOTE[react] elseif it.state == "waiting" then "!" else nil
	if emote then
		table.insert(c, txt("tb-emote", emote, { ["data-kind"] = react or it.state }, (react or it.state) .. (if r then tostring(r.t0) else "")))
	end
	return el("tb-chao", c, { ["data-state"] = it.state, ["data-react"] = react or "" }, "chao" .. it.id .. (if r then tostring(r.t0) else ""))
end

local function sparks(big: boolean, key: string): Node
	local c: { Node } = {}
	for _ = 1, 12 do
		table.insert(c, ui.el("span", { class = "tb-spark" }, { ui.el("span", { class = "tb-dot" }) }))
	end
	return el("tb-sparks", c, if big then { ["data-big"] = "1" } else nil, key)
end

local function button(what: string, label: string, keycap: string, it: Item): Node
	return ui.el("button", {
		class = "tb-act",
		attrs = { ["data-act"] = what },
		actions = { click = what .. "=" .. it.id },
	}, { txt("tb-cap", keycap), txt("tb-act-label", label) })
end

local function reason_view(state: State, it: Item): Node
	return el("tb-reason", {
		txt("tb-reason-label", "Deny it — why? (optional, " .. it.bot .. " reads it)"),
		el("tb-input", {
			txt("tb-typed", if state.typed == "" then "one line, or just ⏎" else state.typed, if state.typed == "" then { ["data-empty"] = "1" } else nil),
			ui.el("span", { class = "tb-caret" }),
		}),
		ui.el("button", { class = "tb-act", attrs = { ["data-act"] = "deny" }, actions = { click = "confirm=" .. it.id } }, { txt("tb-cap", "⏎"), txt("tb-act-label", "Deny") }),
		ui.el("button", { class = "tb-act tb-quiet", actions = { click = "cancel" } }, { txt("tb-cap", "esc"), txt("tb-act-label", "Back") }),
	}, nil, "reason" .. it.id)
end

local function body_md(body: string): string
	if #body > 900 then
		body = (body:sub(1, 880):match("^(.*)%s") or body:sub(1, 880)) .. " …"
	end
	return body
end

local function row_view(state: State, it: Item, rank: number): Node
	local sel = state.sel == it.id
	local meta: { Node } = {
		txt("tb-bot", it.bot),
		txt("tb-proj", it.project, { ["data-lane"] = it.lane }),
	}
	if (it.bumped or 0) > 0 then
		table.insert(meta, txt("tb-bumped", "↑ bumped"))
	elseif (it.bumped or 0) < 0 then
		table.insert(meta, txt("tb-bumped", "↓ bumped"))
	end
	if later(state, it) then
		table.insert(meta, txt("tb-note", "on the Later shelf"))
	end
	local main: { Node } = { txt("tb-title", it.title), el("tb-meta", meta) }
	if sel then
		if it.rest ~= "" then
			table.insert(main, el("tb-body", { ui.md(body_md(it.rest)) }))
		end
		if state.mode == "deny" then
			table.insert(main, reason_view(state, it))
		else
			table.insert(main, el("tb-acts", {
				button("approve", "Approve", "A", it),
				button("deny", "Deny", "D", it),
				button("handle", "Handle", "H", it),
			}))
		end
	end
	local nope = state.nope and state.nope.id == it.id
	local attrs: { [string]: string } = { ["data-state"] = it.state, ["data-lane"] = it.lane }
	if sel then
		attrs["data-sel"] = "1"
	end
	if nope then
		attrs["data-nope"] = "1"
	end
	return el("tb-row", {
		txt("tb-rank", tostring(rank)),
		chao_view(state, it),
		el("tb-main", main, nil, nil, "sel=" .. it.id),
		el("tb-side", {
			txt("tb-state", STATE_LABEL[it.state] or it.state, { ["data-state"] = it.state }),
			txt("tb-age", age(it.at)),
			el("tb-bump", {
				ui.el("button", { class = "tb-bump-btn", text = "▲", title = "Bump up (⇧↑)", actions = { click = "up=" .. it.id } }),
				ui.el("button", { class = "tb-bump-btn", text = "▼", title = "Bump down (⇧↓)", actions = { click = "down=" .. it.id } }),
			}),
		}),
	}, attrs, "row" .. it.id .. (if nope then "nope" .. tostring(state.nope and state.nope.t0) else ""))
end

local function ghost_view(state: State, g: Ghost): Node
	local it = g.it
	return el("tb-row tb-ghost", {
		txt("tb-rank", "✓"),
		chao_view(state, it),
		el("tb-main", { txt("tb-title", it.title), el("tb-meta", { txt("tb-bot", it.bot), txt("tb-note", it.note or "") }) }),
		el("tb-side", { txt("tb-state", STATE_LABEL[g.act], { ["data-state"] = g.act }) }),
	}, { ["data-fly"] = g.act, ["data-state"] = g.act, ["data-lane"] = it.lane }, "ghost" .. it.id)
end

local function minis(state: State, items: { Item }, n: number): Node
	local c: { Node } = {}
	local seen: { [string]: boolean } = {}
	for _, it in items do
		if #c >= n then
			break
		end
		if not seen[it.bot] then
			seen[it.bot] = true
			table.insert(c, sprite(state, it.bot, 1))
		end
	end
	return el("tb-minis", c)
end

-- The top TOP decisions in full; the rest one "+N more" line until opened. A row flying off keeps its place.
local function list_view(state: State): Node
	local c: { Node } = {}
	local list = rows(state)
	local shown = 0
	for _, id in state.order do
		local it = state.by_id[id]
		local g = state.ghosts[id]
		if g and shown < TOP then
			table.insert(c, ghost_view(state, g))
		elseif it and listed(state, it) and (shown < TOP or state.more) then
			shown += 1
			table.insert(c, row_view(state, it, shown))
		end
	end
	if #list > TOP then
		local rest = {}
		for k = TOP + 1, #list do
			table.insert(rest, list[k])
		end
		if state.more then
			table.insert(c, el("tb-more-line", { txt("tb-more-n", "Top 3 only"), el("tb-grow"), txt("tb-cap", "m") }, { ["data-open"] = "1" }, "more-open", "more"))
		else
			table.insert(c, el("tb-more-line", {
				txt("tb-more-n", string.format("+%d more", #rest)),
				minis(state, rest, 6),
				el("tb-grow"),
				txt("tb-cap", "m"),
			}, nil, "more" .. #rest, "more"))
		end
	end
	if #list == 0 and not state.zero then
		table.insert(c, txt("tb-empty", "Nothing needs you."))
	end
	return el("tb-list", c, nil, "list")
end

-- The quiet line: what the bots are doing, what finished, and what slid onto Later.
local function shelf_view(state: State): Node
	local working, finished, shelved = {}, {}, {}
	for _, it in state.items do
		if WORKING[it.state] then
			table.insert(working, it)
		elseif FINISHED[it.state] then
			table.insert(finished, it)
		elseif later(state, it) then
			table.insert(shelved, it)
		end
	end
	local parts: { Node } = {
		el("tb-shelf-seg", { minis(state, working, 5), txt("tb-shelf-n", tostring(#working)), txt("tb-shelf-u", "at work") }),
		txt("tb-shelf-dot", "·"),
		el("tb-shelf-seg tb-shelf-link", {
			txt("tb-shelf-n", tostring(#finished)),
			txt("tb-shelf-u", "finished"),
			txt("tb-shelf-view", if state.history then "hide" else "view"),
			txt("tb-cap", "v"),
		}, nil, nil, "history"),
		txt("tb-shelf-dot", "·"),
		el("tb-shelf-seg tb-shelf-link", {
			txt("tb-shelf-u", "later"),
			txt("tb-shelf-n", tostring(#shelved)),
			txt("tb-shelf-view", if state.shelf then "hide" else "view"),
			txt("tb-cap", "l"),
		}, { ["title"] = "asks untouched for 3 days" }, nil, "shelf"),
	}
	local out: { Node } = { el("tb-shelf", parts) }
	if state.history and #finished > 0 then
		local c: { Node } = {}
		for k = 1, math.min(HISTORY, #finished) do
			local it = finished[k]
			local label = if it.state == "done" and it.answer then it.answer else it.state
			table.insert(c, el("tb-done", {
				sprite(state, it.bot, 1),
				txt("tb-done-title", it.title),
				txt("tb-state", STATE_LABEL[label] or label, { ["data-state"] = label }),
				txt("tb-age", age(it.at)),
			}, nil, "done" .. it.id))
		end
		if #finished > HISTORY then
			table.insert(c, txt("tb-more", string.format("+ %d older", #finished - HISTORY)))
		end
		table.insert(out, el("tb-done-list", c, nil, "history"))
	end
	return el("tb-foot", out, nil, "foot")
end

local function hud_view(state: State): Node
	local n = #rows(state)
	local right: { Node } = {
		el("tb-score", { txt("tb-score-n", tostring(state.today), nil, "today" .. state.today), txt("tb-score-u", "settled today") }),
	}
	if state.streak >= 2 and tern.now() - state.last_at < STREAK_GAP then
		table.insert(right, txt("tb-streak", string.format("×%d", state.streak), nil, "streak" .. state.streak))
	end
	return el("tb-hud", {
		txt("tb-heading", "Task board"),
		el("tb-need", { txt("tb-need-n", tostring(n), nil, "need" .. n), txt("tb-need-u", if n == 1 then "needs you" else "need you") }, if n == 0 then { ["data-zero"] = "1" } else nil),
		el("tb-grow"),
		el("tb-right", right),
	})
end

local function zero_view(state: State): Node
	local z = state.zero :: { t0: number }
	local parade: { Node } = {}
	local bots: { string } = {}
	local seen: { [string]: boolean } = {}
	for _, it in state.items do
		if not seen[it.bot] then
			seen[it.bot] = true
			table.insert(bots, it.bot)
		end
	end
	table.sort(bots)
	for k, bot in bots do
		table.insert(parade, el("tb-parade-chao", { sprite(state, bot, 3) }, { ["data-i"] = tostring((k - 1) % 6) }))
	end
	local mins = math.max(1, math.round((z.t0 - state.started) / 60000))
	return el("tb-zero", {
		sparks(true, "zsparks" .. z.t0),
		txt("tb-eyebrow", "Nothing waits on you"),
		txt("tb-zero-title", "Inbox zero"),
		el("tb-parade", parade),
		el("tb-tiles", {
			el("tb-tile", { txt("tb-tile-label", "Settled"), txt("tb-tile-value", tostring(state.settled)) }),
			el("tb-tile", { txt("tb-tile-label", "Best run"), txt("tb-tile-value", tostring(state.best)) }),
			el("tb-tile", { txt("tb-tile-label", "Took"), txt("tb-tile-value", string.format("%d min", mins)) }),
		}),
	}, nil, "zero" .. z.t0)
end

local function fx_view(state: State): Node?
	local fx = state.fx
	if not fx or tern.now() - fx.t0 >= FX_MS then
		return nil
	end
	local c: { Node } = {
		el("tb-fx-chao", { sprite(state, fx.bot, 3), txt("tb-emote", EMOTE[fx.act], { ["data-kind"] = fx.act }) }, { ["data-react"] = fx.act }),
		el("tb-fx-text", {
			txt("tb-fx-verb", fx.verb),
			txt("tb-fx-meta", fx.meta),
		}),
	}
	if state.streak >= 3 then
		table.insert(c, txt("tb-combo", string.format("%d in a row", state.streak), nil, "combo" .. state.streak))
	end
	if fx.act ~= "deny" then
		table.insert(c, sparks(state.streak >= 3, "fxs" .. fx.n))
	end
	return el("tb-fx", c, { ["data-act"] = fx.act }, "fx" .. fx.n)
end

local function view(state: State, _cx: BlockCx): BlockView
	state.viewed = true
	if not state.loaded then
		return { main = ui.col({ el("tb-wrap", { txt("tb-loading", "Reading the queue…") }) }) }
	end
	local parts: { Node } = { hud_view(state) }
	if state.zero then
		table.insert(parts, zero_view(state))
	end
	table.insert(parts, list_view(state))
	table.insert(parts, shelf_view(state))
	if state.error then
		table.insert(parts, txt("tb-error", state.error))
	end
	local fx = fx_view(state)
	local dock: { Span }
	if state.mode == "deny" then
		dock = { ui.span("type", "key"), ui.span(" a reason  ", "muted"), ui.span("⏎", "key"), ui.span(" deny  ", "muted"), ui.span("esc", "key"), ui.span(" back", "muted") }
	else
		dock = {
			ui.span("↑↓", "key"), ui.span(" pick  ", "muted"),
			ui.span("a", "key"), ui.span(" approve  ", "muted"),
			ui.span("d", "key"), ui.span(" deny  ", "muted"),
			ui.span("h", "key"), ui.span(" handle  ", "muted"),
			ui.span("⇧↑↓", "key"), ui.span(" bump  ", "muted"),
			ui.span("m", "key"), ui.span(" more  ", "muted"),
			ui.span("v", "key"), ui.span(" finished  ", "muted"),
			ui.span("l", "key"), ui.span(" later", "muted"),
		}
	end
	return {
		main = ui.col({ el("tb-wrap", parts) }),
		layer = if fx then ui.col({ el("tb-fx-wrap", { fx }) }) else nil,
		dock = ui.text(dock),
	}
end

local function move(state: State, dir: number)
	local list = rows(state)
	if #list == 0 then
		return
	end
	local i = 1
	for k, it in list do
		if it.id == state.sel then
			i = k
		end
	end
	local j = math.clamp(i + dir, 1, #list)
	if j > TOP then
		state.more = true
	end
	state.sel = list[j].id
end

local function toggle_more(state: State)
	state.more = not state.more
	local list = rows(state)
	if not state.more and list[TOP + 1] then
		for k = TOP + 1, #list do
			if list[k].id == state.sel then
				state.sel = list[TOP].id
			end
		end
	end
end

local function toggle_shelf(state: State)
	state.shelf = not state.shelf
	local sel = state.sel and state.by_id[state.sel]
	if not (sel and listed(state, sel)) then
		state.sel = first_row(state)
	end
end

local function do_bump(state: State, id: string?, dir: number)
	if not id then
		return
	end
	if not bump(state, id, dir) then
		state.nope = { id = id, t0 = tern.now() }
	end
end

local function strings(t: any): { [string]: number }
	local out = {}
	if type(t) == "table" then
		for k, v in t do
			if type(k) == "string" and type(v) == "number" then
				out[k] = v
			end
		end
	end
	return out
end

tern.block.define("board", {
	init = function(cx: BlockCx, _args: { string }, saved: any): State
		saved = if type(saved) == "table" then saved else {}
		local order = {}
		for _, id in (if type(saved.order) == "table" then saved.order else {}) :: any do
			if type(id) == "string" then
				table.insert(order, id)
			end
		end
		local state: State = {
			cx = cx,
			items = {},
			by_id = {},
			order = order,
			bumped = strings(saved.bumped),
			touched = strings(saved.touched),
			pending = {},
			more = false,
			history = false,
			shelf = false,
			mode = "board",
			typed = "",
			loaded = false,
			loading = false,
			again = false,
			ghosts = {},
			reacts = {},
			streak = 0,
			best = 0,
			last_at = -math.huge,
			settled = 0,
			day = if type(saved.day) == "string" then saved.day else "",
			today = if type(saved.today) == "number" then saved.today else 0,
			started = tern.now(),
			blobs = {},
			bots = roster(),
			asked = false,
			viewed = false,
			closed = false,
			nfx = 0,
		}
		count_today(state, 0)
		load(state)
		poll(state)
		return state
	end,
	title = function(_state: State): string?
		return "Task board"
	end,
	view = view,
	event = function(state: State, ev: UiEvent, cx: BlockCx)
		state.cx = cx
		if ev.ev ~= "action" then
			return
		end
		local what, id = ev.act, ev.value
		if what == "sel" and id then
			if state.sel ~= id then
				state.mode = "board"
				state.typed = ""
			end
			state.sel = id
		elseif (what == "approve" or what == "handle") and id then
			state.sel = id
			state.mode = "board"
			act(state, id, what)
		elseif what == "deny" and id then
			state.sel = id
			state.mode = "deny"
			state.typed = ""
		elseif what == "confirm" and id then
			state.mode = "board"
			act(state, id, "deny", state.typed)
			state.typed = ""
		elseif what == "cancel" then
			state.mode = "board"
			state.typed = ""
		elseif what == "more" then
			toggle_more(state)
		elseif what == "history" then
			state.history = not state.history
		elseif what == "shelf" then
			toggle_shelf(state)
		elseif (what == "up" or what == "down") and id then
			state.sel = id
			do_bump(state, id, if what == "up" then -1 else 1)
			cx:save()
		end
		ensure_tick(state)
	end,
	key = function(state: State, key: Key, cx: BlockCx): boolean?
		state.cx = cx
		if key.ctrl or key.meta or key.alt then
			return false
		end
		if not state.loaded then
			return false
		end
		if state.mode == "deny" then
			if key.name == "enter" then
				state.mode = "board"
				if state.sel then
					act(state, state.sel, "deny", state.typed)
				end
				state.typed = ""
			elseif key.name == "escape" then
				state.mode = "board"
				state.typed = ""
			elseif key.name == "backspace" then
				state.typed = string.sub(state.typed, 1, (utf8.offset(state.typed, -1) or 1) - 1)
			elseif key.text and key.text ~= "" and #state.typed < 120 then
				state.typed ..= key.text
			else
				return false
			end
			ensure_tick(state)
			return true
		end
		local name = key.name
		if (name == "up" or name == "k") and key.shift or name == "K" then
			do_bump(state, state.sel, -1)
		elseif (name == "down" or name == "j") and key.shift or name == "J" then
			do_bump(state, state.sel, 1)
		elseif name == "up" or name == "k" then
			move(state, -1)
		elseif name == "down" or name == "j" then
			move(state, 1)
		elseif key.text == "a" and state.sel then
			act(state, state.sel, "approve")
		elseif key.text == "h" and state.sel then
			act(state, state.sel, "handle")
		elseif key.text == "d" and state.sel then
			state.mode = "deny"
			state.typed = ""
		elseif key.text == "m" then
			toggle_more(state)
		elseif key.text == "v" then
			state.history = not state.history
		elseif key.text == "l" then
			toggle_shelf(state)
		else
			return false
		end
		ensure_tick(state)
		return true
	end,
	font = "sans",
	-- Your order and bumps, and the day's count; the queue itself is read fresh.
	save = function(state: State): any
		local order = {}
		for _, id in state.order do
			if not state.loaded or (state.by_id[id] and state.by_id[id].state == "waiting") then
				table.insert(order, id)
			end
		end
		return { order = order, bumped = state.bumped, touched = state.touched, day = state.day, today = state.today }
	end,
})
