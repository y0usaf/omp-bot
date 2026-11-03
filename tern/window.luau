--!strict

local ROOT = tern.plugin.dir .. "/.."
local STATE = tern.getenv("OMP_BOT_STATE") or ((tern.getenv("XDG_STATE_HOME") or ((tern.getenv("HOME") or "") .. "/.local/state")) .. "/omp-bot")
local ROSTER = STATE .. "/bots.json"
local TINTS = { "purple", "teal", "orange", "pink", "blue", "green", "yellow", "red" }
local RELAUNCH = 76
local SHELLS = { sh = true, bash = true, zsh = true, fish = true, dash = true, nu = true, rush = true }
local GONE_MS = 10000
local SETTLE_MS = 15000

local EYES = { "pill", "round", "visor", "lids", "dots" }
local RAIL_EYES = {
	round = "left: 5.2px; top: 6.8px; width: 2.8px; height: 2.8px; border-radius: 50%; box-shadow: 4.8px 0 0 #1a1730;",
	visor = "left: 5px; top: 7.4px; width: 8px; height: 2.2px; border-radius: 1.1px; box-shadow: none;",
	lids = "left: 5.1px; top: 6.6px; width: 2.8px; height: 3.2px; border-radius: 0.6px 0.6px 1.6px 1.6px; box-shadow: 4.8px 0 0 #1a1730;",
	dots = "left: 5px; top: 7.4px; width: 2px; height: 2px; border-radius: 50%; box-shadow: 6px 0 0 #1a1730;",
}

type Bot = { name: string, role: string?, tint: string?, cwd: string?, persona: string? }

local function mul32(a: number, b: number): number
	return ((a % 65536) * b + (((a // 65536) * (b % 65536)) % 65536) * 65536) % 4294967296
end

local function eyes(name: string): string
	local h = 0x811cb697
	for i = 1, #name do
		h = mul32(bit32.bxor(h, string.byte(name, i)), 0x01000193)
	end
	h = mul32(bit32.bxor(h, bit32.rshift(h, 16)), 0x85ebca6b)
	h = mul32(bit32.bxor(h, bit32.rshift(h, 13)), 0xc2b2ae35)
	h = bit32.bxor(h, bit32.rshift(h, 16))
	return EYES[h % #EYES + 1]
end

local function quote(s: string): string
	return "'" .. s:gsub("'", "'\\''") .. "'"
end

local function roster(): { Bot }
	return tern.json.decode(tern.fs.read(tern.fs.exists(ROSTER) and ROSTER or ROOT .. "/bots.json"))
end

local function show_roles(bots: { Bot })
	local rules = {}
	for _, bot in ipairs(bots) do
		if bot.tint and bot.role then
			local row = "#tabbar .tt[data-tc='" .. bot.tint .. "'] .sub"
			rules[#rules + 1] = row .. " { font-size: 0; }\n" .. row .. "::after { content: " .. tern.json.encode(bot.role) .. "; }"
		end
		local look = bot.tint and RAIL_EYES[eyes(bot.name)]
		if look then
			rules[#rules + 1] = "#tabbar .tt[data-tc='" .. bot.tint .. "'] .tn-dk-c::after { " .. look .. " }"
		end
	end
	tern.css("roles", table.concat(rules, "\n"))
end

local function open_names(cx: WindowCx): { [string]: number }
	local names = {}
	for _, tab in ipairs(cx.session:tabs()) do
		if tab.name then
			names[tab.name] = tab.pane
		end
	end
	return names
end

local function command(name: string, tint: string?): string
	local env = {}
	for _, key in ipairs({ "OMP_BIN", "OMP_BOT_MODEL", "OMP_BOT_STATE", "OMP_BOT_NO_TOOLS" }) do
		local value = tern.getenv(key)
		if value and value ~= "" then
			env[#env + 1] = key .. "=" .. quote(value)
		end
	end
	local prefix = #env > 0 and "env " .. table.concat(env, " ") .. " " or ""
	local create = tint and " --create " .. quote(tint) or ""
	return prefix .. quote(ROOT .. "/bin/omp-bot") .. " " .. quote(name) .. create
end

local function open(cx: WindowCx, bot: Bot, new: boolean?)
	local id = cx.layout:new_tab({ command = command(bot.name, new and bot.tint or nil) })
	if not id then
		cx:toast("error", "Could not open " .. bot.name)
		return
	end
	local tab = cx.session:tab_of(id) or id
	cx.layout:name_tab(tab, bot.name)
	if bot.tint then
		cx.layout:color_tab(tab, bot.tint :: any)
	end
end

local function open_all(cx: WindowCx)
	local names = open_names(cx)
	for _, bot in ipairs(roster()) do
		if not names[bot.name] then
			open(cx, bot)
		end
	end
end

local function stage(cx: WindowCx)
	local config = tern.getenv("TERN_CONFIG_DIR")
	if not (config and config:find("omp-bot-demo", 1, true)) then
		cx:toast("error", "Bots: Stage demo only runs in the omp-bot-demo window")
		return
	end
	tern.css("flat", tern.fs.read(tern.plugin.dir .. "/flat.css"))
	if tern.fs.exists(config .. "/settings.json") then
		cx.settings:set_many(tern.json.decode(tern.fs.read(config .. "/settings.json")))
	end
	open_all(cx)
	local bots = {}
	for _, bot in ipairs(roster()) do
		bots[bot.name] = true
	end
	for _, tab in ipairs(cx.session:tabs()) do
		if not (tab.name and bots[tab.name]) then
			cx.layout:close(tab.pane)
		end
	end
end

local function create(cx: WindowCx, bots: { Bot })
	cx:prompt({ placeholder = "Name your bot", icon = "sparkle", action = "create" }):next(function(name, _, cx2)
		name = name and name:match("^%s*(.-)%s*$")
		if not name or name == "" or not cx2 then
			return
		end
		if #name > 40 or name:sub(1, 1) == "." or name:find("[^%w%._ %-]") then
			cx2:toast("error", "Bot names use letters, digits, spaces, '.', '_' or '-', and can't start with '.'")
			return
		end
		local function free_tint(): string
			local used = {}
			for _, other in ipairs(bots) do
				used[other.tint or ""] = true
			end
			local tint = TINTS[#bots % #TINTS + 1]
			for _, t in ipairs(TINTS) do
				if not used[t] then
					tint = t
					break
				end
			end
			return tint
		end
		for _, existing in ipairs(bots) do
			if existing.name == name then
				cx2:pick({
					items = {
						{ label = "Open " .. name, detail = "keeps its conversation", icon = "sparkle", reuse = true },
						{ label = "Start a fresh " .. name, detail = "archives the old conversation first", icon = "plus", fresh = true },
					},
					placeholder = name .. " already exists",
					icon = "sparkle",
					action = "open",
				}):next(function(choice, _, cx3)
					if not choice or not cx3 then
						return
					end
					if choice.reuse then
						open(cx3, existing)
						return
					end
					local pane = open_names(cx3)[name]
					if pane then
						cx3.layout:close(pane)
					end
					local env = {}
					local state = tern.getenv("OMP_BOT_STATE")
					if state then
						env.OMP_BOT_STATE = state
					end
					tern.process.run({ ROOT .. "/bin/omp-bot-remove", name }, { env = env, timeout_ms = 30000 }, function(result, cx4)
						if not cx4 then
							return
						end
						if result.status ~= 0 then
							cx4:toast("error", "Could not clear " .. name, (result.stderr:gsub("%s+$", "")))
							return
						end
						open(cx4, { name = name, role = "Assistant", tint = free_tint(), cwd = "~" }, true)
						show_roles(roster())
					end)
				end)
				return
			end
		end
		local bot = { name = name, role = "Assistant", tint = free_tint(), cwd = "~" }
		bots[#bots + 1] = bot
		show_roles(bots)
		open(cx2, bot, true)
	end)
end

local function new_bot(cx: WindowCx)
	local bots = roster()
	local items = {}
	for _, bot in ipairs(bots) do
		items[#items + 1] = { label = bot.name, detail = bot.role, icon = "sparkle", bot = bot }
	end
	items[#items + 1] = { label = "Someone new…", icon = "plus" }
	cx:pick({ items = items, placeholder = "Which bot?", icon = "sparkle", action = "open" }):next(function(item, _, cx2)
		if not item or not cx2 then
			return
		end
		if item.bot then
			local pane = open_names(cx2)[item.bot.name]
			if pane then
				cx2.layout:focus(pane)
			else
				open(cx2, item.bot)
			end
		else
			create(cx2, bots)
		end
	end)
end

local function remove_bot(cx: WindowCx)
	local items = {}
	for _, bot in ipairs(roster()) do
		items[#items + 1] = { label = bot.name, detail = bot.role, icon = "trash", bot = bot }
	end
	cx:pick({ items = items, placeholder = "Remove which bot?", icon = "trash", action = "remove" }):next(function(item, _, cx2)
		if not item or not cx2 then
			return
		end
		local name = item.bot.name
		cx2:pick({
			items = {
				{ label = "Remove " .. name, detail = "Its conversation is archived, not deleted", icon = "trash", go = true },
				{ label = "Cancel" },
			},
			placeholder = "Remove " .. name .. "?",
			icon = "trash",
			action = "confirm",
		}):next(function(choice, _, cx3)
			if not choice or not choice.go or not cx3 then
				return
			end
			local pane = open_names(cx3)[name]
			if pane then
				cx3.layout:close(pane)
			end
			local env = {}
			local state = tern.getenv("OMP_BOT_STATE")
			if state then
				env.OMP_BOT_STATE = state
			end
			tern.process.run({ ROOT .. "/bin/omp-bot-remove", name }, { env = env, timeout_ms = 30000 }, function(result, cx4)
				if result.status == 0 then
					show_roles(roster())
					if cx4 then
						cx4:toast("info", "Removed " .. name)
					end
				elseif cx4 then
					cx4:toast("error", "Could not remove " .. name, (result.stderr:gsub("%s+$", "")))
				end
			end)
		end)
	end)
end

tern.command({ id = "new", title = "Bots: Open bot", icon = "sparkle", run = new_bot })
tern.command({ id = "remove", title = "Bots: Remove bot", icon = "trash", run = remove_bot })
tern.command({ id = "open_all", title = "Bots: Open all", icon = "sparkle", run = open_all })
tern.command({ id = "stage", title = "Bots: Stage demo", available = function()
	return false
end, run = stage })

local cwds = {}

local function forward(kind, payload)
	local env = {}
	local state = tern.getenv("OMP_BOT_STATE")
	if state then
		env.OMP_BOT_STATE = state
	end
	local event = tern.json.encode({ source = "tern", kind = kind, payload = payload })
	tern.process.run({ ROOT .. "/bin/omp-bot-ctl", "event", event }, { env = env, timeout_ms = 5000 }, function() end)
end

show_roles(roster())

local function by_name(): { [string]: Bot }
	local bots = {}
	for _, bot in ipairs(roster()) do
		bots[bot.name] = bot
	end
	return bots
end

local function session_names(cx: WindowCx): { [number]: string }
	local names = {}
	for _, s in ipairs(cx.session:sessions()) do
		names[s.id] = s.name
	end
	return names
end

local function idle_shell(pane: PaneInfo?): boolean
	if not pane or pane.kind ~= "terminal" or pane.busy or pane.running or pane.exited ~= nil then
		return false
	end
	local program = (pane.program or ""):gsub("^%-", ""):match("[^/]*$")
	return pane.at_prompt == true or SHELLS[program] == true
end

local function relaunch(cx: WindowCx, pane: number, bot: Bot)
	local new = cx.layout:split(pane, "right", { command = command(bot.name) })
	if not new then
		cx:toast("error", "Could not reopen " .. bot.name)
		return
	end
	cx.layout:close(pane)
	local tab = cx.session:tab_of(new)
	if tab and bot.tint then
		cx.layout:color_tab(tab, bot.tint :: any)
	end
end

local function restore(cx: WindowCx, reopen: boolean)
	local saved = tern.kv.get("open") or {}
	local bots = by_name()
	for _, s in ipairs(cx.session:sessions()) do
		local want = saved[s.name]
		if want then
			local tabs = {}
			for _, tab in ipairs(cx.session:tabs()) do
				if tab.session == s.id and tab.name then
					tabs[tab.name] = tab
				end
			end
			local order = {}
			for name, position in pairs(want) do
				if bots[name] then
					order[#order + 1] = { name = name, position = position }
				end
			end
			table.sort(order, function(a, b)
				return a.position < b.position
			end)
			for _, entry in ipairs(order) do
				local bot = bots[entry.name]
				local tab = tabs[entry.name]
				if tab then
					if tab.panes == 1 and idle_shell(cx.session:pane(tab.pane)) then
						relaunch(cx, tab.pane, bot)
					end
				elseif reopen and s.current then
					local id = cx.layout:new_tab({ command = command(bot.name) }, { focus = false })
					local new = id and (cx.session:tab_of(id) or id)
					if new then
						cx.layout:name_tab(new, bot.name)
						if bot.tint then
							cx.layout:color_tab(new, bot.tint :: any)
						end
						cx.layout:order_tab(new, entry.position)
					end
				end
			end
		end
	end
end

local gone: { [string]: number } = {}

local function remember(cx: WindowCx)
	local bots = by_name()
	local sessions = session_names(cx)
	local present = {}
	for _, tab in ipairs(cx.session:tabs()) do
		local session = sessions[tab.session]
		if session and tab.name and bots[tab.name] then
			present[session] = present[session] or {}
			present[session][tab.name] = tab.position
		end
	end
	local saved = tern.kv.get("open") or {}
	local changed = false
	local now = tern.now()
	for _, session in pairs(sessions) do
		local want = saved[session] or {}
		local have = present[session] or {}
		for name, position in pairs(have) do
			gone[session .. "/" .. name] = nil
			if want[name] ~= position then
				want[name] = position
				changed = true
			end
		end
		for name in pairs(want) do
			local key = session .. "/" .. name
			if not have[name] then
				gone[key] = gone[key] or now
				if now - gone[key] >= GONE_MS then
					want[name] = nil
					gone[key] = nil
					changed = true
				end
			end
		end
		saved[session] = next(want) and want or nil
	end
	if changed then
		tern.kv.set("open", saved)
	end
end

local function relaunch_exited(cx: WindowCx)
	local bots = by_name()
	local names = {}
	for _, tab in ipairs(cx.session:tabs()) do
		names[tab.id] = tab.name
	end
	for _, pane in ipairs(cx.session:panes()) do
		local name = pane.exited == RELAUNCH and pane.tab and names[pane.tab]
		if name and bots[name] then
			relaunch(cx, pane.pane, bots[name])
		end
	end
end

local started = 0

local function sync(_ev: any, cx: WindowCx)
	relaunch_exited(cx)
	if tern.now() - started < SETTLE_MS then
		restore(cx, false)
	end
	remember(cx)
end

for _, event in ipairs({ "focus", "pane_created", "pane_closed", "tab_created", "tab_closed", "title", "agent_state" }) do
	tern.on(event, sync)
end

tern.on("cwd", function(ev, cx: WindowCx)
	cwds[ev.pane] = ev.path
	sync(ev, cx)
end)

tern.on("command_finished", function(ev, cx: WindowCx)
	sync(ev, cx)
	if ev.status == 0 then
		return
	end
	forward("command_finished", { pane = ev.pane, line = ev.line, status = ev.status, took_ms = ev.took_ms, cwd = cwds[ev.pane] })
end)

tern.on("agent_finished", function(ev, cx: WindowCx)
	sync(ev, cx)
	forward("agent_finished", { pane = ev.pane, result = ev.result })
end)

tern.on("window_start", function(cx: WindowCx)
	started = tern.now()
	restore(cx, true)
	remember(cx)
end)
