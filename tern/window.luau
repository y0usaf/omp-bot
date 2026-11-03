--!strict

local ROOT = tern.plugin.dir .. "/.."
local STATE = tern.getenv("OMP_BOT_STATE") or ((tern.getenv("XDG_STATE_HOME") or ((tern.getenv("HOME") or "") .. "/.local/state")) .. "/omp-bot")
local ROSTER = STATE .. "/bots.json"
local TINTS = { "purple", "teal", "orange", "pink", "blue", "green", "yellow", "red" }
local TABS = tern.plugin.data .. "/../agent-tabs/kv.json"

local CHAO_EYES = { "oval", "round", "dot" }
local CHAO_TYPES = { "neutral", "neutral", "hero", "dark" }
local SPRITES: { [string]: { string } } = {
	neutral = {
		"...........oo......",
		".........ooddo.....",
		".....oooodiaado....",
		"...oonijjjjjjino...",
		"..oembbbbbbbbbmeo..",
		".osmbbbbbbbbbbbmso.",
		".ombbbbbbbbbbbbbmo.",
		"ocmbbwwbbbbbwwbbmco",
		"osmbweewbbbweewbmso",
		"osmbweewbbbweewbmso",
		"osmmweewbbbweewmmso",
		"ocmmweewbbbweewmmco",
		"oesmmwwmmmmmwwmmseo",
		".oecsssssssssssceo.",
		"..oooecsssssceooo..",
		".oosmcmmmmmmmcmsoo.",
		"odjbmsmbbbbbmsmbjdo",
		"oiaiecsmmmmmsceiaio",
		"odinoecsssssceonido",
		".ooodsseoooessdooo.",
		"..odajmscocsmjado..",
		"..ondimscocsmidno..",
		"...oooooo.oooooo...",
	},
	hero = {
		"........oo.....oo........",
		".......oaao...oaao.......",
		".......oajjo.ojjao.......",
		"........ojbo.objo........",
		".........obbobbo.........",
		".........oocbcoo.........",
		".......oocbbbbbcoo.......",
		"......obbbbbbbbbbbo......",
		".....ocbbbbbbbbbbbco.....",
		"....osbbbbbbbbbbbbbso....",
		"....obbbbbbbbbbbbbbbo....",
		"...ocbbbccbbbbbccbbbco...",
		"...osbbccbcbbbccbcbbso...",
		"...osbbcbbcbbbcbbcbbso...",
		"...osbbcbbcbbbcbbcbbso...",
		"...osbbcbccbbbcbccbbso...",
		"...ocsbbccbbbbbccbbsco...",
		"..oooccsbbbbbbbbbsccooo..",
		".oyyyooocccssscccoooyyyo.",
		"oyyyoosbcsbbbbbscbsooyyyo",
		"oyyoajjbsbbbbbbbsbjjaoyyo",
		".oooajjjcsbbbbbscjjjaooo.",
		"...oaaaoccsssssccoaaao...",
		"....oooajscooocsjaooo....",
		".....oajjjscocsjjjao.....",
		".....oaaajscocsjaaao.....",
		"......oooooo.oooooo......",
	},
	dark = {
		"...........oooo........",
		".......ooooooooooo.oo..",
		"....ooooobbbbbbbboodao.",
		"...ooobbbbbbbboobbbddao",
		"..oobbbbbbbbbbbbobboodo",
		".oobbbbbbbbbbbbbbobo...",
		".obbbbbbbbbbbbbbbooo...",
		"oobbbbbbbbbbbbbbboo....",
		"oobbewbbbbbbbwebboo....",
		"oobbewwbbbbbwwebboo....",
		"oobbewwbbbbbwwebboo....",
		"oobbewwebbbewwebboo....",
		"oobbeweebbbeweebboo....",
		"ooobbeebbbbbeebbooo....",
		".oooobbbbbbbbboooo.....",
		"..oooodooooodoooo......",
		".ddoboaoooooaobodd.....",
		"dadobobaaaaabobodao....",
		"daddooooaaaooooddao....",
		"daaaoooobbbooooaaao....",
		".ooddoooooooooddoo.....",
		"..oaddbboooboddao......",
		"..oaaadbbobbdaaao......",
		"...oooooo.oooooo.......",
	},
}
local INK: { [string]: string } = { o = "#000", w = "#f8f8f8", b = "var(--mb)", m = "var(--mm)", s = "var(--ms)", c = "var(--mc)", e = "var(--me)", a = "var(--ma)", i = "var(--mi)", d = "var(--md)", n = "var(--mn)", j = "var(--mj)", y = "var(--my)" }
local TYPE_INK: { [string]: string } = {
	neutral = "--mb: color-mix(in srgb, var(--bot) 35%, #fff); --mm: color-mix(in srgb, var(--bot) 50%, #fff); --ms: color-mix(in srgb, var(--bot) 70%, #fff); --mc: color-mix(in srgb, var(--bot) 82%, #000); --me: color-mix(in srgb, var(--bot) 55%, #000); --ma: #f8f820; --mi: #d8d868; --md: #c0b830; --mn: #88a850; --mj: #d8f8b0;",
	hero = "--mb: #f8f8f8; --ms: #bec2bf; --mc: #647c9a; --mj: #c8ebf1; --ma: #89a8dd; --my: #f7df56;",
	dark = "--mb: color-mix(in srgb, var(--bot) 22%, #152745); --me: #1c63a1; --ma: #d52b38; --md: #a71a30;",
}

local function mul32(a: number, b: number): number
	return ((a % 65536) * b + (((a // 65536) * (b % 65536)) % 65536) * 65536) % 4294967296
end

local function chao(bot: Bot): string
	local h = 0x811cb697
	for i = 1, #bot.name do
		h = mul32(bit32.bxor(h, string.byte(bot.name, i)), 0x01000193)
	end
	h = mul32(bit32.bxor(h, bit32.rshift(h, 16)), 0x85ebca6b)
	h = mul32(bit32.bxor(h, bit32.rshift(h, 13)), 0xc2b2ae35)
	h = bit32.bxor(h, bit32.rshift(h, 16))
	local kind = CHAO_TYPES[(h // #CHAO_EYES) % #CHAO_TYPES + 1]
	local own = type(bot.chao) == "string" and { type = bot.chao } or (type(bot.chao) == "table" and bot.chao or {})
	return SPRITES[own.type] and own.type or kind
end

local function mini(kind: string): string
	local rows = SPRITES[kind]
	local left = (18 - #rows[1]) // 2
	local top = 18 - #rows
	local shadows: { string } = {}
	for y, line in ipairs(rows) do
		for x = 1, #line do
			local ink = INK[line:sub(x, x)]
			if ink then
				shadows[#shadows + 1] = (left + x + 29) .. "px " .. (top + y + 29) .. "px 0 " .. ink
			end
		end
	end
	return table.concat(shadows, ", ")
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
		if bot.tint then
			local dot = "#tabbar .tt[data-tc='" .. bot.tint .. "'] .tn-dk-c"
			local kind = chao(bot)
			rules[#rules + 1] = dot .. " { " .. TYPE_INK[kind] .. " }\n" .. dot .. "::after { box-shadow: " .. mini(kind) .. "; }"
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

local registered = ""

local function register(bots: { Bot })
	local tabs = {}
	for _, bot in ipairs(bots) do
		tabs[bot.name] = { command = command(bot.name), tint = bot.tint }
	end
	local text = tern.json.encode(tabs)
	if text ~= registered then
		registered = text
		tern.kv.set("agent-tabs", tabs)
	end
end

local function show(bots: { Bot })
	show_roles(bots)
	register(bots)
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
						local bot = { name = name, role = "Assistant", tint = free_tint(), cwd = "~" }
						local now = roster()
						now[#now + 1] = bot
						show(now)
						open(cx4, bot, true)
					end)
				end)
				return
			end
		end
		local bot = { name = name, role = "Assistant", tint = free_tint(), cwd = "~" }
		bots[#bots + 1] = bot
		show(bots)
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
					show(roster())
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

local legacy = tern.kv.get("open")
if legacy then
	local kv = tern.fs.exists(TABS) and tern.json.decode(tern.fs.read(TABS)) or {}
	if kv.open == nil then
		kv.open = legacy
		tern.fs.mkdir(tern.plugin.data .. "/../agent-tabs")
		tern.fs.write(TABS, tern.json.encode(kv, true))
	end
	tern.kv.set("open", nil)
end

show(roster())

for _, event in ipairs({ "focus", "tab_created" }) do
	tern.on(event, function()
		register(roster())
	end)
end

tern.on("cwd", function(ev)
	cwds[ev.pane] = ev.path
end)

tern.on("command_finished", function(ev)
	if ev.status == 0 then
		return
	end
	forward("command_finished", { pane = ev.pane, line = ev.line, status = ev.status, took_ms = ev.took_ms, cwd = cwds[ev.pane] })
end)

tern.on("agent_finished", function(ev)
	forward("agent_finished", { pane = ev.pane, result = ev.result })
end)
