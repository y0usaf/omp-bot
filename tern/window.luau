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
local PARTS = { "shape", "color" }
local SHAPE_NAMES, COLOR_NAMES = {}, {}
for name in AVATAR.shapes do
	SHAPE_NAMES[#SHAPE_NAMES + 1] = name
end
for name in AVATAR.colors do
	COLOR_NAMES[#COLOR_NAMES + 1] = name
end
table.sort(SHAPE_NAMES)
table.sort(COLOR_NAMES)
local AUTO_COLORS = AVATAR.autoColors or COLOR_NAMES

local function look(bot: Bot): { shape: string, color: string }
	local h = hash(bot.name)
	local fixed = AVATAR.bots[bot.name]
	local shape = fixed and fixed.shape or SHAPE_NAMES[h % #SHAPE_NAMES + 1]
	h = h // #SHAPE_NAMES
	local color = fixed and fixed.color or AUTO_COLORS[h % #AUTO_COLORS + 1]
	local own = type(bot.avatar) == "table" and bot.avatar or {}
	if own.shape ~= nil then
		if AVATAR.shapes[own.shape] then
			shape = own.shape
		else
			print("omp bots: " .. bot.name .. "'s avatar has no shape " .. tostring(own.shape))
		end
	end
	if own.color ~= nil then
		if AVATAR.colors[own.color] then
			color = own.color
		else
			print("omp bots: " .. bot.name .. "'s avatar has no colour " .. tostring(own.color))
		end
	end
	return { shape = shape, color = color }
end

local CX = AVATAR.center or 114.2705
local SVG_OPEN = "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='" .. (AVATAR.viewBox or "-15 -15 259 259") .. "'%3E"
local SVG_SHUT = "%3C/svg%3E"

local FACES: { [string]: number } = {
	open = 7,
	listen = 7,
	thinking = 7,
	working = 7,
	wide = 7,
	happy = 7,
	drowsy = 7,
	sleep = 2,
	error = 7,
}

local function hex_esc(hex: string): string
	return "%23" .. hex:sub(2)
end

local function svg(parts: { string }): string
	return SVG_OPEN .. table.concat(parts) .. SVG_SHUT
end

local function image(escaped: string): string
	return "url(\"data:image/svg+xml," .. escaped .. "\")"
end

local SKIN_CACHE: { [string]: string } = {}
local function skin_parts(shape: string, color: string): string
	local key = shape .. "." .. color
	local got = SKIN_CACHE[key]
	if got then
		return got
	end
	local pair = AVATAR.colors[color] or AVATAR.colors.blue
	local d = AVATAR.shapes[shape] or AVATAR.shapes.blob
	got = "%3Cdefs%3E%3ClinearGradient id='g' x1='0' x2='1' y1='0' y2='1'%3E"
		.. "%3Cstop offset='0' stop-color='" .. hex_esc(pair.light) .. "'/%3E"
		.. "%3Cstop offset='1' stop-color='" .. hex_esc(pair.dark) .. "'/%3E"
		.. "%3C/linearGradient%3E%3C/defs%3E"
		.. "%3Cpath d='" .. d .. "' fill='url(%23g)'/%3E"
	SKIN_CACHE[key] = got
	return got
end

local function face_parts(pose: string, fill: string): string
	local ry = string.format("%.2f", FACES[pose] or 7)
	local lx = string.format("%.2f", CX - 29)
	local rx = string.format("%.2f", CX + 29)
	local cy = string.format("%.2f", CX - 8)
	return "%3Cg fill='" .. fill .. "'%3E"
		.. "%3Cellipse cx='" .. lx .. "' cy='" .. cy .. "' rx='10' ry='" .. ry .. "'/%3E"
		.. "%3Cellipse cx='" .. rx .. "' cy='" .. cy .. "' rx='10' ry='" .. ry .. "'/%3E"
		.. "%3C/g%3E"
end

local function smile_parts(fill: string): string
	local x0 = string.format("%.2f", CX - 20)
	local xm = string.format("%.2f", CX)
	local x1 = string.format("%.2f", CX + 20)
	local y0 = string.format("%.2f", CX + 24)
	local ym = string.format("%.2f", CX + 38)
	return "%3Cpath d='M" .. x0 .. " " .. y0 .. " Q" .. xm .. " " .. ym .. " " .. x1 .. " " .. y0
		.. "' fill='none' stroke='" .. fill .. "' stroke-linecap='round' stroke-width='5'/%3E"
end

local EYE_LIGHT = "%23ffffff"
local EYE_DARK = "%23161616"
local EYES_OPEN_LIGHT = image(svg({ face_parts("open", EYE_LIGHT) }))
local EYES_OPEN_DARK = image(svg({ face_parts("open", EYE_DARK) }))

local function avatar(bot: Bot): string
	local got = look(bot)
	local skin = skin_parts(got.shape, got.color)
	local pair = AVATAR.colors[got.color] or AVATAR.colors.blue
	return "--bot-face: " .. image(svg({ skin, face_parts("open", EYE_LIGHT) }))
		.. "; --bot-face-dark: " .. image(svg({ skin, face_parts("open", EYE_DARK) }))
		.. "; --bot-skin: " .. image(svg({ skin }))
		.. "; --bot-ink: " .. pair.light .. ";"
end

local function tempo(name: string): string
	local h = hash(name)
	local a, b = h % 256, h // 256 % 256
	local c, d = h // 65536 % 256, h // 16777216 % 256
	local blink = 4.6 + a / 255 * 2.8
	local glance = 10 + c / 255 * 8
	return string.format(
		"--bot-blink: %.2fs; --bot-blink-delay: -%.2fs; --bot-glance: %.2fs; --bot-glance-delay: -%.2fs;",
		blink, blink * b / 255,
		glance, glance * d / 255
	)
end

local function skins(): string
	local rules = {}
	for _, shape in ipairs(SHAPE_NAMES) do
		for _, color in ipairs(COLOR_NAMES) do
			rules[#rules + 1] = ":root:not(#bot) [data-role='omp.bot.skin." .. shape .. "." .. color .. "'] { background-image: " .. image(svg({ skin_parts(shape, color) })) .. "; }"
		end
	end
	return table.concat(rules, "\n")
end

local function frames(): string
	local rules = {
		":root:not(#bot) { --bot-eyes: " .. EYES_OPEN_LIGHT .. "; }",
		":root[data-theme='dark']:not(#bot) { --bot-eyes: " .. EYES_OPEN_DARK .. "; }",
	}
	for pose in FACES do
		rules[#rules + 1] = ":root:not(#bot) [data-role='omp.bot.face." .. pose .. "'] { background-image: " .. image(svg({ face_parts(pose, EYE_LIGHT) })) .. "; }"
		rules[#rules + 1] = ":root[data-theme='dark']:not(#bot) [data-role='omp.bot.face." .. pose .. "'] { background-image: " .. image(svg({ face_parts(pose, EYE_DARK) })) .. "; }"
	end
	rules[#rules + 1] = ":root:not(#bot) [data-role='omp.bot.lid'] { background-image: " .. image(svg({ smile_parts(EYE_LIGHT) })) .. "; }"
	rules[#rules + 1] = ":root[data-theme='dark']:not(#bot) [data-role='omp.bot.lid'] { background-image: " .. image(svg({ smile_parts(EYE_DARK) })) .. "; }"
	return table.concat(rules, "\n")
end

local function paint()
	tern.css("frames", frames())
	tern.timer(0, function()
		tern.css("skins", skins())
	end)
end

local function quote(s: string): string
	return "'" .. s:gsub("'", "'\\''") .. "'"
end

local function roster(): { Bot }
	return tern.json.decode(tern.fs.read(tern.fs.exists(ROSTER) and ROSTER or ROOT .. "/bots.json"))
end

local SAND_ACCENTS: { [string]: { light: string, dark: string } } = {
	blue = { light = "#126fd4", dark = "#116dd2" },
	red = { light = "#c82532", dark = "#cf2b35" },
	orange = { light = "#d2550a", dark = "#cd5309" },
	yellow = { light = "#c2730b", dark = "#c8770c" },
	green = { light = "#0d9655", dark = "#0e9f5a" },
	cyan = { light = "#0d9381", dark = "#0e9886" },
	teal = { light = "#0d9381", dark = "#0e9886" },
	purple = { light = "#7442d1", dark = "#7845d7" },
	magenta = { light = "#c82779", dark = "#cf297e" },
	pink = { light = "#c82779", dark = "#cf297e" },
	brown = { light = "#86592e", dark = "#8c5d31" },
}

local function accent_vars(tint: string?): string?
	local pair = tint and SAND_ACCENTS[tint] or nil
	if not pair then
		return nil
	end
	local val = "light-dark(" .. pair.light .. ", " .. pair.dark .. ")"
	return "--sand-fill-bubble-user: " .. val
		.. "; --sand-accent: " .. val
		.. "; --sand-prompt-cta-fill: " .. val
		.. "; --sand-focus: " .. val .. ";"
end

local function show_avatars(bots: { Bot })
	local rules = {
		":root { " .. avatar({ name = "", avatar = AVATAR.default } :: any) .. " }",
		":root:not(#bot) #tabbar .tt[data-tc] :is(.tn-ib-pip, .tn-dk-pip) { --sand-accent: light-dark(#1680f3, #4d9bff); --accent: light-dark(#1680f3, #4d9bff); --accent-fill: light-dark(#1680f3, #4d9bff); }",
	}
	local tints: { [string]: number } = {}
	local tint_order: { string } = {}
	for _, bot in ipairs(bots) do
		if bot.tint then
			if not tints[bot.tint] then
				tint_order[#tint_order + 1] = bot.tint
			end
			tints[bot.tint] = (tints[bot.tint] or 0) + 1
		end
	end
	for _, tint in ipairs(tint_order) do
		local vars = accent_vars(tint)
		if vars then
			local own = "[data-role='omp.bot.top." .. tint .. "'], [data-role='omp.bot.chat." .. tint .. "'], [data-role='omp.bot.hero." .. tint .. "']"
			rules[#rules + 1] = ":root:not(#bot) :is(.sf-chat-reader:has(" .. own .. "), .tn-pane:has(" .. own .. "), #tabbar .tt[data-tc='" .. tint .. "']) { " .. vars .. " }"
		end
	end
	for _, bot in ipairs(bots) do
		if bot.tint and tints[bot.tint] == 1 then
			rules[#rules + 1] = ":root:not(#bot) :is([data-role^='omp.bot.'][data-role$='." .. bot.tint .. "'], #tabbar .tt[data-tc='" .. bot.tint .. "']) { " .. avatar(bot) .. " " .. tempo(bot.name) .. " }"
		end
	end
	tern.css("avatars", table.concat(rules, "\n"))
end

local current: { Bot } = {}
local faces = ""

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
	local faces_of, faces_text, pane_ids = {}, {}, {}
	for _, pane in ipairs(cx.session:panes()) do
		local bot = pane.tab and owner[pane.tab]
		if bot then
			faces_of[#faces_of + 1] = "#banners .tn-dk-c[data-pane='" .. pane.pane .. "']"
			faces_text[#faces_text + 1] = bot
			pane_ids[#pane_ids + 1] = pane.pane
		end
	end
	local rules = {}
	for index, selector in ipairs(faces_of) do
		rules[#rules + 1] = ":root:not(#bot) " .. selector .. " { " .. avatar(faces_text[index]) .. " left: 0; top: 0; width: 100%; height: 100%; border-radius: 0; background: var(--bot-face) center / 28px 28px no-repeat; box-shadow: none; }"
		rules[#rules + 1] = ":root[data-theme='dark']:not(#bot) " .. selector .. " { background-image: var(--bot-face-dark); }"
		rules[#rules + 1] = ":root:not(#bot) " .. selector .. " > * { display: none; }"
		rules[#rules + 1] = ":root:not(#bot) " .. selector .. "::before, :root:not(#bot) " .. selector .. "::after { content: none; }"
		local vars = accent_vars(faces_text[index].tint)
		if vars then
			rules[#rules + 1] = ":root:not(#bot) .tn-pane[data-pane='" .. pane_ids[index] .. "'] { " .. vars .. " }"
		end
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

local function state_env(): { [string]: string }
	local env = {}
	local state = tern.getenv("OMP_BOT_STATE")
	if state then
		env.OMP_BOT_STATE = state
	end
	return env
end

local function pick_faces(cx: WindowCx, opts: any, faces: { string }): any
	local n = #faces
	local rules = {}
	for i, face in ipairs(faces) do
		local row = ":root:not(#bot) #pick .ck-item:nth-child(" .. i .. " of .ck-item):nth-last-child(" .. (n - i + 1) .. " of .ck-item)"
		rules[#rules + 1] = row .. " .ck-ic { " .. face .. " width: 28px; height: 28px; background: var(--bot-face) center / 100% 100% no-repeat; }"
		rules[#rules + 1] = ":root[data-theme='dark']:not(#bot) #pick .ck-item:nth-child(" .. i .. " of .ck-item):nth-last-child(" .. (n - i + 1) .. " of .ck-item) .ck-ic { background-image: var(--bot-face-dark); }"
		rules[#rules + 1] = row .. " .ck-ic > .ico { display: none; }"
		rules[#rules + 1] = row .. "[aria-selected='true'] .ck-ic { --bot-amp: 1.158%; --bot-tilt: 0deg; animation: bot-bob 2500ms linear infinite; }"
	end
	rules[#rules + 1] = "@media (prefers-reduced-motion: reduce) { :root:not(#bot) #pick .ck-item .ck-ic { animation: none !important; } }"
	tern.css("pick", table.concat(rules, "\n"))
	return cx:pick(opts)
end

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

local KIND_NAMES: { [string]: string } = { shape = "shape", color = "colour" }

local function pick_part(cx: WindowCx, bot: Bot, own: { [string]: string }, step: number)
	local kind = PARTS[step]
	local now = look({ name = bot.name, avatar = own } :: any)
	local items, faces = {}, {}
	local function add(item: any, try: { [string]: string }?)
		item.icon = "sparkle"
		items[#items + 1] = item
		faces[#faces + 1] = avatar({ name = bot.name, avatar = try } :: any)
	end
	if kind == "shape" then
		add({ label = "From name", detail = "shape and colour picked from the name " .. bot.name, reset = true, current = bot.avatar == nil }, nil)
		for _, name in ipairs(SHAPE_NAMES) do
			add({ label = name, value = name, current = now.shape == name }, { shape = name, color = now.color })
		end
	else
		for _, name in ipairs(COLOR_NAMES) do
			add({ label = name, detail = AVATAR.colors[name].light, value = name, current = now.color == name }, { shape = now.shape, color = name })
		end
	end
	local last = step == #PARTS
	pick_faces(cx, { items = items, placeholder = bot.name .. "'s " .. KIND_NAMES[kind], icon = "sparkle", action = last and "save" or "next" }, faces):next(function(item, _, cx2)
		tern.css("pick", "")
		if not item or not cx2 then
			return
		end
		if item.reset then
			save_avatar(bot.name, nil)
			return
		end
		own[kind] = item.value
		if last then
			save_avatar(bot.name, own)
		else
			pick_part(cx2, bot, own, step + 1)
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
			pick_part(cx2, item.bot, look(item.bot), 1)
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
paint()

for _, event in ipairs({ "focus", "tab_created", "tab_closed", "pane_created", "pane_closed", "agent_state" }) do
	tern.on(event, function(_ev, cx: WindowCx)
		register(roster())
		show_faces(cx)
	end)
end

tern.timer(0, show_faces)

