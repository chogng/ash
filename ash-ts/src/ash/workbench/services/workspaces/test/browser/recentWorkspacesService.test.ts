import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../../../base/common/uri.js";
import { BrowserStorageService } from "../../../storage/browser/storageService.js";
import { StorageScope } from "../../../../../platform/storage/common/storage.js";
import type { IWorkspaceOpenService } from "../../browser/workspaceOpenService.js";
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
	using recent = new RecentWorkspacesService(storage, workspace, workspaceOpenService);

	assert.deepEqual(recent.recentWorkspaces.map(project => project.name), ["alpha"]);
	workspace.updateWorkspace({ id: "beta", uri: URI.file("/workspaces/beta") });
	workspace.updateWorkspace({ id: "alpha", uri: URI.file("/workspaces/alpha") });
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
	assert.deepEqual(recent.recentWorkspaces.map(project => project.name), ["Team", "alpha", "beta"]);
	assert.equal(recent.recentWorkspaces[0]?.root, URI.file("/workspaces/team.code-workspace").fsPath);

	await recent.openWorkspace("/workspaces/beta");
	assert.deepEqual(openedRoots, ["/workspaces/beta"]);

	using restoredStorage = new BrowserStorageService({
		ownerWindow: browser.window as unknown as Window,
		applicationId: "recent-workspaces-test",
		workspaceId: "restored",
		backend: browser.window.localStorage,
		flushInterval: 0,
	});
	using restoredWorkspace = new WorkspaceContextService({ id: "empty-window" });
	using restored = new RecentWorkspacesService(restoredStorage, restoredWorkspace, workspaceOpenService);
	assert.deepEqual(restored.recentWorkspaces.map(project => project.name), ["Team", "alpha", "beta"]);
	assert.equal(restoredStorage.get("workbench.recentWorkspaces", StorageScope.PROFILE) !== undefined, true);
	browser.window.close();
});
