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
import { IClipboardService } from "../../../../../platform/clipboard/common/clipboardService.js";
import { BrowserClipboardService } from "../../../../../platform/clipboard/browser/clipboardService.js";
import { ILabelService, LabelService } from "../../../../../platform/label/common/labelService.js";
import { isWindows, OperatingSystem } from "../../../../../base/common/platform.js";
import type { IContextMenuDelegate } from "../../../../../base/browser/contextmenu.js";
import { MenuId } from "../../../../../platform/actions/common/actions.js";
import { MenuService } from "../../../../../platform/actions/common/menuService.js";
import type { IAction } from "../../../../../base/common/actions.js";
import '../../browser/searchActionsTopBar.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import type { IContentSearchComplete, IContentSearchOptions } from '../../../../../platform/search/common/search.js';
import type { SearchReplaceResult } from '../../browser/replace.js';

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

test('Search exposes query and replacement as multiline inputs and folding replacement preserves its value', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, { search: async () => ({ resultCount: 0, limitHit: false, error: undefined }) });
		const { SearchView } = await import('../../browser/searchView.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		const query = input(view.element, 'Search workspace');
		const replacement = input(view.element, 'Replace');
		const row = view.element.querySelector<HTMLElement>('.ash-search-replace-row')!;
		assert.equal(row.hidden, false, 'Search and Replace are visible when Search first opens');
		assert.deepEqual([query.tagName, replacement.tagName], ['TEXTAREA', 'TEXTAREA']);
		replacement.value = 'first\nsecond';
		replacement.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
		replacement.focus();
		view.element.querySelector<HTMLButtonElement>('button[aria-label="Toggle Replace"]')!.click();
		assert.equal(row.hidden, true);
		assert.equal(browser.window.document.activeElement, query);
		view.element.querySelector<HTMLButtonElement>('button[aria-label="Toggle Replace"]')!.click();
		assert.equal(row.hidden, false);
		assert.equal(replacement.value, 'first\nsecond');
	} finally {
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});

test('Search presents a bounded preview around a late match without changing complete result data', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	const preview = '😀' + 'prefix '.repeat(40) + 'needle' + ' suffix'.repeat(80);
	const start = preview.indexOf('needle');
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, {
			search: async (_query, options) => {
				options?.onProgress?.([{ ...matches[0]!, preview, ranges: [{ start, end: start + 6 }] }]);
				return { resultCount: 1, limitHit: false, error: undefined };
			},
		});
		const { SearchView } = await import('../../browser/searchView.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		input(view.element, 'Search workspace').value = 'needle';
		view.triggerQueryChange();
		await waitFor(() => view.getControl().element.getAttribute('aria-busy') === 'false');
		const visible = view.element.querySelector<HTMLElement>('.ash-search-preview')!;
		assert.equal(visible.querySelector('mark')?.textContent, 'needle');
		assert.ok(visible.textContent!.length <= 250, 'Only the displayed preview is bounded');
		assert.match(visible.textContent!, /^…/u);
		assert.equal(view.searchResult.files[0]!.matches[0]!.preview, preview);
		assert.equal(view.searchResult.files[0]!.matches[0]!.range.startColumn, start + 1);
		assert.ok(view.getSearchResultSnapshot()!.content.includes(`4:${start + 1}-4:${start + 7}: needle`));
	} finally {
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});

test('Search bounds expanded multiline preview context without splitting emoji or changing editor coordinates', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	const preview = '😀\t中文\n'.repeat(30) + 'needle\r\n😀中文' + '\r\n😀'.repeat(100);
	const start = preview.indexOf('needle');
	const hit = 'needle\r\n😀中文';
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, {
			search: async (_query, options) => {
				options?.onProgress?.([{ ...matches[0]!, preview, ranges: [{ start, end: start + hit.length }] }]);
				return { resultCount: 1, limitHit: false, error: undefined };
			},
		});
		const { SearchView } = await import('../../browser/searchView.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		input(view.element, 'Search workspace').value = hit;
		view.triggerQueryChange();
		await waitFor(() => view.getControl().element.getAttribute('aria-busy') === 'false');
		const visible = view.element.querySelector<HTMLElement>('.ash-search-preview')!;
		assert.ok(visible.textContent!.length <= 250);
		assert.doesNotMatch(visible.textContent!, /[\uD800-\uDFFF]/u);
		assert.equal(visible.querySelector('mark')?.textContent, 'needle ↵ 😀中文');
		const match = view.searchResult.files[0]!.matches[0]!;
		assert.equal(match.preview, preview);
		assert.deepEqual({ ...match.range }, { startLineNumber: 34, startColumn: 1, endLineNumber: 35, endColumn: 5 });
	} finally {
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});

test('Search compresses directory chains while retaining match identity, copy paths and dismiss behavior', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	const written: string[] = [];
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, {
			search: async (_query, options) => {
				options?.onProgress?.([{ ...matches[0]!, path: 'deep/nested/folder/main.ts' }]);
				return { resultCount: 1, limitHit: false, error: undefined };
			},
		});
		services.registerInstance(IClipboardService, new BrowserClipboardService({ writeText: async value => { written.push(value); } } as Clipboard));
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		await import('../../browser/searchActionsRemoveReplace.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		input(view.element, 'Search workspace').value = 'needle';
		view.triggerQueryChange();
		await waitFor(() => view.getControl().element.getAttribute('aria-busy') === 'false');
		const before = view.getSearchResultSnapshot();
		const match = view.searchResult.files[0]!.matches[0]!;
		let actions: readonly IAction[] = [];
		services.get(IContextMenuService).showContextMenu = delegate => { actions = delegate.getActions?.() ?? []; };
		view.element.querySelector<HTMLButtonElement>('button[aria-label="More Actions"]')!.click();
		await actions.find(action => action.id === 'search.treeView')!.run();
		const tree = view.getControl();
		assert.equal(view.element.querySelector('.ash-search-folder-path .ash-icon-label-text')?.textContent, 'deep/nested/folder');
		assert.equal(view.element.querySelector('.ash-search-folder-path .ash-icon-label')?.getAttribute('aria-label'), 'deep/nested/folder');
		assert.equal(tree.model.rootNodes.length, 1);
		const folder = tree.model.rootNodes[0]!.element;
		assert.equal(folder.kind, 'folder');
		assert.equal(tree.model.getElement(match.id), match);
		assert.deepEqual(view.getSearchResultSnapshot(), before);
		await services.get(ICommandService).executeCommand(SearchCommandIds.CopyPathCommandId, folder);
		assert.deepEqual(written, ['/workspace/deep/nested/folder']);
		tree.setFocus(match.id); tree.setSelection([match.id]);
		await services.get(ICommandService).executeCommand(SearchCommandIds.RemoveActionId);
		assert.equal(view.searchResult.count, 0);
		assert.equal(tree.model.rootNodes.length, 0);
	} finally {
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});

test('Search lifecycle commands cancel retained results, replace running queries and clear inputs in two stages', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	const jobs: { query: IContentSearchQuery; options: IContentSearchOptions; completion: DeferredPromise<IContentSearchComplete>; }[] = [];
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, {
			search(query, options = {}) {
				const completion = new DeferredPromise<IContentSearchComplete>();
				jobs.push({ query, options, completion });
				options.onProgress?.(matches);
				options.signal?.addEventListener('abort', () => options.onProgress?.([{ ...matches[0]!, path: 'synchronous-abort.ts' }]), { once: true });
				return completion.p;
			},
		});
		const { SearchView } = await import('../../browser/searchView.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		const queryInput = input(view.element, 'Search workspace');
		const replacement = input(view.element, 'Replace');
		const includes = input(view.element, 'Files to include');
		const excludes = input(view.element, 'Files to exclude');
		const commands = services.get(ICommandService);
		const menus = services.createInstance(MenuService);
		const palette = (id: string) => menus.getMenuActions(MenuId.CommandPalette).flatMap(([, actions]) => actions).find(action => action.id === id);
		assert.equal(palette('search.action.cancel'), undefined);
		assert.equal(palette('search.action.clearSearchResults'), undefined);
		queryInput.value = 'needle'; replacement.value = 'replacement'; includes.value = 'src/**'; excludes.value = '**/*.test.ts';
		for (const field of [queryInput, replacement, includes, excludes]) { field.dispatchEvent(new browser.window.Event('input', { bubbles: true })); }
		view.element.querySelector<HTMLButtonElement>('button[aria-label="Match Case"]')!.click();
		assert.equal(palette('search.action.refreshSearchResults')?.enabled, true);
		await commands.executeCommand('search.action.refreshSearchResults');
		assert.equal(jobs.length, 1);
		assert.equal(services.get(IContextKeyService).getValue('searchState'), 1);
		assert.equal(browser.window.document.activeElement, queryInput);
		view.getControl().domFocus();
		await commands.executeCommand('search.action.cancel');
		assert.equal(jobs[0]!.options.signal?.aborted, true);
		assert.equal(view.getSearchResultSnapshot()?.matchCount, 2);
		assert.equal(browser.window.document.activeElement, queryInput);
		assert.equal(view.element.querySelector('.ash-search-status')?.textContent, 'Search stopped. 2 results retained.');
		assert.equal(view.cancelSearch(), false);
		jobs[0]!.options.onProgress?.([{ ...matches[0]!, path: 'late-cancel.ts' }]);
		assert.equal(view.searchResult.count, 2);
		await commands.executeCommand('search.action.refreshSearchResults');
		queryInput.value = 'again'; queryInput.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
		await commands.executeCommand('search.action.refreshSearchResults');
		assert.equal(jobs.length, 3);
		assert.equal(jobs[1]!.options.signal?.aborted, true);
		jobs[1]!.options.onProgress?.([{ ...matches[0]!, path: 'late-refresh.ts' }]);
		await jobs[1]!.completion.complete({ resultCount: 3, limitHit: true, error: 'stale failure' });
		assert.equal(view.searchResult.count, 2);
		assert.equal(view.getControl().element.getAttribute('aria-busy'), 'true');
		await commands.executeCommand('search.action.clearSearchResults');
		assert.equal(jobs[2]!.options.signal?.aborted, true);
		assert.deepEqual([queryInput.value, replacement.value, includes.value, excludes.value], ['', '', 'src/**', '**/*.test.ts']);
		assert.deepEqual({ results: view.searchResult.count, snapshot: view.getSearchResultSnapshot(), state: services.get(IContextKeyService).getValue('searchState'), status: view.element.querySelector('.ash-search-status')?.textContent }, { results: 0, snapshot: undefined, state: 0, status: '' });
		assert.equal(palette('search.action.clearSearchResults')?.enabled, true);
		jobs[2]!.options.onProgress?.([{ ...matches[0]!, path: 'late-clear.ts' }]);
		assert.equal(view.searchResult.count, 0);
		await commands.executeCommand('search.action.clearSearchResults');
		assert.deepEqual([includes.value, excludes.value], ['', '']);
		assert.equal(palette('search.action.clearSearchResults'), undefined);
		queryInput.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
		assert.equal(queryInput.value, 'again');
		queryInput.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
		assert.equal(queryInput.value, '');
		queryInput.value = 'final'; queryInput.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
		await commands.executeCommand('search.action.refreshSearchResults');
		assert.equal(jobs[3]!.query.caseSensitivity, 'sensitive');
		assert.deepEqual(jobs[3]!.query.includePatterns, []);
		view.setVisible(false);
		await commands.executeCommand('search.action.clearSearchResults');
		await commands.executeCommand('search.action.cancel');
		await commands.executeCommand('search.action.refreshSearchResults');
		assert.equal(jobs.length, 4);
		assert.equal(jobs[3]!.options.signal?.aborted, false);
		view.dispose();
		jobs[3]!.options.onProgress?.([{ ...matches[0]!, path: 'late-dispose.ts' }]);
		assert.equal(jobs[3]!.options.signal?.aborted, true);
		assert.equal(view.searchResult.count, 0);
		for (const key of ['searchState', 'viewHasSearchPattern', 'viewHasReplacePattern', 'viewHasFilePattern']) {
			assert.equal(services.get(IContextKeyService).getValue(key), key === 'searchState' ? 0 : false);
		}
	} finally {
		for (const job of jobs) { await job.completion.complete({ resultCount: 2, limitHit: false, error: undefined }); }
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});

test('Search lifecycle clears zero-result queries and input-only patterns and an empty refresh creates no job', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	let searches = 0;
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, { search: async () => { searches++; return { resultCount: 0, limitHit: false, error: undefined }; } });
		const { SearchView } = await import('../../browser/searchView.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		const commands = services.get(ICommandService);
		const menus = services.createInstance(MenuService);
		const clear = () => menus.getMenuActions(MenuId.CommandPalette).flatMap(([, actions]) => actions).find(action => action.id === 'search.action.clearSearchResults');
		const queryInput = input(view.element, 'Search workspace');
		queryInput.value = 'absent'; queryInput.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
		await commands.executeCommand('search.action.refreshSearchResults');
		await waitFor(() => view.getControl().element.getAttribute('aria-busy') === 'false');
		assert.equal(view.element.querySelector('.ash-search-status')?.textContent, 'No results found.');
		assert.equal(clear()?.enabled, true);
		await commands.executeCommand('search.action.clearSearchResults');
		assert.equal(queryInput.value, '');
		for (const label of ['Replace', 'Files to include', 'Files to exclude']) {
			const field = input(view.element, label);
			field.value = 'pattern'; field.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
			assert.equal(clear()?.enabled, true);
			await commands.executeCommand('search.action.clearSearchResults');
			assert.deepEqual({ value: field.value, clear: clear(), results: view.searchResult.count }, { value: '', clear: undefined, results: 0 });
		}
		input(view.element, 'Files to include').value = 'src/**';
		await commands.executeCommand('search.action.refreshSearchResults');
		assert.deepEqual({ searches, query: queryInput.value, includes: input(view.element, 'Files to include').value, status: view.element.querySelector('.ash-search-status')?.textContent }, { searches: 1, query: '', includes: 'src/**', status: '' });
	} finally {
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});

for (const operation of ['replace', 'undo'] as const) {
	test(`Search lifecycle clearing blocks a late ${operation} from restarting search or writing its failure`, async () => {
		const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
		const globals = installDomGlobals(browser);
		const replacement = new DeferredPromise<SearchReplaceResult>();
		const undo = new DeferredPromise<void>();
		const result: SearchReplaceResult = { ariaSummary: 'applied', isApplied: true, resources: [], undo: () => undo.p, saveErrors: ['late save failure'] };
		let searches = 0;
		let signal: AbortSignal | undefined;
		let pending: Promise<unknown> | undefined;
		try {
			using store = new DisposableStore();
			const services = createServices(store, browser, { search: async (_query, options) => { searches++; options?.onProgress?.(matches); return { resultCount: 2, limitHit: false, error: undefined }; } }, undefined, undefined,
				{ replace: async (_matches, _query, _replacement, options) => { signal = options.signal; return operation === 'replace' ? replacement.p : result; } });
			const { SearchView } = await import('../../browser/searchView.js');
			using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
			registerView(services, view);
			input(view.element, 'Search workspace').value = 'needle';
			view.triggerQueryChange();
			await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 2);
			view.getControl().setFocus(view.searchResult.files[0]!.matches[0]!.id);
			let actions: readonly IAction[] = [];
			services.get(IContextMenuService).showContextMenu = delegate => { actions = delegate.getActions?.() ?? []; };
			const action = (id: string) => {
				view.element.querySelector<HTMLButtonElement>('button[aria-label="More Actions"]')!.click();
				return actions.find(action => action.id === id)!;
			};
			pending = Promise.resolve(action('search.replaceSelected').run());
			if (operation === 'undo') {
				await pending;
				assert.equal(searches, 2);
				pending = Promise.resolve(action('search.undoReplacement').run());
			}
			await services.get(ICommandService).executeCommand('search.action.clearSearchResults');
			if (operation === 'replace') { assert.equal(signal?.aborted, true); await replacement.complete(result); }
			else { await undo.error(new Error('late undo failure')); }
			await pending;
			assert.deepEqual({ searches, results: view.searchResult.count, query: input(view.element, 'Search workspace').value, status: view.element.querySelector('.ash-search-status')?.textContent }, { searches: operation === 'replace' ? 1 : 2, results: 0, query: '', status: '' });
		} finally {
			await replacement.complete(result);
			await undo.complete();
			await pending;
			browser.window.close();
			for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
		}
	});
}

test('Search lifecycle slow-search timer belongs to its query and errors restore idle actions', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	const originalTimeout = browser.window.setTimeout.bind(browser.window);
	const originalClearTimeout = browser.window.clearTimeout.bind(browser.window);
	const scheduled = new Map<number, () => void>();
	const cancelled: number[] = [];
	let nextTimer = 1_000_000;
	const jobs: DeferredPromise<IContentSearchComplete>[] = [];
	// Control only the owner's two-second UI timer; jsdom and widget scheduling remain real.
	browser.window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
		if (delay !== 2_000 || typeof handler !== 'function') { return originalTimeout(handler, delay, ...args); }
		const id = nextTimer++;
		scheduled.set(id, () => handler(...args));
		return id;
	}) as typeof browser.window.setTimeout;
	browser.window.clearTimeout = id => { if (id !== undefined && scheduled.has(id)) { cancelled.push(id); } else { originalClearTimeout(id); } };
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, { search() { const job = new DeferredPromise<IContentSearchComplete>(); jobs.push(job); return job.p; } });
		const { SearchView } = await import('../../browser/searchView.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		const queryInput = input(view.element, 'Search workspace');
		queryInput.value = 'needle';
		const commands = services.get(ICommandService);
		await commands.executeCommand('search.action.refreshSearchResults');
		assert.equal(scheduled.size, 1);
		const oldTimer = [...scheduled.keys()][0]!;
		await commands.executeCommand('search.action.refreshSearchResults');
		assert.ok(cancelled.includes(oldTimer));
		scheduled.get(oldTimer)!();
		assert.equal(services.get(IContextKeyService).getValue('searchState'), 1);
		const currentTimer = [...scheduled.keys()].at(-1)!;
		view.element.querySelector<HTMLButtonElement>('button[aria-label="Refresh search"]')!.focus();
		scheduled.get(currentTimer)!();
		const cancel = view.element.querySelector<HTMLButtonElement>('button[aria-label="Cancel Search"]')!;
		assert.ok(cancel);
		assert.equal(browser.window.document.activeElement, cancel);
		assert.equal(services.get(IContextKeyService).getValue('searchState'), 2);
		await jobs[1]!.error(new Error('backend failed'));
		await waitFor(() => view.getControl().element.getAttribute('aria-busy') === 'false');
		assert.equal(services.get(IContextKeyService).getValue('searchState'), 0);
		assert.equal(view.element.querySelector('.ash-search-status')?.textContent, 'backend failed');
		assert.ok(view.element.querySelector('button[aria-label="Refresh search"]'));
		await commands.executeCommand('search.action.refreshSearchResults');
		const disposedTimer = [...scheduled.keys()].at(-1)!;
		view.dispose();
		assert.ok(cancelled.includes(disposedTimer));
		scheduled.get(disposedTimer)!();
		assert.equal(services.get(IContextKeyService).getValue('searchState'), 0);
	} finally {
		for (const job of jobs) { await job.complete({ resultCount: 0, limitHit: false, error: undefined }); }
		browser.window.setTimeout = originalTimeout;
		browser.window.clearTimeout = originalClearTimeout;
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});

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
			pane.element.querySelector(".ash-search-file-path .ash-icon-label-text")?.textContent,
			"main.ts",
		);
		assert.equal(pane.element.querySelector(".ash-search-file-path .ash-icon-label-description")?.textContent, "src");
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

function createServices(store: DisposableStore, browser: JSDOM, search: IContentSearchService, configured?: WorkbenchConfigurationService, workspace?: WorkspaceContextService, replace?: IReplaceService): InstantiationService {
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
	services.registerInstance(IWorkspaceContextService, workspace ?? store.add(new WorkspaceContextService({ id: "workspace", uri: URI.file("/workspace") })));
	services.registerInstance(ILabelService, store.add(new LabelService(services.get(IWorkspaceContextService), OperatingSystem.Linux)));
	services.registerInstance(IEditorService, { onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, activeEditor: undefined, visibleEditors: [], openEditor: async () => { }, focusActiveEditor() { } });
	services.registerInstance(IStorageService, store.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: "workspace", flushInterval: 0 })));
	services.registerInstance(ISearchHistoryService, store.add(services.createInstance(SearchHistoryService)));
	const editing = store.add(new BulkEditTestServices([]));
	services.registerInstance(ITextModelResourceService, editing.models);
	services.registerInstance(IBulkEditService, editing.service);
	services.registerInstance(IDialogService, editing.dialogs);
	services.registerInstance(IWorkingCopyService, editing.workingCopies);
	services.registerInstance(IReplaceService, replace ?? services.createInstance(ReplaceService));
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
		getActiveViewWithId: <T extends IView>(id: string) => id === SEARCH_VIEW_ID && view.isVisible() ? view as unknown as T : null,
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

for (const scenario of [
	{ name: 'the next collapsed file', focusedFile: 'a.ts', expectedFile: 'b.ts', expectedMatch: 0, selectedFile: undefined, count: 5 },
	{ name: 'the last collapsed file when no later match remains', focusedFile: 'c.ts', expectedFile: 'b.ts', expectedMatch: 1, selectedFile: 'c.ts', count: 4 },
	{ name: 'the next collapsed file beyond a selected branch', focusedFile: 'a.ts', expectedFile: 'c.ts', expectedMatch: 0, selectedFile: 'b.ts', count: 3 },
]) {
	test(`Dismiss restores match focus in ${scenario.name}`, async () => {
		const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
		const globals = installDomGlobals(browser);
		const delivered = ['a.ts', 'b.ts', 'c.ts'].flatMap(path => matches.map(match => ({ ...match, path })));
		try {
			using store = new DisposableStore();
			const services = createServices(store, browser, {
				search: async (_query, options) => {
					options?.onProgress?.(delivered);
					return { resultCount: delivered.length, limitHit: false, error: undefined };
				}
			});
			const { SearchView } = await import('../../browser/searchView.js');
			await import('../../browser/searchActionsRemoveReplace.js');
			using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
			registerView(services, view);
			input(view.element, 'Search workspace').value = 'needle';
			view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
			await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 6);
			const tree = view.getControl();
			const focused = view.searchResult.files.find(file => file.path === scenario.focusedFile)!.matches[1]!;
			const expectedFile = view.searchResult.files.find(file => file.path === scenario.expectedFile)!;
			const expected = expectedFile.matches[scenario.expectedMatch]!;
			const selected = view.searchResult.files.find(file => file.path === scenario.selectedFile);
			for (const file of view.searchResult.files) {
				if (file.path !== scenario.focusedFile) { tree.collapse(file.id); }
			}
			tree.setFocus(focused.id);
			tree.setSelection(selected ? [focused.id, selected.id] : [focused.id]);
			await services.get(ICommandService).executeCommand(SearchCommandIds.RemoveActionId);
			assert.deepEqual({ focus: tree.focus?.id, selection: tree.selection.map(element => element.id), collapsed: tree.isCollapsed(expectedFile.id), count: view.getSearchResultSnapshot()?.matchCount }, {
				focus: expected.id, selection: [expected.id], collapsed: false, count: scenario.count,
			});
			assert.equal(browser.window.document.activeElement, tree.element);
			assert.ok(tree.getVisibleElements().includes(expected));
			for (const file of view.searchResult.files) {
				if (file.path !== scenario.focusedFile && file !== expectedFile) { assert.equal(tree.isCollapsed(file.id), true); }
			}
		} finally {
			browser.window.close();
			for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
		}
	});
}

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

test('Copy All formats the retained model in root, folder, filename and range order without changing it', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	const block = 'context\r\n  needle\r\nnext\r\nunused';
	const delivered: ContentSearchMatch[] = [
		{ dirId: 'other', path: 'src/file2.ts', lineNumber: 8, preview: 'remote needle', ranges: [{ start: 7, end: 13 }] },
		{ dirId: 'workspace', path: 'alpha.ts', lineNumber: 1, preview: 'root needle', ranges: [{ start: 5, end: 11 }] },
		{ dirId: 'workspace', path: 'src/file10.ts', lineNumber: 3, preview: 'ten needle', ranges: [{ start: 4, end: 10 }] },
		{ dirId: 'workspace', path: 'src/file2.ts', lineNumber: 20, preview: 'a needle b needle', ranges: [{ start: 11, end: 17 }, { start: 2, end: 8 }] },
		{ dirId: 'workspace', path: 'src/file2.ts', lineNumber: 10, preview: block, ranges: [{ start: block.indexOf('needle'), end: block.indexOf('next') + 4 }] },
		{ dirId: 'workspace', path: 'src/nested/z.ts', lineNumber: 4, preview: 'nested needle', ranges: [{ start: 7, end: 13 }] },
	];
	const written: string[] = [];
	try {
		using store = new DisposableStore();
		const workspace = store.add(new WorkspaceContextService({
			id: 'multi', folders: [
				{ id: 'workspace', name: 'workspace', index: 0, uri: URI.file('/workspace') },
				{ id: 'other', name: 'other', index: 1, uri: URI.parse('ssh://host/other') },
			]
		}));
		const services = createServices(store, browser, {
			search: async (_query, options) => {
				options?.onProgress?.(delivered);
				return { resultCount: 7, limitHit: false, error: undefined };
			}
		}, undefined, workspace);
		services.registerInstance(IClipboardService, new BrowserClipboardService({ writeText: async value => { written.push(value); } } as Clipboard));
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		await import('../../browser/searchActionsRemoveReplace.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		input(view.element, 'Search workspace').value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 7);
		const before = view.getSearchResultSnapshot();
		const modelOrder = view.searchResult.files.map(file => [file.id, ...file.matches.map(match => match.id)]);
		for (const file of view.searchResult.files) { view.getControl().collapse(file.id); }
		await services.get(ICommandService).executeCommand(SearchCommandIds.CopyAllCommandId);
		const delimiter = isWindows ? '\r\n' : '\n';
		const blocks = [
			'/workspace/src/nested/z.ts' + delimiter + '  4,8: nested needle',
			'/workspace/src/file2.ts' + delimiter + ['  11,3:   needle\n  12:   next', '  20,3: a needle b needle', '  20,12: a needle b needle'].join(delimiter),
			'/workspace/src/file10.ts' + delimiter + '  3,5: ten needle',
			'/workspace/alpha.ts' + delimiter + '  1,6: root needle',
			'/other/src/file2.ts' + delimiter + '  8,8: remote needle',
		];
		assert.deepEqual(written, [blocks.join(delimiter + delimiter)]);
		assert.deepEqual(view.getSearchResultSnapshot(), before);
		assert.deepEqual(view.searchResult.files.map(file => [file.id, ...file.matches.map(match => match.id)]), modelOrder);
		const dismissed = view.searchResult.files.find(file => file.path === 'src/file10.ts')!;
		view.getControl().setFocus(dismissed.id);
		view.getControl().setSelection([dismissed.id]);
		await services.get(ICommandService).executeCommand(SearchCommandIds.RemoveActionId);
		await services.get(ICommandService).executeCommand(SearchCommandIds.CopyAllCommandId);
		assert.equal(written[1], blocks.filter(block => !block.startsWith('/workspace/src/file10.ts')).join(delimiter + delimiter));
		assert.equal(view.getSearchResultSnapshot()?.matchCount, 6);
		assert.ok(!view.getSearchResultSnapshot()?.content.includes('file10.ts'));
	} finally {
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});

test('Copy All leaves the clipboard intact while Search is inactive and reads retained results after reopening', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	const written: string[] = [];
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, {
			search: async (_query, options) => {
				options?.onProgress?.(matches);
				return { resultCount: matches.length, limitHit: false, error: undefined };
			}
		});
		services.registerInstance(IClipboardService, new BrowserClipboardService({ writeText: async value => { written.push(value); } } as Clipboard));
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		input(view.element, 'Search workspace').value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 2);
		const snapshot = view.getSearchResultSnapshot();
		view.setVisible(false);
		assert.equal(services.get(IViewsService).getActiveViewWithId(SEARCH_VIEW_ID), null);
		assert.equal(services.get(IViewsService).getViewWithId(SEARCH_VIEW_ID), view);
		await services.get(ICommandService).executeCommand(SearchCommandIds.CopyAllCommandId);
		assert.deepEqual({ written, snapshot: view.getSearchResultSnapshot(), visible: view.isVisible() }, { written: [], snapshot, visible: false });
		view.setVisible(true);
		await services.get(ICommandService).executeCommand(SearchCommandIds.CopyAllCommandId);
		const delimiter = isWindows ? '\r\n' : '\n';
		assert.deepEqual(written, [['/workspace/src/main.ts', '  4,7: const needle = true;', '  9,5: use(needle);'].join(delimiter)]);
	} finally {
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});

test('Copy All uses the latest running batch and leaves the search and clipboard failure intact', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	const written: string[] = [];
	const denied = new Error('Clipboard permission denied');
	let rejectWrite = false;
	let finish: (() => void) | undefined;
	let addBatch: (() => void) | undefined;
	let aborted = false;
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, {
			search: async (_query, options) => {
				options?.signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
				options?.onProgress?.([matches[0]!]);
				addBatch = () => options?.onProgress?.([matches[1]!]);
				await new Promise<void>(resolve => { finish = resolve; });
				return { resultCount: 2, limitHit: false, error: undefined };
			}
		});
		services.registerInstance(IClipboardService, new BrowserClipboardService({
			writeText: async value => {
				if (rejectWrite) { throw denied; }
				written.push(value);
			}
		} as Clipboard));
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		await import('../../browser/searchActionsRemoveReplace.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		const commands = services.get(ICommandService);
		await commands.executeCommand(SearchCommandIds.CopyAllCommandId);
		assert.deepEqual(written, ['']);
		input(view.element, 'Search workspace').value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => addBatch !== undefined);
		await commands.executeCommand(SearchCommandIds.CopyAllCommandId);
		view.getControl().setFocus(view.searchResult.files[0]!.matches[0]!.id);
		await commands.executeCommand(SearchCommandIds.RemoveActionId);
		addBatch!();
		await commands.executeCommand(SearchCommandIds.CopyAllCommandId);
		const delimiter = isWindows ? '\r\n' : '\n';
		assert.deepEqual(written.slice(1), [
			'/workspace/src/main.ts' + delimiter + '  4,7: const needle = true;',
			'/workspace/src/main.ts' + delimiter + '  9,5: use(needle);',
		]);
		rejectWrite = true;
		const before = view.searchResult.files[0]!.matches.map(match => match.id);
		await assert.rejects(commands.executeCommand(SearchCommandIds.CopyAllCommandId), error => error === denied);
		assert.deepEqual(view.searchResult.files[0]!.matches.map(match => match.id), before);
		assert.equal(written.length, 3);
		assert.equal(aborted, false);
		assert.equal(view.getControl().element.getAttribute('aria-busy'), 'true');
		finish!();
		await waitFor(() => view.getControl().element.getAttribute('aria-busy') === 'false');
		assert.equal(view.getSearchResultSnapshot()?.matchCount, 1);
	} finally {
		finish?.();
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});

test('Copy uses the first selection or explicit row and formats match, file and collapsed folder scopes', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	const written: string[] = [];
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, {
			search: async (_query, options) => {
				options?.onProgress?.([...matches, { dirId: 'workspace', path: 'src/nested/file2.ts', lineNumber: 10, preview: '中文😀 needle\r\nnext', ranges: [{ start: 5, end: 17 }] }, { dirId: 'workspace', path: 'root.ts', lineNumber: 1, preview: 'root needle', ranges: [{ start: 5, end: 11 }] }]);
				return { resultCount: 4, limitHit: false, error: undefined };
			}
		});
		services.registerInstance(IClipboardService, new BrowserClipboardService({ writeText: async value => { written.push(value); } } as Clipboard));
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		input(view.element, 'Search workspace').value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 4);
		const tree = view.getControl();
		const main = view.searchResult.files.find(file => file.path === 'src/main.ts')!;
		const nested = view.searchResult.files.find(file => file.path === 'src/nested/file2.ts')!;
		const before = view.getSearchResultSnapshot();
		tree.setSelection([main.matches[1]!.id, main.matches[0]!.id]);
		tree.setFocus(main.matches[1]!.id);
		const selection = tree.selection.map(element => element.id);
		const commands = services.get(ICommandService);
		await commands.executeCommand('search.action.copyMatch');
		await commands.executeCommand('search.action.copyMatch', nested.matches[0]);
		assert.deepEqual(tree.selection.map(element => element.id), selection);
		tree.collapse(main.id);
		const collapsedSelection = tree.selection.map(element => element.id);
		await commands.executeCommand('search.action.copyMatch', main);
		const folder = [...view.searchResult.children[0]!.children.values()].find(element => element.kind === 'folder')!;
		await commands.executeCommand('search.action.copyMatch', folder);
		const delimiter = isWindows ? '\r\n' : '\n';
		const mainBlock = ['/workspace/src/main.ts', '  4,7: const needle = true;', '  9,5: use(needle);'].join(delimiter);
		const nestedBlock = '/workspace/src/nested/file2.ts' + delimiter + '  10,6: 中文😀 needle\n  11:   next';
		assert.deepEqual(written, ['4,7: const needle = true;', '10,6: 中文😀 needle\n11:   next', mainBlock, nestedBlock + delimiter + delimiter + mainBlock]);
		assert.deepEqual(view.getSearchResultSnapshot(), before);
		assert.deepEqual(tree.selection.map(element => element.id), collapsedSelection);
		assert.equal(tree.model.getNode(main.id)?.collapsed, true);
		view.searchResult.batchRemove([main.matches[0]!]);
		await view.queueRefreshTree();
		await commands.executeCommand('search.action.copyMatch', folder);
		assert.equal(written.at(-1), nestedBlock + delimiter + delimiter + '/workspace/src/main.ts' + delimiter + '  9,5: use(needle);');
		assert.equal(view.searchResult.count, 3);
	} finally {
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});

test('Copy leaves no-selection and inactive calls alone but honors dismissed explicit matches and clipboard failures', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	const written: string[] = [];
	const denied = new Error('Clipboard permission denied');
	let rejectWrite = false;
	let finish: (() => void) | undefined;
	let aborted = false;
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, {
			search: async (_query, options) => {
				options?.signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
				options?.onProgress?.(matches);
				await new Promise<void>(resolve => { finish = resolve; });
				return { resultCount: 2, limitHit: false, error: undefined };
			}
		});
		services.registerInstance(IClipboardService, new BrowserClipboardService({ writeText: async value => { if (rejectWrite) { throw denied; } written.push(value); } } as Clipboard));
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		await import('../../browser/searchActionsRemoveReplace.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		const commands = services.get(ICommandService);
		await commands.executeCommand('search.action.copyMatch');
		assert.deepEqual(written, []);
		input(view.element, 'Search workspace').value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => view.searchResult.count === 2);
		const tree = view.getControl();
		const removed = view.searchResult.files[0]!.matches[0]!;
		tree.setFocus(removed.id);
		tree.setSelection([removed.id]);
		await commands.executeCommand(SearchCommandIds.RemoveActionId);
		assert.equal(tree.model.getElement(removed.id), undefined);
		tree.setSelection([]);
		await commands.executeCommand('search.action.copyMatch');
		view.setVisible(false);
		await commands.executeCommand('search.action.copyMatch');
		assert.deepEqual(written, []);
		await commands.executeCommand('search.action.copyMatch', removed);
		assert.deepEqual(written, ['4,7: const needle = true;']);
		view.setVisible(true);
		const before = view.searchResult.files[0]!.matches.map(match => match.id);
		rejectWrite = true;
		await assert.rejects(commands.executeCommand('search.action.copyMatch', view.searchResult.files[0]!), error => error === denied);
		assert.deepEqual(view.searchResult.files[0]!.matches.map(match => match.id), before);
		assert.deepEqual(written, ['4,7: const needle = true;']);
		assert.equal(aborted, false);
		assert.equal(tree.element.getAttribute('aria-busy'), 'true');
		finish!();
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 1);
	} finally {
		finish?.();
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});

test('Copy context menu uses its row and closes and releases listeners when that row or the view is removed', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	const shown: IContextMenuDelegate[] = [];
	let hidden = 0;
	const written: string[] = [];
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, { search: async (_query, options) => { options?.onProgress?.(matches); return { resultCount: 2, limitHit: false, error: undefined }; } });
		services.registerInstance(IClipboardService, new BrowserClipboardService({ writeText: async value => { written.push(value); } } as Clipboard));
		const menus = services.get(IContextMenuService);
		menus.showContextMenu = delegate => { shown.push(delegate as IContextMenuDelegate); };
		menus.hideContextMenu = () => { hidden++; shown.at(-1)?.onHide?.(true); };
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		input(view.element, 'Search workspace').value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 2);
		const tree = view.getControl();
		tree.setSelection([view.searchResult.files[0]!.matches[1]!.id]);
		const row = view.element.querySelector<HTMLElement>('.ash-search-match')!;
		row.dispatchEvent(new browser.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		assert.equal(shown.length, 1);
		const action = shown[0]!.getActions().find(action => action.id === 'search.action.copyMatch');
		assert.ok(action);
		await action.run();
		assert.deepEqual(written, ['4,7: const needle = true;']);
		view.setVisible(false);
		assert.equal(hidden, 1);
		view.setVisible(true);
		row.dispatchEvent(new browser.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		assert.equal(shown.length, 2);
		view.searchResult.batchRemove([view.searchResult.files[0]!.matches[0]!]);
		await view.queueRefreshTree();
		assert.equal(hidden, 2);
		row.dispatchEvent(new browser.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		assert.equal(shown.length, 2);
		const remaining = view.element.querySelector<HTMLElement>('.ash-search-match')!;
		remaining.dispatchEvent(new browser.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		assert.equal(shown.length, 3);
		view.dispose();
		assert.equal(hidden, 3);
		remaining.dispatchEvent(new browser.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		assert.equal(shown.length, 3);
	} finally {
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});

test('Copy keeps dismissed file arguments separate from active snapshots, late batches and refreshed results', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	const written: string[] = [];
	let progress: ((batch: typeof matches) => void) | undefined;
	let finish: (() => void) | undefined;
	let searches = 0;
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, {
			search: async (_query, options) => {
				if (++searches > 1) {
					options?.onProgress?.([{ ...matches[0]!, preview: 'fresh needle', ranges: [{ start: 6, end: 12 }] }]);
					return { resultCount: 1, limitHit: false, error: undefined };
				}
				progress = batch => options?.onProgress?.(batch);
				progress([...matches, { ...matches[0]!, path: 'keep.ts', preview: 'keep needle', ranges: [{ start: 5, end: 11 }] }]);
				await new Promise<void>(resolve => { finish = resolve; });
				return { resultCount: 3, limitHit: false, error: undefined };
			}
		});
		services.registerInstance(IClipboardService, new BrowserClipboardService({ writeText: async value => { written.push(value); } } as Clipboard));
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		await import('../../browser/searchActionsRemoveReplace.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		input(view.element, 'Search workspace').value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => view.searchResult.count === 3);
		const tree = view.getControl();
		const oldFile = view.searchResult.files.find(file => file.path === 'src/main.ts')!;
		const oldMatches = [...oldFile.matches];
		const oldFolder = [...view.searchResult.children[0]!.children.values()].find(child => child.kind === 'folder')!;
		tree.setFocus(oldFile.id);
		tree.setSelection([oldFile.id]);
		const commands = services.get(ICommandService);
		await commands.executeCommand(SearchCommandIds.RemoveActionId);
		await commands.executeCommand(SearchCommandIds.CopyMatchCommandId, oldFile);
		await commands.executeCommand(SearchCommandIds.CopyMatchCommandId, oldFolder);
		await commands.executeCommand(SearchCommandIds.CopyAllCommandId);
		const delimiter = isWindows ? '\r\n' : '\n';
		const oldText = ['/workspace/src/main.ts', '  4,7: const needle = true;', '  9,5: use(needle);'].join(delimiter);
		const keepText = '/workspace/keep.ts' + delimiter + '  4,6: keep needle';
		assert.deepEqual(written, [oldText, keepText]);
		assert.equal(view.searchResult.count, 1);
		assert.equal(view.getSearchResultSnapshot(), undefined);
		progress!([{ ...matches[0]!, preview: 'late NEEDLE', ranges: [{ start: 5, end: 11 }] }]);
		await waitFor(() => view.searchResult.count === 2);
		const replacement = view.searchResult.files.find(file => file.path === oldFile.path)!;
		assert.notEqual(replacement, oldFile);
		assert.notEqual(replacement.matches[0], oldMatches[0]);
		view.searchResult.batchRemove([oldFolder, oldFile, ...oldMatches]);
		assert.equal(view.searchResult.count, 2);
		finish!();
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 2);
		await commands.executeCommand(SearchCommandIds.CopyAllCommandId);
		assert.equal(written.at(-1), '/workspace/src/main.ts' + delimiter + '  4,6: late NEEDLE' + delimiter + delimiter + keepText);
		const snapshot = view.getSearchResultSnapshot()!;
		assert.deepEqual(snapshot.content.split('\n').slice(2), ['# File: file:///workspace/keep.ts', '  4:6-4:12: needle', '', '# File: file:///workspace/src/main.ts', '  4:6-4:12: NEEDLE', '']);
		view.element.querySelector<HTMLButtonElement>('button[aria-label="Refresh search"]')!.click();
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 1);
		view.searchResult.batchRemove([replacement, oldFile, ...oldMatches]);
		await commands.executeCommand(SearchCommandIds.CopyAllCommandId);
		assert.equal(written.at(-1), '/workspace/src/main.ts' + delimiter + '  4,7: fresh needle');
		await commands.executeCommand(SearchCommandIds.CopyMatchCommandId, oldFile);
		assert.equal(written.at(-1), oldText);
		assert.deepEqual(view.getSearchResultSnapshot()!.content.split('\n').slice(2), ['# File: file:///workspace/src/main.ts', '  4:7-4:13: needle', '']);
	} finally {
		finish?.();
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});

test('Copy menu callbacks cannot clear a replacement and keyboard menus ignore inputs and extra modifiers', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	const shown: IContextMenuDelegate[] = [];
	let hidden = 0;
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, { search: async (_query, options) => { options?.onProgress?.(matches); return { resultCount: 2, limitHit: false, error: undefined }; } });
		const menus = services.get(IContextMenuService);
		menus.showContextMenu = delegate => { shown.push(delegate as IContextMenuDelegate); };
		menus.hideContextMenu = () => { hidden++; };
		const { SearchView } = await import('../../browser/searchView.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		input(view.element, 'Search workspace').value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 2);
		const tree = view.getControl();
		tree.setFocus(view.searchResult.files[0]!.matches[0]!.id);
		const embeddedInput = browser.window.document.createElement('input');
		tree.domNode.append(embeddedInput);
		for (const [target, options] of [[embeddedInput, { shiftKey: true }], [tree.element, { shiftKey: true, ctrlKey: true }], [tree.element, { shiftKey: true, altKey: true }], [tree.element, { shiftKey: true, metaKey: true }], [tree.element, { shiftKey: true, isComposing: true }]] as const) {
			const event = new browser.window.KeyboardEvent('keydown', { key: 'F10', bubbles: true, cancelable: true, ...options });
			target.dispatchEvent(event);
			assert.equal(event.defaultPrevented, false);
		}
		assert.equal(shown.length, 0);
		const row = view.element.querySelector<HTMLElement>('.ash-search-match')!;
		row.dispatchEvent(new browser.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		row.dispatchEvent(new browser.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		assert.equal(shown.length, 2);
		assert.equal(hidden, 1);
		input(view.element, 'Search workspace').focus();
		shown[0]!.onHide?.(true);
		assert.equal(browser.window.document.activeElement, input(view.element, 'Search workspace'));
		view.searchResult.batchRemove([view.searchResult.files[0]!.matches[0]!]);
		await view.queueRefreshTree();
		assert.equal(hidden, 2);
	} finally {
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});

test('Copy Path uses only the first selected file while explicit detached files and folders retain their URI', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	const written: string[] = [];
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, {
			search: async (_query, options) => {
				options?.onProgress?.([...matches, { ...matches[0]!, path: 'other.ts' }]);
				return { resultCount: 3, limitHit: false, error: undefined };
			}
		});
		services.registerInstance(IClipboardService, new BrowserClipboardService({ writeText: async value => { written.push(value); } } as Clipboard));
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		input(view.element, 'Search workspace').value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 3);
		const tree = view.getControl();
		const [file, other] = view.searchResult.files;
		const folder = view.searchResult.children[0]!;
		const before = view.getSearchResultSnapshot();
		const commands = services.get(ICommandService);
		tree.setFocus(file!.id);
		tree.setSelection([file!.id, other!.id]);
		assert.deepEqual(tree.selection.map(element => element.id), [other!.id, file!.id]);
		await commands.executeCommand(SearchCommandIds.CopyPathCommandId);
		await commands.executeCommand(SearchCommandIds.CopyPathCommandId, file);
		await commands.executeCommand(SearchCommandIds.CopyPathCommandId, folder);
		assert.deepEqual(written, ['/workspace/other.ts', '/workspace/src/main.ts', '/workspace']);
		for (const selection of [[], [other!.matches[0]!.id, file!.id]]) {
			tree.setSelection(selection);
			assert.ok(!tree.selection.length || tree.selection[0]!.kind === 'match');
			await commands.executeCommand(SearchCommandIds.CopyPathCommandId);
		}
		tree.setSelection([file!.id]);
		view.setVisible(false);
		await commands.executeCommand(SearchCommandIds.CopyPathCommandId);
		assert.equal(written.length, 3);
		assert.deepEqual(view.getSearchResultSnapshot(), before);
		view.searchResult.clear();
		await view.queueRefreshTree();
		await commands.executeCommand(SearchCommandIds.CopyPathCommandId, file);
		await commands.executeCommand(SearchCommandIds.CopyPathCommandId, folder);
		assert.deepEqual(written.slice(3), ['/workspace/src/main.ts', '/workspace']);
		assert.equal(view.searchResult.count, 0);
		using formatter = services.get(ILabelService).registerFormatter({ scheme: 'file', format: resource => 'formatted:' + resource.path });
		await commands.executeCommand(SearchCommandIds.CopyPathCommandId, file);
		assert.equal(written.at(-1), 'formatted:/workspace/src/main.ts');
	} finally {
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});

test('Copy Path preserves a running search and propagates clipboard failures without changing results', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	const denied = new Error('Clipboard permission denied');
	let finish: (() => void) | undefined;
	let aborted = false;
	let rejected = false;
	const written: string[] = [];
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, {
			search: async (_query, options) => {
				options?.signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
				options?.onProgress?.(matches);
				await new Promise<void>(resolve => { finish = resolve; });
				return { resultCount: 2, limitHit: false, error: undefined };
			}
		});
		services.registerInstance(IClipboardService, new BrowserClipboardService({ writeText: async value => { if (rejected) { throw denied; } written.push(value); } } as Clipboard));
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		input(view.element, 'Search workspace').value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => finish !== undefined);
		const file = view.searchResult.files[0]!;
		const before = file.matches.map(match => match.id);
		await services.get(ICommandService).executeCommand(SearchCommandIds.CopyPathCommandId, file);
		rejected = true;
		await assert.rejects(services.get(ICommandService).executeCommand(SearchCommandIds.CopyPathCommandId, file), error => error === denied);
		assert.deepEqual({ written, matches: file.matches.map(match => match.id), aborted, busy: view.getControl().element.getAttribute('aria-busy') }, { written: ['/workspace/src/main.ts'], matches: before, aborted: false, busy: 'true' });
		finish!();
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 2);
	} finally {
		finish?.();
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});

test('Expand All runs for empty, partially collapsed and multi-root results without changing selection or outside focus', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	let searched = 0;
	try {
		using store = new DisposableStore();
		const workspace = store.add(new WorkspaceContextService({
			id: 'multiple', folders: [
				{ id: 'workspace', name: 'Workspace', index: 0, uri: URI.file('/workspace') },
				{ id: 'other', name: 'Other', index: 1, uri: URI.file('/other') },
			]
		}));
		const delivered = [...matches, { ...matches[0]!, dirId: 'other', path: 'deep/nested/other.ts' }];
		const services = createServices(store, browser, {
			search: async (_query, options) => {
				searched++;
				options?.onProgress?.(delivered);
				return { resultCount: delivered.length, limitHit: false, error: undefined };
			},
		}, undefined, workspace);
		const { SearchView } = await import('../../browser/searchView.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		const command = () => services.get(ICommandService).executeCommand('search.action.expandSearchResults');
		await command();
		assert.equal(view.searchResult.count, 0);
		const queryInput = input(view.element, 'Search workspace');
		queryInput.value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 3);
		let actions: readonly IAction[] = [];
		services.get(IContextMenuService).showContextMenu = delegate => { actions = delegate.getActions?.() ?? []; };
		view.element.querySelector<HTMLButtonElement>('button[aria-label="More Actions"]')!.click();
		await actions.find(action => action.id === 'search.treeView')!.run();
		const tree = view.getControl();
		const selected = tree.model.rootNodes[0]!.element;
		tree.setFocus(selected.id);
		tree.setSelection([selected.id]);
		const before = view.getSearchResultSnapshot();
		const otherRoot = tree.model.rootNodes[1]!;
		tree.collapseRecursive(otherRoot.id);
		queryInput.focus();
		await command();
		await command();
		assert.deepEqual({
			visibleMatches: tree.model.visibleNodes.filter(node => node.element.kind === 'match').length,
			selection: tree.selection.map(element => element.id), focus: tree.focus?.id,
			snapshot: view.getSearchResultSnapshot(), searched, inputFocused: browser.window.document.activeElement === queryInput,
		}, { visibleMatches: 3, selection: [selected.id], focus: selected.id, snapshot: before, searched: 1, inputFocused: true });
		for (const node of tree.model.rootNodes) { tree.collapseRecursive(node.id); }
		view.setVisible(false);
		await command();
		assert.equal(tree.model.visibleNodes.filter(node => node.element.kind === 'match').length, 0);
		view.setVisible(true);
		await command();
		assert.equal(tree.model.visibleNodes.filter(node => node.element.kind === 'match').length, 3);
	} finally {
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});

test('Expand All palette follows late batches, preserves hidden retained state and clears on owner disposal', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	let finish: (() => void) | undefined;
	let aborted = false;
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, {
			search: async (_query, options) => {
				options?.signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
				options?.onProgress?.(matches);
				await new Promise<void>(resolve => { finish = () => { options?.onProgress?.([{ ...matches[0]!, path: 'late.ts' }]); resolve(); }; });
				return { resultCount: 3, limitHit: false, error: undefined };
			},
		});
		const { SearchView } = await import('../../browser/searchView.js');
		using view = services.createInstance(SearchView, browser.window.document.body, { id: SEARCH_VIEW_ID, title: 'Search' });
		registerView(services, view);
		const menus = services.createInstance(MenuService);
		const palette = () => menus.getMenuActions(MenuId.CommandPalette).flatMap(([, actions]) => actions).find(action => action.id === 'search.action.expandSearchResults');
		assert.equal(palette(), undefined);
		input(view.element, 'Search workspace').value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => finish !== undefined);
		assert.equal(palette(), undefined);
		const tree = view.getControl();
		tree.collapseRecursive(tree.model.rootNodes[0]!.id);
		assert.deepEqual({ label: palette()?.label, enabled: palette()?.enabled, busy: tree.element.getAttribute('aria-busy'), aborted }, {
			label: 'Search: Expand All', enabled: true, busy: 'true', aborted: false,
		});
		await palette()!.run();
		assert.equal(palette(), undefined);
		finish!();
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 3);
		assert.deepEqual({ expandedMatches: tree.model.visibleNodes.filter(node => node.element.kind === 'match').length, aborted }, { expandedMatches: 3, aborted: false });
		for (const node of tree.model.rootNodes) { tree.collapseRecursive(node.id); }
		assert.equal(palette()?.enabled, true);
		view.setVisible(false);
		assert.equal(palette()?.enabled, true);
		await palette()!.run();
		assert.deepEqual({ visibleMatches: tree.model.visibleNodes.filter(node => node.element.kind === 'match').length, visible: view.isVisible() }, { visibleMatches: 0, visible: false });
		view.setVisible(true);
		assert.equal(palette()?.enabled, true);
		view.dispose();
		await services.get(ICommandService).executeCommand('search.action.expandSearchResults');
		assert.deepEqual({ palette: palette(), hasResults: services.get(IContextKeyService).getValue('hasSearchResult'), hasCollapsible: services.get(IContextKeyService).getValue('viewHasSomeCollapsibleResult') }, {
			palette: undefined, hasResults: false, hasCollapsible: false,
		});
	} finally {
		finish?.();
		browser.window.close();
		for (const name of globals) { Reflect.deleteProperty(globalThis, name); }
	}
});
