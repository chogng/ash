import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import type { IContextMenuProvider } from "../../../../../base/browser/contextmenu.js";
import { AnchorAxisAlignment, AnchorPosition } from "../../../../../base/common/layout.js";
import { URI } from "../../../../../base/common/uri.js";
import { MenuId, registerAction2 } from "../../../../../platform/actions/common/actions.js";
import type { ICommandService } from "../../../../../platform/commands/common/commands.js";
import { ServiceContainer } from "../../../../../platform/instantiation/common/instantiation.js";
import type { IContextMenuService } from "../../../../../platform/contextview/browser/contextView.js";
import type { HoverSetupOptions, IHoverService, IManagedHover } from "../../../../../platform/hover/browser/hoverService.js";
import type { IResourceIconRenderer } from "../../../../browser/labels.js";
import { IGitService, type GraphQuery, type GitStatus } from "../../../../../workbench/services/git/common/gitService.js";
import { IEditorService, type EditorInput, type EditorOpenOptions } from "../../../../../workbench/services/editor/common/editorService.js";
import { CommandService } from "../../../../../workbench/services/commands/common/commandService.js";
import { OpenScmMultiDiffEditorAction } from "../../../../../workbench/contrib/multiDiffEditor/browser/scmMultiDiffAction.js";
import { resolveGitChangeInputs } from "../../../../../workbench/contrib/scm/browser/scmChangeEditorInput.js";
import { emptyEditorServiceState } from '../../../../../workbench/test/common/testEditorService.js';

test("SCM diff inputs open live files and keep deleted files on the readable side", async () => {
	const status: GitStatus = {
		repositoryId: "repo-1",
		streamInstanceId: "git-input-stream",
		revision: 1,
		workspacePath: "/workspace",
		head: { type: "branch", name: "main", objectId: "1234567890", upstream: undefined },
		changes: [],
	};
	const gitService = {
		changeFile: async (path: string) => path.endsWith("deleted.ts")
			? { original: { kind: "text" as const, text: "before\n" }, modified: { kind: "missing" as const } }
			: { original: { kind: "text" as const, text: "before\n" }, modified: { kind: "text" as const, text: "after\n" } },
	} as unknown as IGitService;
	const live = await resolveGitChangeInputs(gitService, status, change("src/working.ts", "unmodified", "modified"), "unstaged");
	const deleted = await resolveGitChangeInputs(gitService, status, change("src/deleted.ts", "unmodified", "deleted"), "unstaged");

	assert.equal(live.goToFile?.resource.toString(), "file:///workspace/src/working.ts");
	assert.equal(deleted.goToFile, deleted.original);
});

test("Git contribution registers Changes, Agent Review, and Graph as ordered panes", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);

	try {
		const { WorkbenchViewRegistry, WorkbenchViewContainerId } = await import("../../../../../workbench/common/views.js");
		const { GIT_AGENT_REVIEW_VIEW_ID, GIT_GRAPH_VIEW_ID, GIT_VIEW_ID, registerGitViews } = await import("../../../../../workbench/contrib/scm/browser/scm.contribution.js");
		const registry = new WorkbenchViewRegistry();

		registerGitViews(registry);

		const views = registry.getViews(WorkbenchViewContainerId.Git);
		assert.deepEqual(views.map((view) => view.id), [GIT_VIEW_ID, GIT_AGENT_REVIEW_VIEW_ID, GIT_GRAPH_VIEW_ID]);
		assert.deepEqual(views.map((view) => view.title), ["Changes", "Agent Review", "Graph"]);
		assert.deepEqual(views.map((view) => view.collapsed === true), [false, true, true]);
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

test("ScmGraphViewPane renders a repository history page", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	const graphRequests: GraphQuery[] = [];
	const [
		{ ContextKeyService },
		{ MenuService },
		{ ServiceContainer },
		{ CommandService },
	] = await Promise.all([
		import("../../../../../platform/contextkey/browser/contextKeyService.js"),
		import("../../../../../platform/actions/common/menuService.js"),
		import("../../../../../platform/instantiation/common/instantiation.js"),
		import("../../../../../workbench/services/commands/common/commandService.js"),
	]);
	using contextKeyService = new ContextKeyService();
	const services = new ServiceContainer();
	const menuService = new MenuService(new CommandService(services), contextKeyService);
	const hoverOptions: HoverSetupOptions[] = [];
	const graphRepositoryIds: Array<string | undefined> = [];
	const remoteRepositoryIds: Array<string | undefined> = [];
	let readySubscriptions = 0;
	const hoverService: IHoverService = {
		setupHover: (options) => {
			hoverOptions.push(options);
			return testManagedHover();
		},
		showHover: () => testManagedHover(),
		hideHover() {},
	};
	const status: GitStatus = {
		repositoryId: "repo-1",
		streamInstanceId: "git-graph-stream",
		revision: 1,
		workspacePath: ".",
		head: { type: "branch", name: "main", objectId: "1234567890abcdef", upstream: { name: "origin/main", ahead: 0, behind: 0 } },
		changes: [],
	};
	const gitService = {
		activeRepository: { id: "repo-1", label: "workspace", path: "", root: URI.file("/workspace") },
		onDidBecomeReady: () => {
			readySubscriptions += 1;
			return noEvent();
		},
		status: async (repositoryId?: string) => {
			assert.equal(repositoryId, "repo-1");
			return status;
		},
		graph: async (query: GraphQuery, repositoryId?: string) => {
				graphRequests.push(query);
				graphRepositoryIds.push(repositoryId);
				return {
					commits: [
						{ objectId: "1234567890abcdef", parentObjectIds: ["abcdef1234567890", "side-parent"], timestampSeconds: 1_753_000_000, subject: "Wire SCM panes" },
						{ objectId: "abcdef1234567890", parentObjectIds: ["parent-one", "parent-two"], timestampSeconds: 1_752_900_000, subject: "Prepare graph data" },
					],
					references: [
						{ name: "main", objectId: "1234567890abcdef", kind: "localBranch", remoteName: undefined, current: true },
						{ name: "origin/main", objectId: "abcdef1234567890", kind: "remoteBranch", remoteName: "origin", current: false },
					],
					remotes: [{ name: "origin", identity: { provider: "github", host: "github.com", owner: "chogng", repository: "ash" } }],
					hasMore: false,
					nextCursor: undefined,
				};
			},
		fetch: async (repositoryId?: string) => {
			remoteRepositoryIds.push(repositoryId);
			return status;
		},
	} as unknown as IGitService;
	services.registerInstance(IGitService, gitService);

	try {
		const { ScmGraphViewPane } = await import("../../../../../workbench/contrib/scm/browser/scmGraphViewPane.js");
		using pane = new ScmGraphViewPane(browser.window.document.body, { id: "ash.gitGraph.test", title: "Graph" }, gitService, menuService, {} as IContextMenuService, contextKeyService, hoverService, testEditorService(), testFileIconThemeService());
		browser.window.document.body.append(pane.element);
		await waitFor(() => pane.element.querySelectorAll(".ash-scm-graph-commit").length === 2);
		assert.equal(readySubscriptions, 1);

		const remoteActionItems = [...pane.element.querySelectorAll<HTMLElement>(".ash-pane-view-header-actions .ash-action-view-item")];
		assert.deepEqual(remoteActionItems.map((item) => item.dataset.actionId), ["ash.git.fetch", "ash.git.pull", "ash.git.push", "ash.git.graph.refresh"]);
		assert.equal(remoteActionItems.filter((item) => item.querySelector(".ash-icon")).length, 4);
		pane.setCollapsed(true);
		assert.equal(pane.element.querySelector<HTMLElement>(".ash-pane-view-header-actions")?.hidden, true);
		pane.setCollapsed(false);
		assert.equal(pane.element.querySelector<HTMLElement>(".ash-pane-view-header-actions")?.hidden, false);

		const refresh = pane.element.querySelector<HTMLButtonElement>('[data-action-id="ash.git.graph.refresh"] > button');
		assert.ok(refresh);
		refresh.click();
		await waitFor(() => graphRequests.length === 2 && pane.element.querySelectorAll(".ash-scm-graph-subject").length === 2);
		assert.deepEqual(graphRequests, [{ limit: 50 }, { limit: 50 }]);
		assert.deepEqual(graphRepositoryIds, ["repo-1", "repo-1"]);

		assert.deepEqual([...pane.element.querySelectorAll(".ash-scm-graph-subject")].map((element) => element.textContent), ["Wire SCM panes", "Prepare graph data"]);
		assert.equal(pane.element.querySelector(".ash-scm-graph-commit.current")?.getAttribute("aria-current"), "true");
		assert.ok(pane.element.querySelector(".ash-scm-graph-commit.head"));
		assert.ok(pane.element.querySelector(".ash-scm-graph-commit.merge"));
		assert.ok(pane.element.querySelector(".ash-scm-graph-commit.head.merge"));
		assert.equal(pane.element.querySelector(".ash-scm-graph-label.head")?.textContent, "main");
		assert.ok(pane.element.querySelector(".ash-scm-graph-label.head .ash-icon"));
		assert.equal(pane.element.querySelector(".ash-scm-graph-label.remote")?.textContent, "origin/main");
		assert.equal(pane.element.querySelector<HTMLElement>(".ash-scm-graph-label.remote")?.dataset.icon, "cloud");
		assert.match(pane.element.querySelector(".ash-scm-graph-remote")?.textContent ?? "", /^GitHub · chogng\/ash · origin$/);
		assert.equal(hoverOptions.length, 4);
		assert.ok(hoverOptions.every((options) => options.target.classList.contains("ash-scm-graph-commit")));
		assert.ok(hoverOptions.every((options) => options.anchorAxisAlignment === AnchorAxisAlignment.Horizontal));
		assert.ok(hoverOptions.every((options) => options.anchorPosition === AnchorPosition.Below));
		assert.equal(pane.element.querySelector(".ash-scm-graph-graph.head")?.querySelectorAll(".ash-scm-graph-node").length, 2);
		assert.ok(new Set([...pane.element.querySelectorAll<SVGPathElement>(".ash-scm-graph-path")].map((path) => path.dataset.laneColor)).size > 1);
		assert.equal(pane.element.querySelector(".ash-scm-graph-commit.head.merge > .ash-scm-graph-row > .ash-scm-graph-graph")?.classList.contains("head"), true);
		assert.equal(pane.element.querySelector(".ash-scm-graph-commit.head.merge > .ash-scm-graph-row > .ash-scm-graph-graph")?.classList.contains("merge"), false);
		assert.equal(pane.element.querySelectorAll(".ash-scm-graph-twistie").length, 0);
		assert.equal(pane.element.querySelector(".ash-scm-graph-graph.merge")?.querySelectorAll(".ash-scm-graph-node").length, 2);
		assert.equal(pane.element.querySelector<SVGSVGElement>(".ash-scm-graph-graph.merge")?.style.width, "44px");
		assert.ok((pane.element.querySelector(".ash-scm-graph-graph.merge")?.querySelectorAll(".ash-scm-graph-path").length ?? 0) > 1);
		assert.match(pane.element.querySelector(".ash-scm-graph-metadata")?.textContent ?? "", /^1234567 · /);

		const fetch = pane.element.querySelector<HTMLButtonElement>('[data-action-id="ash.git.fetch"] > button');
		assert.ok(fetch);
		fetch.click();
		await waitFor(() => remoteRepositoryIds.length === 1 && graphRequests.length === 3);
		assert.deepEqual(remoteRepositoryIds, ["repo-1"]);
		assert.equal(readySubscriptions, 1);
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

test("ScmGraphViewPane loads the complete history across graph pages", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	const graphRequests: GraphQuery[] = [];
	const [
		{ ContextKeyService },
		{ MenuService },
		{ ServiceContainer },
		{ CommandService },
	] = await Promise.all([
		import("../../../../../platform/contextkey/browser/contextKeyService.js"),
		import("../../../../../platform/actions/common/menuService.js"),
		import("../../../../../platform/instantiation/common/instantiation.js"),
		import("../../../../../workbench/services/commands/common/commandService.js"),
	]);
	using contextKeyService = new ContextKeyService();
	const menuService = new MenuService(new CommandService(new ServiceContainer()), contextKeyService);
	const hoverService: IHoverService = {
		setupHover: () => testManagedHover(),
		showHover: () => testManagedHover(),
		hideHover() {},
	};
	const status: GitStatus = {
		repositoryId: "repo-1",
		streamInstanceId: "git-graph-stream",
		revision: 1,
		workspacePath: ".",
		head: { type: "branch", name: "main", objectId: "commit-1", upstream: undefined },
		changes: [],
	};
	const gitService = {
		onDidBecomeReady: noEvent,
		status: async () => status,
		graph: async (query: GraphQuery) => {
			graphRequests.push(query);
			const firstPage = [
				{ objectId: "commit-1", parentObjectIds: ["commit-2"], timestampSeconds: 1_753_000_000, subject: "First page one" },
				{ objectId: "commit-2", parentObjectIds: ["commit-3"], timestampSeconds: 1_752_900_000, subject: "First page two" },
			];
			const secondPage = [
				{ objectId: "commit-3", parentObjectIds: [], timestampSeconds: 1_752_800_000, subject: "Second page one" },
			];
			return {
				commits: query.cursor ? secondPage : firstPage,
				references: [],
				remotes: [],
				hasMore: !query.cursor,
				nextCursor: query.cursor ? undefined : "cursor-1",
			};
		},
	} as unknown as IGitService;

	try {
		const { ScmGraphViewPane } = await import("../../../../../workbench/contrib/scm/browser/scmGraphViewPane.js");
		using pane = new ScmGraphViewPane(browser.window.document.body, { id: "ash.gitGraph.pagination.test", title: "Graph" }, gitService, menuService, {} as IContextMenuService, contextKeyService, hoverService, testEditorService(), testFileIconThemeService());
		browser.window.document.body.append(pane.element);
		await waitFor(() => pane.element.querySelector(".ash-scm-graph-list") !== null);
		const list = pane.element.querySelector(".ash-scm-graph-list");
		await waitFor(() => pane.element.querySelectorAll(".ash-scm-graph-commit").length === 3);

		assert.deepEqual(graphRequests, [{ limit: 50 }, { limit: 50, cursor: "cursor-1" }]);
		assert.equal(pane.element.querySelector(".ash-scm-graph-list"), list);
		assert.deepEqual([...pane.element.querySelectorAll(".ash-scm-graph-subject")].map((element) => element.textContent), ["First page one", "First page two", "Second page one"]);
		assert.equal(pane.element.querySelector(".ash-scm-graph-load-more"), null);
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

test("ScmGraphViewPane virtualizes loaded history rows", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	let resizeCallback: ResizeObserverCallback | undefined;
	class TestResizeObserver {
		constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	}
	Object.defineProperty(browser.window, "ResizeObserver", { configurable: true, value: TestResizeObserver });
	Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });
	const [
		{ ContextKeyService },
		{ MenuService },
		{ ServiceContainer },
		{ CommandService },
	] = await Promise.all([
		import("../../../../../platform/contextkey/browser/contextKeyService.js"),
		import("../../../../../platform/actions/common/menuService.js"),
		import("../../../../../platform/instantiation/common/instantiation.js"),
		import("../../../../../workbench/services/commands/common/commandService.js"),
	]);
	using contextKeyService = new ContextKeyService();
	const menuService = new MenuService(new CommandService(new ServiceContainer()), contextKeyService);
	const status: GitStatus = {
		repositoryId: "repo-1",
		streamInstanceId: "git-graph-stream",
		revision: 1,
		workspacePath: ".",
		head: { type: "branch", name: "main", objectId: "commit-0", upstream: undefined },
		changes: [],
	};
	const commits = Array.from({ length: 100 }, (_, index) => ({
		objectId: `commit-${index}`,
		parentObjectIds: index === 99 ? [] : [`commit-${index + 1}`],
		timestampSeconds: 1_753_000_000 - index,
		subject: `Commit ${index}`,
	}));
	const gitService = {
		onDidBecomeReady: noEvent,
		status: async () => status,
		graph: async (_query: GraphQuery) => ({ commits, references: [], remotes: [], hasMore: false, nextCursor: undefined }),
	} as unknown as IGitService;
	const hoverService: IHoverService = {
		setupHover: () => testManagedHover(),
		showHover: () => testManagedHover(),
		hideHover() {},
	};

	try {
		const { ScmGraphViewPane } = await import("../../../../../workbench/contrib/scm/browser/scmGraphViewPane.js");
		using pane = new ScmGraphViewPane(browser.window.document.body, { id: "ash.gitGraph.virtualized.test", title: "Graph" }, gitService, menuService, {} as IContextMenuService, contextKeyService, hoverService, testEditorService(), testFileIconThemeService());
		const graph = pane.element.querySelector<HTMLElement>(".ash-scm-graph");
		assert.ok(graph);
		Object.defineProperty(graph, "clientHeight", { configurable: true, value: 100 });
		browser.window.document.body.append(pane.element);
		await waitFor(() => pane.element.querySelectorAll(".ash-scm-graph-commit").length > 0);

		const initialRows = pane.element.querySelectorAll(".ash-scm-graph-commit").length;
		assert.ok(initialRows < commits.length);
		assert.equal(pane.element.querySelectorAll(".ash-scm-graph-spacer").length, 2);
		assert.equal(pane.element.querySelectorAll<HTMLElement>(".ash-scm-graph-spacer")[1].style.height, `${(commits.length - initialRows) * 22}px`);

		Object.defineProperty(graph, "clientHeight", { configurable: true, value: 320 });
		resizeCallback?.([{ borderBoxSize: [{ inlineSize: 320, blockSize: 320 }], contentRect: { width: 320, height: 320 } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
		assert.ok(pane.element.querySelectorAll(".ash-scm-graph-commit").length > initialRows);

		const list = pane.element.querySelector<HTMLElement>(".ash-scm-graph-list");
		assert.ok(list);
		Object.defineProperty(graph, "offsetParent", { configurable: true, value: browser.window.document.body });
		Object.defineProperty(list, "offsetParent", { configurable: true, value: browser.window.document.body });
		Object.defineProperty(graph, "offsetTop", { configurable: true, value: 450 });
		Object.defineProperty(list, "offsetTop", { configurable: true, value: 478 });
		Object.defineProperty(graph, "scrollTop", { configurable: true, writable: true, value: 1_000 });
		graph.dispatchEvent(new browser.window.Event("scroll"));
		assert.ok([...pane.element.querySelectorAll(".ash-scm-graph-subject")].some((element) => element.textContent === "Commit 45"));
		assert.ok(pane.element.querySelectorAll(".ash-scm-graph-commit").length < commits.length);
	} finally {
		Reflect.deleteProperty(globalThis, "ResizeObserver");
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

test("ScmGraphViewPane expands commit files and opens a selected change in the diff editor", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	const [{ ContextKeyService }, { MenuService }, { ServiceContainer }, { CommandService }] = await Promise.all([
		import("../../../../../platform/contextkey/browser/contextKeyService.js"),
		import("../../../../../platform/actions/common/menuService.js"),
		import("../../../../../platform/instantiation/common/instantiation.js"),
		import("../../../../../workbench/services/commands/common/commandService.js"),
	]);
	using contextKeyService = new ContextKeyService();
	const menuService = new MenuService(new CommandService(new ServiceContainer()), contextKeyService);
	const objectId = "1".repeat(40);
	const parentObjectId = "2".repeat(40);
	let changeRequests = 0;
	let fileRequests = 0;
	const gitService = {
		onDidBecomeReady: noEvent,
		status: async (): Promise<GitStatus> => ({
			repositoryId: "repo-1",
			streamInstanceId: "git-graph-stream",
			revision: 1,
			workspacePath: ".",
			head: { type: "branch", name: "main", objectId, upstream: undefined },
			changes: [],
		}),
		graph: async () => ({
			commits: [{ objectId, parentObjectIds: [parentObjectId], timestampSeconds: 1_753_000_000, subject: "Change editor files" }],
			references: [{ name: "main", objectId, kind: "localBranch" as const, remoteName: undefined, current: true }],
			remotes: [],
			hasMore: false,
			nextCursor: undefined,
		}),
		commitChanges: async () => {
			changeRequests += 1;
			return { parentObjectId, changes: [{ path: "src/editor.ts", originalPath: undefined, status: "modified" as const }] };
		},
		commitFile: async () => {
			fileRequests += 1;
			return { original: { kind: "text" as const, text: "before\n" }, modified: { kind: "text" as const, text: "after\n" } };
		},
	} as unknown as IGitService;
	const opened: Array<{ readonly input: EditorInput; readonly options: EditorOpenOptions | undefined }> = [];
	const editorService = testEditorService(opened);
	const hoverService: IHoverService = {
		setupHover: () => testManagedHover(),
		showHover: () => testManagedHover(),
		hideHover() {},
	};
	const contextMenus: Array<{
		readonly menuId: MenuId;
		readonly menuActionOptions?: { readonly arg?: unknown; readonly args?: readonly unknown[] };
	}> = [];
	const contextMenuService = {
		showContextMenu: (options: { readonly menuId: MenuId; readonly menuActionOptions?: { readonly arg?: unknown; readonly args?: readonly unknown[] } }) => contextMenus.push(options),
	} as unknown as IContextMenuService;

	try {
		const { ScmGraphViewPane } = await import("../../../../../workbench/contrib/scm/browser/scmGraphViewPane.js");
		using pane = new ScmGraphViewPane(browser.window.document.body, { id: "ash.gitGraph.changes.test", title: "Graph" }, gitService, menuService, contextMenuService, contextKeyService, hoverService, editorService, testFileIconThemeService());
		browser.window.document.body.append(pane.element);
		await waitFor(() => pane.element.querySelector(".ash-scm-graph-commit") !== null);

		const commit = pane.element.querySelector<HTMLElement>(".ash-scm-graph-commit");
		assert.ok(commit);
		commit.dispatchEvent(new browser.window.MouseEvent("contextmenu", { bubbles: true }));
		assert.equal(contextMenus[0]?.menuId, MenuId.SCMHistoryItemContext);
		assert.equal((contextMenus[0]?.menuActionOptions?.arg as { readonly objectId: string }).objectId, objectId);
		commit.click();
		await waitFor(() => pane.element.querySelector(".ash-scm-graph-change") !== null);
		assert.equal(changeRequests, 1);
		assert.equal(fileRequests, 0);
		assert.equal(pane.element.querySelector(".ash-scm-graph-commit")?.getAttribute("aria-expanded"), "true");
		assert.equal(pane.element.querySelector(".ash-scm-graph-change-label .ash-icon-label-text")?.textContent, "editor.ts");
		assert.equal(pane.element.querySelector(".ash-scm-graph-change-description")?.textContent, "src");
		assert.equal(pane.element.querySelector(".ash-scm-graph-change-label .ash-icon-label-icon")?.getAttribute("data-file-icon"), "editor.ts");
		assert.ok([...pane.element.querySelectorAll<SVGPathElement>(".ash-scm-graph-path")].some((path) => path.getAttribute("d")?.endsWith("V 44")));
		assert.equal(commit.style.getPropertyValue("--scm-graph-node-x"), "11px");
		assert.equal(commit.style.getPropertyValue("--scm-graph-content-x"), "22px");
		assert.ok(commit.querySelector(":scope > .ash-scm-graph-row > .ash-scm-graph-graph"));

		const change = pane.element.querySelector<HTMLButtonElement>(".ash-scm-graph-change");
		change?.dispatchEvent(new browser.window.MouseEvent("contextmenu", { bubbles: true }));
		assert.equal(contextMenus[1]?.menuId, MenuId.SCMHistoryItemChangeContext);
		assert.deepEqual(
			contextMenus[1]?.menuActionOptions?.args?.map(value => (value as { readonly path?: string; readonly objectId?: string }).path ?? (value as { readonly objectId?: string }).objectId),
			[objectId, "src/editor.ts"],
		);
		change?.click();
		await waitFor(() => opened.length === 1);
		assert.equal(fileRequests, 1);
		assert.equal(opened[0].input.contentType, "application/vnd.stanza.editor-diff");
		assert.equal(opened[0].input.label, "editor.ts (2222222) ↔ editor.ts (1111111)");
		assert.equal(opened[0].options?.pinned, false);

		change?.dispatchEvent(new browser.window.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
		await waitFor(() => opened.length === 2);
		assert.equal(fileRequests, 2);
		assert.equal(opened[1].options?.pinned, true);
		pane.dispose();
		commit.dispatchEvent(new browser.window.MouseEvent("contextmenu", { bubbles: true }));
		change?.dispatchEvent(new browser.window.MouseEvent("contextmenu", { bubbles: true }));
		assert.equal(contextMenus.length, 2);
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

test("ScmAgentReviewViewPane exposes an explicit empty state", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);

	try {
		const { ScmAgentReviewViewPane } = await import("../../../../../workbench/contrib/scm/browser/scmAgentReviewViewPane.js");
		using pane = new ScmAgentReviewViewPane(browser.window.document.body, { id: "ash.gitAgentReview.test", title: "Agent Review" });
		assert.equal(pane.element.querySelector(".ash-scm-empty")?.textContent, "No agent changes to review.");
		const findIssues = pane.element.querySelector<HTMLButtonElement>(".ash-scm-find-issues");
		assert.ok(findIssues);
		assert.equal(findIssues.textContent, "Find Issues");
		assert.ok(findIssues.classList.contains("ash-button"));
		assert.ok(findIssues.classList.contains("label-centered"));
		assert.ok(findIssues.querySelector(".ash-icon"));
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

test("ScmViewPane groups App Server Git status", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	let requestCount = 0;
	let stagedPaths: readonly string[] | undefined;
	let stagedRepositoryId: string | undefined;
	let completeStage: (() => void) | undefined;
	let committedMessage: string | undefined;
	let committedRepositoryId: string | undefined;
	let statusListener: ((status: GitStatus) => void) | undefined;
	const changeFileRequests: Array<{ readonly path: string; readonly comparison: "staged" | "unstaged"; readonly repositoryId: string | undefined }> = [];
	const opened: Array<{ readonly input: EditorInput; readonly options: EditorOpenOptions | undefined }> = [];
	const first: GitStatus = {
		repositoryId: "repo-1",
		streamInstanceId: "git-stream-1",
		revision: 1,
		workspacePath: ".",
		head: {
			type: "branch",
			name: "main",
			objectId: "1234567890",
			upstream: { name: "origin/main", ahead: 2, behind: 1 },
		},
		changes: [
			change("staged.ts", "added", "unmodified"),
			change("src/working.ts", "unmodified", "modified"),
			change("both.ts", "modified", "modified"),
			{ ...change("conflict.ts", "unmerged", "unmerged"), conflicted: true },
		],
	};
	const committedClean: GitStatus = {
		repositoryId: first.repositoryId,
		streamInstanceId: first.streamInstanceId,
		revision: 2,
		workspacePath: first.workspacePath,
		head: first.head,
		changes: [],
	};
	const external: GitStatus = {
		...first,
		revision: 3,
	};
	const nestedStatus: GitStatus = {
		repositoryId: "repo-2",
		streamInstanceId: "git-stream-2",
		revision: 1,
		workspacePath: "/workspace/nested",
		head: { type: "branch", name: "nested", objectId: "2345678901", upstream: undefined },
		changes: [],
	};
	const repositories = [
		{ id: first.repositoryId, label: "workspace", path: "", root: URI.file("/workspace") },
		{ id: nestedStatus.repositoryId, label: "nested", path: "nested", root: URI.file("/workspace/nested") },
	];
	let activeRepository = repositories[0];
	const selectedRepositories: string[] = [];
	const gitService = {
		repositories,
		get activeRepository() { return activeRepository; },
		onDidChangeRepositories: noEvent,
		onDidChangeActiveRepository: noEvent,
		selectRepository: async (repositoryId: string) => {
			selectedRepositories.push(repositoryId);
			activeRepository = repositories.find(repository => repository.id === repositoryId)!;
			return nestedStatus;
		},
		status: async () => {
			requestCount += 1;
			return first;
		},
		stage: (paths: readonly string[], repositoryId?: string) => new Promise<GitStatus>((resolve) => {
			stagedPaths = paths;
			stagedRepositoryId = repositoryId;
			completeStage = () => resolve(first);
		}),
		unstage: async () => first,
		discardWorktree: async () => first,
		commit: async (message: string, repositoryId?: string) => {
			committedMessage = message;
			committedRepositoryId = repositoryId;
			return { objectId: "abcdef123456", status: committedClean };
		},
		fetch: async () => first,
		pull: async () => first,
		push: async () => first,
		changeFile: async (path: string, comparison: "staged" | "unstaged", repositoryId?: string) => {
			changeFileRequests.push({ path, comparison, repositoryId });
			return comparison === "staged"
				? { original: { kind: "text" as const, text: "head\n" }, modified: { kind: "text" as const, text: "index\n" } }
				: { original: { kind: "text" as const, text: "index\n" }, modified: { kind: "text" as const, text: "worktree\n" } };
		},
		onDidChangeStatus: (listener: (status: GitStatus) => void) => {
			statusListener = listener;
			const dispose = () => {
				statusListener = undefined;
			};
			return { dispose, [Symbol.dispose]: dispose };
		},
		onDidBecomeReady: () => ({ dispose(): void {}, [Symbol.dispose](): void {} }),
	} as unknown as IGitService;

	try {
		const { ScmViewPane } = await import("../../../../../workbench/contrib/scm/browser/scmViewPane.js");
		const editorService = testEditorService(opened);
		const services = new ServiceContainer();
		services.registerInstance(IGitService, gitService);
		services.registerInstance(IEditorService, editorService);
		using commandService = new CommandService(services);
		using actionRegistration = registerAction2(OpenScmMultiDiffEditorAction);
		using pane = new ScmViewPane(browser.window.document.body, {
			id: "ash.git",
			title: "Changes",
		}, gitService, testFileIconThemeService(), editorService, commandService, testContextMenuProvider);
		browser.window.document.body.append(pane.element);
		await waitFor(() => pane.element.querySelector(".ash-scm-status")?.textContent === "4 changed files");

		assert.equal(pane.element.querySelector(".ash-scm-branch"), null);
		assert.equal(pane.element.querySelector(".ash-scm-summary"), null);
		assert.ok(pane.element.querySelector(".ash-scm-status")?.classList.contains("ash-aria-live"));
		assert.deepEqual(
			[...pane.element.querySelectorAll(".ash-scm-section-heading > span:first-child")].map((element) => element.textContent),
			["Merge Changes", "Staged Changes", "Changes"],
		);
		assert.deepEqual(
			[...pane.element.querySelectorAll(".ash-scm-section-count")].map((element) => element.textContent),
			["1", "2", "2"],
		);

		const workingLabel = [...pane.element.querySelectorAll<HTMLElement>(".ash-scm-change-label")]
			.find((element) => element.querySelector(".ash-icon-label-text")?.textContent === "working.ts");
		assert.ok(workingLabel);
		assert.equal(workingLabel.querySelector(".ash-scm-change-description")?.textContent, "src");
		assert.equal(workingLabel.querySelector(".ash-icon-label-icon")?.getAttribute("data-file-icon"), "working.ts");
		assert.equal(pane.element.querySelector<HTMLButtonElement>('button[aria-label="Merge conflict in conflict.ts"]')?.disabled, true);

		const stagedOpen = pane.element.querySelector<HTMLButtonElement>('button[aria-label="Open staged changes for staged.ts"]');
		assert.ok(stagedOpen);
		stagedOpen.click();
		await waitFor(() => opened.length === 1);
		assert.deepEqual(changeFileRequests[0], { path: "staged.ts", comparison: "staged", repositoryId: first.repositoryId });
		assert.equal(opened[0].input.contentType, "application/vnd.stanza.editor-diff");
		assert.equal(opened[0].input.label, "staged.ts (HEAD) ↔ staged.ts (Index)");
		assert.equal(opened[0].options?.pinned, false);

		const workingOpen = pane.element.querySelector<HTMLButtonElement>('button[aria-label="Open changes for src/working.ts"]');
		assert.ok(workingOpen);
		workingOpen.click();
		await waitFor(() => opened.length === 2);
		assert.deepEqual(changeFileRequests[1], { path: "src/working.ts", comparison: "unstaged", repositoryId: first.repositoryId });
		assert.equal(opened[1].input.contentType, "application/vnd.stanza.editor-diff");
		assert.equal(opened[1].input.label, "working.ts (Index) ↔ working.ts (Working Tree)");
		assert.equal(opened[1].options?.pinned, false);

		workingOpen.dispatchEvent(new browser.window.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
		await waitFor(() => opened.length === 3);
		assert.equal(opened[2].options?.pinned, true);

		const viewAllChanges = pane.element.querySelector<HTMLButtonElement>('button[aria-label="View All Changes"]');
		assert.ok(viewAllChanges);
		assert.ok(viewAllChanges.querySelector(".ash-icon"));
		viewAllChanges.click();
		await waitFor(() => opened.length === 4);
		assert.equal(opened[3].input.contentType, "application/vnd.stanza.editor-multi-diff");
		const multiDiffInput = opened[3].input as EditorInput & { readonly items: readonly { readonly goToFile?: EditorInput }[] };
		assert.equal(multiDiffInput.items.length, 2);
		assert.deepEqual(multiDiffInput.items.map((item) => item.goToFile?.resource.toString()), [
			"file:///src/working.ts",
			"file:///both.ts",
		]);
		assert.equal(opened[3].options?.pinned, true);

		const stageAll = pane.element.querySelector<HTMLButtonElement>('button[aria-label="Stage All Changes"]');
		const discardAll = pane.element.querySelector<HTMLButtonElement>('button[aria-label="Discard All Changes"]');
		assert.ok(stageAll?.querySelector(".ash-icon"));
		assert.ok(discardAll?.querySelector(".ash-icon"));
		const unstageAll = pane.element.querySelector<HTMLButtonElement>('button[aria-label="Unstage All Changes"]');
		const unstage = pane.element.querySelector<HTMLButtonElement>('button[aria-label="Unstage staged.ts"]');
		assert.ok(unstageAll?.querySelector(".ash-icon"));
		assert.ok(unstage?.querySelector(".ash-icon"));

		const stage = pane.element.querySelector<HTMLButtonElement>('button[aria-label="Stage src/working.ts"]');
		const discard = pane.element.querySelector<HTMLButtonElement>('button[aria-label="Discard src/working.ts"]');
		assert.ok(stage);
		assert.ok(stage.querySelector(".ash-icon"));
		assert.ok(discard?.querySelector(".ash-icon"));
		stage.click();
		await waitFor(() => stagedPaths !== undefined);
		assert.deepEqual(stagedPaths, ["src/working.ts"]);
		assert.equal(stagedRepositoryId, first.repositoryId);
		assert.equal(stage.disabled, true);
		assert.equal(viewAllChanges.disabled, true);
		assert.ok(completeStage);
		completeStage();
		await waitFor(() => pane.element.querySelector<HTMLButtonElement>('button[aria-label="Stage src/working.ts"]')?.disabled === false);

		const message = pane.element.querySelector<HTMLTextAreaElement>('[aria-label="Commit message"]');
		const commit = pane.element.querySelector<HTMLButtonElement>(".ash-scm-commit");
		assert.ok(message);
		assert.ok(commit);
		assert.ok(commit.classList.contains("ash-button"));
		assert.ok(commit.classList.contains("label-centered"));
		assert.equal(commit.textContent, "Commit");
		assert.ok(commit.querySelector(".ash-icon"));
		await waitFor(() => !commit.disabled);
		message.value = "ship scm";
		commit.click();
		await waitFor(() => committedMessage !== undefined);
		assert.equal(committedMessage, "ship scm");
		assert.equal(committedRepositoryId, first.repositoryId);
		await waitFor(() => pane.element.querySelector(".ash-scm-status")?.textContent?.startsWith("Created commit abcdef1.") === true);

		assert.ok(statusListener);
		statusListener(external);
		await waitFor(() => pane.element.querySelector(".ash-scm-status")?.textContent === "4 changed files");

		const repositorySelector = pane.element.querySelector<HTMLSelectElement>('[aria-label="Active source control repository"]');
		assert.ok(repositorySelector);
		assert.equal(repositorySelector.closest("label")?.hidden, false);
		assert.deepEqual([...repositorySelector.options].map(option => option.textContent), ["workspace", "nested — nested"]);
		repositorySelector.value = nestedStatus.repositoryId;
		repositorySelector.dispatchEvent(new browser.window.Event("change", { bubbles: true }));
		await waitFor(() => pane.element.querySelector(".ash-scm-status")?.textContent === "No changes.");
		assert.deepEqual(selectedRepositories, [nestedStatus.repositoryId]);
		assert.equal(repositorySelector.value, nestedStatus.repositoryId);

		assert.equal(requestCount, 2);
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

test("ScmViewPane accepts a restarted Git stream and rejects its retired predecessor", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	let statusRequest = 0;
	let statusListener: ((status: GitStatus) => void) | undefined;
	let readyListener: (() => void) | undefined;
	const previous: GitStatus = {
		repositoryId: "repo-1",
		streamInstanceId: "git-stream-before-restart",
		revision: 20,
		workspacePath: ".",
		head: { type: "branch", name: "before", objectId: "1111111", upstream: undefined },
		changes: [change("before.ts", "unmodified", "modified")],
	};
	const restarted: GitStatus = {
		repositoryId: "repo-1",
		streamInstanceId: "git-stream-after-restart",
		revision: 1,
		workspacePath: ".",
		head: { type: "branch", name: "after", objectId: "2222222", upstream: undefined },
		changes: [],
	};
	const latePrevious: GitStatus = {
		...previous,
		revision: 21,
		head: { type: "branch", name: "late-before", objectId: "3333333", upstream: undefined },
	};
	const gitService = {
		repositories: [],
		activeRepository: undefined,
		onDidChangeRepositories: noEvent,
		onDidChangeActiveRepository: noEvent,
			status: async () => statusRequest++ === 0 ? previous : restarted,
			onDidChangeStatus: (listener: (status: GitStatus) => void) => {
				statusListener = listener;
				return { dispose(): void {}, [Symbol.dispose](): void {} };
			},
			onDidBecomeReady: (listener: () => void) => {
				readyListener = listener;
				return { dispose(): void {}, [Symbol.dispose](): void {} };
			},
	} as unknown as IGitService;

	try {
		const { ScmViewPane } = await import("../../../../../workbench/contrib/scm/browser/scmViewPane.js");
		using pane = new ScmViewPane(browser.window.document.body, {
			id: "ash.git.restart",
			title: "Changes",
		}, gitService, testFileIconThemeService(), testEditorService(), inactiveCommandService(), testContextMenuProvider);
		browser.window.document.body.append(pane.element);
		await waitFor(() => pane.element.querySelector('[aria-label="Open changes for before.ts"]') !== null);
		assert.equal(pane.element.querySelector(".ash-scm-branch"), null);

		assert.ok(readyListener);
		readyListener();
		await waitFor(() => pane.element.querySelector(".ash-scm-status")?.textContent === "No changes.");
		assert.equal(statusRequest, 2);

		assert.ok(statusListener);
		statusListener(latePrevious);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(pane.element.querySelector(".ash-scm-status")?.textContent, "No changes.");
		assert.equal(pane.element.querySelector('[aria-label="Open changes for before.ts"]'), null);
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

function change(path: string, indexStatus: GitStatus["changes"][number]["indexStatus"], worktreeStatus: GitStatus["changes"][number]["worktreeStatus"]): GitStatus["changes"][number] {
	return {
		path,
		originalPath: undefined,
		indexStatus,
		worktreeStatus,
		conflicted: false,
		submodule: {
			isSubmodule: false,
			commitChanged: false,
			trackedChanges: false,
			untrackedChanges: false,
		},
	};
}

function testManagedHover(): IManagedHover {
	return {
		visible: false,
		show() {},
		hide() {},
		update() {},
		dispose() {},
		[Symbol.dispose]() {},
	};
}

function testEditorService(opened: Array<{ readonly input: EditorInput; readonly options: EditorOpenOptions | undefined }> = []): IEditorService {
	return {
		...emptyEditorServiceState,
		openEditor: async (input, options) => { opened.push({ input, options }); },
		focusActiveEditor() {},
	};
}

function testFileIconThemeService(): IResourceIconRenderer {
	return {
		onDidChangeResourceIcons: () => ({ dispose(): void {}, [Symbol.dispose](): void {} }),
		renderFileIcon: (resource, container) => { container.dataset.fileIcon = decodeURIComponent(resource.path.split("/").at(-1) ?? ""); },
	};
}

const testContextMenuProvider: IContextMenuProvider = {
	showContextMenu() {},
};

function inactiveCommandService(): ICommandService {
	return {
		executeCommand: async () => undefined,
	} as unknown as ICommandService;
}

async function waitFor(condition: () => boolean, timeoutMillis = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMillis;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for ScmViewPane");
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function noEvent(): { dispose(): void; [Symbol.dispose](): void } {
	const dispose = (): void => undefined;
	return { dispose, [Symbol.dispose]: dispose };
}

function installDomGlobals(browser: JSDOM): readonly string[] {
	const globals = {
		window: browser.window,
		document: browser.window.document,
		Node: browser.window.Node,
		Element: browser.window.Element,
		HTMLElement: browser.window.HTMLElement,
		Event: browser.window.Event,
		MouseEvent: browser.window.MouseEvent,
		KeyboardEvent: browser.window.KeyboardEvent,
		navigator: browser.window.navigator,
	};
	for (const [name, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, name, { configurable: true, value });
	}
	return Object.keys(globals);
}
test("SCM presents Git unavailability without raw RPC errors", async () => {
	const { gitErrorMessage } = await import("../../../../../workbench/contrib/scm/browser/scmError.js");
	assert.equal(
		gitErrorMessage(new Error("Error invoking remote method 'ash:git:status': JsonRpcRemoteError: GitUnavailable")),
		"Git is unavailable for this workspace. Trust the folder to enable Git changes.",
	);
});
