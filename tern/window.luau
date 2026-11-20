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
local PARTS = { "body", "ink" }
local BODY_NAMES, INK_NAMES = {}, {}
for name in AVATAR.bodies do
	BODY_NAMES[#BODY_NAMES + 1] = name
end
for name in AVATAR.inks do
	INK_NAMES[#INK_NAMES + 1] = name
end
table.sort(BODY_NAMES)
table.sort(INK_NAMES)

-- A bot's look: one body and one ink, fixed per name and overridden piecemeal by the roster's "avatar" table.
local function look(bot: Bot): { body: string, ink: string }
	local h = hash(bot.name)
	local fixed = AVATAR.bots[bot.name]
	local body = fixed and fixed.body or BODY_NAMES[h % #BODY_NAMES + 1]
	h = h // #BODY_NAMES
	local ink = fixed and fixed.ink or INK_NAMES[h % #INK_NAMES + 1]
	local own = type(bot.avatar) == "table" and bot.avatar or {}
	if own.body ~= nil then
		if AVATAR.bodies[own.body] then
			body = own.body
		else
			print("omp bots: " .. bot.name .. "'s avatar has no body " .. tostring(own.body))
		end
	end
	if own.ink ~= nil then
		if AVATAR.inks[own.ink] then
			ink = own.ink
		else
			print("omp bots: " .. bot.name .. "'s avatar has no colour " .. tostring(own.ink))
		end
	end
	return { body = body, ink = ink }
end

-- Every body wears the same face: two eyes two pixels wide, in the one place a chat row, a tab and a notification card
-- all agree on, so one frame of it is one image any body can use. A shape is runs of white pixels off an eye's top left
-- corner, and a gaze moves them one pixel toward where the bot looks.
local EYES = { left = 5, right = 9, top = 6 }
local GAZES = { c = { 0, 0 }, l = { -1, 0 }, r = { 1, 0 }, u = { 0, -1 }, d = { 0, 1 } }
local GAZE_NAMES = { "c", "l", "r", "u", "d" }
local SHAPES = {
	open = { left = { { 0, 0, 2, 3 } }, right = { { 0, 0, 2, 3 } } },
	squint = { left = { { 0, 1, 2, 2 } }, right = { { 0, 1, 2, 2 } } },
	wide = { left = { { 0, 0, 2, 4 } }, right = { { 0, 0, 2, 4 } } },
	shut = { left = { { 0, 2, 2, 1 } }, right = { { 0, 2, 2, 1 } } },
	happy = { left = { { 0, 2, 1, 1 }, { 1, 1, 1, 1 } }, right = { { 1, 2, 1, 1 }, { 0, 1, 1, 1 } } },
	sad = { left = { { 0, 1, 1, 1 }, { 1, 2, 1, 1 } }, right = { { 1, 1, 1, 1 }, { 0, 2, 1, 1 } } },
}

-- The ink moved toward black (factor < 1) or white (factor > 1), so one body can carry a shade and a highlight.
local function shade(hex: string, factor: number): string
	local function jump(v: number): number
		local aim = factor < 1 and v * factor or v + (255 - v) * (factor - 1)
		return math.max(0, math.min(255, math.floor(aim + 0.5)))
	end
	return string.format("#%02x%02x%02x", jump(tonumber(hex:sub(2, 3), 16)), jump(tonumber(hex:sub(4, 5), 16)), jump(tonumber(hex:sub(6, 7), 16)))
end

-- Tern takes an SVG only as a percent-escaped data URL, so every piece is written escaped: passing the sheet through
-- gsub afterwards costs about a millisecond a kilobyte in a plugin's window half, a fifth of the hook's 50 ms.
local SVG_OPEN = "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' shape-rendering='crispEdges'%3E"
local SVG_SHUT = "%3C/svg%3E"
local WHITE = "%23fff"

local function rect(parts: { string }, x: number, y: number, w: number, h: number, fill: string)
	parts[#parts + 1] = "%3Crect x='" .. x .. "' y='" .. y .. "' width='" .. w .. "' height='" .. h .. "' fill='" .. fill .. "'/%3E"
end

type Run = { [number]: number }

-- A body's rows as one run of pixels per run of a tone, found once with the pattern engine: b is the ink, s its shade,
-- l its light. Every skin that body can wear is these same runs in another colour.
local BODY_RUNS: { [string]: { Run } } = {}
local function body_runs(body: string): { Run }
	local got = BODY_RUNS[body]
	if got then
		return got
	end
	local tone: { [string]: number } = { b = 1, s = 2, l = 3 }
	local runs = {}
	for y, line in ipairs(AVATAR.bodies[body].rows) do
		for start, run in line:gmatch("()([bsl]+)") do
			local tone_char = run:sub(1, 1)
			if run == string.rep(tone_char, #run) then
				runs[#runs + 1] = { start - 1, y - 1, #run, tone[tone_char] }
			else
				local at = 1
				while at <= #run do
					local width = 1
					while at + width <= #run and run:sub(at + width, at + width) == tone_char do
						width = width + 1
					end
					runs[#runs + 1] = { start + at - 2, y - 1, width, tone[tone_char] }
					at = at + width
					tone_char = run:sub(at, at)
				end
			end
		end
	end
	BODY_RUNS[body] = runs
	return runs
end

-- The ink, shade and light one ink gives every body, escaped once however many skins wear it.
local INK_TONES: { [string]: { [number]: string } } = {}
local function ink_tones(ink: string): { [number]: string }
	local got = INK_TONES[ink]
	if got then
		return got
	end
	local hex = AVATAR.inks[ink]
	local function fill(colour: string): string
		return "%23" .. colour:sub(2)
	end
	got = { fill(hex), fill(shade(hex, 0.76)), fill(shade(hex, 1.22)) }
	INK_TONES[ink] = got
	return got
end

local function body_parts(parts: { string }, body: string, ink: string): { string }
	local tones = ink_tones(ink)
	for _, run in ipairs(body_runs(body)) do
		rect(parts, run[1], run[2], run[3], 1, tones[run[4]])
	end
	return parts
end

local function eye_parts(parts: { string }, shape: string, gaze: string): { string }
	local gx, gy = GAZES[gaze][1], GAZES[gaze][2]
	local def = SHAPES[shape]
	for _, eye in ipairs({ { EYES.left, def.left }, { EYES.right, def.right } }) do
		for _, run in ipairs(eye[2]) do
			rect(parts, eye[1] + run[1] + gx, EYES.top + run[2] + gy, run[3], run[4], WHITE)
		end
	end
	return parts
end

local function svg(parts: { string }): string
	return SVG_OPEN .. table.concat(parts) .. SVG_SHUT
end

-- A data URL of SVG that is already escaped, so it only needs wrapping.
local function image(escaped: string): string
	return "url(\"data:image/svg+xml," .. escaped .. "\")"
end

-- One body in one ink as the rects a skin or a face wears, and a shape's pixels at the gaze a still shows: a face is
-- the two joined, so a rail of bots draws each body once rather than once per face.
local BODY_INK: { [string]: string } = {}
local function body_ink(body: string, ink: string): string
	local key = body .. "." .. ink
	local got = BODY_INK[key]
	if got then
		return got
	end
	got = table.concat(body_parts({}, body, ink))
	BODY_INK[key] = got
	return got
end

local EYES: { [string]: string } = {}
local function eyes(shape: string): string
	local got = EYES[shape]
	if got then
		return got
	end
	got = table.concat(eye_parts({}, shape, "c"))
	EYES[shape] = got
	return got
end

-- One still image for everywhere but a bot chat: the body with one face, since a tab or a card shows a still.
local function face(body: string, ink: string, shape: string): string
	return svg({ body_ink(body, ink), eyes(shape) })
end

-- The resting face, the same body with its eyes shut, and the open eyes on their own. avatars.css blinks a tab by hiding
-- the open eyes over the shut pair, so a bot blinks in the tab list too, not only in a chat body.
local function avatar(bot: Bot): string
	local got = look(bot)
	return "--bot-face: " .. image(face(got.body, got.ink, "open"))
		.. "; --bot-shut: " .. image(face(got.body, got.ink, "shut"))
		.. "; --bot-eyes: " .. image(svg({ eyes("open") }))
		.. "; --bot-ink: " .. AVATAR.inks[got.ink] .. ";"
end

-- A bot's own clock: how often it blinks and glances, and where in those cycles it starts, seeded by its name so six
-- bots do not blink together. Stepped CSS animations, so Tern draws only when a step lands, and nothing at all offscreen.
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

-- Every skin and every face frame avatars.css paints: a chat body is a skin under a face, so a blink or a look is an
-- image Tern already has, not a redraw of the pixel grid. The rail and the tabs show none of these, so `paint` draws
-- them after the first frame and the load hook keeps its budget on a login busy enough to slow every Lua step.
local function skins(): string
	local rules = {}
	for _, body in ipairs(BODY_NAMES) do
		for _, ink in ipairs(INK_NAMES) do
			rules[#rules + 1] = ":root:not(#bot) [data-role='omp.bot.skin." .. body .. "." .. ink .. "'] { background-image: " .. image(svg({ body_ink(body, ink) })) .. "; }"
		end
	end
	return table.concat(rules, "\n")
end

local function frames(): string
	local rules = {}
	for shape in SHAPES do
		for _, gaze in ipairs(GAZE_NAMES) do
			rules[#rules + 1] = ":root:not(#bot) [data-role='omp.bot.face." .. shape .. "." .. gaze .. "'] { background-image: " .. image(svg(eye_parts({}, shape, gaze))) .. "; }"
		end
	end
	rules[#rules + 1] = ":root:not(#bot) [data-role='omp.bot.lid'] { background-image: " .. image(svg(eye_parts({}, "shut", "c"))) .. "; }"
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
		rules[#rules + 1] = ":root:not(#bot) " .. selector .. " { " .. avatar(faces_text[index]) .. " left: 0; top: 0; width: 100%; height: 100%; border-radius: 0; background: var(--bot-face) center / 32px 32px no-repeat; image-rendering: pixelated; box-shadow: none; }"
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
		rules[#rules + 1] = row .. " .ck-ic { " .. face .. " width: 32px; height: 32px; background: var(--bot-face) center / 32px 32px no-repeat; image-rendering: pixelated; }"
		rules[#rules + 1] = row .. " .ck-ic > .ico { display: none; }"
		rules[#rules + 1] = row .. "[aria-selected='true'] .ck-ic { animation: bot-hop 1600ms steps(1, end) infinite; }"
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

local KIND_NAMES: { [string]: string } = { body = "body", ink = "colour" }

-- One part per pick, in PARTS order, each row drawn as the bot would look with it; "From name" ends the chain.
local function pick_part(cx: WindowCx, bot: Bot, own: { [string]: string }, step: number)
	local kind = PARTS[step]
	local now = look({ name = bot.name, avatar = own } :: any)
	local items, faces = {}, {}
	local function add(item: any, try: { [string]: string }?)
		item.icon = "sparkle"
		items[#items + 1] = item
		faces[#faces + 1] = avatar({ name = bot.name, avatar = try } :: any)
	end
	if kind == "body" then
		add({ label = "From name", detail = "body and colour picked from the name " .. bot.name, reset = true, current = bot.avatar == nil }, nil)
		for _, name in ipairs(BODY_NAMES) do
			add({ label = name, value = name, current = now.body == name }, { body = name, ink = now.ink })
		end
	else
		for _, name in ipairs(INK_NAMES) do
			add({ label = name, detail = AVATAR.inks[name], value = name, current = now.ink == name }, { body = now.body, ink = name })
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

