import { strict as assert } from "node:assert";
import { test } from "mocha";
import { URI } from "../../../base/common/uri.js";
import { LanguagesRegistry } from "../../common/services/languagesRegistry.js";

test("a language description group replaces itself after validating the complete candidate", () => {
	using registry = new LanguagesRegistry();
	using descriptions = registry.registerMany([{ description: { id: "demo", extensions: [".demo"] } }]);

	assert.throws(() => descriptions.replace([{ description: { id: "broken", firstLine: "[" } }]), /regular expression/);
	assert.equal(registry.resolveLanguageId({ resource: URI.file("C:\\project\\file.demo") }), "demo");

	descriptions.replace([{ description: { id: "script", firstLine: "^#!.*demo" } }]);
	assert.equal(registry.resolveLanguageId({ resource: URI.file("C:\\project\\script"), firstLine: "#!/usr/bin/demo" }), "script");
	assert.equal(registry.resolveLanguageId({ resource: URI.file("C:\\project\\file.demo") }), undefined);
});

test("first-line associations are anchored, ignore a UTF-8 BOM, and cannot match empty input", () => {
	using registry = new LanguagesRegistry();
	using descriptions = registry.registerMany([{ description: { id: "script", firstLine: "#!.*\\bdemo" } }]);

	assert.equal(registry.resolveLanguageId({ resource: URI.file("C:\\project\\script"), firstLine: "#!/usr/bin/env demo" }), "script");
	assert.equal(registry.resolveLanguageId({ resource: URI.file("C:\\project\\script"), firstLine: "\uFEFF#!/usr/bin/env demo" }), "script");
	assert.equal(registry.resolveLanguageId({ resource: URI.file("C:\\project\\script"), firstLine: "prefix #!/usr/bin/env demo" }), undefined);
	assert.throws(() => descriptions.replace([{ description: { id: "catch-all", firstLine: ".*" } }]), /must not match an empty line/);
	assert.equal(registry.resolveLanguageId({ resource: URI.file("C:\\project\\script"), firstLine: "#!/usr/bin/env demo" }), "script");
});

test("first-line associations accept VS Code extension regex compatibility escapes", () => {
	using registry = new LanguagesRegistry();
	using description = registry.register({ id: "xml", firstLine: "(\\<\\?xml.*)|(\\<svg)|(\\<\\!doctype\\s+svg)" });

	assert.equal(registry.resolveLanguageId({ resource: URI.file("C:\\project\\document"), firstLine: "<?xml version=\"1.0\"?>" }), "xml");
	assert.equal(registry.resolveLanguageId({ resource: URI.file("C:\\project\\image"), firstLine: "<svg viewBox=\"0 0 10 10\">" }), "xml");
});

test("directory globs recognize snippets at the root and in nested profiles", () => {
	using registry = new LanguagesRegistry();
	using json = registry.register({ id: "json", extensions: [".json"] });
	using snippets = registry.register({ id: "snippets", filenamePatterns: ["**/User/snippets/*.json"] });
	for (const path of ["User/snippets/ruby.json", "/home/me/User/snippets/ruby.json"]) {
		assert.equal(registry.resolveLanguageId({ resource: URI.from({ scheme: "untitled", path }) }), "snippets", path);
	}
	assert.equal(registry.resolveLanguageId({ resource: URI.from({ scheme: "untitled", path: "User/snippets/nested/ruby.json" }) }), "json");
});

test("exact filename associations use the basename of Windows-style paths", () => {
	using registry = new LanguagesRegistry();
	using json = registry.register({ id: "json", extensions: [".json"] });
	using jsonc = registry.register({ id: "jsonc", filenames: ["tasks.json"] });
	for (const path of ["C:\\project\\.vscode\\tasks.json", "/repo/.vscode/tasks.json"]) {
		assert.equal(registry.resolveLanguageId({ resource: URI.file(path) }), "jsonc", path);
	}
	assert.equal(registry.resolveLanguageId({ resource: URI.file("C:\\project\\data.json") }), "json");
	assert.equal(registry.resolveLanguageId({ resource: URI.parse("file:///repo/folder%2Ftasks.json") }), "json");
});

test("supplemental JSONC associations retain the language name, aliases and MIME types", () => {
	using registry = new LanguagesRegistry();
	using jsonc = registry.register({ id: "jsonc", aliases: ["JSON with Comments"], extensions: [".jsonc"], mimetypes: ["application/jsonc"] });
	using typescript = registry.register({ id: "jsonc", filenames: ["tsconfig.json"] });
	assert.equal(registry.getLanguageName("jsonc"), "JSON with Comments");
	assert.equal(registry.getLanguageIdByLanguageName("JSON WITH COMMENTS"), "jsonc");
	assert.equal(registry.getLanguageIdByLanguageName("jsonc"), "jsonc");
	assert.equal(registry.getLanguageIdByMimeType("application/jsonc"), "jsonc");
	assert.equal(registry.resolveLanguageId({ resource: URI.file("/repo/tsconfig.json") }), "jsonc");
	assert.equal(registry.resolveLanguageId({ resource: URI.file("/repo/settings.jsonc") }), "jsonc");
	using renamed = registry.register({ id: "jsonc", aliases: ["Commented JSON"] }, { priority: 200 });
	assert.equal(registry.getLanguageName("jsonc"), "Commented JSON");
	assert.equal(registry.getLanguageIdByLanguageName("JSON with Comments"), "jsonc");
	renamed.dispose();
	assert.equal(registry.getLanguageName("jsonc"), "JSON with Comments");
});
