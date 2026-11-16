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

local function rect(parts: { string }, x: number, y: number, w: number, h: number, fill: string)
	parts[#parts + 1] = "<rect x='" .. x .. "' y='" .. y .. "' width='" .. w .. "' height='" .. h .. "' fill='" .. fill .. "'/>"
end

-- A body's rows as one run of pixels per run of a tone: b is the ink, s its shade, l its light.
local function body_parts(parts: { string }, body: string, ink: string): { string }
	local tones = { b = AVATAR.inks[ink], s = shade(AVATAR.inks[ink], 0.76), l = shade(AVATAR.inks[ink], 1.22) }
	for y, line in ipairs(AVATAR.bodies[body].rows) do
		local x = 1
		while x <= #line do
			local tone = line:sub(x, x)
			if tone == "." then
				x = x + 1
			else
				local from = x
				while x <= #line and line:sub(x, x) == tone do
					x = x + 1
				end
				rect(parts, from - 1, y - 1, x - from, 1, tones[tone] or AVATAR.inks[ink])
			end
		end
	end
	return parts
end

local function eye_parts(parts: { string }, shape: string, gaze: string, fill: string): { string }
	local gx, gy = GAZES[gaze][1], GAZES[gaze][2]
	local def = SHAPES[shape]
	for _, eye in ipairs({ { EYES.left, def.left }, { EYES.right, def.right } }) do
		for _, run in ipairs(eye[2]) do
			rect(parts, eye[1] + run[1] + gx, EYES.top + run[2] + gy, run[3], run[4], fill)
		end
	end
	return parts
end

local function svg(parts: { string }): string
	return "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' shape-rendering='crispEdges'>" .. table.concat(parts) .. "</svg>"
end

-- Tern loads an SVG only as a percent-escaped data URL.
local function image(source: string): string
	return "url(\"data:image/svg+xml," .. source:gsub("#", "%%23"):gsub("<", "%%3C"):gsub(">", "%%3E") .. "\")"
end

-- One still image for everywhere but a bot chat: the body with one face, since a tab or a card shows a still.
local function face(body: string, ink: string, shape: string): string
	return svg(eye_parts(body_parts({}, body, ink), shape, "c", "#fff"))
end

-- The resting face, the same body with its eyes shut, and the open eyes on their own. avatars.css blinks a tab by hiding
-- the open eyes over the shut pair, so a bot blinks in the tab list too, not only in a chat body.
local function avatar(bot: Bot): string
	local got = look(bot)
	return "--bot-face: " .. image(face(got.body, got.ink, "open"))
		.. "; --bot-shut: " .. image(face(got.body, got.ink, "shut"))
		.. "; --bot-eyes: " .. image(svg(eye_parts({}, "open", "c", "#fff")))
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
-- image Tern already has, not a redraw of the pixel grid.
local ART: string? = nil
local function art(): string
	if ART then
		return ART
	end
	local rules = {}
	for _, body in ipairs(BODY_NAMES) do
		for _, ink in ipairs(INK_NAMES) do
			rules[#rules + 1] = ":root:not(#bot) [data-role='omp.bot.skin." .. body .. "." .. ink .. "'] { background-image: " .. image(svg(body_parts({}, body, ink))) .. "; }"
		end
	end
	for shape in SHAPES do
		for _, gaze in ipairs(GAZE_NAMES) do
			rules[#rules + 1] = ":root:not(#bot) [data-role='omp.bot.face." .. shape .. "." .. gaze .. "'] { background-image: " .. image(svg(eye_parts({}, shape, gaze, "#fff"))) .. "; }"
		end
	end
	rules[#rules + 1] = ":root:not(#bot) [data-role='omp.bot.lid'] { background-image: " .. image(svg(eye_parts({}, "shut", "c", "#fff"))) .. "; }"
	ART = table.concat(rules, "\n")
	return ART
end

local function quote(s: string): string
	return "'" .. s:gsub("'", "'\\''") .. "'"
end

local function roster(): { Bot }
	return tern.json.decode(tern.fs.read(tern.fs.exists(ROSTER) and ROSTER or ROOT .. "/bots.json"))
end

-- Per-bot avatar variables for avatars.css, keyed by tint like every bot row; a tint two bots share keeps the default.
local function show_avatars(bots: { Bot })
	local rules = { art(), ":root { " .. avatar({ name = "", avatar = AVATAR.default } :: any) .. " }" }
	local tints: { [string]: number } = {}
	for _, bot in ipairs(bots) do
		if bot.tint then
			tints[bot.tint] = (tints[bot.tint] or 0) + 1
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
		rules[#rules + 1] = ":root:not(#bot) " .. selector .. " { " .. avatar(faces_text[index]) .. " left: 0; top: 0; width: 100%; height: 100%; border-radius: 0; background: var(--bot-face) center / 32px 32px no-repeat; image-rendering: pixelated; box-shadow: none; }"
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
			add({ label = name, value = name, current = now.body == name }, { body = name })
		end
	else
		for _, name in ipairs(INK_NAMES) do
			add({ label = name, detail = AVATAR.inks[name], value = name, current = now.ink == name }, { ink = name })
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

for _, event in ipairs({ "focus", "tab_created", "tab_closed", "pane_created", "pane_closed", "agent_state" }) do
	tern.on(event, function(_ev, cx: WindowCx)
		register(roster())
		show_faces(cx)
	end)
end

tern.timer(0, show_faces)

