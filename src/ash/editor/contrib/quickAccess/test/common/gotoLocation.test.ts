import assert from "node:assert/strict";
import { test } from "mocha";
import { Position } from "../../../../common/core/position.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { parseStanzaGotoLocation } from "../../common/gotoLocation.js";

test("Go to Line parses one-based line and column inputs with clamping", () => {
	using model = new TextModel("zero\none\ntwo");
	assertLocation(parseStanzaGotoLocation(model, "2"), new Position((1) + 1, (0) + 1));
	assertLocation(parseStanzaGotoLocation(model, ":2:3"), new Position((1) + 1, (2) + 1));
	assertLocation(parseStanzaGotoLocation(model, "3,99"), new Position((2) + 1, (3) + 1));
	assertLocation(parseStanzaGotoLocation(model, "0:0"), new Position((0) + 1, (0) + 1));
});

test("Go to Line supports backwards line/column values and UTF-16 offsets", () => {
	using model = new TextModel("alpha\n😊beta\ngamma");
	assertLocation(parseStanzaGotoLocation(model, "-1:-1"), new Position((2) + 1, (5) + 1));
	assertLocation(parseStanzaGotoLocation(model, "::8"), new Position((1) + 1, (1) + 1));
	assertLocation(parseStanzaGotoLocation(model, "::-1"), new Position((2) + 1, (4) + 1));
});

test("Go to Line reports incomplete and invalid input without changing the model", () => {
	using model = new TextModel("alpha");
	assert.equal(parseStanzaGotoLocation(model, "").kind, "empty");
	assert.equal(parseStanzaGotoLocation(model, "line").kind, "invalid");
	assert.equal(parseStanzaGotoLocation(model, "1:").kind, "invalid");
	assert.equal(parseStanzaGotoLocation(model, "::offset").kind, "invalid");
	assert.equal(model.getText(), "alpha");
});

function assertLocation(result: ReturnType<typeof parseStanzaGotoLocation>, position: Position): void {
	assert.equal(result.kind, "location");
	if (result.kind === "location") assert.deepEqual(result.location.position, position);
}
