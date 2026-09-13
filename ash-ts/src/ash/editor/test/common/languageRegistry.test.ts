import { strict as assert } from "node:assert";
import { test } from "mocha";
import { URI } from "../../../base/common/uri.js";
import { LanguageRegistry } from "../../common/languages/languageRegistry.js";

test("a language description group replaces itself after validating the complete candidate", () => {
	using registry = new LanguageRegistry();
	using descriptions = registry.registerMany([{ description: { id: "demo", extensions: [".demo"] } }]);

	assert.throws(() => descriptions.replace([{ description: { id: "broken", firstLine: "[" } }]), /regular expression/);
	assert.equal(registry.resolveLanguageId({ resource: URI.file("C:\\project\\file.demo") }), "demo");

	descriptions.replace([{ description: { id: "script", firstLine: "^#!.*demo" } }]);
	assert.equal(registry.resolveLanguageId({ resource: URI.file("C:\\project\\script"), firstLine: "#!/usr/bin/demo" }), "script");
	assert.equal(registry.resolveLanguageId({ resource: URI.file("C:\\project\\file.demo") }), undefined);
});

test("first-line associations are anchored, ignore a UTF-8 BOM, and cannot match empty input", () => {
	using registry = new LanguageRegistry();
	using descriptions = registry.registerMany([{ description: { id: "script", firstLine: "#!.*\\bdemo" } }]);

	assert.equal(registry.resolveLanguageId({ resource: URI.file("C:\\project\\script"), firstLine: "#!/usr/bin/env demo" }), "script");
	assert.equal(registry.resolveLanguageId({ resource: URI.file("C:\\project\\script"), firstLine: "\uFEFF#!/usr/bin/env demo" }), "script");
	assert.equal(registry.resolveLanguageId({ resource: URI.file("C:\\project\\script"), firstLine: "prefix #!/usr/bin/env demo" }), undefined);
	assert.throws(() => descriptions.replace([{ description: { id: "catch-all", firstLine: ".*" } }]), /must not match an empty line/);
	assert.equal(registry.resolveLanguageId({ resource: URI.file("C:\\project\\script"), firstLine: "#!/usr/bin/env demo" }), "script");
});

test("first-line associations accept VS Code extension regex compatibility escapes", () => {
	using registry = new LanguageRegistry();
	using description = registry.register({ id: "xml", firstLine: "(\\<\\?xml.*)|(\\<svg)|(\\<\\!doctype\\s+svg)" });

	assert.equal(registry.resolveLanguageId({ resource: URI.file("C:\\project\\document"), firstLine: "<?xml version=\"1.0\"?>" }), "xml");
	assert.equal(registry.resolveLanguageId({ resource: URI.file("C:\\project\\image"), firstLine: "<svg viewBox=\"0 0 10 10\">" }), "xml");
});
