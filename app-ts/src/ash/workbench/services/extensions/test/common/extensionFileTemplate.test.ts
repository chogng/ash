import { strict as assert } from "node:assert";
import { test } from "mocha";
import { ExtensionFileTemplateRegistry } from "../../common/extensionFileTemplate.js";
import { materializeExtensionFileTemplate } from "../../common/extensionSnippetProvider.js";

test("replaces extension file templates as one immutable catalog", () => {
	using templates = new ExtensionFileTemplateRegistry();
	const changes: number[] = [];
	using listener = templates.onDidChange(catalog => changes.push(catalog.revision));

	templates.replace([{ id: "ash.demo:html", extensionId: "ash.demo", label: "HTML document", languageId: "html", body: "<!doctype html>" }]);
	templates.replace([{ id: "ash.demo:script", extensionId: "ash.demo", label: "JavaScript file", languageId: "javascript", body: "'use strict';" }]);

	assert.deepEqual(changes, [1, 2]);
	assert.equal(templates.currentCatalog.templates[0]?.languageId, "javascript");
	assert.throws(() => templates.replace([
		{ id: "duplicate", extensionId: "ash.demo", label: "One", languageId: "demo", body: "one" },
		{ id: "duplicate", extensionId: "ash.demo", label: "Two", languageId: "demo", body: "two" },
	]), /Duplicate/);
});

test("materializes file-template defaults without leaving snippet tabstops", () => {
	assert.equal(materializeExtensionFileTemplate({ name: "Class", prefixes: [], body: "class ${1:Name} {\n\t$0\n}", isFileTemplate: true }), "class Name {\n\t\n}");
});
