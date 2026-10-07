import { strict as assert } from "node:assert";
import { test } from "mocha";
import { MAX_EXTENSION_RESOURCE_BYTES, normalizeExtensionCatalog, normalizeExtensionResourceChunk, normalizeExtensionResourceOpenResult } from "../../common/extensionApi.js";

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

test("normalizes exact bounded extension resource envelopes", () => {
	const resource = normalizeExtensionResourceOpenResult({
		resource: {
			resourceId: "resource_0000000000000001",
			mimeType: "application/json",
			size: 3,
			sha256: `sha256:${"a".repeat(64)}`,
		},
	});
	const chunk = normalizeExtensionResourceChunk({
		resourceId: resource.resourceId,
		offset: 0,
		dataBase64: "YWJj",
		decodedLength: 3,
		eof: true,
	});

	assert.equal(resource.size, 3);
	assert.equal(chunk.decodedLength, 3);
	assert(Object.isFrozen(resource));
	assert(Object.isFrozen(chunk));
});

test("rejects oversized or structurally ambiguous extension resource envelopes", () => {
	const metadata = {
		resourceId: "resource_0000000000000001",
		mimeType: "application/json",
		size: MAX_EXTENSION_RESOURCE_BYTES + 1,
		sha256: `sha256:${"a".repeat(64)}`,
	};
	assert.throws(() => normalizeExtensionResourceOpenResult({ resource: metadata }), /size/);
	assert.throws(() => normalizeExtensionResourceOpenResult({ resource: { ...metadata, size: 1, unexpected: true } }), /shape/);
	assert.throws(() => normalizeExtensionResourceChunk({ resourceId: metadata.resourceId, offset: 0, dataBase64: "YQ==", decodedLength: 1, eof: true, unexpected: true }), /shape/);
	assert.throws(() => normalizeExtensionResourceChunk({ resourceId: metadata.resourceId, offset: 0, dataBase64: "YQ==", decodedLength: 262_145, eof: true }), /decoded length/);
});
