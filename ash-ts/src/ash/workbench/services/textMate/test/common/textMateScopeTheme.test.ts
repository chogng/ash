import assert from "node:assert/strict";
import { test } from "mocha";
import { TextMateScopeThemeModel, createTextMateScopeThemeResolver, matchesTextMateScopeSelector, normalizeTextMateScopeTheme } from "../../common/textMateScopeTheme.js";

test("Scope themes apply last matching rules before the stable fallback", () => {
	const resolver = createTextMateScopeThemeResolver({
		revision: 1,
		rules: [
			{ selector: "string", tokenType: "string", modifiers: ["readonly"] },
			{ selector: "source.demo string.regexp", tokenType: "regexp", modifiers: ["deprecated"] },
		],
	});

	assert.deepEqual(resolver(["source.demo", "string.regexp.demo"]), { tokenType: "regexp", modifiers: ["deprecated"] });
	assert.deepEqual(resolver(["source.demo", "string.quoted.demo"]), { tokenType: "string", modifiers: ["readonly"] });
	assert.deepEqual(resolver(["source.demo", "keyword.control.demo"]), { tokenType: "keyword", modifiers: [] });
});

test("Scope themes retain exact foreground, background, and font style presentation", () => {
	const resolver = createTextMateScopeThemeResolver({ revision: 1, rules: [{ selector: "comment", foreground: "#6A9955", background: "#10101080", fontStyle: ["italic", "underline"] }] });
	assert.deepEqual(resolver(["source.demo", "comment.line.demo"]), { tokenType: "comment", modifiers: [], foreground: "#6A9955", background: "#10101080", fontStyle: ["italic", "underline"] });
});

test("Scope selector matching supports comma unions, segment wildcards, and exclusions", () => {
	assert.equal(matchesTextMateScopeSelector("comment, string.*", ["source.demo", "string.quoted.demo"]), true);
	assert.equal(matchesTextMateScopeSelector("source.demo string -string.regexp", ["source.demo", "string.quoted.demo"]), true);
	assert.equal(matchesTextMateScopeSelector("source.demo string -string.regexp", ["source.demo", "string.regexp.demo"]), false);
	assert.equal(matchesTextMateScopeSelector("entity.*.function", ["source.demo", "entity.name.function.demo"]), true);
});

test("Scope theme models clone revisions, publish replacements, and reject invalid data atomically", () => {
	using themes = new TextMateScopeThemeModel();
	const changes: number[] = [];
	using listener = themes.onDidChangeTheme(theme => changes.push(theme.revision));
	const source = { revision: 1, rules: [{ selector: "comment", tokenType: "comment", modifiers: ["deprecated"] }] };

	themes.replace(source);
	assert.notEqual(themes.currentTheme, source);
	assert.equal(Object.isFrozen(themes.currentTheme.rules), true);
	assert.deepEqual(themes.resolve(["comment.line.demo"]), { tokenType: "comment", modifiers: ["deprecated"] });
	assert.throws(() => themes.replace(source), /revision must increase/);
	assert.deepEqual(changes, [1]);

	assert.throws(() => normalizeTextMateScopeTheme({ revision: 2, rules: [{ selector: "", tokenType: "comment" }] }), /selector/);
	assert.throws(() => normalizeTextMateScopeTheme({ revision: 2, rules: [{ selector: "comment", tokenType: "comment", modifiers: ["deprecated", "deprecated"] }] }), /unique/);
	assert.throws(() => normalizeTextMateScopeTheme({ revision: 2, rules: [{ selector: "comment", tokenType: "remark" }] }), /Unsupported semantic token type/);
	assert.equal(themes.currentTheme.revision, 1);
});
