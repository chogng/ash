import assert from "node:assert/strict";
import { test } from "mocha";
import { applySnippetTransform, createSnippetTransform } from "../../common/snippetTransform.js";

test("Completion snippet transforms expand captures, case modifiers, conditionals, and global matches", () => {
	const caseTransform = createSnippetTransform("(?<first>alpha)_(beta)", "${1:/upcase}-${2:/pascalcase}", "i");
	assert.equal(applySnippetTransform("Alpha_beta", caseTransform), "ALPHA-Beta");
	const conditional = createSnippetTransform("(a)?b", "${1:+yes}${1:-no}${1:?A:Z}", "");
	assert.equal(applySnippetTransform("b", conditional), "noZ");
	const global = createSnippetTransform("_", "-", "g");
	assert.equal(applySnippetTransform("two_words_here", global), "two-words-here");
});

test("Completion snippet transforms reject invalid patterns and options", () => {
	assert.throws(() => createSnippetTransform("[", "text", ""), SyntaxError);
	assert.throws(() => createSnippetTransform("x", "text", "zz"), SyntaxError);
});
