--!strict

local ROOT = tern.plugin.dir .. "/.."
local STATE = tern.getenv("OMP_BOT_STATE") or ((tern.getenv("XDG_STATE_HOME") or ((tern.getenv("HOME") or "") .. "/.local/state")) .. "/omp-bot")
local ROSTER = STATE .. "/bots.json"
local SESSION = "Bots"
local TINTS = { "purple", "teal", "orange", "pink", "blue", "green", "yellow", "red" }
local FIELDS = { "name", "role", "tint", "cwd", "persona" }

type Bot = { name: string, role: string?, tint: string?, cwd: string?, persona: string? }

local function quote(s: string): string
	return "'" .. s:gsub("'", "'\\''") .. "'"
end

local function roster(): { Bot }
	return tern.json.decode(tern.fs.read(tern.fs.exists(ROSTER) and ROSTER or ROOT .. "/bots.json"))
end

local function save(bots: { Bot })
	local lines = {}
	for _, bot in ipairs(bots) do
		local parts = {}
		for _, key in ipairs(FIELDS) do
			local value = (bot :: any)[key]
			if value then
				parts[#parts + 1] = tern.json.encode(key) .. ": " .. tern.json.encode(value)
			end
		end
		lines[#lines + 1] = "  {" .. table.concat(parts, ", ") .. "}"
	end
	tern.fs.write(ROSTER, "[\n" .. table.concat(lines, ",\n") .. "\n]\n")
end

local function show_roles(bots: { Bot })
	local rules = {}
	for _, bot in ipairs(bots) do
		if bot.tint and bot.role then
			local row = "#tabbar .tt[data-tc='" .. bot.tint .. "'] .sub"
			rules[#rules + 1] = row .. " { font-size: 0; }\n" .. row .. "::after { content: " .. tern.json.encode(bot.role) .. "; }"
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

local function to_bots_session(cx: WindowCx): { number }?
	for _, session in ipairs(cx.sessions:list()) do
		if session.name == SESSION then
			if not session.current then
				cx.sessions:switch(session.id)
			end
			return nil
		end
	end
	cx.sessions:create({ name = SESSION })
	cx.sessions:lock(nil)
	local fresh = {}
	for _, tab in ipairs(cx.session:tabs()) do
		fresh[#fresh + 1] = tab.pane
	end
	return fresh
end

local function close_all(cx: WindowCx, panes: { number }?)
	for _, pane in ipairs(panes or {}) do
		cx.layout:close(pane)
	end
end

local function command(name: string): string
	local env = {}
	for _, key in ipairs({ "OMP_BIN", "OMP_BOT_MODEL" }) do
		local value = tern.getenv(key)
		if value and value ~= "" then
			env[#env + 1] = key .. "=" .. quote(value)
		end
	end
	local prefix = #env > 0 and "env " .. table.concat(env, " ") .. " " or ""
	return prefix .. quote(ROOT .. "/bin/omp-bot") .. " " .. quote(name)
end

local function open(cx: WindowCx, bot: Bot)
	local id = cx.layout:new_tab({ command = command(bot.name) })
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
	local fresh = to_bots_session(cx)
	local names = open_names(cx)
	for _, bot in ipairs(roster()) do
		if not names[bot.name] then
			open(cx, bot)
		end
	end
	close_all(cx, fresh)
end

local function stage(cx: WindowCx)
	local config = tern.getenv("TERN_CONFIG_DIR")
	if not (config and config:find("omp-bot-demo", 1, true)) then
		cx:toast("error", "Bots: Stage demo only runs in the omp-bot-demo window")
		return
	end
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

local function create(cx: WindowCx, bots: { Bot }, fresh: { number }?)
	cx:prompt({ placeholder = "Name your bot", icon = "sparkle", action = "create" }):next(function(name, _, cx2)
		name = name and name:match("^%s*(.-)%s*$")
		if not name or name == "" or not cx2 then
			return
		end
		for _, bot in ipairs(bots) do
			if bot.name == name then
				open(cx2, bot)
				close_all(cx2, fresh)
				return
			end
		end
		local used = {}
		for _, bot in ipairs(bots) do
			used[bot.tint or ""] = true
		end
		local tint = TINTS[#bots % #TINTS + 1]
		for _, t in ipairs(TINTS) do
			if not used[t] then
				tint = t
				break
			end
		end
		local bot = { name = name, role = "Assistant", tint = tint, cwd = "~" }
		bots[#bots + 1] = bot
		save(bots)
		show_roles(bots)
		open(cx2, bot)
		close_all(cx2, fresh)
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
		local fresh = to_bots_session(cx2)
		if item.bot then
			local pane = open_names(cx2)[item.bot.name]
			if pane then
				cx2.layout:focus(pane)
			else
				open(cx2, item.bot)
			end
			close_all(cx2, fresh)
		else
			create(cx2, bots, fresh)
		end
	end)
end

tern.command({ id = "new", title = "Bots: Open bot", icon = "sparkle", run = new_bot })
tern.command({ id = "open_all", title = "Bots: Open all", icon = "sparkle", run = open_all })
tern.command({ id = "stage", title = "Bots: Stage demo", available = function()
	return false
end, run = stage })

show_roles(roster())
