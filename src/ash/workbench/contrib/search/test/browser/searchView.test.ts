import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { BrowserContentSearchService } from "../../../../../platform/search/browser/searchService.js";
import type { IContentSearchQuery, IContentSearchService, ContentSearchMatch } from "../../../../../platform/search/common/search.js";
import type { IContentSearchApi } from "../../../../../platform/search/common/searchApi.js";
import { WorkbenchConfigurationService } from "../../../../../workbench/services/configuration/browser/configurationService.js";
import { ContentSearchConfiguration } from "../../common/searchConfiguration.js";
import { DisposableStore } from "../../../../../base/common/lifecycle.js";
import { Event } from "../../../../../base/common/event.js";
import { URI } from "../../../../../base/common/uri.js";
import { InstantiationService } from "../../../../../platform/instantiation/common/instantiationService.js";
import { IConfigurationService } from "../../../../../platform/configuration/common/configuration.js";
import { IContentSearchService as ContentSearchServiceId } from "../../../../../platform/search/common/search.js";
import { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import { WorkspaceContextService } from "../../../../services/workspaces/browser/workspaceContextService.js";
import { IEditorService } from "../../../../services/editor/common/editorService.js";
import { IContextMenuService } from "../../../../../platform/contextview/browser/contextView.js";
import { BrowserContextViewService } from "../../../../../platform/contextview/browser/contextViewService.js";
import { HoverService, IHoverService } from "../../../../../platform/hover/browser/hoverService.js";
import { ContextKeyService, IContextKeyService } from "../../../../../platform/contextkey/browser/contextKeyService.js";
import "../../../../contrib/accessibility/browser/accessibilityConfiguration.js";
import { BrowserStorageService } from "../../../../services/storage/browser/storageService.js";
import { SearchHistoryService, ISearchHistoryService } from "../../common/searchHistoryService.js";
import { IStorageService } from "../../../../../platform/storage/common/storage.js";
import { IReplaceService } from "../../browser/replace.js";
import { ReplaceService } from "../../browser/replaceService.js";
import { IWorkingCopyService } from "../../../../services/workingCopy/common/workingCopyService.js";
import { BulkEditTestServices } from "../../../bulkEdit/test/browser/bulkEditTestServices.js";
import { ITextModelResourceService } from "../../../../services/textmodelResolver/common/textModelResourceService.js";
import { IBulkEditService } from "../../../../../editor/browser/services/bulkEditService.js";
import { IDialogService } from "../../../../../platform/dialogs/common/dialogs.js";
import { ICommandService } from "../../../../../platform/commands/common/commands.js";
import { CommandService } from "../../../../services/commands/common/commandService.js";
import { IViewsService } from "../../../../services/views/common/viewsService.js";
import type { IView } from "../../../../common/views.js";
import type { SearchView } from "../../browser/searchView.js";
import { SEARCH_VIEW_ID, SearchCommandIds } from "../../common/constants.js";

const matches: readonly ContentSearchMatch[] = [
	{
		dirId: "workspace",
		path: "src/main.ts",
		lineNumber: 4,
		preview: "const needle = true;",
		ranges: [{ start: 6, end: 12 }],
	},
	{
		dirId: "workspace",
		path: "src/main.ts",
		lineNumber: 9,
		preview: "use(needle);",
		ranges: [{ start: 4, end: 10 }],
	},
];

test("BrowserContentSearchService pulls bounded batches and releases the job", async () => {
	const readCursors: number[] = [];
	let cancelCount = 0;
	const api: IContentSearchApi = {
		start: async (params) => {
			assert.equal(params.query, "needle");
			assert.equal(params.maxResults, 2_000);
			return { searchId: "search-1" };
		},
		read: async (params) => {
			readCursors.push(params.afterMatch);
			if (params.afterMatch === 0) {
				return {
					searchId: params.searchId,
					matches: [{ ...matches[0], ranges: matches[0].ranges.map((range) => ({ ...range })) }],
					nextMatch: 1,
					completed: false,
					limitHit: false,
					error: null,
				};
			}
			return {
				searchId: params.searchId,
				matches: [{ ...matches[1], ranges: matches[1].ranges.map((range) => ({ ...range })) }],
				nextMatch: 2,
				completed: true,
				limitHit: true,
				error: null,
			};
		},
		cancel: async () => {
			cancelCount += 1;
		},
	};
	const service = new BrowserContentSearchService(api);
	const progress: ContentSearchMatch[] = [];

	const complete = await service.search(query(), {
		onProgress: (batch) => progress.push(...batch),
	});

	assert.deepEqual(readCursors, [0, 1]);
	assert.deepEqual(progress, matches);
	assert.deepEqual(complete, {
		resultCount: 2,
		limitHit: true,
		error: undefined,
	});
	assert.equal(cancelCount, 1);
});

test("SearchView submits typed filters and groups highlighted matches", async () => {
	const browser = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test" });
	const installedGlobals = installDomGlobals(browser);
	let submitted: IContentSearchQuery | undefined;
	const service: IContentSearchService = {
		search: async (searchQuery, options) => {
			submitted = searchQuery;
			options?.onProgress?.(matches);
			return {
				resultCount: matches.length,
				limitHit: false,
				error: undefined,
			};
		},
	};

	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, service);
		const { SearchView } = await import(
			"../../../../../workbench/contrib/search/browser/searchView.js"
		);
		using pane = services.createInstance(SearchView,
			browser.window.document.body,
			{
				id: "ash.search",
				title: "Search",
			},
		);
		browser.window.document.body.append(pane.element);
		const details = pane.element.querySelector<HTMLButtonElement>('button[aria-label="Toggle Search Details"]')!;
		assert.equal(details.getAttribute("aria-expanded"), "false");
		details.click();
		assert.equal(details.getAttribute("aria-expanded"), "true");
		input(pane.element, "Search workspace").value = "needle";
		input(pane.element, "Files to include").value = "src/**, docs/**";
		input(pane.element, "Files to exclude").value = "**/*.test.ts";
		pane.element.querySelector<HTMLButtonElement>('button[aria-label="Match Case"]')!.click();
		pane.element.querySelector<HTMLButtonElement>('button[aria-label="Use Regular Expression"]')!.click();
		details.click();
		assert.equal(details.getAttribute("aria-expanded"), "false");
		input(pane.element, "Search workspace").dispatchEvent(new browser.window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
		assert.equal(submitted, undefined);
		input(pane.element, "Search workspace").dispatchEvent(
			new browser.window.KeyboardEvent("keydown", {
				key: "Enter",
				bubbles: true,
				cancelable: true,
			}),
		);

		await waitFor(() =>
			pane.element.querySelector(".ash-search-status")?.textContent ===
			"2 results"
		);
		assert.deepEqual(submitted, {
			text: "needle",
			wholeWord: false,
			patternKind: "regex",
			caseSensitivity: "sensitive",
			includePatterns: ["src/**", "docs/**"],
			excludePatterns: ["**/*.test.ts"],
			maxResults: 2_000,
		});
		assert.equal(
			pane.element.querySelector(".ash-search-file-path")?.textContent,
			"workspace • src/main.ts",
		);
		assert.equal(
			pane.element.querySelector(".ash-search-file-count")?.textContent,
			"2",
		);
		assert.deepEqual(
			[...pane.element.querySelectorAll("mark")].map(
				(element) => element.textContent,
			),
			["needle", "needle"],
		);
	} finally {
		browser.window.close();
		for (const name of installedGlobals) {
			Reflect.deleteProperty(globalThis, name);
		}
	}
});

test("SearchView applies configured query defaults and result limits", async () => {
	const browser = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test" });
	const installedGlobals = installDomGlobals(browser);
	using configuration = new WorkbenchConfigurationService();
	await configuration.updateValue(ContentSearchConfiguration.matchCase, true);
	await configuration.updateValue(ContentSearchConfiguration.smartCase, false);
	await configuration.updateValue(ContentSearchConfiguration.regularExpression, true);
	await configuration.updateValue(ContentSearchConfiguration.includePatterns, "src/**, packages/**");
	await configuration.updateValue(ContentSearchConfiguration.excludePatterns, "**/*.test.ts");
	await configuration.updateValue(ContentSearchConfiguration.maxResults, 750);
	let submitted: IContentSearchQuery | undefined;
	const service: IContentSearchService = {
		search: async searchQuery => {
			submitted = searchQuery;
			return { resultCount: 0, limitHit: false, error: undefined };
		},
	};

	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, service, configuration);
		const { SearchView } = await import("../../../../../workbench/contrib/search/browser/searchView.js");
		using pane = services.createInstance(SearchView, browser.window.document.body, { id: "ash.search", title: "Search" });
		browser.window.document.body.append(pane.element);
		input(pane.element, "Search workspace").value = "Needle";
		assert.equal(pane.element.querySelector('button[aria-label="Match Case"]')?.getAttribute('aria-pressed'), "true");
		assert.equal(pane.element.querySelector('button[aria-label="Use Regular Expression"]')?.getAttribute('aria-pressed'), "true");
		assert.equal(input(pane.element, "Files to include").value, "src/**, packages/**");
		assert.equal(input(pane.element, "Files to exclude").value, "**/*.test.ts");
		pane.element.querySelector("form")?.dispatchEvent(new browser.window.Event("submit", { bubbles: true, cancelable: true }));
		await waitFor(() => submitted !== undefined);
		assert.deepEqual(submitted, {
			text: "Needle",
			wholeWord: false,
			patternKind: "regex",
			caseSensitivity: "sensitive",
			includePatterns: ["src/**", "packages/**"],
			excludePatterns: ["**/*.test.ts"],
			maxResults: 750,
		});
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

function query(): IContentSearchQuery {
	return {
		text: "needle",
		patternKind: "literal",
		caseSensitivity: "smart",
		includePatterns: [],
		excludePatterns: [],
	};
}

function input(container: Element, label: string): HTMLInputElement | HTMLTextAreaElement {
	const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
		`[aria-label="${label}"]`,
	);
	assert.ok(element);
	return element;
}

async function waitFor(
	condition: () => boolean,
	timeoutMillis = 1_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMillis;
	while (!condition()) {
		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for SearchView");
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function installDomGlobals(browser: JSDOM): readonly string[] {
	Object.defineProperty(browser.window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
	Object.defineProperty(browser.window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 280 });
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
		Object.defineProperty(globalThis, name, {
			configurable: true,
			value,
		});
	}
	return Object.keys(globals);
}

function createServices(store: DisposableStore, browser: JSDOM, search: IContentSearchService, configured?: WorkbenchConfigurationService): InstantiationService {
	const configuration = configured ?? store.add(new WorkbenchConfigurationService());
	const services = store.add(new InstantiationService());
	services.registerInstance(ICommandService, store.add(new CommandService(services)));
	const menus: IContextMenuService = { onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu() { }, hideContextMenu() { } };
	const contextView = store.add(new BrowserContextViewService(browser.window.document.body));
	services.registerInstance(ContentSearchServiceId, search);
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextKeyService, store.add(new ContextKeyService()));
	services.registerInstance(IContextMenuService, menus);
	services.registerInstance(IHoverService, store.add(new HoverService(configuration, contextView, menus)));
	services.registerInstance(IWorkspaceContextService, store.add(new WorkspaceContextService({ id: "workspace", uri: URI.file("/workspace") })));
	services.registerInstance(IEditorService, { onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, activeEditor: undefined, visibleEditors: [], openEditor: async () => { }, focusActiveEditor() { } });
	services.registerInstance(IStorageService, store.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: "workspace", flushInterval: 0 })));
	services.registerInstance(ISearchHistoryService, store.add(services.createInstance(SearchHistoryService)));
	const editing = store.add(new BulkEditTestServices([]));
	services.registerInstance(ITextModelResourceService, editing.models);
	services.registerInstance(IBulkEditService, editing.service);
	services.registerInstance(IDialogService, editing.dialogs);
	services.registerInstance(IWorkingCopyService, editing.workingCopies);
	services.registerInstance(IReplaceService, services.createInstance(ReplaceService));
	return services;
}

function registerView(services: InstantiationService, view: SearchView): void {
	view.setVisible(true);
	view.element.ownerDocument.body.append(view.element);
	services.registerInstance(IViewsService, {
		onDidChangeViewContainerVisibility: Event.None,
		onDidChangeViewVisibility: Event.None,
		onDidChangeFocusedView: Event.None,
		isViewContainerVisible: () => true,
		isViewContainerActive: () => true,
		openViewContainer: async () => null,
		closeViewContainer() { },
		getVisibleViewContainer: () => null,
		getActiveViewPaneContainerWithId: () => null,
		getFocusedView: () => null,
		getFocusedViewName: () => 'Search',
		isViewVisible: id => id === SEARCH_VIEW_ID,
		openView: async <T extends IView>(): Promise<T | null> => view as unknown as T,
		closeView() { },
		getActiveViewWithId: <T extends IView>(id: string) => id === SEARCH_VIEW_ID ? view as unknown as T : null,
		getViewWithId: <T extends IView>(id: string) => id === SEARCH_VIEW_ID ? view as unknown as T : null,
		focusView: async () => { view.focus(); return true; },
	});
}

test('Dismiss runs the registered command, restores focus and updates retained snapshots until refresh', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	const delivered = [...matches, { ...matches[0]!, path: 'other.ts' }];
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, {
			search: async (_query, options) => {
				options?.onProgress?.(delivered);
				return { resultCount: delivered.length, limitHit: true, error: undefined };
			}
		});
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsRemoveReplace.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		input(view.element, 'Search workspace').value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 3);
		const tree = view.getControl();
		const file = view.searchResult.files[0]!;
		const next = file.matches[1]!;
		tree.setFocus(file.matches[0]!.id);
		tree.setSelection([file.matches[0]!.id]);
		await services.get(ICommandService).executeCommand(SearchCommandIds.RemoveActionId);
		assert.deepEqual({ count: view.getSearchResultSnapshot()?.matchCount, focused: tree.focus?.id, status: view.element.querySelector('[role="status"]')!.textContent }, {
			count: 2, focused: next.id, status: '2 results (result limit reached)',
		});
		assert.match(view.getSearchResultSnapshot()!.content, /# File: file:\/\/\/workspace\/src\/main\.ts\n  9:5-9:11: needle\n\n/);
		tree.setSelection([next.id, view.searchResult.files[1]!.id]);
		await services.get(ICommandService).executeCommand(SearchCommandIds.RemoveActionId);
		await services.get(ICommandService).executeCommand(SearchCommandIds.RemoveActionId);
		assert.deepEqual({ count: view.searchResult.count, focused: tree.focus, snapshot: view.getSearchResultSnapshot(), status: view.element.querySelector('[role="status"]')!.textContent }, {
			count: 0, focused: undefined, snapshot: undefined, status: 'No results found.',
		});
		assert.equal(browser.window.document.activeElement, tree.element);
		view.element.querySelector<HTMLButtonElement>('button[aria-label="Refresh search"]')!.click();
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 3);
	} finally {
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});

test('Dismiss during a running search retains the job and accepts later batches before completion', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	let finish: (() => void) | undefined;
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, {
			search: async (_query, options) => {
				options?.onProgress?.(matches.slice(0, 1));
				await new Promise<void>(resolve => { finish = () => { options?.onProgress?.(matches); resolve(); }; });
				return { resultCount: 3, limitHit: false, error: undefined };
			}
		});
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsRemoveReplace.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		input(view.element, 'Search workspace').value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => finish !== undefined);
		const tree = view.getControl();
		const file = view.searchResult.files[0]!;
		tree.setFocus(file.id);
		await services.get(ICommandService).executeCommand(SearchCommandIds.RemoveActionId);
		assert.deepEqual({ count: view.searchResult.count, busy: tree.element.getAttribute('aria-busy'), status: view.element.querySelector('[role="status"]')!.textContent }, {
			count: 0, busy: 'true', status: '0 results…',
		});
		finish!();
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 2);
		assert.equal(view.element.querySelector('[role="status"]')!.textContent, '2 results');
	} finally {
		finish?.();
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});
