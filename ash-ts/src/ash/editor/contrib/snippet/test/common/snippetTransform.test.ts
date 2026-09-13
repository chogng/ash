import assert from "node:assert/strict";
import { test } from "mocha";
import { applyLanguageCompletionSnippetTransform, createLanguageCompletionSnippetTransform } from "../../common/snippetTransform.js";

test("Completion snippet transforms expand captures, case modifiers, conditionals, and global matches", () => {
	const caseTransform = createLanguageCompletionSnippetTransform("(?<first>alpha)_(beta)", "${1:/upcase}-${2:/pascalcase}", "i");
	assert.equal(applyLanguageCompletionSnippetTransform("Alpha_beta", caseTransform), "ALPHA-Beta");
	const conditional = createLanguageCompletionSnippetTransform("(a)?b", "${1:+yes}${1:-no}${1:?A:Z}", "");
	assert.equal(applyLanguageCompletionSnippetTransform("b", conditional), "noZ");
	const global = createLanguageCompletionSnippetTransform("_", "-", "g");
	assert.equal(applyLanguageCompletionSnippetTransform("two_words_here", global), "two-words-here");
});

test("Completion snippet transforms reject invalid patterns and options", () => {
	assert.throws(() => createLanguageCompletionSnippetTransform("[", "text", ""), SyntaxError);
	assert.throws(() => createLanguageCompletionSnippetTransform("x", "text", "zz"), SyntaxError);
});
