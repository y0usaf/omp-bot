--!strict
-- The bots' Chao, as omp-bot's rail draws them: the SVGs in tern/chao/ (drawn in purple, recoloured to the
-- bot's tint). Keep the hash in step with tern/window.luau: a plugin can't require a file outside its own folder.
local M = {}

local CHAO_EYES = { "oval", "round", "dot" }
local CHAO_TYPES = { "neutral", "neutral", "hero", "dark" }
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
	return table.find(CHAO_TYPES, look.type) and look.type or kind
end

-- A bot's colour: its roster tint, else one picked by its name.
function M.tint(name: string, tint: string?): string
	return M.TINTS[tint or ""] or M.TINTS[TINT_ORDER[hash(name) % #TINT_ORDER + 1]]
end

local ART = tern.plugin.dir .. "/../tern/chao/"
local BOX = 27

local function inner(name: string): string
	return (tern.fs.read(ART .. name .. ".svg"):match("<svg[^>]*>(.*)</svg>") or "")
end

-- The Chao (body, ball, eyes) BOX × `px` pixels tall in `color`. Tern sizes an SVG by its viewBox, so the
-- 26 × 32 art is scaled in the coordinates.
function M.svg(kind: string, color: string, px: number): string
	kind = if table.find(CHAO_TYPES, kind) then kind else "neutral"
	local h = BOX * px
	local w = math.round(h * 26 / 32)
	local art = (inner(kind) .. inner("ball-" .. kind) .. inner("eyes-oval")):gsub(M.TINTS.purple, color)
	return string.format('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d"><g transform="scale(%g)">%s</g></svg>', w, h, w, h, h / 32, art)
end

return M
