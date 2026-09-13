import assert from "node:assert/strict";
import { test } from "mocha";
import { Position } from "../../../common/core/position.js";
import { Range } from "../../../common/core/range.js";
import { TextModel } from "../../../common/model/textModel.js";
import { findSectionHeaders } from "../../../common/services/findSectionHeaders.js";

test("section headers include named regions but not ordinary foldable lines", () => {
	using model = new TextModel("// #region -- Runtime --\nfunction run() {\n}\n// #endregion");
	const headers = findSectionHeaders(model, {
		foldingRules: { markers: { start: /^\s*\/\/\s*#?region\b/iu, end: /^\s*\/\/\s*#?endregion\b/iu } },
		findRegionSectionHeaders: true,
		findMarkSectionHeaders: false,
		markSectionHeaderRegex: "",
	});

	assert.deepEqual(headers, [{
		range: Range.fromPositions(new Position((0) + 1, (10) + 1), new Position((0) + 1, (24) + 1)),
		text: " Runtime ",
		hasSeparatorLine: true,
		shouldBeInComments: false,
	}]);
});

test("section headers collect single-line and multiline MARK matches", () => {
	using model = new TextModel("const value = 1; // MARK: API\n/* MARK:\n * Details */\nconst other = 2;");
	const headers = findSectionHeaders(model, {
		findRegionSectionHeaders: false,
		findMarkSectionHeaders: true,
		markSectionHeaderRegex: "MARK:[ \\t]*(?<separator>-?)[ \\t]*(?<label>[^\\n*]+|\\n\\s*\\*\\s*[^*]+)",
	});

	assert.equal(headers.length, 2);
	assert.equal(headers[0]?.text, "API");
	assert.equal(headers[0]?.range.startLineNumber, 1);
	assert.equal(headers[1]?.range.startLineNumber, 2);
	assert.equal(headers[1]?.range.endLineNumber, 3);
});

test("section headers reject invalid MARK expressions", () => {
	using model = new TextModel("// MARK: Value");
	assert.throws(() => findSectionHeaders(model, {
		findRegionSectionHeaders: false,
		findMarkSectionHeaders: true,
		markSectionHeaderRegex: "(",
	}), /valid regular expression/);
});
