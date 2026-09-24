import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter } from "../../../../../base/common/event.js";
import { lxiconsLibrary } from "../../../../../base/common/lxiconsLibrary.js";
import { ScmStatusContribution } from "../../../../../workbench/contrib/scm/browser/scmStatus.js";
import type { GitStatus, IGitService } from "../../../../../workbench/services/git/common/gitService.js";
import { StatusbarAlignment, StatusbarService } from "../../../../../workbench/services/statusbar/browser/statusbar.js";
import type { IViewsService } from "../../../../../workbench/services/views/browser/viewsService.js";

test("SCM status projects the Git branch and upstream counts", async () => {
	const changes = new Emitter<GitStatus>();
	let status = branchStatus(2, 3);
	const gitService = {
		onDidChangeStatus: changes.event,
		onDidBecomeReady: () => ({ dispose(): void {}, [Symbol.dispose](): void {} }),
		status: async () => status,
	} as unknown as IGitService;
	const focusedViews: string[] = [];
	const viewsService = {
		focusView: (viewId: string) => { focusedViews.push(viewId); return true; },
	} as unknown as IViewsService;
	using statusbar = new StatusbarService();
	using contribution = new ScmStatusContribution({ statusbarService: statusbar, gitService, viewsService });

	await settle();
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left).map(item => item.id), [
		"ash.status.git.branch",
		"ash.status.git.sync",
	]);
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left).map(item => item.entry.text), ["main", "3↓ 2↑"]);
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left).map(item => item.compactGroup), ["ash.status.git", "ash.status.git"]);
	assert.equal(statusbar.getEntries(StatusbarAlignment.Left)[1]?.entry.icon, lxiconsLibrary.sync);
	assert.equal(statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.run?.(), true);
	assert.equal(statusbar.getEntries(StatusbarAlignment.Left)[1]?.entry.run?.(), true);
	assert.deepEqual(focusedViews, ["ash.gitView", "ash.gitView"]);

	status = detachedStatus();
	changes.fire(status);
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left).map(item => item.entry.text), ["12345678", ""]);

	contribution.dispose();
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left), []);
});

test("Git status events supersede an older in-flight status request", async () => {
	const changes = new Emitter<GitStatus>();
	let resolveInitial!: (status: GitStatus) => void;
	const initial = new Promise<GitStatus>(resolve => { resolveInitial = resolve; });
	const gitService = {
		onDidChangeStatus: changes.event,
		onDidBecomeReady: () => ({ dispose(): void {}, [Symbol.dispose](): void {} }),
		status: () => initial,
	} as unknown as IGitService;
	const viewsService = { focusView: () => true } as unknown as IViewsService;
	using statusbar = new StatusbarService();
	using contribution = new ScmStatusContribution({ statusbarService: statusbar, gitService, viewsService });

	changes.fire(branchStatus(4, 5, "event-branch"));
	resolveInitial(branchStatus(1, 1, "stale-branch"));
	await settle();

	assert.equal(statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text, "event-branch");
});

function branchStatus(ahead: number, behind: number, name = "main"): GitStatus {
	return {
		repositoryId: "repo-1",
		streamInstanceId: "git-stream",
		revision: 1,
		workspacePath: ".",
		head: { type: "branch", name, objectId: "abcdef1234567890", upstream: { name: `origin/${name}`, ahead, behind } },
		changes: [],
	};
}

function detachedStatus(): GitStatus {
	return {
		repositoryId: "repo-1",
		streamInstanceId: "git-stream",
		revision: 2,
		workspacePath: ".",
		head: { type: "detached", objectId: "1234567890abcdef" },
		changes: [],
	};
}

function settle(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}
