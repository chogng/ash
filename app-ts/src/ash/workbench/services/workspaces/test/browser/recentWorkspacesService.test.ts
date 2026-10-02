import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../../../base/common/uri.js";
import { BrowserStorageService } from "../../../storage/browser/storageService.js";
import { IStorageService, StorageScope, StorageTarget } from "../../../../../platform/storage/common/storage.js";
import { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import { IWorkspacesService, LEGACY_RECENT_WORKSPACES_STORAGE_KEY, RECENTLY_OPENED_STORAGE_KEY } from "../../../../../platform/workspaces/common/workspaces.js";
import { InstantiationService } from "../../../../../platform/instantiation/common/instantiationService.js";
import { IWorkspaceOpenService } from "../../browser/workspaceOpenService.js";
import { BrowserWorkspacesService } from "../../browser/workspacesService.js";
import { RecentWorkspacesService } from "../../browser/recentWorkspacesService.js";
import { WorkspaceContextService } from "../../browser/workspaceContextService.js";

test("RecentWorkspacesService records, persists, deduplicates, and reopens folders", async () => {
	const browser = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test" });
	const openedRoots: string[] = [];
	const workspaceOpenService: IWorkspaceOpenService = {
		canOpenFolder: true,
		canOpenWorkspace: true,
		openFolder: async () => {},
		openWorkspace: async root => {
			openedRoots.push(root);
		},
		pickFolder: async () => undefined,
	};
	using storage = new BrowserStorageService({
		ownerWindow: browser.window as unknown as Window,
		applicationId: "recent-workspaces-test",
		workspaceId: "alpha",
		backend: browser.window.localStorage,
		flushInterval: 0,
	});
	using workspace = new WorkspaceContextService({ id: "alpha", uri: URI.file("/workspaces/alpha") });
	using services = new InstantiationService();
	services.registerInstance(IStorageService, storage);
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IWorkspaceOpenService, workspaceOpenService);
	using history = services.createInstance(BrowserWorkspacesService);
	services.registerInstance(IWorkspacesService, history);
	using recent = services.createInstance(RecentWorkspacesService);
	await recent.initialize();

	assert.deepEqual(recent.recentWorkspaces.map(project => project.name), ["alpha"]);
	workspace.updateWorkspace({ id: "beta", uri: URI.file("/workspaces/beta") });
	workspace.updateWorkspace({ id: "alpha", uri: URI.file("/workspaces/alpha") });
	await recent.initialize();
	assert.deepEqual(recent.recentWorkspaces.map(project => project.name), ["alpha", "beta"]);
	assert.equal(recent.recentWorkspaces.length, 2);
	workspace.updateWorkspace({
		id: "team",
		folders: [
			{ id: "frontend", uri: URI.file("/workspaces/frontend"), name: "frontend", index: 0 },
			{ id: "backend", uri: URI.file("/workspaces/backend"), name: "backend", index: 1 },
		],
		configuration: URI.file("/workspaces/team.code-workspace"),
		name: "Team",
	});
	await recent.initialize();
	assert.deepEqual(recent.recentWorkspaces.map(project => project.name), ["Team", "alpha", "beta"]);
	assert.equal(recent.recentWorkspaces[0]?.root, URI.file("/workspaces/team.code-workspace").fsPath);

	await recent.openWorkspace("/workspaces/beta");
	assert.deepEqual(openedRoots, ["/workspaces/beta"]);
	await storage.flush();

	using restoredStorage = new BrowserStorageService({
		ownerWindow: browser.window as unknown as Window,
		applicationId: "recent-workspaces-test",
		workspaceId: "restored",
		backend: browser.window.localStorage,
		flushInterval: 0,
	});
	using restoredWorkspace = new WorkspaceContextService({ id: "empty-window" });
	using restoredServices = new InstantiationService();
	restoredServices.registerInstance(IStorageService, restoredStorage);
	restoredServices.registerInstance(IWorkspaceContextService, restoredWorkspace);
	restoredServices.registerInstance(IWorkspaceOpenService, workspaceOpenService);
	using restoredHistory = restoredServices.createInstance(BrowserWorkspacesService);
	restoredServices.registerInstance(IWorkspacesService, restoredHistory);
	using restored = restoredServices.createInstance(RecentWorkspacesService);
	await restored.initialize();
	assert.deepEqual(restored.recentWorkspaces.map(project => project.name), ["Team", "alpha", "beta"]);
	assert.notEqual(restoredStorage.get(RECENTLY_OPENED_STORAGE_KEY, StorageScope.PROFILE), undefined);
	await restoredHistory.removeRecentlyOpened([URI.file("/workspaces/alpha")]);
	await restored.initialize();
	assert.deepEqual(restored.recentWorkspaces.map(project => project.name), ["Team", "beta"]);
	await restoredHistory.clearRecentlyOpened();
	await restored.initialize();
	assert.deepEqual(restored.recentWorkspaces, []);
	browser.window.close();
});

test("browser history migrates Welcome records and clears the old key", async () => {
	const browser = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test" });
	try {
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, applicationId: "legacy-recent-test", workspaceId: "empty", backend: browser.window.localStorage, flushInterval: 0 });
		storage.store(LEGACY_RECENT_WORKSPACES_STORAGE_KEY, JSON.stringify([
			{ root: "/workspaces/team.code-workspace", name: "Team", lastOpened: 2 },
			{ root: "/workspaces/alpha", name: "alpha", lastOpened: 1 },
		]), StorageScope.PROFILE, StorageTarget.USER);
		using services = new InstantiationService();
		services.registerInstance(IStorageService, storage);
		using history = services.createInstance(BrowserWorkspacesService);
		const migrated = await history.getRecentlyOpened();
		assert.equal(migrated.workspaces.length, 2);
		assert.equal("workspace" in migrated.workspaces[0]!, true);
		await history.addRecentlyOpened([{ folderUri: URI.file("/workspaces/beta") }]);
		assert.equal(storage.get(LEGACY_RECENT_WORKSPACES_STORAGE_KEY, StorageScope.PROFILE), undefined);
		assert.notEqual(storage.get(RECENTLY_OPENED_STORAGE_KEY, StorageScope.PROFILE), undefined);
		assert.deepEqual((await history.getRecentlyOpened()).workspaces.map(recent => recent.label), [undefined, "Team", "alpha"]);
	} finally { browser.window.close(); }
});
