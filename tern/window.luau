--!strict

local ROOT = tern.plugin.dir .. "/.."
local STATE = tern.getenv("OMP_BOT_STATE") or ((tern.getenv("XDG_STATE_HOME") or ((tern.getenv("HOME") or "") .. "/.local/state")) .. "/omp-bot")
local ROSTER = STATE .. "/bots.json"
local TINTS = { "purple", "teal", "orange", "pink", "blue", "green", "yellow", "red" }
local TABS = tern.plugin.data .. "/../agent-tabs/kv.json"
local AVATAR = tern.json.decode(tern.fs.read(tern.plugin.dir .. "/avatars.json"))
local PARTS = { "shape", "color" }
local MARK_MS = 100

local function mul32(a: number, b: number): number
	return ((a % 65536) * b + (((a // 65536) * (b % 65536)) % 65536) * 65536) % 4294967296
end

local function fnv(text: string): number
	local h = 0x811c9dc5
	for i = 1, #text do
		h = mul32(bit32.bxor(h, string.byte(text, i)), 0x01000193)
	end
	return h
end

local function mix(text: string): number
	local h = fnv(text)
	h = mul32(bit32.bxor(h, bit32.rshift(h, 16)), 0x045d9f3b)
	h = mul32(bit32.bxor(h, bit32.rshift(h, 13)), 0xc2b2ae35)
	return bit32.bxor(h, bit32.rshift(h, 16))
end

local function first_draw(seed: number): number
	local t = (seed + 0x6d2b79f5) % 4294967296
	local e = mul32(bit32.bxor(t, bit32.rshift(t, 15)), bit32.bor(t, 1))
	e = bit32.bxor(e, (e + mul32(bit32.bxor(e, bit32.rshift(e, 7)), bit32.bor(e, 61))) % 4294967296)
	return bit32.bxor(e, bit32.rshift(e, 14)) / 4294967296
end

local function look(bot: Bot): { shape: string, color: string }
	local own = type(bot.avatar) == "table" and bot.avatar or {}
	local shape = own.shape
	if shape ~= nil and not AVATAR.marks[shape] then
		print("omp bots: " .. bot.name .. "'s avatar has no shape " .. tostring(shape))
		shape = nil
	end
	local color = own.color
	if color ~= nil and not AVATAR.inks[color] then
		print("omp bots: " .. bot.name .. "'s avatar has no colour " .. tostring(color))
		color = nil
	end
	if not color and AVATAR.identity == "tint" and bot.tint then
		color = AVATAR.tints[bot.tint]
	end
	return {
		shape = shape or AVATAR.shapes[mix(bot.name) % #AVATAR.shapes + 1],
		color = color or AVATAR.palette[math.floor(first_draw(fnv(bot.name)) * #AVATAR.palette) + 1],
	}
end

local function num(n: number): string
	return string.format("%.6g", n)
end

local function paths(frame: string, ink: string): string
	local out = {}
	for layer in string.gmatch(frame, "[^;]+") do
		local op, body = string.match(layer, "^([^~]*)~(.*)$")
		local d = {}
		for ring in string.gmatch(body :: string, "[^|]+") do
			local x, y, rest = string.match(ring, "^(%S+) (%S+) ?(.*)$")
			d[#d + 1] = "M" .. x .. " " .. y .. (rest ~= "" and ("l" .. rest) or "") .. "z"
		end
		out[#out + 1] = "<path fill='" .. ink .. "' fill-rule='evenodd'" .. (op ~= "" and (" fill-opacity='" .. op .. "'") or "") .. " d='" .. table.concat(d) .. "'/>"
	end
	return table.concat(out)
end

local function url(svg: string): string
	local esc = svg:gsub("%%", "%%25")
	esc = esc:gsub("<", "%%3C")
	esc = esc:gsub(">", "%%3E")
	esc = esc:gsub("#", "%%23")
	return "url(\"data:image/svg+xml," .. esc .. "\")"
end

local function placed(frame: string, ink: string, units: number, q: number, size: number): string
	local canvas = size * 0.92 / 0.6
	local pitch = math.ceil(canvas)
	if (pitch - size) % 2 == 1 then
		pitch += 1
	end
	local offset = num((pitch - canvas) / 2)
	local p = num(pitch)
	return url("<svg xmlns='http://www.w3.org/2000/svg' width='" .. p .. "' height='" .. p .. "' viewBox='0 0 " .. p .. " " .. p .. "'><g transform='translate(" .. offset .. " " .. offset .. ") scale(" .. num(canvas / (units * q)) .. ")'>" .. paths(frame, ink) .. "</g></svg>")
end

local function still(mark: any, ink: string): string
	local b = mark.still.box
	return url("<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='" .. num(b[1]) .. " " .. num(b[2]) .. " " .. num(b[3]) .. " " .. num(b[4]) .. "'><g transform='scale(" .. num(1 / mark.q) .. ")'>" .. paths(mark.still.frame, ink) .. "</g></svg>")
end

local function inks(color: string): { light: string, dark: string }
	return AVATAR.inks[color] or AVATAR.inks.gray
end

local function face(bot: Bot, theme: string): string
	local got = look(bot)
	return still(AVATAR.marks[got.shape], (inks(got.color) :: any)[theme])
end

local function hero(bot: Bot, theme: string): string
	local got = look(bot)
	local mark = AVATAR.marks[got.shape]
	return placed(mark.hero.frame, (inks(got.color) :: any)[theme], mark.hero.canvas, mark.q, 72)
end

local function quote(s: string): string
	return "'" .. s:gsub("'", "'\\''") .. "'"
end

local function roster(): { Bot }
	return tern.json.decode(tern.fs.read(tern.fs.exists(ROSTER) and ROSTER or ROOT .. "/bots.json"))
end

local HUES: { [string]: { bubble: { string }, primary: { string }, hover: { string }, text: { string } } } = {
	brown = { bubble = { "#86592e", "#8c5d31" }, primary = { "#9d6937", "#8c5d31" }, hover = { "#86592e", "#aa723d" }, text = { "#996b42", "#c59e7d" } },
	red = { bubble = { "#c82532", "#cf2b35" }, primary = { "#e72e3b", "#cf2b35" }, hover = { "#c82532", "#f73643" }, text = { "#cd2834", "#ff6463" } },
	orange = { bubble = { "#d2550a", "#cd5309" }, primary = { "#ee620d", "#cd5309" }, hover = { "#d2550a", "#f4650e" }, text = { "#c14c00", "#fe6600" } },
	yellow = { bubble = { "#c2730b", "#c8770c" }, primary = { "#da830e", "#c8770c" }, hover = { "#c2730b", "#ea8c10" }, text = { "#aa6300", "#e28600" } },
	green = { bubble = { "#0d9655", "#0e9f5a" }, primary = { "#10ab61", "#0e9f5a" }, hover = { "#0d9655", "#13bb6b" }, text = { "#00854a", "#00ba69" } },
	cyan = { bubble = { "#0d9381", "#0e9886" }, primary = { "#10a693", "#0e9886" }, hover = { "#0d9381", "#12b39f" }, text = { "#008273", "#00b7a2" } },
	blue = { bubble = { "#126fd4", "#116dd2" }, primary = { "#1680f3", "#116dd2" }, hover = { "#126fd4", "#1784fb" }, text = { "#0b6dd3", "#4d9bff" } },
	violet = { bubble = { "#7442d1", "#7845d7" }, primary = { "#8351e4", "#7845d7" }, hover = { "#7442d1", "#8e59f8" }, text = { "#7547d0", "#a582ff" } },
	magenta = { bubble = { "#c82779", "#cf297e" }, primary = { "#e52f8b", "#cf297e" }, hover = { "#c82779", "#f63397" }, text = { "#c62378", "#ff55a4" } },
}
local NEUTRAL = {
	bubble = { "#1c1c1c", "#f5f5f52e" },
	ink = { "#ffffff", "#f5f5f5" },
	cta = { "#1c1c1c", "#f5f5f5" },
	cta_ink = { "#fcfcfc", "#121212" },
}

local function pair(p: { string }): string
	return "light-dark(" .. p[1] .. ", " .. p[2] .. ")"
end

local function accent_vars(color: string?): string?
	if not color then
		return nil
	end
	local hue = HUES[color]
	if not hue then
		return "--sand-fill-bubble-user: " .. pair(NEUTRAL.bubble)
			.. "; --sand-transcript-bubble-user-text: " .. pair(NEUTRAL.ink)
			.. "; --sand-prompt-cta-fill: " .. pair(NEUTRAL.cta)
			.. "; --sand-prompt-cta-text: " .. pair(NEUTRAL.cta_ink) .. ";"
	end
	return "--sand-fill-bubble-user: " .. pair(hue.bubble)
		.. "; --sand-transcript-bubble-user-text: light-dark(#ffffff, #f5f5f5)"
		.. "; --sand-accent: " .. pair(hue.bubble)
		.. "; --sand-bg-accent-primary: " .. pair(hue.primary)
		.. "; --sand-bg-accent-primary-hover: " .. pair(hue.hover)
		.. "; --sand-text-accent-primary: " .. pair(hue.text)
		.. "; --sand-prompt-cta-fill: " .. pair(hue.primary)
		.. "; --sand-prompt-cta-text: light-dark(#ffffff, #f5f5f5)"
		.. "; --sand-focus: " .. pair(hue.bubble) .. ";"
end
local current: { Bot } = {}
local banners: { [string]: { number } } = {}
local installed: { [string]: string } = {}
local faces = ""

local function tab_of(bot: Bot): string
	local tab = "#tabbar .tt" .. (bot.tint and ("[data-tc='" .. bot.tint .. "']") or "[data-tc]") .. ":is([title*='" .. bot.name .. "  '], [title*='" .. bot.name .. "\\A '])"
	for _, other in ipairs(current) do
		if other.name ~= bot.name and (other.name:sub(-#bot.name) == bot.name or other.name:find(bot.name .. "  ", 1, true)) then
			tab ..= ":not([title*='" .. other.name .. "  ']):not([title*='" .. other.name .. "\\A '])"
		end
	end
	return tab
end

local function live_targets(bot: Bot): string
	local tab = tab_of(bot)
	local parts = {
		tab .. " .tn-dk-c",
		"[data-role='omp.bot.mark.live/" .. bot.name .. "']",
	}
	for _, pane in ipairs(banners[bot.name] or {}) do
		parts[#parts + 1] = "#banners .tn-dk-c[data-pane='" .. pane .. "']"
	end
	return ":is(" .. table.concat(parts, ", ") .. ")"
end

local keyframes: { [string]: boolean } = {}

local function show_avatars(bots: { Bot })
	local shapes: { [string]: boolean } = {}
	local fallback = AVATAR.inks[AVATAR.fallback.color]
	local rules = {
		":root:not(#bot) #tabbar .tt[data-tc] :is(.tn-ib-pip, .tn-dk-pip) { --sand-accent: light-dark(#1680f3, #4d9bff); --accent: light-dark(#1680f3, #4d9bff); --accent-fill: light-dark(#1680f3, #4d9bff); }",
		":root:not(#bot) #tabbar .tt[data-tc] .tn-dk-c { --mk-ink: " .. fallback.light .. "; }",
		":root[data-theme='dark']:not(#bot) #tabbar .tt[data-tc] .tn-dk-c { --mk-ink: " .. fallback.dark .. "; }",
		":root:not(#bot) #tabbar .tt[data-tc] .tn-dk-c::before { background-image: url(\"marks/" .. AVATAR.fallback.shape .. "/rest.svgz\"); }",
		":root:not(#bot):not(#mk) [data-role^='omp.bot.mark.live/']::before { background-image: url(\"marks/" .. AVATAR.fallback.shape .. "/rest.svgz\"); }",
	}
	local nobody = { name = "", avatar = AVATAR.fallback } :: any
	for _, theme in ipairs({ "light", "dark" }) do
		local root = theme == "dark" and ":root[data-theme='dark']:not(#bot):not(#mk) " or ":root:not(#bot):not(#mk) "
		rules[#rules + 1] = root .. "[data-role^='omp.bot.mark.live/'] { --mk-ink: " .. (fallback :: any)[theme] .. "; }"
		rules[#rules + 1] = root .. ":is([data-role^='omp.bot.mark.still/'], [data-role^='omp.bot.mark.event/']) { background-image: " .. face(nobody, theme) .. "; }"
		rules[#rules + 1] = root .. "[data-role^='omp.bot.mark.hero/']::before { background-image: " .. hero(nobody, theme) .. "; }"
	end
	for _, bot in ipairs(bots) do
		local vars = accent_vars(look(bot).color)
		if vars then
			local own = "[data-role='omp.bot.mark.still/" .. bot.name .. "'], [data-role='omp.bot.mark.hero/" .. bot.name .. "'], [data-role='omp.bot.mark.live/" .. bot.name .. "']"
			rules[#rules + 1] = ":root:not(#bot) :is(.sf-chat-reader:has(" .. own .. "), .tn-pane:has(" .. own .. "), " .. tab_of(bot) .. ") { " .. vars .. " }"
		end
	end
	for _, bot in ipairs(bots) do
		local still_sel = ":is([data-role='omp.bot.mark.still/" .. bot.name .. "'], [data-role='omp.bot.mark.event/" .. bot.name .. "'])"
		local hero_sel = "[data-role='omp.bot.mark.hero/" .. bot.name .. "']::before"
		local live_sel = live_targets(bot)
		local got = look(bot)
		shapes[got.shape] = true
		rules[#rules + 1] = ":root:not(#bot):not(#mk) " .. live_sel .. "::before { background-image: url(\"marks/" .. got.shape .. "/rest.svgz\"); }"
		for _, theme in ipairs({ "light", "dark" }) do
			local root = theme == "dark" and ":root[data-theme='dark']:not(#bot):not(#mk) " or ":root:not(#bot):not(#mk) "
			local own = theme == "dark" and ":root[data-theme='dark']:not(#bot):not(#mk):not(#mk3) " or ":root:not(#bot):not(#mk):not(#mk3) "
			rules[#rules + 1] = own .. still_sel .. " { background-image: " .. face(bot, theme) .. "; }"
			rules[#rules + 1] = own .. hero_sel .. " { background-image: " .. hero(bot, theme) .. "; }"
			rules[#rules + 1] = root .. live_sel .. " { --mk-ink: " .. (inks(got.color) :: any)[theme] .. "; }"
		end
	end
	for shape in shapes do
		if not keyframes[shape] then
			keyframes[shape] = true
			tern.css("marks-" .. shape, tern.fs.read(tern.plugin.dir .. "/marks/" .. shape .. ".css"))
		end
	end
	tern.css("avatars", table.concat(rules, "\n"))
end

local function show_marks()
	local seen: { [string]: boolean } = {}
	for _, bot in ipairs(current) do
		seen[bot.name] = true
		local dir = STATE .. "/bots/" .. bot.name
		local mood = tern.fs.exists(dir .. "/mood") and tern.fs.read(dir .. "/mood") or nil
		if mood and mood:match("^%S+%s+%S+%s+(%S+)") ~= look(bot).shape then
			mood = nil
		end
		local target = live_targets(bot)
		local key = (mood or "") .. "|" .. target
		if key ~= installed[bot.name] then
			installed[bot.name] = key
			local css = mood and tern.fs.exists(dir .. "/mark.css") and tern.fs.read(dir .. "/mark.css") or ""
			css = css:gsub("%%MARK%%", target)
			tern.css("mark-" .. bot.name, css)
		end
	end
	for name in installed do
		if not seen[name] then
			installed[name] = nil
			tern.css("mark-" .. name, "")
		end
	end
end

local function watch_marks()
	tern.timer(MARK_MS, watch_marks)
	pcall(show_marks)
end

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
	local panes: { [string]: { number } } = {}
	local rules = {}
	for _, pane in ipairs(cx.session:panes()) do
		local bot = pane.tab and owner[pane.tab]
		if bot then
			panes[bot.name] = panes[bot.name] or {}
			table.insert(panes[bot.name], pane.pane)
			local selector = "#banners .tn-dk-c[data-pane='" .. pane.pane .. "']"
			rules[#rules + 1] = ":root:not(#bot):not(#mk) " .. selector .. " { left: calc(50% - 36px) !important; top: calc(50% - 36px) !important; width: 72px !important; height: 72px !important; overflow: hidden !important; border-radius: 0 !important; background: none !important; box-shadow: none !important; }"
			local got = look(bot)
			rules[#rules + 1] = ":root:not(#bot) " .. selector .. " { --mk-ink: " .. inks(got.color).light .. "; }"
			rules[#rules + 1] = ":root[data-theme='dark']:not(#bot) " .. selector .. " { --mk-ink: " .. inks(got.color).dark .. "; }"
			rules[#rules + 1] = ":root:not(#bot) " .. selector .. " > * { display: none; }"
			rules[#rules + 1] = ":root:not(#bot):not(#mk) " .. selector .. "::before { background-image: url(\"marks/" .. got.shape .. "/rest.svgz\"); }"
			rules[#rules + 1] = ":root:not(#bot):not(#mk) " .. selector .. "::before, :root:not(#bot):not(#mk) " .. selector .. "::after { content: ''; position: absolute; left: -1000px; top: 0; width: 1em; height: 1em; font-size: 72px; background-repeat: no-repeat; background-size: 1em 1em; background-position: 0 0; filter: drop-shadow(1000px 0 0 var(--mk-ink, transparent)); pointer-events: none; }"
			rules[#rules + 1] = ":root:not(#bot):not(#mk) " .. selector .. "::before { display: block; }"
			rules[#rules + 1] = ":root:not(#bot):not(#mk) " .. selector .. "::after { display: none; }"
			local vars = accent_vars(got.color)
			if vars then
				rules[#rules + 1] = ":root:not(#bot) .tn-pane[data-pane='" .. pane.pane .. "'] { " .. vars .. " }"
			end
		end
	end
	local text = table.concat(rules, "\n")
	local function sig(map: { [string]: { number } }): string
		local keys = {}
		for name, ids in map do
			local sorted = table.clone(ids)
			table.sort(sorted)
			keys[#keys + 1] = name .. "=" .. table.concat(sorted, ",")
		end
		table.sort(keys)
		return table.concat(keys, ";")
	end
	local moved = sig(panes) ~= sig(banners)
	banners = panes
	if text ~= faces then
		faces = text
		tern.css("faces", text)
	end
	if moved then
		show_avatars(current)
		pcall(show_marks)
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

local shown = ""

local function show(bots: { Bot })
	current = bots
	shown = tern.json.encode(bots)
	show_avatars(bots)
	register(bots)
	pcall(show_marks)
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
local function pick_faces(cx: WindowCx, opts: any, faces: { Bot }): any
	local n = #faces
	local rules = {}
	for i, bot in ipairs(faces) do
		local row = "#pick .ck-item:nth-child(" .. i .. " of .ck-item):nth-last-child(" .. (n - i + 1) .. " of .ck-item)"
		rules[#rules + 1] = ":root:not(#bot) " .. row .. " .ck-ic { width: 28px; height: 28px; background: " .. face(bot, "light") .. " center / 28px 28px no-repeat; }"
		rules[#rules + 1] = ":root[data-theme='dark']:not(#bot) " .. row .. " .ck-ic { background-image: " .. face(bot, "dark") .. "; }"
		rules[#rules + 1] = ":root:not(#bot) " .. row .. " .ck-ic > .ico { display: none; }"
	end
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

local function colors(): { string }
	local out = { "black" }
	for _, name in ipairs(AVATAR.palette) do
		out[#out + 1] = name
	end
	return out
end

local function pick_part(cx: WindowCx, bot: Bot, own: { [string]: string }, step: number)
	local kind = PARTS[step]
	local now = look({ name = bot.name, tint = bot.tint, avatar = own } :: any)
	local items, faces = {}, {}
	local function add(item: any, try: { [string]: string }?)
		item.icon = "sparkle"
		items[#items + 1] = item
		faces[#faces + 1] = { name = bot.name, tint = bot.tint, avatar = try } :: any
	end
	if kind == "shape" then
		add({ label = "From name", detail = "shape and colour picked from the name " .. bot.name, reset = true, current = bot.avatar == nil }, nil)
		for _, name in ipairs(AVATAR.shapes) do
			add({ label = name, value = name, current = now.shape == name }, { shape = name, color = now.color })
		end
	else
		for _, name in ipairs(colors()) do
			add({ label = name, detail = inks(name).light, value = name, current = now.color == name }, { shape = now.shape, color = name })
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
	local items = {}
	for _, bot in ipairs(bots) do
		items[#items + 1] = { label = bot.name, icon = "sparkle", bot = bot }
	end
	pick_faces(cx, { items = items, placeholder = "Change whose avatar?", icon = "sparkle", action = "next" }, bots):next(function(item, _, cx2)
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
		local bots = roster()
		if tern.json.encode(bots) ~= shown then
			show(bots)
		else
			register(bots)
		end
		show_faces(cx)
	end)
end

tern.timer(0, show_faces)
tern.timer(0, watch_marks)
