--!strict
local BLOCK = "task-board.board"

-- A window opened a moment ago may not have its daemon's host halves yet: try again for a few seconds.
local function open(cx: WindowCx, tries: number)
	if cx:new_block(BLOCK, {}, "tab") ~= nil then
		return
	end
	if tries <= 0 then
		cx:toast("error", "The task board is unavailable", "Its host half isn't loaded on this host.")
		return
	end
	tern.timer(250, function(later: WindowCx?)
		if later then
			open(later, tries - 1)
		end
	end)
end

tern.command({
	id = "open",
	title = "Bots: Task board",
	icon = "layers",
	run = function(cx: WindowCx)
		open(cx, 20)
	end,
})
