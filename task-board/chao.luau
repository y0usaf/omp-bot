--!strict
-- The bots' Chao, as omp-bot's rail draws them (tern/window.luau: SPRITES, chao(), mini()), drawn here as
-- an SVG of square pixels in concrete colours so a block can show them at any size. Keep the sprites and
-- the hash in step with tern/window.luau: a plugin can't require a file outside its own folder.
local M = {}

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

-- rail.css's tints.
M.TINTS = {
	red = "#ff4d5e",
	orange = "#ff8a3d",
	yellow = "#f2b705",
	green = "#2fbf71",
	teal = "#19b8c4",
	blue = "#3d7bff",
	purple = "#8f6bff",
	pink = "#ff5fa8",
}
local TINT_ORDER = { "purple", "teal", "orange", "pink", "blue", "green", "yellow", "red" }

local function rgb(hex: string): (number, number, number)
	return tonumber(hex:sub(2, 3), 16) :: number, tonumber(hex:sub(4, 5), 16) :: number, tonumber(hex:sub(6, 7), 16) :: number
end

-- color-mix(in srgb, a p%, b)
local function mix(a: string, p: number, b: string): string
	local r1, g1, b1 = rgb(a)
	local r2, g2, b2 = rgb(b)
	local k = p / 100
	return string.format("#%02x%02x%02x", math.round(r1 * k + r2 * (1 - k)), math.round(g1 * k + g2 * (1 - k)), math.round(b1 * k + b2 * (1 - k)))
end

-- window.luau's TYPE_INK, resolved for one bot colour.
local function inks(kind: string, bot: string): { [string]: string }
	local ink: { [string]: string } = { o = "#000000", w = "#f8f8f8" }
	if kind == "hero" then
		ink.b, ink.s, ink.c, ink.j, ink.a, ink.y = "#f8f8f8", "#bec2bf", "#647c9a", "#c8ebf1", "#89a8dd", "#f7df56"
	elseif kind == "dark" then
		ink.b, ink.e, ink.a, ink.d = mix(bot, 22, "#152745"), "#1c63a1", "#d52b38", "#a71a30"
	else
		ink.b, ink.m, ink.s = mix(bot, 35, "#ffffff"), mix(bot, 50, "#ffffff"), mix(bot, 70, "#ffffff")
		ink.c, ink.e = mix(bot, 82, "#000000"), mix(bot, 55, "#000000")
		ink.a, ink.i, ink.d, ink.n, ink.j = "#f8f820", "#d8d868", "#c0b830", "#88a850", "#d8f8b0"
	end
	return ink
end

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

-- window.luau's chao(): the bot's own `chao` look, else one picked by its name.
function M.kind(name: string, own: any): string
	local h = hash(name)
	local kind = CHAO_TYPES[(h // #CHAO_EYES) % #CHAO_TYPES + 1]
	local look = type(own) == "string" and { type = own } or (type(own) == "table" and own or {})
	return SPRITES[look.type] and look.type or kind
end

-- A bot's colour: its roster tint, else one picked by its name.
function M.tint(name: string, tint: string?): string
	return M.TINTS[tint or ""] or M.TINTS[TINT_ORDER[hash(name) % #TINT_ORDER + 1]]
end

local BOX = 27

-- The sprite on a BOX × BOX grid (every kind the same size, centred as mini() centres it), `px` pixels a cell.
-- Tern sizes an SVG by its viewBox, so the grid is scaled in the coordinates.
function M.svg(kind: string, color: string, px: number): string
	local rows = SPRITES[kind] or SPRITES.neutral
	local ink = inks(kind, color)
	local left = (BOX - #rows[1]) // 2
	local top = (BOX - #rows) // 2
	local runs: { [string]: { string } } = {}
	local order: { string } = {}
	for y, line in ipairs(rows) do
		local x = 1
		while x <= #line do
			local ch = line:sub(x, x)
			local run = 1
			while line:sub(x + run, x + run) == ch do
				run += 1
			end
			if ink[ch] then
				if not runs[ch] then
					runs[ch] = {}
					table.insert(order, ch)
				end
				table.insert(runs[ch], string.format("M%d %dh%dv%dh-%dz", (left + x - 1) * px, (top + y - 1) * px, run * px, px, run * px))
			end
			x += run
		end
	end
	local paths: { string } = {}
	for _, ch in order do
		table.insert(paths, string.format('<path fill="%s" d="%s"/>', ink[ch], table.concat(runs[ch])))
	end
	return string.format('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d" shape-rendering="crispEdges">%s</svg>', BOX * px, BOX * px, BOX * px, BOX * px, table.concat(paths))
end

return M
