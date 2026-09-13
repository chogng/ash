import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { createDefaultDocumentSchema } from '../../../../common/model/documentSchema.js';
import { createDocumentFragmentFromHtml } from '../../../../browser/widget/richTextEditor/htmlDocumentFragment.js';

test("Stanza external HTML clipboard converts supported structure and inline marks into schema nodes", () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const schema = createDefaultDocumentSchema();
	const fragment = createDocumentFragmentFromHtml(environment.window.document, schema, [
		"<h2>Heading</h2>",
		"<p>Hello <strong>bold</strong> <em>italic</em> <a href='https://example.com'>link</a>.</p>",
		"<ol start='3'><li>One</li><li>Two</li></ol>",
		"<table><tbody><tr><th>A</th><td>B</td></tr></tbody></table>",
	].join(""));

	assert.ok(fragment);
	assert.deepEqual(fragment.content.map(node => node.type), ["heading", "paragraph", "orderedList", "table"]);
	assert.equal(fragment.content[0]?.attrs.level, 2);
	assert.deepEqual(fragment.content[1]?.content.map(node => [node.text, node.marks.map(mark => mark.type)]), [
		["Hello ", []],
		["bold", ["strong"]],
		[" ", []],
		["italic", ["em"]],
		[" ", []],
		["link", ["link"]],
		[".", []],
	]);
	assert.equal(fragment.content[2]?.attrs.order, 3);
	assert.deepEqual(fragment.content[2]?.content.map(item => item.content[0]?.content[0]?.text), ["One", "Two"]);
	assert.deepEqual(fragment.content[3]?.content[0]?.content.map(cell => cell.content[0]?.content[0]?.text), ["A", "B"]);
	environment.window.close();
});

test("Stanza external HTML clipboard discards executable content and unsafe URLs", () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const schema = createDefaultDocumentSchema();
	const fragment = createDocumentFragmentFromHtml(environment.window.document, schema, "<p onclick='alert(1)'><a href='javascript:alert(1)'>unsafe</a><script>ignored()</script><img src='javascript:alert(1)' alt='ignored'>safe</p>");

	assert.ok(fragment);
	assert.equal(fragment.content.length, 1);
	assert.deepEqual(fragment.content[0]?.content.map(node => [node.type, node.text, node.marks]), [
		["text", "unsafe", []],
		["text", "safe", []],
	]);
	environment.window.close();
});

test("Stanza external HTML clipboard preserves nested block containers without flattening them", () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const schema = createDefaultDocumentSchema();
	const fragment = createDocumentFragmentFromHtml(environment.window.document, schema, "<div>Before<p>Paragraph</p><div>After</div></div>");

	assert.ok(fragment);
	assert.deepEqual(fragment.content.map(node => [node.type, node.content[0]?.text]), [
		["paragraph", "Before"],
		["paragraph", "Paragraph"],
		["paragraph", "After"],
	]);
	environment.window.close();
});

test("Stanza external HTML clipboard rejects empty and unbounded input", () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const schema = createDefaultDocumentSchema();

	assert.equal(createDocumentFragmentFromHtml(environment.window.document, schema, ""), undefined);
	assert.equal(createDocumentFragmentFromHtml(environment.window.document, schema, "<p>".padEnd(1_000_001, "x")), undefined);
	environment.window.close();
});
