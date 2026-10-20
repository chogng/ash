import assert from "node:assert/strict";
import { test } from "mocha";
import { parseSnippet } from "../../common/snippetParser.js";

test("Completion snippets expand tabstops, defaults, mirrors, nesting, and final cursor order", () => {
	const snippet = parseSnippet("fn ${1:name}(${2:${1}}) { $0 }");
	assert.equal(snippet.text, "fn name(name) {  }");
	assert.deepEqual(snippet.placeholderGroups, [
		{
			index: 1,
			placeholders: [{ startOffset: 3, endOffset: 7 }, { startOffset: 8, endOffset: 12 }],
		},
		{ index: 2, placeholders: [{ startOffset: 8, endOffset: 12 }] },
		{ index: 0, placeholders: [{ startOffset: 16, endOffset: 16 }] },
	]);
});

test("Completion snippets preserve explicit escapes and reject unsupported syntax", () => {
	assert.deepEqual(parseSnippet("\\$${1:ok}\\}\\\\"), {
		text: "$ok}\\",
		placeholderGroups: [{ index: 1, placeholders: [{ startOffset: 1, endOffset: 3 }] }],
	});
	for (const source of ["$TM_FILENAME", "${name}", "${1", "${1|one,two}", "${1|one\\x|}", "\\x"]) {
		assert.throws(() => parseSnippet(source));
	}
});

test("Completion snippets parse escaped choices and preserve them for mirrored tabstops", () => {
	const snippet = parseSnippet("${1|one,two\\,three,\\|four|} = $1");
	assert.deepEqual(snippet, {
		text: "one = one",
		placeholderGroups: [{
			index: 1,
			choices: ["one", "two,three", "|four"],
			placeholders: [
				{ startOffset: 0, endOffset: 3, choices: ["one", "two,three", "|four"] },
				{ startOffset: 6, endOffset: 9, choices: ["one", "two,three", "|four"] },
			],
		}],
	});
});

test("Completion snippets resolve explicit variables and retain defaults for unknown names", () => {
	const snippet = parseSnippet("$TM_FILENAME:${MISSING:fallback}", {
		variables: {
			resolveVariable(name): string | undefined {
				return name === "TM_FILENAME" ? "main.ts" : undefined;
			},
		},
	});
	assert.deepEqual(snippet, {
		text: "main.ts:fallback",
		placeholderGroups: [],
	});
	assert.throws(() => parseSnippet("$MISSING", {
		variables: { resolveVariable: () => undefined },
	}), /has no value/);
});

test("Completion snippets apply deterministic tabstop and variable transforms during expansion", () => {
	const tabstop = parseSnippet("${1:warp drive} => ${1/(.*)/${1:/pascalcase}/}");
	assert.deepEqual(tabstop, {
		text: "warp drive => WarpDrive",
		placeholderGroups: [{ index: 1, placeholders: [{ startOffset: 0, endOffset: 10 }] }],
		transforms: [{
			index: 1,
			startOffset: 14,
			endOffset: 23,
			transform: { pattern: "(.*)", format: "${1:/pascalcase}", options: "" },
		}],
	});
	const variable = parseSnippet("${TM_FILENAME/(.*)\\.tsx?/${1:/upcase}/}", {
		variables: { resolveVariable: () => "main.ts" },
	});
	assert.deepEqual(variable, { text: "MAIN", placeholderGroups: [] });
	const global = parseSnippet("${1:already_word} ${1/(_)/${1:+-}/g}");
	assert.deepEqual(global, {
		text: "already_word already-word",
		placeholderGroups: [{ index: 1, placeholders: [{ startOffset: 0, endOffset: 12 }] }],
		transforms: [{
			index: 1,
			startOffset: 13,
			endOffset: 25,
			transform: { pattern: "(_)", format: "${1:+-}", options: "g" },
		}],
	});
});

test("Completion snippets reject malformed transform syntax before acceptance", () => {
	for (const source of ["${1/[/x/}", "${1/a/x/z}", "${TM_FILENAME/a/x/"]) {
		assert.throws(() => parseSnippet(source, {
			variables: { resolveVariable: () => "value" },
		}));
	}
});

for (const declaration of ["${1:ab}", "${1|ab,long|}"]) {
	test(`Completion snippets resolve a transform before its source ${declaration}`, () => {
		const snippet = parseSnippet("$0${1/(.*)/${1:/upcase}/}" + declaration + "$1");
		assert.equal(snippet.text, "ABabab");
		assert.deepEqual(snippet.placeholderGroups.map(group => ({
			index: group.index,
			ranges: group.placeholders.map(({ startOffset, endOffset }) => [startOffset, endOffset]),
		})), [
			{ index: 1, ranges: [[2, 4], [4, 6]] },
			{ index: 0, ranges: [[0, 0]] },
		]);
		assert.deepEqual(snippet.transforms, [{
			index: 1, startOffset: 0, endOffset: 2,
			transform: { pattern: "(.*)", format: "${1:/upcase}", options: "" },
		}]);
	});
}

test("Completion snippets resolve nested forward transforms and their final ranges", () => {
	const snippet = parseSnippet("${1/(.*)/${1:/upcase}/}|${1:${2/(.*)/${1:/upcase}/}}|${2:ab}$0");
	assert.equal(snippet.text, "AB|AB|ab");
	assert.deepEqual(snippet.placeholderGroups, [
		{ index: 1, placeholders: [{ startOffset: 3, endOffset: 5 }] },
		{ index: 2, placeholders: [{ startOffset: 6, endOffset: 8 }] },
		{ index: 0, placeholders: [{ startOffset: 8, endOffset: 8 }] },
	]);
	assert.deepEqual(snippet.transforms?.map(({ index, startOffset, endOffset }) => ({ index, startOffset, endOffset })), [
		{ index: 1, startOffset: 0, endOffset: 2 },
		{ index: 2, startOffset: 3, endOffset: 5 },
	]);
});

test("Completion snippets resolve source variables once and preserve empty transform positions", () => {
	let calls = 0;
	const snippet = parseSnippet("${1/(.*)/${1:/upcase}/}${1:$VALUE}${2/(.*)/${1:/upcase}/}${2:}$0", {
		variables: { resolveVariable: () => { calls++; return "ab"; } },
	});
	assert.equal(snippet.text, "ABab");
	assert.equal(calls, 1);
	assert.deepEqual(snippet.transforms?.map(({ startOffset, endOffset }) => [startOffset, endOffset]), [[0, 2], [4, 4]]);
});

test("Completion snippets terminate recursive transformed defaults", () => {
	assert.equal(parseSnippet("${1:${1/(.*)/x/}}$0").text, "x");
});

test("Completion snippets expand mirrors before the default declaration", () => {
	assert.deepEqual(parseSnippet("$1-${1:hello}-$1$0"), {
		text: "hello-hello-hello",
		placeholderGroups: [
			{ index: 1, placeholders: [{ startOffset: 0, endOffset: 5 }, { startOffset: 6, endOffset: 11 }, { startOffset: 12, endOffset: 17 }] },
			{ index: 0, placeholders: [{ startOffset: 17, endOffset: 17 }] },
		],
	});
});

test("Completion snippets retain choices for forward and nested mirrors", () => {
	const snippet = parseSnippet("${2:$1-${1|a,long|}}-$1$0");
	assert.equal(snippet.text, "a-a-a");
	assert.deepEqual(snippet.placeholderGroups[0], {
		index: 1,
		choices: ["a", "long"],
		placeholders: [
			{ startOffset: 0, endOffset: 1, choices: ["a", "long"] },
			{ startOffset: 2, endOffset: 3, choices: ["a", "long"] },
			{ startOffset: 4, endOffset: 5, choices: ["a", "long"] },
		],
	});
});
