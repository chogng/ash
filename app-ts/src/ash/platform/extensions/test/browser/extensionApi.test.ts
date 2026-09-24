import { strict as assert } from "node:assert";
import { test } from "mocha";
import type { IResourceApi } from "../../../app-server/common/appServerApi.js";
import type { AppServerProtocolClient } from "../../../app-server/browser/appServerProtocolClient.js";
import { createAppServerExtensionApi } from "../../browser/extensionApi.js";
import { MAX_EXTENSION_RESOURCE_BYTES } from "../../common/extensionApi.js";

test("Vite extension resources reject oversized open metadata before reading", async () => {
	let reads = 0;
	const api = createAppServerExtensionApi(connectionReturning({
		resource: metadata(MAX_EXTENSION_RESOURCE_BYTES + 1),
	}), resourceApi({
		read: async () => {
			reads += 1;
			throw new Error("resource read must not run");
		},
	}));

	await assert.rejects(api.readResource({ generation: 1, extensionId: "ash.demo", path: "demo.json" }), /size/);
	assert.equal(reads, 0);
});

test("Vite extension resources reject malformed chunks and release the handle", async () => {
	let releases = 0;
	const api = createAppServerExtensionApi(connectionReturning({ resource: metadata(1) }), resourceApi({
		read: async () => ({
			resourceId: "resource_0000000000000001",
			offset: 0,
			dataBase64: "YQ==",
			decodedLength: 1,
			eof: true,
			unexpected: true,
		} as never),
		release: async () => { releases += 1; },
	}));

	await assert.rejects(api.readResource({ generation: 1, extensionId: "ash.demo", path: "demo.json" }), /shape/);
	assert.equal(releases, 1);
});

test("Vite extension resources verify assembled bytes and release a corrupted handle", async () => {
	let releases = 0;
	const api = createAppServerExtensionApi(connectionReturning({ resource: metadata(1) }), resourceApi({
		read: async () => ({ resourceId: "resource_0000000000000001", offset: 0, dataBase64: "YQ==", decodedLength: 1, eof: true }),
		release: async () => { releases += 1; },
	}));

	await assert.rejects(api.readResource({ generation: 1, extensionId: "ash.demo", path: "demo.json" }), /digest/);
	assert.equal(releases, 1);
});

function connectionReturning(result: unknown): AppServerProtocolClient {
	return { request: async () => result } as unknown as AppServerProtocolClient;
}

function resourceApi(overrides: Partial<IResourceApi>): IResourceApi {
	return {
		metadata: async () => metadata(0),
		read: async () => { throw new Error("resource read is unavailable"); },
		release: async () => {},
		...overrides,
	};
}

function metadata(size: number) {
	return {
		resourceId: "resource_0000000000000001",
		mimeType: "application/json",
		size,
		sha256: `sha256:${"a".repeat(64)}`,
	};
}
