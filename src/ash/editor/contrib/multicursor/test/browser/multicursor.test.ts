import assert from "node:assert/strict";
import { test } from "mocha";
import { OperatingSystem } from "../../../../../base/common/platform.js";
import { resolveStanzaAdjacentCursorDirection } from "../../browser/multicursor.js";

test("Multi-cursor chord selection follows platform-specific non-conflicting bindings", () => {
	assert.equal(resolveStanzaAdjacentCursorDirection(
		keydown("ArrowUp", { ctrlKey: true, altKey: true }),
		OperatingSystem.Windows,
	), "up");
	assert.equal(resolveStanzaAdjacentCursorDirection(
		keydown("ArrowDown", { metaKey: true, altKey: true }),
		OperatingSystem.Macintosh,
	), "down");
	assert.equal(resolveStanzaAdjacentCursorDirection(
		keydown("ArrowUp", { shiftKey: true, altKey: true }),
		OperatingSystem.Linux,
	), undefined);
	assert.equal(resolveStanzaAdjacentCursorDirection(
		keydown("ArrowUp", { ctrlKey: true, shiftKey: true, altKey: true }),
		OperatingSystem.Linux,
	), "up");
});

function keydown(key: string, options: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>>): Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'> {
	return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...options };
}
