import assert from "node:assert/strict";
import { test } from "mocha";
import type { ServerNotification } from "../../../../../platform/app-server/common/generated/index.js";
import type { IServerEventApi } from "../../../../../platform/app-server/common/appServerApi.js";
import type { IMarketplaceApi } from "../../../../../platform/marketplace/common/marketplaceApi.js";
import { AppServerMarketplaceService } from "../../browser/appServerMarketplaceService.js";

test("Marketplace browse snapshots survive view recreation and invalidate after lifecycle changes", async () => {
	let searches = 0;
	const requests: Parameters<IMarketplaceApi["search"]>[0][] = [];
	let installedReads = 0;
	let eventListener: ((event: ServerNotification) => void) | undefined;
	const summary = { id: "example/docs", version: "1.0.0", packageType: "mcp", displayName: "Docs", description: "Documentation search." };
	const packageReference = { id: summary.id, version: summary.version, digest: `sha256:${"a".repeat(64)}` };
	const details = { package: packageReference, packageType: summary.packageType, displayName: summary.displayName, description: summary.description, license: "MIT", source: "thirdParty" as const, upstream: null, capabilities: [] };
	const installed = { installationId: "installed-1", package: packageReference, state: "installed" as const, capabilities: [] };
	const api = {
		search: async (params: Parameters<IMarketplaceApi["search"]>[0]) => {
			requests.push(params);
			searches += 1;
			return { packages: [summary] };
		},
		get: async () => details,
		download: async () => ({ id: "artifact-1", package: packageReference }),
		install: async () => installed,
		update: async () => installed,
		uninstall: async () => {},
		listInstalled: async () => {
			installedReads += 1;
			return { instanceId: "marketplace-runtime-1", generation: 1, packages: [] };
		},
		acquireCapability: async () => { throw new Error("unused"); },
		releaseCapability: async () => {},
		openResource: async () => { throw new Error("unused"); },
	} as IMarketplaceApi;
	const events = {
		subscribe: (listener: (event: ServerNotification) => void) => {
			eventListener = listener;
			return { dispose: () => { eventListener = undefined; } };
		},
	} as IServerEventApi;
	using service = new AppServerMarketplaceService(api, events);
	let installedChanges = 0;
	service.onDidChangeInstalled(() => installedChanges++);

	const first = await service.browse("", { limit: 100 });
	const reopened = await service.browse("", { limit: 100 });
	assert.equal(reopened, first);
	assert.equal(service.cachedBrowse("", { limit: 100 }), first);
	assert.equal(searches, 1);
	assert.equal(installedReads, 1);

	await service.install(summary.id, summary.version);
	assert.equal(installedChanges, 0);
	assert.equal(service.cachedBrowse("", { limit: 100 }), first);

	eventListener?.({ method: "marketplace/changed", params: { instanceId: "marketplace-runtime-1", generation: 2 } });
	assert.equal(installedChanges, 1);
	assert.equal(service.cachedBrowse("", { limit: 100 }), undefined);
	await service.browse("", { limit: 100 });
	assert.equal(searches, 2);
	assert.equal(installedReads, 2);

	eventListener?.({ method: "marketplace/changed", params: { instanceId: "marketplace-runtime-1", generation: 2 } });
	assert.equal(installedChanges, 1, "replayed generations are ignored");

	eventListener?.({ method: "marketplace/changed", params: { instanceId: "marketplace-runtime-1", generation: 3 } });
	assert.equal(installedChanges, 2, "another connection invalidates this service");

	eventListener?.({ method: "marketplace/changed", params: { instanceId: "marketplace-runtime-2", generation: 1 } });
	assert.equal(installedChanges, 3, "a restarted authority accepts its lower initial generation");
	const skills = await service.browse("", { capabilityKind: "skill" });
	const lsp = await service.browse("", { capabilityKind: "executable", languageId: "typescriptreact" });
	assert.notEqual(skills, lsp);
	assert.equal(await service.browse("", { capabilityKind: "skill" }), skills);
	assert.deepEqual(requests.slice(-2), [
		{ query: "", packageType: null, limit: null, capabilityKind: "skill", languageId: null },
		{ query: "", packageType: null, limit: null, capabilityKind: "executable", languageId: "typescriptreact" },
	]);
});
