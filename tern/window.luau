--!strict

local ROOT = tern.plugin.dir .. "/.."
local STATE = tern.getenv("OMP_BOT_STATE") or ((tern.getenv("XDG_STATE_HOME") or ((tern.getenv("HOME") or "") .. "/.local/state")) .. "/omp-bot")
local ROSTER = STATE .. "/bots.json"
local TINTS = { "purple", "teal", "orange", "pink", "blue", "green", "yellow", "red" }
local TABS = tern.plugin.data .. "/../agent-tabs/kv.json"

local function mul32(a: number, b: number): number
	return ((a % 65536) * b + (((a // 65536) * (b % 65536)) % 65536) * 65536) % 4294967296
end

local function hash(name: string): number
	local h = 0x811cb697
	for i = 1, #name do
		h = mul32(bit32.bxor(h, string.byte(name, i)), 0x01000193)
	end
	h = mul32(bit32.bxor(h, bit32.rshift(h, 16)), 0x85ebca6b)
	h = mul32(bit32.bxor(h, bit32.rshift(h, 13)), 0xc2b2ae35)
	return bit32.bxor(h, bit32.rshift(h, 16))
end

local AVATAR = tern.json.decode(tern.fs.read(tern.plugin.dir .. "/avatars.json"))
local PARTS = { "body", "color", "eyes", "accessory", "motion" }

local function part(kind: string, name: any): any
	for _, item in ipairs(AVATAR[kind]) do
		if item.name == name then
			return item
		end
	end
	return nil
end

-- A bot's parts: one of each, seeded from its name, with the roster's "avatar" table overriding any of them.
local function parts(bot: Bot): { [string]: string }
	local h = hash(bot.name)
	local own = type(bot.avatar) == "table" and bot.avatar or {}
	local got: { [string]: string } = {}
	for _, kind in ipairs(PARTS) do
		local list = AVATAR[kind]
		got[kind] = list[h % #list + 1].name
		h = h // #list
		local want = own[kind]
		if want ~= nil then
			if part(kind, want) or (kind == "body" and AVATAR.sprites[want]) or (kind == "color" and type(want) == "string" and want:match("^#%x+$")) then
				got[kind] = want
			else
				print("omp bots: " .. bot.name .. "'s avatar has no " .. kind .. " " .. tostring(want))
			end
		end
	end
	return got
end

local function avatar(bot: Bot): string
	local got = parts(bot)
	local rows = AVATAR.sprites[got.body]
	if rows then
		return "--bot-face: url(\"avatars/" .. got.body .. ".png\"); --bot-cols: 10; --bot-rows: " .. rows .. "; --bot-move: avatar-" .. got.body .. "; --bot-move-big: avatar-" .. got.body .. "-big;"
	end
	local body = part("body", got.body)
	local color = part("color", got.color)
	local ink = color and color.hex or got.color
	local svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'><mask id='e'><rect width='128' height='128' fill='white'/>"
		.. "<g transform='translate(" .. body.eyes[1] .. " " .. body.eyes[2] .. ")'>" .. part("eyes", got.eyes).svg .. "</g></mask>"
		.. "<g fill='" .. ink .. "' stroke='" .. ink .. "' stroke-width='0' mask='url(#e)'>" .. body.svg
		.. "<g transform='translate(" .. body.top[1] .. " " .. body.top[2] .. ")'>" .. part("accessory", got.accessory).svg .. "</g></g></svg>"
	local url = svg:gsub("#", "%%23"):gsub("<", "%%3C"):gsub(">", "%%3E")
	return "--bot-face: url(\"data:image/svg+xml," .. url .. "\"); --bot-cols: 1; --bot-rows: 1; --bot-move: avatar-" .. got.motion .. "; --bot-move-big: avatar-" .. got.motion .. ";"
end

local function quote(s: string): string
	return "'" .. s:gsub("'", "'\\''") .. "'"
end

local function roster(): { Bot }
	return tern.json.decode(tern.fs.read(tern.fs.exists(ROSTER) and ROSTER or ROOT .. "/bots.json"))
end

-- Per-bot avatar variables for avatars.css, keyed by tint like every bot row; a tint two bots share keeps the default.
local function show_avatars(bots: { Bot })
	local rules = { ":root { --bot-face: url(\"avatars/sol.png\"); --bot-cols: 10; --bot-rows: 8; --bot-move: avatar-sol; --bot-move-big: avatar-sol-big; }" }
	local tints: { [string]: number } = {}
	for _, bot in ipairs(bots) do
		if bot.tint then
			tints[bot.tint] = (tints[bot.tint] or 0) + 1
		end
	end
	for _, bot in ipairs(bots) do
		if bot.tint and tints[bot.tint] == 1 then
			rules[#rules + 1] = ":root:not(#bot) :is([data-role^='omp.bot.'][data-role$='." .. bot.tint .. "'], #tabbar .tt[data-tc='" .. bot.tint .. "']) { " .. avatar(bot) .. " }"
		end
	end
	tern.css("avatars", table.concat(rules, "\n"))
end

local current: { Bot } = {}
local faces = ""

-- A tab of a bot keeps that bot's tint, also when a reopened tab (or an attach) came back without one.
local function ensure_colors(cx: WindowCx)
	local by_name: { [string]: Bot } = {}
	for _, bot in ipairs(current) do
		by_name[bot.name] = bot
	end
	for _, tab in ipairs(cx.session:tabs()) do
		local bot = tab.name and by_name[tab.name]
		if bot and bot.tint and not tab.color then
			cx.layout:color_tab(tab.id, bot.tint :: any)
		end
	end
end

local function show_faces(cx: WindowCx?)
	if not cx then
		return
	end
	ensure_colors(cx)
	local by_tint: { [string]: Bot } = {}
	local by_name: { [string]: Bot } = {}
	local shared: { [string]: boolean } = {}
	for _, bot in ipairs(current) do
		by_name[bot.name] = bot
		if bot.tint then
			shared[bot.tint] = by_tint[bot.tint] ~= nil
			by_tint[bot.tint] = bot
		end
	end
	local owner: { [number]: Bot } = {}
	for _, tab in ipairs(cx.session:tabs()) do
		local bot = tab.name and by_name[tab.name]
		if not bot and tab.color and by_tint[tab.color] and not shared[tab.color] then
			bot = by_tint[tab.color]
		end
		if bot then
			owner[tab.id] = bot
		end
	end
	local faces_of, faces_text = {}, {}
	for _, pane in ipairs(cx.session:panes()) do
		local bot = pane.tab and owner[pane.tab]
		if bot then
			faces_of[#faces_of + 1] = "#banners .tn-dk-c[data-pane='" .. pane.pane .. "']"
			faces_text[#faces_text + 1] = bot
		end
	end
	local rules = {}
	for index, selector in ipairs(faces_of) do
		rules[#rules + 1] = ":root:not(#bot) " .. selector .. " { " .. avatar(faces_text[index]) .. " left: 0; top: 0; width: 100%; height: 100%; border-radius: 0; background: var(--bot-face) 0 0 / calc(100% * var(--bot-cols)) calc(100% * var(--bot-rows)) no-repeat; box-shadow: none; }"
		rules[#rules + 1] = ":root:not(#bot) " .. selector .. " > * { display: none; }"
		rules[#rules + 1] = ":root:not(#bot) " .. selector .. "::before, :root:not(#bot) " .. selector .. "::after { content: none; }"
	end
	local text = table.concat(rules, "\n")
	if text ~= faces then
		faces = text
		tern.css("faces", text)
	end
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
	current = bots
	show_avatars(bots)
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
						local bot = { name = name, tint = free_tint(), cwd = "~" }
						local now = roster()
						now[#now + 1] = bot
						show(now)
						open(cx4, bot, true)
					end)
				end)
				return
			end
		end
		local bot = { name = name, tint = free_tint(), cwd = "~" }
		bots[#bots + 1] = bot
		show(bots)
		open(cx2, bot, true)
	end)
end

local function new_bot(cx: WindowCx)
	local bots = roster()
	local items = {}
	for _, bot in ipairs(bots) do
		items[#items + 1] = { label = bot.name, icon = "sparkle", bot = bot }
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
		items[#items + 1] = { label = bot.name, icon = "trash", bot = bot }
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

-- The roster's folder, as bin/ scripts read it.
local function state_env(): { [string]: string }
	local env = {}
	local state = tern.getenv("OMP_BOT_STATE")
	if state then
		env.OMP_BOT_STATE = state
	end
	return env
end

-- Tern's pick items take only an icon name, so a sheet keyed on row position draws each row's face; a row matches
-- only while the list is whole, so a typed filter, which drops rows, falls back to the icons.
local function pick_faces(cx: WindowCx, opts: any, faces: { string }): any
	local n = #faces
	local rules = {}
	for i, face in ipairs(faces) do
		local row = ":root:not(#bot) #pick .ck-item:nth-child(" .. i .. " of .ck-item):nth-last-child(" .. (n - i + 1) .. " of .ck-item)"
		rules[#rules + 1] = row .. " .ck-ic { " .. face .. " width: 32px; height: 32px; background: var(--bot-face) 0 0 / calc(32px * var(--bot-cols)) calc(32px * var(--bot-rows)) no-repeat; }"
		rules[#rules + 1] = row .. " .ck-ic > .ico { display: none; }"
		rules[#rules + 1] = row .. "[aria-selected='true'] .ck-ic { animation: var(--bot-move) 4s steps(1, end) infinite; }"
	end
	rules[#rules + 1] = "@media (prefers-reduced-motion: reduce) { :root:not(#bot) #pick .ck-item .ck-ic { animation: none !important; } }"
	tern.css("pick", table.concat(rules, "\n"))
	return cx:pick(opts)
end

-- Writes one bot's "avatar" (nil drops it, back to the parts its name picks) and redraws every avatar in place.
local function save_avatar(name: string, own: { [string]: string }?)
	local fields = {}
	for _, kind in ipairs(PARTS) do
		if own and own[kind] then
			fields[#fields + 1] = tern.json.encode(kind) .. ": " .. tern.json.encode(own[kind])
		end
	end
	tern.process.run({ ROOT .. "/bin/omp-bot-avatar", name, own and ("{" .. table.concat(fields, ", ") .. "}") or "--name" }, { env = state_env(), timeout_ms = 10000 }, function(result, cx)
		if result.status ~= 0 then
			if cx then
				cx:toast("error", "Could not save " .. name .. "'s avatar", (result.stderr:gsub("%s+$", "")))
			end
			return
		end
		show(roster())
		show_faces(cx)
	end)
end

local KIND_NAMES: { [string]: string } = { body = "body", color = "colour", eyes = "eyes", accessory = "accessory", motion = "motion" }

-- One part per pick, in PARTS order, each row drawn as the bot would look with it; a drawn sprite or "From name" ends the chain.
local function pick_part(cx: WindowCx, bot: Bot, own: { [string]: string }, step: number)
	local kind = PARTS[step]
	local now = parts({ name = bot.name, avatar = own } :: any)
	local items, faces = {}, {}
	local function add(item: any, try: { [string]: string }?)
		item.icon = "sparkle"
		items[#items + 1] = item
		faces[#faces + 1] = avatar({ name = bot.name, avatar = try } :: any)
	end
	if kind == "body" then
		add({ label = "From name", detail = "parts picked from the name " .. bot.name, reset = true, current = bot.avatar == nil }, nil)
		local sprites = {}
		for name in AVATAR.sprites do
			sprites[#sprites + 1] = name
		end
		table.sort(sprites)
		for _, name in ipairs(sprites) do
			add({ label = name, detail = "drawn", value = name, current = now.body == name }, { body = name })
		end
	end
	for _, item in ipairs(AVATAR[kind]) do
		local try = table.clone(own)
		try[kind] = item.name
		add({ label = item.name, detail = item.hex, value = item.name, current = now[kind] == item.name }, try)
	end
	local last = step == #PARTS
	pick_faces(cx, { items = items, placeholder = bot.name .. "'s " .. KIND_NAMES[kind], icon = "sparkle", action = last and "save" or "next" }, faces):next(function(item, _, cx2)
		tern.css("pick", "")
		if not item or not cx2 then
			return
		end
		if item.reset then
			save_avatar(bot.name, nil)
		elseif AVATAR.sprites[item.value :: string] then
			save_avatar(bot.name, { body = item.value })
		else
			own[kind] = item.value
			if last then
				save_avatar(bot.name, own)
			else
				pick_part(cx2, bot, own, step + 1)
			end
		end
	end)
end

local function change_avatar(cx: WindowCx)
	local bots = roster()
	local items, faces = {}, {}
	for _, bot in ipairs(bots) do
		items[#items + 1] = { label = bot.name, icon = "sparkle", bot = bot }
		faces[#faces + 1] = avatar(bot)
	end
	pick_faces(cx, { items = items, placeholder = "Change whose avatar?", icon = "sparkle", action = "next" }, faces):next(function(item, _, cx2)
		tern.css("pick", "")
		if item and cx2 then
			pick_part(cx2, item.bot, parts(item.bot), 1)
		end
	end)
end

tern.command({ id = "new", title = "Bots: Open bot", icon = "sparkle", run = new_bot })
tern.command({ id = "remove", title = "Bots: Remove bot", icon = "trash", run = remove_bot })
tern.command({ id = "avatar", title = "Bots: Change avatar", icon = "sparkle", run = change_avatar })
tern.command({ id = "open_all", title = "Bots: Open all", icon = "sparkle", run = open_all })
tern.command({ id = "stage", title = "Bots: Stage demo", available = function()
	return false
end, run = stage })

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

for _, event in ipairs({ "focus", "tab_created", "tab_closed", "pane_created", "pane_closed", "agent_state" }) do
	tern.on(event, function(_ev, cx: WindowCx)
		register(roster())
		show_faces(cx)
	end)
end

tern.timer(0, show_faces)

