import assert from "node:assert/strict";
import { test } from "mocha";
import { createStanzaIndentationGuides } from "../../../../browser/viewParts/indentGuides/indentGuides.js";

test("Indentation guides follow complete visual units in mixed leading whitespace", () => {
	assert.deepEqual(createStanzaIndentationGuides("        value", 4), [
		{ columnIndex: 4, level: 1 },
		{ columnIndex: 8, level: 2 },
	]);
	assert.deepEqual(createStanzaIndentationGuides("  \t  value", 4), [
		{ columnIndex: 3, level: 1 },
	]);
});

test("Indentation guides stop at source text and validate tab sizing", () => {
	assert.deepEqual(createStanzaIndentationGuides("  value  ", 4), []);
	assert.throws(() => createStanzaIndentationGuides("  ", 0), /positive safe integer/);
});
