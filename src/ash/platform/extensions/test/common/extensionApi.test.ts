import { strict as assert } from "node:assert";
import { test } from "mocha";
import { normalizeExtensionCatalog } from "../../common/extensionApi.js";

test("normalizes an extension catalog and preserves explicit diagnostics", () => {
	const catalog = normalizeExtensionCatalog({
		generation: 3,
		extensions: [{
			id: "ash.demo",
			name: "demo",
			publisher: "ash",
			version: "1.0.0",
			displayName: "Demo",
			sourceKind: "builtIn",
			manifestJson: "{}",
			manifestSha256: `sha256:${"a".repeat(64)}`,
			packageSha256: `sha256:${"b".repeat(64)}`,
		}],
		diagnostics: [{
			source: "user",
			subject: null,
			code: "invalidManifest",
			message: "manifest is invalid",
		}],
	});

	assert.equal(catalog.generation, 3);
	assert.equal(catalog.extensions[0]?.id, "ash.demo");
	assert.equal(catalog.extensions[0]?.packageSha256, `sha256:${"b".repeat(64)}`);
	assert.equal(catalog.diagnostics[0]?.subject, undefined);
	assert(Object.isFrozen(catalog));
});

test("rejects unknown extension diagnostics", () => {
	assert.throws(() => normalizeExtensionCatalog({
		generation: 1,
		extensions: [],
		diagnostics: [{ source: "user", subject: null, code: "unknown", message: "bad" }],
	}));
});

test("rejects malformed extension package digests", () => {
	assert.throws(() => normalizeExtensionCatalog({
		generation: 1,
		extensions: [{
			id: "ash.demo",
			name: "demo",
			publisher: "ash",
			version: "1.0.0",
			displayName: "Demo",
			sourceKind: "builtIn",
			manifestJson: "{}",
			manifestSha256: `sha256:${"a".repeat(64)}`,
			packageSha256: "sha256:not-a-digest",
		}],
		diagnostics: [],
	}), /package digest/);
});
