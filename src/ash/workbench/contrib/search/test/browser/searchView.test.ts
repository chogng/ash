import { expect } from '@playwright/test';
import type { ActivityBarPosition } from '../../../../common/configuration.js';
import type { ViewContainerLocation } from '../../../../common/views.js';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import { BrowserPathService } from '../../../../services/path/browser/pathService.js';
import { createDisconnectedRendererApi } from '../../../../browser/rendererApi.js';
import { BrowserFileSearchService } from '../../../../../platform/search/browser/browserFileSearchService.js';
import { IFileSearchService } from '../../../../../platform/search/common/fileSearch.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { SearchService } from '../../../../services/search/common/searchService.js';
import { IFileTextModelService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import assert from 'node:assert/strict';
import { test, suite } from 'mocha';
import { JSDOM } from 'jsdom';
import { BrowserContentSearchService } from '../../../../../platform/search/browser/searchService.js';
import type { IContentSearchQuery, ContentSearchMatch } from '../../../../../platform/search/common/search.js';
import type { IContentSearchApi } from '../../../../../platform/search/common/searchApi.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import { ContentSearchConfiguration } from '../../common/searchConfiguration.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContentSearchService as ContentSearchServiceId } from '../../../../../platform/search/common/search.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TestWorkspaceService } from '../../../../services/configuration/test/common/testServices.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { HoverService, IHoverService } from '../../../../../platform/hover/browser/hoverService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import '../../../../contrib/accessibility/browser/accessibilityConfiguration.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { SearchHistoryService, ISearchHistoryService } from '../../common/searchHistoryService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IReplaceService } from '../../browser/replace.js';
import { ReplaceService } from '../../browser/replaceService.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { BulkEditTestServices } from '../../../bulkEdit/test/browser/bulkEditTestServices.js';
import { ITextModelResourceService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { IBulkEditService } from '../../../../../editor/browser/services/bulkEditService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import type { IView } from '../../../../common/views.js';
import type { SearchView } from '../../browser/searchView.js';
import { SEARCH_VIEW_ID, SearchCommandIds } from '../../common/constants.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { BrowserClipboardService } from '../../../../../platform/clipboard/browser/clipboardService.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { LabelService } from '../../../../services/label/common/labelService.js';
import { isWindows, operatingSystem, OperatingSystem } from '../../../../../base/common/platform.js';
import type { IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import type { IAction } from '../../../../../base/common/actions.js';
import '../../browser/searchActionsTopBar.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import type { IContentSearchComplete, IContentSearchOptions } from '../../../../../platform/search/common/search.js';
import type { SearchReplaceResult } from '../../browser/replace.js';

interface ViewSearchProvider {
	search(query: IContentSearchQuery, options?: IContentSearchOptions): Promise<IContentSearchComplete>;
}

const matches: readonly ContentSearchMatch[] = [
	{
		dirId: 'workspace',
		path: 'src/main.ts',
		lineNumber: 4,
		preview: 'const needle = true;',
		ranges: [{ start: 6, end: 12 }],
	},
	{
		dirId: 'workspace',
		path: 'src/main.ts',
		lineNumber: 9,
		preview: 'use(needle);',
		ranges: [{ start: 4, end: 10 }],
	},
];

test('Search sidebar hides line numbers by default and applies explicit changes without searching again', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	try {
		using store = new DisposableStore();
		let searches = 0;
		const services = createServices(store, browser, {
			search: async (_query, options) => {
				searches++;
				options?.onProgress?.([
					...matches,
					{
						dirId: 'workspace',
						path: 'src/main.ts',
						lineNumber: 10,
						preview: 'needle\nnext',
						ranges: [{ start: 0, end: 11 }],
					},
				]);
				return { resultCount: 3, limitHit: false, error: undefined };
			},
		});
		const configuration = services.get(IConfigurationService);
		assert.equal(configuration.getValue(ContentSearchConfiguration.showLineNumbers), false);
		const { SearchView } = await import('../../browser/searchView.js');
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
		registerView(services, view);
		input(view.element, 'Search workspace').value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 3);
		const snapshot = view.getSearchResultSnapshot();
		const labels = (): (string | null)[] => [...view.element.querySelectorAll('.ash-search-line-number')].map(element => element.textContent);
		assert.deepEqual(labels(), ['+1']);
		assert.match(view.element.querySelector('.ash-search-match')!.getAttribute('aria-label')!, /Line 4, column 7/);
		await configuration.updateValue(ContentSearchConfiguration.showLineNumbers, true);
		assert.deepEqual(labels(), ['4:', '9:', '10:+1']);
		await configuration.updateValue(ContentSearchConfiguration.showLineNumbers, false);
		assert.deepEqual(labels(), ['+1']);
		assert.equal(searches, 1);
		assert.deepEqual(view.getSearchResultSnapshot(), snapshot);
	} finally {
		browser.window.close();
		for (const name of globals) Reflect.deleteProperty(globalThis, name);
	}
});

test('Search exposes query and replacement as multiline inputs and folding replacement preserves its value', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, {
			search: async () => ({ resultCount: 0, limitHit: false, error: undefined }),
		});
		const { SearchView } = await import('../../browser/searchView.js');
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
		registerView(services, view);
		const query = input(view.element, 'Search workspace');
		const replacement = input(view.element, 'Replace');
		const row = view.element.querySelector<HTMLElement>('.ash-search-replace-row')!;
		assert.equal(row.hidden, false, 'Search and Replace are visible when Search first opens');
		assert.deepEqual([query.tagName, replacement.tagName], ['TEXTAREA', 'TEXTAREA']);
		const context = services.get(IContextKeyService);
		for (const label of ['Search workspace', 'Replace', 'Files to include', 'Files to exclude']) {
			const field = input(view.element, label);
			field.focus();
			assert.equal(context.getContext(field).getValue('searchViewletFocus'), true, `${label} inherits Search keyboard commands through its history scope`);
			assert.equal(context.getContext(field).getValue('historyNavigationWidgetFocus'), true);
		}
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
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
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
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
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
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
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
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
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
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
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
		services.registerInstance(
			IClipboardService,
			new BrowserClipboardService({
				writeText: async value => {
					written.push(value);
				},
			} as Clipboard),
		);
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		await import('../../browser/searchActionsRemoveReplace.js');
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
		registerView(services, view);
		input(view.element, 'Search workspace').value = 'needle';
		view.triggerQueryChange();
		await waitFor(() => view.getControl().element.getAttribute('aria-busy') === 'false');
		const before = view.getSearchResultSnapshot();
		const match = view.searchResult.files[0]!.matches[0]!;
		let actions: readonly IAction[] = [];
		services.get(IContextMenuService).showContextMenu = delegate => {
			actions = delegate.getActions?.() ?? [];
		};
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
		tree.setFocus(match.id);
		tree.setSelection([match.id]);
		await services.get(ICommandService).executeCommand(SearchCommandIds.RemoveActionId);
		assert.equal(view.searchResult.count, 0);
		assert.equal(tree.model.rootNodes.length, 0);
	} finally {
		browser.window.close();
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
	}
});

test('Search lifecycle commands cancel retained results, replace running queries and clear inputs in two stages', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	const jobs: {
		query: IContentSearchQuery;
		options: IContentSearchOptions;
		completion: DeferredPromise<IContentSearchComplete>;
	}[] = [];
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
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
		registerView(services, view);
		const queryInput = input(view.element, 'Search workspace');
		const replacement = input(view.element, 'Replace');
		const includes = input(view.element, 'Files to include');
		const excludes = input(view.element, 'Files to exclude');
		const commands = services.get(ICommandService);
		const menus = services.createInstance(MenuService);
		const palette = (id: string) =>
			menus
				.getMenuActions(MenuId.CommandPalette)
				.flatMap(([, actions]) => actions)
				.find(action => action.id === id);
		assert.equal(palette('search.action.cancel'), undefined);
		assert.equal(palette('search.action.clearSearchResults'), undefined);
		queryInput.value = 'needle';
		replacement.value = 'replacement';
		includes.value = 'src/**';
		excludes.value = '**/*.test.ts';
		for (const field of [queryInput, replacement, includes, excludes]) {
			field.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
		}
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
		queryInput.value = 'again';
		queryInput.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
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
		assert.deepEqual(
			{
				results: view.searchResult.count,
				snapshot: view.getSearchResultSnapshot(),
				state: services.get(IContextKeyService).getValue('searchState'),
				status: view.element.querySelector('.ash-search-status')?.textContent,
			},
			{ results: 0, snapshot: undefined, state: 0, status: '' },
		);
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
		queryInput.value = 'final';
		queryInput.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
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
		for (const job of jobs) {
			await job.completion.complete({ resultCount: 2, limitHit: false, error: undefined });
		}
		browser.window.close();
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
	}
});

test('Search lifecycle clears zero-result queries and input-only patterns and an empty refresh creates no job', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	let searches = 0;
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, {
			search: async () => {
				searches++;
				return { resultCount: 0, limitHit: false, error: undefined };
			},
		});
		const { SearchView } = await import('../../browser/searchView.js');
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
		registerView(services, view);
		const commands = services.get(ICommandService);
		const menus = services.createInstance(MenuService);
		const clear = () =>
			menus
				.getMenuActions(MenuId.CommandPalette)
				.flatMap(([, actions]) => actions)
				.find(action => action.id === 'search.action.clearSearchResults');
		const queryInput = input(view.element, 'Search workspace');
		queryInput.value = 'absent';
		queryInput.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
		await commands.executeCommand('search.action.refreshSearchResults');
		await waitFor(() => view.getControl().element.getAttribute('aria-busy') === 'false');
		assert.equal(view.element.querySelector('.ash-search-status')?.textContent, 'No results found.');
		assert.equal(clear()?.enabled, true);
		await commands.executeCommand('search.action.clearSearchResults');
		assert.equal(queryInput.value, '');
		for (const label of ['Replace', 'Files to include', 'Files to exclude']) {
			const field = input(view.element, label);
			field.value = 'pattern';
			field.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
			assert.equal(clear()?.enabled, true);
			await commands.executeCommand('search.action.clearSearchResults');
			assert.deepEqual({ value: field.value, clear: clear(), results: view.searchResult.count }, { value: '', clear: undefined, results: 0 });
		}
		input(view.element, 'Files to include').value = 'src/**';
		await commands.executeCommand('search.action.refreshSearchResults');
		assert.deepEqual(
			{
				searches,
				query: queryInput.value,
				includes: input(view.element, 'Files to include').value,
				status: view.element.querySelector('.ash-search-status')?.textContent,
			},
			{ searches: 1, query: '', includes: 'src/**', status: '' },
		);
	} finally {
		browser.window.close();
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
	}
});

for (const operation of ['replace', 'undo'] as const) {
	test(`Search lifecycle clearing blocks a late ${operation} from restarting search or writing its failure`, async () => {
		const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
		const globals = installDomGlobals(browser);
		const replacement = new DeferredPromise<SearchReplaceResult>();
		const undo = new DeferredPromise<void>();
		const result: SearchReplaceResult = {
			ariaSummary: 'applied',
			isApplied: true,
			resources: [],
			undo: () => undo.p,
			saveErrors: ['late save failure'],
		};
		let searches = 0;
		let signal: AbortSignal | undefined;
		let pending: Promise<unknown> | undefined;
		try {
			using store = new DisposableStore();
			const services = createServices(
				store,
				browser,
				{
					search: async (_query, options) => {
						searches++;
						options?.onProgress?.(matches);
						return { resultCount: 2, limitHit: false, error: undefined };
					},
				},
				undefined,
				undefined,
				{
					replace: async (_matches, _query, _replacement, options) => {
						signal = options.signal;
						return operation === 'replace' ? replacement.p : result;
					},
				},
			);
			const { SearchView } = await import('../../browser/searchView.js');
			using view = services.createInstance(SearchView, browser.window.document.body, {
				id: SEARCH_VIEW_ID,
				title: 'Search',
			});
			registerView(services, view);
			input(view.element, 'Search workspace').value = 'needle';
			view.triggerQueryChange();
			await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 2);
			view.getControl().setFocus(view.searchResult.files[0]!.matches[0]!.id);
			let actions: readonly IAction[] = [];
			services.get(IContextMenuService).showContextMenu = delegate => {
				actions = delegate.getActions?.() ?? [];
			};
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
			if (operation === 'replace') {
				assert.equal(signal?.aborted, true);
				await replacement.complete(result);
			} else {
				await undo.error(new Error('late undo failure'));
			}
			await pending;
			assert.deepEqual(
				{
					searches,
					results: view.searchResult.count,
					query: input(view.element, 'Search workspace').value,
					status: view.element.querySelector('.ash-search-status')?.textContent,
				},
				{ searches: operation === 'replace' ? 1 : 2, results: 0, query: '', status: '' },
			);
		} finally {
			await replacement.complete(result);
			await undo.complete();
			await pending;
			browser.window.close();
			for (const name of globals) {
				Reflect.deleteProperty(globalThis, name);
			}
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
		if (delay !== 2_000 || typeof handler !== 'function') {
			return originalTimeout(handler, delay, ...args);
		}
		const id = nextTimer++;
		scheduled.set(id, () => handler(...args));
		return id;
	}) as typeof browser.window.setTimeout;
	browser.window.clearTimeout = id => {
		if (id !== undefined && scheduled.has(id)) {
			cancelled.push(id);
		} else {
			originalClearTimeout(id);
		}
	};
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, {
			search() {
				const job = new DeferredPromise<IContentSearchComplete>();
				jobs.push(job);
				return job.p;
			},
		});
		const { SearchView } = await import('../../browser/searchView.js');
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
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
		for (const job of jobs) {
			await job.complete({ resultCount: 0, limitHit: false, error: undefined });
		}
		browser.window.setTimeout = originalTimeout;
		browser.window.clearTimeout = originalClearTimeout;
		browser.window.close();
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
	}
});

test('BrowserContentSearchService pulls bounded batches and releases the job', async () => {
	const readCursors: number[] = [];
	let cancelCount = 0;
	const api: IContentSearchApi = {
		start: async params => {
			assert.equal(params.query, 'needle');
			assert.equal(params.maxResults, 2_000);
			return { searchId: 'search-1' };
		},
		read: async params => {
			readCursors.push(params.afterMatch);
			if (params.afterMatch === 0) {
				return {
					searchId: params.searchId,
					matches: [{ ...matches[0], ranges: matches[0].ranges.map(range => ({ ...range })) }],
					nextMatch: 1,
					completed: false,
					limitHit: false,
					error: null,
				};
			}
			return {
				searchId: params.searchId,
				matches: [{ ...matches[1], ranges: matches[1].ranges.map(range => ({ ...range })) }],
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

	const complete = await service.search({ id: 'workspace', uri: URI.file('/workspace'), name: 'workspace', index: 0 }, query(), {
		onProgress: batch => progress.push(...batch),
	});

	assert.deepEqual(readCursors, [0, 1]);
	assert.deepEqual(
		progress,
		matches.map(match => ({ ...match, dirName: 'workspace' })),
	);
	assert.deepEqual(complete, {
		resultCount: 2,
		limitHit: true,
		error: undefined,
	});
	assert.equal(cancelCount, 1);
});

test('SearchView submits typed filters and groups highlighted matches', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const installedGlobals = installDomGlobals(browser);
	let submitted: IContentSearchQuery | undefined;
	const service: ViewSearchProvider = {
		search: async (searchQuery, options) => {
			submitted = searchQuery;
			options?.onProgress?.(matches);
			return { resultCount: matches.length, limitHit: false, error: undefined };
		},
	};

	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, service);
		const { SearchView } = await import('../../../../../workbench/contrib/search/browser/searchView.js');
		using pane = services.createInstance(SearchView, browser.window.document.body, {
			id: 'ash.search',
			title: 'Search',
		});
		browser.window.document.body.append(pane.element);
		const details = pane.element.querySelector<HTMLButtonElement>('button[aria-label="Toggle Search Details"]')!;
		assert.equal(details.getAttribute('aria-expanded'), 'false');
		details.click();
		assert.equal(details.getAttribute('aria-expanded'), 'true');
		input(pane.element, 'Search workspace').value = 'needle';
		input(pane.element, 'Files to include').value = 'src/**, docs/**';
		input(pane.element, 'Files to exclude').value = '**/*.test.ts';
		pane.element.querySelector<HTMLButtonElement>('button[aria-label="Match Case"]')!.click();
		pane.element.querySelector<HTMLButtonElement>('button[aria-label="Use Regular Expression"]')!.click();
		details.click();
		assert.equal(details.getAttribute('aria-expanded'), 'false');
		input(pane.element, 'Search workspace').dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
		assert.equal(submitted, undefined);
		input(pane.element, 'Search workspace').dispatchEvent(
			new browser.window.KeyboardEvent('keydown', {
				key: 'Enter',
				bubbles: true,
				cancelable: true,
			}),
		);

		await waitFor(() => pane.element.querySelector('.ash-search-status')?.textContent === '2 results');
		assert.deepEqual(submitted, {
			text: 'needle',
			wholeWord: false,
			patternKind: 'regex',
			caseSensitivity: 'sensitive',
			includePatterns: ['src/**', 'docs/**'],
			excludePatterns: ['**/*.test.ts'],
			maxResults: 2_000,
			freshness: 'current',
		});
		assert.equal(pane.element.querySelector('.ash-search-file-path .ash-icon-label-text')?.textContent, 'main.ts');
		assert.equal(pane.element.querySelector('.ash-search-file-path .ash-icon-label-description')?.textContent, 'src');
		assert.equal(pane.element.querySelector('.ash-search-file-count')?.textContent, '2');
		assert.deepEqual(
			[...pane.element.querySelectorAll('mark')].map(element => element.textContent),
			['needle', 'needle'],
		);
	} finally {
		browser.window.close();
		for (const name of installedGlobals) {
			Reflect.deleteProperty(globalThis, name);
		}
	}
});

test('SearchView applies configured query defaults and result limits', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const installedGlobals = installDomGlobals(browser);
	using configuration = new WorkbenchConfigurationService();
	await configuration.updateValue(ContentSearchConfiguration.matchCase, true);
	await configuration.updateValue(ContentSearchConfiguration.smartCase, false);
	await configuration.updateValue(ContentSearchConfiguration.regularExpression, true);
	await configuration.updateValue(ContentSearchConfiguration.includePatterns, 'src/**, packages/**');
	await configuration.updateValue(ContentSearchConfiguration.excludePatterns, '**/*.test.ts');
	await configuration.updateValue(ContentSearchConfiguration.maxResults, 750);
	let submitted: IContentSearchQuery | undefined;
	const service: ViewSearchProvider = {
		search: async searchQuery => {
			submitted = searchQuery;
			return { resultCount: 0, limitHit: false, error: undefined };
		},
	};

	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, service, configuration);
		const { SearchView } = await import('../../../../../workbench/contrib/search/browser/searchView.js');
		using pane = services.createInstance(SearchView, browser.window.document.body, {
			id: 'ash.search',
			title: 'Search',
		});
		browser.window.document.body.append(pane.element);
		input(pane.element, 'Search workspace').value = 'Needle';
		assert.equal(pane.element.querySelector('button[aria-label="Match Case"]')?.getAttribute('aria-pressed'), 'true');
		assert.equal(pane.element.querySelector('button[aria-label="Use Regular Expression"]')?.getAttribute('aria-pressed'), 'true');
		assert.equal(input(pane.element, 'Files to include').value, 'src/**, packages/**');
		assert.equal(input(pane.element, 'Files to exclude').value, '**/*.test.ts');
		pane.element.querySelector('form')?.dispatchEvent(new browser.window.Event('submit', { bubbles: true, cancelable: true }));
		await waitFor(() => submitted !== undefined);
		assert.deepEqual(submitted, {
			text: 'Needle',
			wholeWord: false,
			patternKind: 'regex',
			caseSensitivity: 'sensitive',
			includePatterns: ['src/**', 'packages/**'],
			excludePatterns: ['**/*.test.ts'],
			maxResults: 750,
			freshness: 'current',
		});
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

function query(): IContentSearchQuery {
	return {
		text: 'needle',
		patternKind: 'literal',
		caseSensitivity: 'smart',
		includePatterns: [],
		excludePatterns: [],
	};
}

function input(container: Element, label: string): HTMLInputElement | HTMLTextAreaElement {
	const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
	assert.ok(element);
	return element;
}

async function waitFor(condition: () => boolean, timeoutMillis = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMillis;
	while (!condition()) {
		if (Date.now() >= deadline) {
			throw new Error('Timed out waiting for SearchView');
		}
		await new Promise(resolve => setTimeout(resolve, 0));
	}
}

function installDomGlobals(browser: JSDOM): readonly string[] {
	Object.defineProperty(browser.window.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
	Object.defineProperty(browser.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 280 });
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

function createServices(
	store: DisposableStore,
	browser: JSDOM,
	search: ViewSearchProvider,
	configured?: WorkbenchConfigurationService,
	workspace?: TestWorkspaceService,
	replace?: IReplaceService,
): InstantiationService {
	const configuration = configured ?? store.add(new WorkbenchConfigurationService());
	const services = store.add(new InstantiationService());
	services.registerInstance(ICommandService, store.add(new CommandService(services)));
	const menus: IContextMenuService = {
		contextMenuStyle: 'custom' as const,
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu() {},
		hideContextMenu() {},
	};
	const contextView = store.add(new BrowserContextViewService(browser.window.document.body));
	services.registerInstance(ContentSearchServiceId, {
		search: (folder, query, options) =>
			search.search(query, {
				...options,
				onProgress: matches => options?.onProgress?.(matches.filter(match => match.dirId === folder.id)),
			}),
	});
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextKeyService, store.add(new ContextKeyService()));
	services.registerInstance(IContextMenuService, menus);
	services.registerInstance(IHoverService, store.add(new HoverService(configuration, contextView, menus)));
	services.registerInstance(IWorkspaceContextService, workspace ?? store.add(new TestWorkspaceService({ id: 'workspace', uri: URI.file('/workspace') })));
	services.registerInstance(ILabelService, store.add(createTestLabelService(services.get(IWorkspaceContextService), OperatingSystem.Linux)));
	services.registerInstance(IEditorService, {
		...emptyEditorServiceState,
		onDidActiveEditorChange: Event.None,
		onDidVisibleEditorsChange: Event.None,
		activeEditor: undefined,
		visibleEditors: [],
		openEditor: async () => {},
		focusActiveEditor() {},
	});
	services.registerInstance(
		IStorageService,
		store.add(
			new BrowserStorageService({
				ownerWindow: browser.window as unknown as Window,
				workspaceId: 'workspace',
				flushInterval: 0,
			}),
		),
	);
	services.registerInstance(ISearchHistoryService, store.add(services.createInstance(SearchHistoryService)));
	const editing = store.add(new BulkEditTestServices([]));
	services.registerInstance(ITextModelResourceService, editing.models);
	services.registerInstance(IFileTextModelService, editing.models);
	services.registerInstance(IFileSearchService, new BrowserFileSearchService(editing.files));
	services.registerInstance(ISearchService, store.add(services.createInstance(SearchService)));
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
		getViewProgressIndicator: () => view.getProgressIndicator(),
		onDidChangeViewContainerVisibility: Event.None,
		onDidChangeViewVisibility: Event.None,
		onDidChangeFocusedView: Event.None,
		isViewContainerVisible: () => true,
		isViewContainerActive: () => true,
		openViewContainer: async () => null,
		closeViewContainer() {},
		getVisibleViewContainer: () => null,
		getActiveViewPaneContainerWithId: () => null,
		getFocusedView: () => null,
		getFocusedViewName: () => 'Search',
		isViewVisible: id => id === SEARCH_VIEW_ID,
		openView: async <T extends IView>(): Promise<T | null> => view as unknown as T,
		closeView() {},
		getActiveViewWithId: <T extends IView>(id: string) => (id === SEARCH_VIEW_ID && view.isVisible() ? (view as unknown as T) : null),
		getViewWithId: <T extends IView>(id: string) => (id === SEARCH_VIEW_ID ? (view as unknown as T) : null),
		focusView: async () => {
			view.focus();
			return true;
		},
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
			},
		});
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsRemoveReplace.js');
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
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
		assert.deepEqual(
			{
				count: view.getSearchResultSnapshot()?.matchCount,
				focused: tree.focus?.id,
				status: view.element.querySelector('[role="status"]')!.textContent,
			},
			{
				count: 2,
				focused: next.id,
				status: '2 results (result limit reached)',
			},
		);
		assert.match(view.getSearchResultSnapshot()!.content, /# File: file:\/\/\/workspace\/src\/main\.ts\n  9:5-9:11: needle\n\n/);
		tree.setSelection([next.id, view.searchResult.files[1]!.id]);
		await services.get(ICommandService).executeCommand(SearchCommandIds.RemoveActionId);
		await services.get(ICommandService).executeCommand(SearchCommandIds.RemoveActionId);
		assert.deepEqual(
			{
				count: view.searchResult.count,
				focused: tree.focus,
				snapshot: view.getSearchResultSnapshot(),
				status: view.element.querySelector('[role="status"]')!.textContent,
			},
			{
				count: 0,
				focused: undefined,
				snapshot: undefined,
				status: 'No results found.',
			},
		);
		assert.equal(browser.window.document.activeElement, tree.element);
		view.element.querySelector<HTMLButtonElement>('button[aria-label="Refresh search"]')!.click();
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 3);
	} finally {
		browser.window.close();
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
	}
});

for (const scenario of [
	{
		name: 'the next collapsed file',
		focusedFile: 'a.ts',
		expectedFile: 'b.ts',
		expectedMatch: 0,
		selectedFile: undefined,
		count: 5,
	},
	{
		name: 'the last collapsed file when no later match remains',
		focusedFile: 'c.ts',
		expectedFile: 'b.ts',
		expectedMatch: 1,
		selectedFile: 'c.ts',
		count: 4,
	},
	{
		name: 'the next collapsed file beyond a selected branch',
		focusedFile: 'a.ts',
		expectedFile: 'c.ts',
		expectedMatch: 0,
		selectedFile: 'b.ts',
		count: 3,
	},
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
				},
			});
			const { SearchView } = await import('../../browser/searchView.js');
			await import('../../browser/searchActionsRemoveReplace.js');
			using view = services.createInstance(SearchView, browser.window.document.body, {
				id: SEARCH_VIEW_ID,
				title: 'Search',
			});
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
				if (file.path !== scenario.focusedFile) {
					tree.collapse(file.id);
				}
			}
			tree.setFocus(focused.id);
			tree.setSelection(selected ? [focused.id, selected.id] : [focused.id]);
			await services.get(ICommandService).executeCommand(SearchCommandIds.RemoveActionId);
			assert.deepEqual(
				{
					focus: tree.focus?.id,
					selection: tree.selection.map(element => element.id),
					collapsed: tree.isCollapsed(expectedFile.id),
					count: view.getSearchResultSnapshot()?.matchCount,
				},
				{
					focus: expected.id,
					selection: [expected.id],
					collapsed: false,
					count: scenario.count,
				},
			);
			assert.equal(browser.window.document.activeElement, tree.element);
			assert.ok(tree.getVisibleElements().includes(expected));
			for (const file of view.searchResult.files) {
				if (file.path !== scenario.focusedFile && file !== expectedFile) {
					assert.equal(tree.isCollapsed(file.id), true);
				}
			}
		} finally {
			browser.window.close();
			for (const name of globals) {
				Reflect.deleteProperty(globalThis, name);
			}
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
				await new Promise<void>(resolve => {
					finish = () => {
						options?.onProgress?.(matches);
						resolve();
					};
				});
				return { resultCount: 3, limitHit: false, error: undefined };
			},
		});
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsRemoveReplace.js');
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
		registerView(services, view);
		input(view.element, 'Search workspace').value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => finish !== undefined);
		const tree = view.getControl();
		const file = view.searchResult.files[0]!;
		tree.setFocus(file.id);
		await services.get(ICommandService).executeCommand(SearchCommandIds.RemoveActionId);
		assert.deepEqual(
			{
				count: view.searchResult.count,
				busy: tree.element.getAttribute('aria-busy'),
				status: view.element.querySelector('[role="status"]')!.textContent,
			},
			{
				count: 0,
				busy: 'true',
				status: '0 results…',
			},
		);
		finish!();
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 2);
		assert.equal(view.element.querySelector('[role="status"]')!.textContent, '2 results');
	} finally {
		finish?.();
		browser.window.close();
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
	}
});

test('Copy All formats the retained model in root, folder, filename and range order without changing it', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	const block = 'context\r\n  needle\r\nnext\r\nunused';
	const delivered: ContentSearchMatch[] = [
		{
			dirId: 'other',
			path: 'src/file2.ts',
			lineNumber: 8,
			preview: 'remote needle',
			ranges: [{ start: 7, end: 13 }],
		},
		{
			dirId: 'workspace',
			path: 'alpha.ts',
			lineNumber: 1,
			preview: 'root needle',
			ranges: [{ start: 5, end: 11 }],
		},
		{
			dirId: 'workspace',
			path: 'src/file10.ts',
			lineNumber: 3,
			preview: 'ten needle',
			ranges: [{ start: 4, end: 10 }],
		},
		{
			dirId: 'workspace',
			path: 'src/file2.ts',
			lineNumber: 20,
			preview: 'a needle b needle',
			ranges: [
				{ start: 11, end: 17 },
				{ start: 2, end: 8 },
			],
		},
		{
			dirId: 'workspace',
			path: 'src/file2.ts',
			lineNumber: 10,
			preview: block,
			ranges: [{ start: block.indexOf('needle'), end: block.indexOf('next') + 4 }],
		},
		{
			dirId: 'workspace',
			path: 'src/nested/z.ts',
			lineNumber: 4,
			preview: 'nested needle',
			ranges: [{ start: 7, end: 13 }],
		},
	];
	const written: string[] = [];
	try {
		using store = new DisposableStore();
		const workspace = store.add(
			new TestWorkspaceService({
				id: 'multi',
				folders: [
					{ id: 'workspace', name: 'workspace', index: 0, uri: URI.file('/workspace') },
					{ id: 'other', name: 'other', index: 1, uri: URI.parse('ssh://host/other') },
				],
			}),
		);
		const services = createServices(
			store,
			browser,
			{
				search: async (_query, options) => {
					options?.onProgress?.(delivered);
					return { resultCount: 7, limitHit: false, error: undefined };
				},
			},
			undefined,
			workspace,
		);
		services.registerInstance(
			IClipboardService,
			new BrowserClipboardService({
				writeText: async value => {
					written.push(value);
				},
			} as Clipboard),
		);
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		await import('../../browser/searchActionsRemoveReplace.js');
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
		registerView(services, view);
		input(view.element, 'Search workspace').value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 7);
		const before = view.getSearchResultSnapshot();
		const modelOrder = view.searchResult.files.map(file => [file.id, ...file.matches.map(match => match.id)]);
		for (const file of view.searchResult.files) {
			view.getControl().collapse(file.id);
		}
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
		assert.deepEqual(
			view.searchResult.files.map(file => [file.id, ...file.matches.map(match => match.id)]),
			modelOrder,
		);
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
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
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
			},
		});
		services.registerInstance(
			IClipboardService,
			new BrowserClipboardService({
				writeText: async value => {
					written.push(value);
				},
			} as Clipboard),
		);
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
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
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
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
				options?.signal?.addEventListener(
					'abort',
					() => {
						aborted = true;
					},
					{ once: true },
				);
				options?.onProgress?.([matches[0]!]);
				addBatch = () => options?.onProgress?.([matches[1]!]);
				await new Promise<void>(resolve => {
					finish = resolve;
				});
				return { resultCount: 2, limitHit: false, error: undefined };
			},
		});
		services.registerInstance(
			IClipboardService,
			new BrowserClipboardService({
				writeText: async value => {
					if (rejectWrite) {
						throw denied;
					}
					written.push(value);
				},
			} as Clipboard),
		);
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		await import('../../browser/searchActionsRemoveReplace.js');
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
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
		assert.deepEqual(written.slice(1), ['/workspace/src/main.ts' + delimiter + '  4,7: const needle = true;', '/workspace/src/main.ts' + delimiter + '  9,5: use(needle);']);
		rejectWrite = true;
		const before = view.searchResult.files[0]!.matches.map(match => match.id);
		await assert.rejects(commands.executeCommand(SearchCommandIds.CopyAllCommandId), error => error === denied);
		assert.deepEqual(
			view.searchResult.files[0]!.matches.map(match => match.id),
			before,
		);
		assert.equal(written.length, 3);
		assert.equal(aborted, false);
		assert.equal(view.getControl().element.getAttribute('aria-busy'), 'true');
		finish!();
		await waitFor(() => view.getControl().element.getAttribute('aria-busy') === 'false');
		assert.equal(view.getSearchResultSnapshot()?.matchCount, 1);
	} finally {
		finish?.();
		browser.window.close();
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
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
				options?.onProgress?.([
					...matches,
					{
						dirId: 'workspace',
						path: 'src/nested/file2.ts',
						lineNumber: 10,
						preview: '中文😀 needle\r\nnext',
						ranges: [{ start: 5, end: 17 }],
					},
					{
						dirId: 'workspace',
						path: 'root.ts',
						lineNumber: 1,
						preview: 'root needle',
						ranges: [{ start: 5, end: 11 }],
					},
				]);
				return { resultCount: 4, limitHit: false, error: undefined };
			},
		});
		services.registerInstance(
			IClipboardService,
			new BrowserClipboardService({
				writeText: async value => {
					written.push(value);
				},
			} as Clipboard),
		);
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
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
		assert.deepEqual(
			tree.selection.map(element => element.id),
			selection,
		);
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
		assert.deepEqual(
			tree.selection.map(element => element.id),
			collapsedSelection,
		);
		assert.equal(tree.model.getNode(main.id)?.collapsed, true);
		view.searchResult.batchRemove([main.matches[0]!]);
		await view.queueRefreshTree();
		await commands.executeCommand('search.action.copyMatch', folder);
		assert.equal(written.at(-1), nestedBlock + delimiter + delimiter + '/workspace/src/main.ts' + delimiter + '  9,5: use(needle);');
		assert.equal(view.searchResult.count, 3);
	} finally {
		browser.window.close();
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
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
				options?.signal?.addEventListener(
					'abort',
					() => {
						aborted = true;
					},
					{ once: true },
				);
				options?.onProgress?.(matches);
				await new Promise<void>(resolve => {
					finish = resolve;
				});
				return { resultCount: 2, limitHit: false, error: undefined };
			},
		});
		services.registerInstance(
			IClipboardService,
			new BrowserClipboardService({
				writeText: async value => {
					if (rejectWrite) {
						throw denied;
					}
					written.push(value);
				},
			} as Clipboard),
		);
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		await import('../../browser/searchActionsRemoveReplace.js');
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
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
		assert.deepEqual(
			view.searchResult.files[0]!.matches.map(match => match.id),
			before,
		);
		assert.deepEqual(written, ['4,7: const needle = true;']);
		assert.equal(aborted, false);
		assert.equal(tree.element.getAttribute('aria-busy'), 'true');
		finish!();
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 1);
	} finally {
		finish?.();
		browser.window.close();
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
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
		const services = createServices(store, browser, {
			search: async (_query, options) => {
				options?.onProgress?.(matches);
				return { resultCount: 2, limitHit: false, error: undefined };
			},
		});
		services.registerInstance(
			IClipboardService,
			new BrowserClipboardService({
				writeText: async value => {
					written.push(value);
				},
			} as Clipboard),
		);
		const menus = services.get(IContextMenuService);
		menus.showContextMenu = delegate => {
			shown.push(delegate as IContextMenuDelegate);
		};
		menus.hideContextMenu = () => {
			hidden++;
			shown.at(-1)?.onHide?.(true);
		};
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
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
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
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
				await new Promise<void>(resolve => {
					finish = resolve;
				});
				return { resultCount: 3, limitHit: false, error: undefined };
			},
		});
		services.registerInstance(
			IClipboardService,
			new BrowserClipboardService({
				writeText: async value => {
					written.push(value);
				},
			} as Clipboard),
		);
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		await import('../../browser/searchActionsRemoveReplace.js');
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
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
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
	}
});

test('Copy menu callbacks cannot clear a replacement and keyboard menus ignore inputs and extra modifiers', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	const shown: IContextMenuDelegate[] = [];
	let hidden = 0;
	try {
		using store = new DisposableStore();
		const services = createServices(store, browser, {
			search: async (_query, options) => {
				options?.onProgress?.(matches);
				return { resultCount: 2, limitHit: false, error: undefined };
			},
		});
		const menus = services.get(IContextMenuService);
		menus.showContextMenu = delegate => {
			shown.push(delegate as IContextMenuDelegate);
		};
		menus.hideContextMenu = () => {
			hidden++;
		};
		const { SearchView } = await import('../../browser/searchView.js');
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
		registerView(services, view);
		input(view.element, 'Search workspace').value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 2);
		const tree = view.getControl();
		tree.setFocus(view.searchResult.files[0]!.matches[0]!.id);
		const embeddedInput = browser.window.document.createElement('input');
		tree.domNode.append(embeddedInput);
		for (const [target, options] of [
			[embeddedInput, { shiftKey: true }],
			[tree.element, { shiftKey: true, ctrlKey: true }],
			[tree.element, { shiftKey: true, altKey: true }],
			[tree.element, { shiftKey: true, metaKey: true }],
			[tree.element, { shiftKey: true, isComposing: true }],
		] as const) {
			const event = new browser.window.KeyboardEvent('keydown', {
				key: 'F10',
				bubbles: true,
				cancelable: true,
				...options,
			});
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
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
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
			},
		});
		services.registerInstance(
			IClipboardService,
			new BrowserClipboardService({
				writeText: async value => {
					written.push(value);
				},
			} as Clipboard),
		);
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
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
		assert.deepEqual(
			tree.selection.map(element => element.id),
			[other!.id, file!.id],
		);
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
		using formatter = services.get(ILabelService).registerFormatter({ scheme: 'file', formatting: { label: 'formatted:${path}', separator: '/' } });
		await commands.executeCommand(SearchCommandIds.CopyPathCommandId, file);
		assert.equal(written.at(-1), 'formatted:/workspace/src/main.ts');
	} finally {
		browser.window.close();
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
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
				options?.signal?.addEventListener(
					'abort',
					() => {
						aborted = true;
					},
					{ once: true },
				);
				options?.onProgress?.(matches);
				await new Promise<void>(resolve => {
					finish = resolve;
				});
				return { resultCount: 2, limitHit: false, error: undefined };
			},
		});
		services.registerInstance(
			IClipboardService,
			new BrowserClipboardService({
				writeText: async value => {
					if (rejected) {
						throw denied;
					}
					written.push(value);
				},
			} as Clipboard),
		);
		const { SearchView } = await import('../../browser/searchView.js');
		await import('../../browser/searchActionsCopy.js');
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
		registerView(services, view);
		input(view.element, 'Search workspace').value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => finish !== undefined);
		const file = view.searchResult.files[0]!;
		const before = file.matches.map(match => match.id);
		await services.get(ICommandService).executeCommand(SearchCommandIds.CopyPathCommandId, file);
		rejected = true;
		await assert.rejects(services.get(ICommandService).executeCommand(SearchCommandIds.CopyPathCommandId, file), error => error === denied);
		assert.deepEqual(
			{
				written,
				matches: file.matches.map(match => match.id),
				aborted,
				busy: view.getControl().element.getAttribute('aria-busy'),
			},
			{ written: ['/workspace/src/main.ts'], matches: before, aborted: false, busy: 'true' },
		);
		finish!();
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 2);
	} finally {
		finish?.();
		browser.window.close();
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
	}
});

test('Expand All runs for empty, partially collapsed and multi-root results without changing selection or outside focus', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const globals = installDomGlobals(browser);
	let searched = 0;
	try {
		using store = new DisposableStore();
		const workspace = store.add(
			new TestWorkspaceService({
				id: 'multiple',
				folders: [
					{ id: 'workspace', name: 'Workspace', index: 0, uri: URI.file('/workspace') },
					{ id: 'other', name: 'Other', index: 1, uri: URI.file('/other') },
				],
			}),
		);
		const delivered = [...matches, { ...matches[0]!, dirId: 'other', path: 'deep/nested/other.ts' }];
		const services = createServices(
			store,
			browser,
			{
				search: async (_query, options) => {
					searched++;
					options?.onProgress?.(delivered);
					return { resultCount: delivered.length, limitHit: false, error: undefined };
				},
			},
			undefined,
			workspace,
		);
		const { SearchView } = await import('../../browser/searchView.js');
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
		registerView(services, view);
		const command = () => services.get(ICommandService).executeCommand('search.action.expandSearchResults');
		await command();
		assert.equal(view.searchResult.count, 0);
		const queryInput = input(view.element, 'Search workspace');
		queryInput.value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 3);
		let actions: readonly IAction[] = [];
		services.get(IContextMenuService).showContextMenu = delegate => {
			actions = delegate.getActions?.() ?? [];
		};
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
		assert.deepEqual(
			{
				visibleMatches: tree.model.visibleNodes.filter(node => node.element.kind === 'match').length,
				selection: tree.selection.map(element => element.id),
				focus: tree.focus?.id,
				snapshot: view.getSearchResultSnapshot(),
				searched,
				inputFocused: browser.window.document.activeElement === queryInput,
			},
			{
				visibleMatches: 3,
				selection: [selected.id],
				focus: selected.id,
				snapshot: before,
				searched: 2,
				inputFocused: true,
			},
		);
		for (const node of tree.model.rootNodes) {
			tree.collapseRecursive(node.id);
		}
		view.setVisible(false);
		await command();
		assert.equal(tree.model.visibleNodes.filter(node => node.element.kind === 'match').length, 0);
		view.setVisible(true);
		await command();
		assert.equal(tree.model.visibleNodes.filter(node => node.element.kind === 'match').length, 3);
	} finally {
		browser.window.close();
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
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
				options?.signal?.addEventListener(
					'abort',
					() => {
						aborted = true;
					},
					{ once: true },
				);
				options?.onProgress?.(matches);
				await new Promise<void>(resolve => {
					finish = () => {
						options?.onProgress?.([{ ...matches[0]!, path: 'late.ts' }]);
						resolve();
					};
				});
				return { resultCount: 3, limitHit: false, error: undefined };
			},
		});
		const { SearchView } = await import('../../browser/searchView.js');
		using view = services.createInstance(SearchView, browser.window.document.body, {
			id: SEARCH_VIEW_ID,
			title: 'Search',
		});
		registerView(services, view);
		const menus = services.createInstance(MenuService);
		const palette = () =>
			menus
				.getMenuActions(MenuId.CommandPalette)
				.flatMap(([, actions]) => actions)
				.find(action => action.id === 'search.action.expandSearchResults');
		assert.equal(palette(), undefined);
		input(view.element, 'Search workspace').value = 'needle';
		view.element.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { cancelable: true }));
		await waitFor(() => finish !== undefined);
		assert.equal(palette(), undefined);
		const tree = view.getControl();
		tree.collapseRecursive(tree.model.rootNodes[0]!.id);
		assert.deepEqual(
			{
				label: palette()?.label,
				enabled: palette()?.enabled,
				busy: tree.element.getAttribute('aria-busy'),
				aborted,
			},
			{
				label: 'Search: Expand All',
				enabled: true,
				busy: 'true',
				aborted: false,
			},
		);
		await palette()!.run();
		assert.equal(palette(), undefined);
		finish!();
		await waitFor(() => view.getSearchResultSnapshot()?.matchCount === 3);
		assert.deepEqual({ expandedMatches: tree.model.visibleNodes.filter(node => node.element.kind === 'match').length, aborted }, { expandedMatches: 3, aborted: false });
		for (const node of tree.model.rootNodes) {
			tree.collapseRecursive(node.id);
		}
		assert.equal(palette()?.enabled, true);
		view.setVisible(false);
		assert.equal(palette()?.enabled, true);
		await palette()!.run();
		assert.deepEqual(
			{
				visibleMatches: tree.model.visibleNodes.filter(node => node.element.kind === 'match').length,
				visible: view.isVisible(),
			},
			{ visibleMatches: 0, visible: false },
		);
		view.setVisible(true);
		assert.equal(palette()?.enabled, true);
		view.dispose();
		await services.get(ICommandService).executeCommand('search.action.expandSearchResults');
		assert.deepEqual(
			{
				palette: palette(),
				hasResults: services.get(IContextKeyService).getValue('hasSearchResult'),
				hasCollapsible: services.get(IContextKeyService).getValue('viewHasSomeCollapsibleResult'),
			},
			{
				palette: undefined,
				hasResults: false,
				hasCollapsible: false,
			},
		);
	} finally {
		finish?.();
		browser.window.close();
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
	}
});

function createTestLabelService(workspace: ConstructorParameters<typeof LabelService>[0], os: OperatingSystem = operatingSystem): LabelService {
	const api = createDisconnectedRendererApi();
	const host = { ...api, hasAppServer: true, appServer: { ...api.appServer, operatingSystem: os } };
	return new LabelService(workspace, new BrowserPathService(host, workspace), host);
}

suite('search browser component', () => {
	const browserTests = useBrowserTests();
	// Default fixtures model a POSIX host; the Windows suite below supplies its own browser identity.
	if (process.platform === 'win32')
		browserTests.use({
			userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36',
		});
	for (const locale of ['en', 'zh-CN']) {
		test(`Sidebar auto hide follows active containers, moves and settings without losing focus (${locale})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/search.html?locale=${locale}`);
			await page.waitForFunction(() => !!window.ashSearchIntegration);
			const setting = await page.evaluate(() => window.ashSearchIntegration.autoHideSetting());
			expect(setting).toEqual({
				title: locale === 'en' ? 'Auto Hide Activity Bar' : '自动隐藏活动栏',
				description:
					locale === 'en'
						? 'Hide each side bar view switcher when it is at the top or bottom and at most one container at that location has active views.'
						: '侧边栏的视图切换栏位于顶部或底部，且该位置最多只有一个容器具有可用视图时，隐藏该切换栏。',
				value: false,
			});
			const sidebar = page.locator('[data-part="sidebar"]');
			const content = sidebar.locator(':scope > .ash-composite-content');
			const switcher = sidebar.locator('.ash-composite-bar');
			const query = page.getByRole('textbox', {
				name: locale === 'en' ? 'Search workspace' : '搜索工作区',
				exact: true,
			});
			for (const position of ['top', 'bottom']) {
				await page.evaluate(position => window.ashSearchIntegration.setActivityBarLocation(position as ActivityBarPosition), position);
				await expect(switcher).toBeVisible();
				await page.evaluate(() => window.ashSearchIntegration.setAutoHide(true));
				await expect(switcher).toBeVisible();
				const before = await content.evaluate(element => element.clientHeight);
				await switcher.getByRole('tab').first().focus();
				await page.evaluate(() => window.ashSearchIntegration.setExplorerActive(false));
				await expect(switcher).toBeHidden();
				await expect(query).toBeFocused();
				expect(await content.evaluate(element => element.clientHeight)).toBe(before + 36);
				for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
					await page.evaluate(theme => window.ashSearchIntegration.setTheme(theme), theme);
					await expect(switcher).toBeHidden();
					await expect(query).toBeVisible();
				}
				await sidebar.screenshot({ path: testInfo.outputPath(`auto-hidden-${position}-${locale}.png`) });
				await page.evaluate(() => window.ashSearchIntegration.setAutoHide(false));
				await expect(switcher).toBeVisible();
				expect(await content.evaluate(element => element.clientHeight)).toBe(before);
				await page.evaluate(() => window.ashSearchIntegration.setAutoHide(true));
				await expect(switcher).toBeHidden();
				await page.evaluate(() => window.ashSearchIntegration.setExplorerActive(true));
				await expect(switcher).toBeVisible();
				await page.evaluate(() => window.ashSearchIntegration.moveExplorer('auxiliarybar' as ViewContainerLocation));
				await expect(switcher).toBeHidden();
				await page.evaluate(() => window.ashSearchIntegration.moveExplorer('sidebar' as ViewContainerLocation));
				await expect(switcher).toBeVisible();
			}
			await page.evaluate(() => window.ashSearchIntegration.setExplorerActive(false));
			await page.evaluate(() => window.ashSearchIntegration.setActivityBarLocation('default' as ActivityBarPosition));
			await expect(switcher).not.toHaveAttribute('hidden');
			expect(errors).toEqual([]);
		});
	}

	test('Sidebar boundary follows the production Grid across position changes and releases on disposal', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/search.html');
		const sidebar = page.locator('[data-part="sidebar"]');
		const boundary = page.locator('.ash-primary-sidebar-sash');
		for (const position of ['left', 'right', 'left'] as const) {
			const previous = await boundary.elementHandle();
			await page.evaluate(position => window.ashSearchIntegration.setSidebarPosition(position), position);
			await expect(boundary).toHaveCount(1);
			await expect(boundary).toHaveAttribute('aria-orientation', 'vertical');
			const partBounds = (await sidebar.locator('..').boundingBox())!;
			const sashBounds = (await boundary.boundingBox())!;
			expect(sashBounds.x + sashBounds.width / 2).toBeCloseTo(position === 'left' ? partBounds.x + partBounds.width : partBounds.x, 0);
			if (previous) {
				const stillCurrent = await previous.evaluate(element => element.isConnected);
				if (!stillCurrent) expect(await previous.evaluate(element => element.classList.contains('ash-primary-sidebar-sash'))).toBe(false);
				await previous.dispose();
			}
		}
		const sash = (await boundary.elementHandle())!;
		await boundary.focus();
		await expect(boundary).toBeFocused();
		const before = (await sidebar.boundingBox())!.width;
		await boundary.press('ArrowRight');
		await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(before);
		await page.evaluate(() => window.ashSearchIntegration.disposeSidebar());
		await expect(boundary).toHaveCount(0);
		expect(await sash.evaluate(element => element.isConnected)).toBe(true);
		await sash.dispose();
		expect(errors).toEqual([]);
	});

	test('Search ActionBar centers icon-only actions and keeps text actions visible', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const replaceAll = page.getByRole('button', { name: 'Replace All', exact: true });
		const preserveCase = page.getByRole('button', { name: 'Preserve Case', exact: true });
		for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
			await page.evaluate(theme => window.ashSearchIntegration.setTheme(theme), theme);
			for (const width of [180, 400]) {
				await page.evaluate(width => window.ashSearchIntegration.setWidth(width), width);
				await expect
					.poll(() =>
						replaceAll.evaluate(element => {
							const button = element.getBoundingClientRect();
							const svg = element.querySelector('.ash-icon');
							if (!svg) return Number.POSITIVE_INFINITY;
							const icon = svg.getBoundingClientRect();
							return Math.max(Math.abs(icon.x + icon.width / 2 - button.x - button.width / 2), Math.abs(icon.y + icon.height / 2 - button.y - button.height / 2));
						}),
					)
					.toBeLessThan(0.01);
				await expect(preserveCase.locator('.ash-action-label-text')).toBeVisible();
				await expect(preserveCase).toHaveText('AB');
			}
		}
		await preserveCase.click();
		await expect(preserveCase).toHaveAttribute('aria-pressed', 'true');
	});

	test('Search reserves its result viewport when expanded inputs and filters compete with another pane', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('needle');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('1 results');
		await page.evaluate(() => window.ashSearchIntegration.setSecondView(true));
		await page.getByRole('button', { name: 'Toggle Search Details', exact: true }).click();
		await query.fill('long query '.repeat(100));
		const pane = page.locator('[data-view-id="ash.searchView"]');
		const split = pane.locator('xpath=../..');
		const sash = split.locator(':scope > .ash-sash').first();
		const resize = async (): Promise<void> => {
			const handle = (await sash.boundingBox())!;
			const bounds = (await split.boundingBox())!;
			await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
			await page.mouse.down();
			await page.mouse.move(handle.x + handle.width / 2, bounds.y + 1);
			await page.mouse.up();
		};
		await resize();
		const viewport = pane.locator('.ash-search-results .ash-scrollbar-viewport');
		await expect.poll(() => viewport.evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(120);
		await expect(pane.locator('.ash-search-match')).toBeInViewport();
		const header = pane.locator('.ash-pane-view-header-button');
		await header.press('ArrowLeft');
		await header.press('ArrowRight');
		await expect.poll(() => viewport.evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(120);
		await expect(query).toHaveValue('long query '.repeat(100));
		await query.fill('needle');
		await resize();
		await expect.poll(() => viewport.evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(120);
		expect(errors).toEqual([]);
	});

	test('Search uses current model occurrences and suppresses stale disk hits without saving', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		await page.evaluate(() => window.ashSearchIntegration.setFileText('中文😀 needle needle'));
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('needle');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('2 results');
		const snapshot = await page.evaluate(() => window.ashSearchIntegration.snapshot());
		expect(snapshot?.content).toContain('1:6-1:12:');
		expect(snapshot?.content).toContain('1:13-1:19:');
		expect(await page.evaluate(() => window.ashSearchIntegration.diskText())).toBe('const needle = true;');
		await page.evaluate(() => window.ashSearchIntegration.setFileText('edited without a match'));
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('No results found.');
		await expect(page.locator('.ash-search-match')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashSearchIntegration.diskText())).toBe('const needle = true;');
	});

	test('Search explains unsaved model search in Chinese accessibility help', async function () {
		const { page } = browserTests;

		await page.goto('/search.html?locale=zh-CN');
		expect(await page.evaluate(() => window.ashSearchIntegration.help())).toContain(
			'搜索会使用已打开文件和无标题文档的当前编辑器文本，包括工作区外的资源。搜索不会保存文件。替换无标题文档的结果后，草稿仍保持未保存状态。',
		);
	});

	test('Search line numbers default off and change live without altering matches or submitting another query', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('layout');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('3 results');
		const rows = page.locator('.ash-search-match');
		await expect(rows.locator('.ash-search-line-number')).toHaveCount(0);
		const snapshot = await page.evaluate(() => window.ashSearchIntegration.snapshot());
		const measure = () =>
			rows.evaluateAll(elements =>
				elements.map(element => ({
					preview: element.querySelector('.ash-search-preview')!.getBoundingClientRect().width,
					origin: element.querySelector('.ash-search-preview')!.getBoundingClientRect().left - element.getBoundingClientRect().left,
				})),
			);
		const unnumbered = await measure();
		await page.evaluate(() => window.ashSearchIntegration.setLineNumbers(true));
		expect((await rows.locator('.ash-search-line-number').allTextContents()).sort()).toEqual(['1000:', '3456:', '43:']);
		const numbered = await measure();
		for (let index = 0; index < numbered.length; index++) {
			expect(numbered[index].origin).toBeGreaterThan(unnumbered[index].origin);
			expect(numbered[index].preview).toBeLessThan(unnumbered[index].preview);
		}
		await page.evaluate(() => window.ashSearchIntegration.setLineNumbers(false));
		await expect(rows.locator('.ash-search-line-number')).toHaveCount(0);
		expect(await measure()).toEqual(unnumbered);
		expect(await page.evaluate(() => window.ashSearchIntegration.snapshot())).toEqual(snapshot);
		expect((await page.evaluate(() => window.ashSearchIntegration.queries)).length).toBe(1);
		await query.fill('windows');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('2 results');
		await expect(rows.locator('.ash-search-line-number')).toHaveText('+1');
		const multiline = rows.filter({ hasText: 'next' }).locator('.ash-search-preview');
		const hintWidth = (await multiline.boundingBox())!.width;
		await page.evaluate(() => window.ashSearchIntegration.setLineNumbers(true));
		await expect(rows.locator('.ash-search-line-number')).toHaveText(['2:', '9:+1']);
		expect((await multiline.boundingBox())!.width).toBeLessThan(hintWidth);
	});

	test('Search registration merges View and container actions and preserves state and focus through title host switching', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		const toolbar = page.getByRole('toolbar', { name: 'Search result actions', exact: true });
		const title = page.locator('.ash-sidebar-title-label');
		const paneHeader = page.locator('.ash-search').locator('..').locator('.ash-pane-view-header');
		await expect(title).toHaveText('Search');
		await expect(paneHeader).toBeHidden();
		await expect(page.locator('.ash-pane-composite-title-view-actions').getByRole('toolbar', { name: 'Search result actions', exact: true })).toHaveCount(1);
		await query.fill('needle');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('1 results');
		const before = await page.evaluate(() => window.ashSearchIntegration.snapshot());
		const originalHost = await page.locator('.ash-pane-composite-title-view-actions .ash-pane-view-header-actions').elementHandle();
		expect(originalHost).not.toBeNull();
		const refresh = toolbar.getByRole('button', { name: 'Refresh search', exact: true });
		await refresh.focus();
		await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.focusedView())).toBe('ash.searchView');
		await page.evaluate(() => window.ashSearchIntegration.setSecondView(true));
		await expect(paneHeader).toBeVisible();
		await expect(paneHeader.getByRole('toolbar', { name: 'Search result actions', exact: true })).toHaveCount(1);
		await expect(refresh).toBeFocused();
		expect(await originalHost!.evaluate(node => node === document.querySelector('.ash-search')!.parentElement!.querySelector('.ash-pane-view-header-actions'))).toBe(true);
		await page.evaluate(() => window.ashSearchIntegration.setSecondView(false));
		await expect(paneHeader).toBeHidden();
		await expect(refresh).toBeFocused();
		await page.evaluate(() => window.ashSearchIntegration.switchSidebar('explorer'));
		await expect(title).toHaveText('Explorer');
		await expect(toolbar).toBeHidden();
		await page.evaluate(() => window.ashSearchIntegration.switchSidebar('search'));
		await expect(title).toHaveText('Search');
		await expect(toolbar).toBeVisible();
		await expect(query).toHaveValue('needle');
		expect(await originalHost!.evaluate(node => node === document.querySelector('.ash-pane-composite-title-view-actions .ash-pane-view-header-actions'))).toBe(true);
		expect(await page.evaluate(() => window.ashSearchIntegration.snapshot())).toEqual(before);
		await page.evaluate(() => window.ashSearchIntegration.setSecondView(true));
		await paneHeader.getByRole('button', { name: 'Search', exact: true }).click();
		await expect(query).toBeHidden();
		await page.evaluate(() => window.ashSearchIntegration.setSecondView(false));
		await expect(query).toBeVisible();
		await page.evaluate(() => window.ashSearchIntegration.setSecondView(true));
		await expect(query).toBeHidden();
		await paneHeader.getByRole('button', { name: 'Search', exact: true }).click();
		await expect(query).toBeVisible();
		await originalHost!.dispose();
	});

	test('Search inputs wrap within shared height limits, preserve caret and use managed scrolling', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		const replace = page.getByRole('textbox', { name: 'Replace', exact: true });
		await expect(replace).toBeVisible();
		await query.fill('one');
		const single = await query.boundingBox();
		expect(single!.height).toBe(24);
		const long = '中文😀 long search text '.repeat(40);
		await query.fill(long);
		await expect.poll(async () => (await query.boundingBox())!.height).toBe(134);
		await query.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
		expect(await query.evaluate((input: HTMLTextAreaElement) => input.selectionStart)).toBe(0);
		await query.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
		await expect.poll(() => query.evaluate((input: HTMLTextAreaElement) => input.scrollTop)).toBeGreaterThan(0);
		const scrolling = await query.evaluate((input: HTMLTextAreaElement) => ({
			value: input.value,
			caret: input.selectionEnd,
			scroll: input.scrollTop,
			overflowing: input.scrollHeight > input.clientHeight,
			browserBar: getComputedStyle(input).scrollbarWidth,
			managed: input.parentElement!.querySelectorAll('.ash-scrollbar-track-vertical').length,
		}));
		expect(scrolling).toMatchObject({
			value: long,
			caret: long.length,
			overflowing: true,
			browserBar: 'none',
			managed: 1,
		});
		expect(scrolling.scroll).toBeGreaterThan(0);
		await query.fill('first\nsecond');
		await query.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
		expect(await query.evaluate((input: HTMLTextAreaElement) => input.selectionStart)).toBe(0);
		await query.press('ArrowDown');
		await expect(query).toHaveValue('first\nsecond');
		expect(await query.evaluate((input: HTMLTextAreaElement) => input.selectionStart)).toBeGreaterThan(5);
		await replace.fill('replacement\nsecond');
		await replace.focus();
		const toggle = page.getByRole('button', { name: 'Toggle Replace', exact: true });
		await toggle.evaluate((button: HTMLButtonElement) => button.click());
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');
		await expect(query).toBeFocused();
		await toggle.click();
		await expect(replace).toHaveValue('replacement\nsecond');
		await query.fill('one');
		await expect.poll(async () => (await query.boundingBox())!.height).toBe(24);
	});

	test('Expand All replaces the collapsed toolbar slot, preserves keyboard focus and expands both roots', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		const collapse = page.getByRole('button', { name: 'Collapse all results', exact: true });
		const expand = page.getByRole('button', { name: 'Expand All', exact: true });
		await expect(collapse).toBeDisabled();
		await expect(expand).toHaveCount(0);
		await query.fill('中文');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('3 results');
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		await page.getByRole('toolbar', { name: 'Search result actions', exact: true }).getByRole('button', { name: 'More Actions', exact: true }).click();
		await page.evaluate(() => window.ashSearchIntegration.selectTreeView());
		const before = await page.evaluate(() => window.ashSearchIntegration.snapshot());
		await collapse.focus();
		await collapse.press('Enter');
		await expect(expand).toBeFocused();
		await expect(collapse).toHaveCount(0);
		await expect(tree.locator('.ash-search-match')).toHaveCount(0);
		await expand.press('Enter');
		await expect(collapse).toBeFocused();
		await expect(tree.locator('.ash-search-match')).toHaveCount(3);
		await expect(tree.locator('[aria-expanded="false"]')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashSearchIntegration.snapshot())).toEqual(before);
		expect(
			await page.evaluate(() => ({
				queries: window.ashSearchIntegration.queries.length,
				opened: window.ashSearchIntegration.opened.length,
			})),
		).toEqual({ queries: 1, opened: 0 });
		await tree.getByRole('treeitem', { name: 'other', exact: true }).locator('.ash-tree-twistie').click();
		await expect(tree).toBeFocused();
		await expect(collapse).toBeVisible();
		await expect(expand).toHaveCount(0);
		await query.focus();
		await collapse.evaluate((button: HTMLButtonElement) => button.click());
		await expect(query).toBeFocused();
		await expand.evaluate((button: HTMLButtonElement) => button.click());
		await expect(query).toBeFocused();
		await expect(tree.locator('.ash-search-match')).toHaveCount(3);
	});

	test('Expand All updates after a late batch and its Chinese action and help stay discoverable', async function () {
		const { page } = browserTests;

		await page.goto('/search.html?locale=zh-CN');
		const query = page.getByRole('textbox', { name: '搜索工作区', exact: true });
		await query.fill('slow');
		await query.press('Enter');
		const tree = page.getByRole('tree');
		await expect(tree).toHaveAttribute('aria-busy', 'true');
		await page.getByRole('button', { name: '收起所有结果', exact: true }).click();
		await expect(page.getByRole('button', { name: '全部展开', exact: true })).toBeVisible();
		const oldExpand = await page.getByRole('button', { name: '全部展开', exact: true }).elementHandle();
		expect(oldExpand).not.toBeNull();
		await page.evaluate(() => window.ashSearchIntegration.finishLateSearch());
		await expect(tree).toHaveAttribute('aria-busy', 'false');
		await expect(page.getByRole('button', { name: '收起所有结果', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: '全部展开', exact: true })).toHaveCount(0);
		await oldExpand!.evaluate((button: HTMLButtonElement) => button.click());
		await expect(tree.locator('.ash-search-match')).toHaveCount(1);
		await oldExpand!.dispose();
		await page.getByRole('button', { name: '收起所有结果', exact: true }).click();
		await page.getByRole('button', { name: '全部展开', exact: true }).click();
		await expect(tree.locator('.ash-search-match')).toHaveCount(2);
		expect(await page.evaluate(() => window.ashSearchIntegration.help())).toContain('全部展开');
		expect(await page.evaluate(() => window.ashSearchIntegration.cancelled())).toBe(0);
		await page.evaluate(() => window.ashSearchIntegration.closeWorkspace());
		await expect(page.getByRole('button', { name: '收起所有结果', exact: true })).toBeDisabled();
		await expect(page.getByRole('button', { name: '全部展开', exact: true })).toHaveCount(0);
	});

	test('Copy Path shortcut copies the first selected file and ignores input focus, matches and extra modifiers', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('中文');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('3 results');
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		const first = tree.getByRole('treeitem').filter({
			has: page.locator('.ash-search-file-path').filter({ has: page.locator('.ash-icon-label-description', { hasText: 'workspace • src' }) }),
		});
		const other = tree.getByRole('treeitem').filter({
			has: page.locator('.ash-search-file-path').filter({ has: page.locator('.ash-icon-label-description', { hasText: 'other • src' }) }),
		});
		await first.click();
		await other.click({ modifiers: ['ControlOrMeta'] });
		const shortcut = 'ControlOrMeta+Alt+c';
		await tree.press(shortcut);
		await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['/workspace/src/main.ts']);
		await tree.press('ControlOrMeta+Shift+Alt+c');
		await query.focus();
		await query.press(shortcut);
		await tree.getByRole('treeitem', { name: 'Line 1, column 6: 中文😀 needle needle', exact: true }).click();
		await tree.press(shortcut);
		expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['/workspace/src/main.ts']);
		await expect(page.getByRole('status')).toHaveText('3 results');
	});

	test('Copy Path menus copy explicit file and folder URIs and release callbacks on refresh and hiding', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('中文');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('3 results');
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		const first = tree.getByRole('treeitem').filter({
			has: page.locator('.ash-search-file-path').filter({ has: page.locator('.ash-icon-label-description', { hasText: 'workspace • src' }) }),
		});
		const other = tree.getByRole('treeitem').filter({
			has: page.locator('.ash-search-file-path').filter({ has: page.locator('.ash-icon-label-description', { hasText: 'other • src' }) }),
		});
		await first.click();
		await other.click({ button: 'right' });
		await expect(page.getByRole('menuitem', { name: 'Copy Path', exact: true }).locator('.ash-menu-keybinding')).toBeVisible();
		await page.getByRole('menuitem', { name: 'Copy Path', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['/other/src/main.ts']);
		await page.getByRole('toolbar', { name: 'Search result actions', exact: true }).getByRole('button', { name: 'More Actions', exact: true }).click();
		await page.evaluate(() => window.ashSearchIntegration.selectTreeView());
		const folder = tree.getByRole('treeitem', { name: 'other', exact: true });
		await folder.click();
		await tree.press('ControlOrMeta+Alt+c');
		expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['/other/src/main.ts']);
		await tree.press('Shift+F10');
		await page.getByRole('menuitem', { name: 'Copy Path', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['/other/src/main.ts', '/other']);
		const removedContent = await folder.locator('.ash-search-result').elementHandle();
		expect(removedContent).not.toBeNull();
		await tree.press('Shift+F10');
		await expect(page.getByRole('menuitem', { name: 'Copy Path', exact: true })).toBeVisible();
		await query.focus();
		await page.getByRole('button', { name: 'Refresh search', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
		await expect(page.getByRole('menu')).toHaveCount(0);
		await expect(query).toBeFocused();
		await removedContent!.dispatchEvent('contextmenu', { bubbles: true, cancelable: true });
		await expect(page.getByRole('menu')).toHaveCount(0);
		await removedContent!.dispose();
		await folder.click();
		await tree.press('Shift+F10');
		await expect(page.getByRole('menuitem', { name: 'Copy Path', exact: true })).toBeVisible();
		await page.evaluate(() => window.ashSearchIntegration.setSearchVisible(false));
		await expect(page.getByRole('menu')).toHaveCount(0);
		await expect(tree).toBeHidden();
		expect(await page.evaluate(() => window.ashSearchIntegration.snapshot()?.matchCount)).toBe(3);
	});

	test('Copy Path menu excludes matching lines and translates its path-only help', async function () {
		const { page } = browserTests;

		await page.goto('/search.html?locale=zh-CN');
		const query = page.getByRole('textbox', { name: '搜索工作区', exact: true });
		await query.fill('needle');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('1 个结果');
		await page.locator('.ash-search-match').click({ button: 'right' });
		await expect(page.getByRole('menuitem', { name: '复制路径', exact: true })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await page.locator('.ash-search-file-path').click({ button: 'right' });
		await page.getByRole('menuitem', { name: '复制路径', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['/workspace/src/main.ts']);
		expect(await page.evaluate(() => window.ashSearchIntegration.help())).toContain('仅在选择首项是文件时复制其路径');
	});

	test('Copy shortcut uses the first selection and a context menu copies its explicit row', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('中文');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('3 results');
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		const first = tree.getByRole('treeitem', { name: 'Line 1, column 6: 中文😀 needle needle', exact: true });
		const other = tree.getByRole('treeitem', { name: 'Line 8, column 7: const needle = true;', exact: true });
		await first.click();
		await other.click({ modifiers: ['ControlOrMeta'] });
		await tree.press('ControlOrMeta+c');
		await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['1,6: 中文😀 needle needle']);
		await other.click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Copy', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['1,6: 中文😀 needle needle', '8,7: const needle = true;']);
		await expect(page.getByRole('status')).toHaveText('3 results');
	});

	test('Copy does not intercept query text copying and keyboard menus close on refresh', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('needle');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('1 results');
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		await tree.getByRole('treeitem', { name: 'Line 1, column 7: const needle = true;', exact: true }).click();
		await query.focus();
		await query.press('ControlOrMeta+a');
		await query.press('ControlOrMeta+c');
		expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual([]);
		await tree.focus();
		await tree.press('ControlOrMeta+c');
		await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['1,7: const needle = true;']);
		await tree.press('Shift+F10');
		await expect(page.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(tree).toBeFocused();
		await tree.press('Shift+F10');
		await page.getByRole('button', { name: 'Refresh search', exact: true }).click();
		await expect(page.getByRole('menu')).toHaveCount(0);
		await expect(page.getByRole('status')).toHaveText('1 results');
	});

	test('Copy result menu and accessibility guidance use the Chinese catalog', async function () {
		const { page } = browserTests;

		await page.goto('/search.html?locale=zh-CN');
		const query = page.getByRole('textbox', { name: '搜索工作区', exact: true });
		await query.fill('needle');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('1 个结果');
		await page.locator('.ash-search-match').click({ button: 'right' });
		await page.getByRole('menuitem', { name: '复制', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['1,7: const needle = true;']);
		expect(await page.evaluate(() => window.ashSearchIntegration.help())).toContain('不会合并多选');
	});

	test('Copy menu closing preserves focus already moved to another input', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('needle');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('1 results');
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		await tree.getByRole('treeitem', { name: 'Line 1, column 7: const needle = true;', exact: true }).click();
		await tree.press('Shift+F10');
		await expect(page.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible();
		await query.focus();
		await page.evaluate(() => window.ashSearchIntegration.closeResultMenu());
		await expect(query).toBeFocused();
	});

	test('Copy menu replacement does not overwrite the next menu focus origin', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('needle');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('1 results');
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		await tree.getByRole('treeitem', { name: 'Line 1, column 7: const needle = true;', exact: true }).click();
		await tree.press('Shift+F10');
		await query.focus();
		await page.evaluate(() => window.ashSearchIntegration.replaceResultMenu());
		await expect(page.getByRole('menuitem', { name: 'Other menu action', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(query).toBeFocused();
	});

	test('Copy menu release on hiding Search preserves editor focus and refresh focuses the query', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		await page.evaluate(() => {
			const editor = document.createElement('div');
			editor.contentEditable = 'true';
			editor.setAttribute('role', 'textbox');
			editor.setAttribute('aria-label', 'Outside editor');
			document.body.append(editor);
		});
		const editor = page.getByRole('textbox', { name: 'Outside editor', exact: true });
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('needle');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('1 results');
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		const result = tree.getByRole('treeitem', { name: 'Line 1, column 7: const needle = true;', exact: true });
		await result.click();
		await tree.press('Shift+F10');
		await expect(page.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible();
		await editor.focus();
		await page.evaluate(() => window.ashSearchIntegration.setSearchVisible(false));
		await expect(page.getByRole('menu')).toHaveCount(0);
		await expect(tree).toBeHidden();
		await expect(editor).toBeFocused();
		await page.evaluate(() => window.ashSearchIntegration.setSearchVisible(true));
		await result.click();
		await tree.press('Shift+F10');
		await expect(page.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible();
		await editor.focus();
		await page.getByRole('button', { name: 'Refresh search', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
		await expect(page.getByRole('menu')).toHaveCount(0);
		await expect(page.getByRole('status')).toHaveText('1 results');
		await expect(query).toBeFocused();
	});

	test('Dismiss updates retained results and focus while refresh restores the searched files', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('中文');
		await query.press('Enter');
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		await expect(page.getByRole('status')).toHaveText('3 results');
		await tree.locator('.ash-search-match').first().click();
		await page.evaluate(() => window.ashSearchIntegration.dismiss());
		await expect(page.getByRole('status')).toHaveText('2 results');
		await expect(tree).toBeFocused();
		await expect(tree.locator('.ash-search-match')).toHaveCount(2);
		const activeId = await tree.getAttribute('aria-activedescendant');
		await expect(page.locator(`[id="${activeId}"]`)).toHaveAccessibleName('Line 1, column 13: 中文😀 needle needle');
		expect(await page.evaluate(() => window.ashSearchIntegration.snapshot()?.matchCount)).toBe(2);
		await tree
			.getByRole('treeitem')
			.filter({
				has: page.locator('.ash-search-file-path').filter({ has: page.locator('.ash-icon-label-description', { hasText: 'workspace • src' }) }),
			})
			.click();
		await page.evaluate(() => window.ashSearchIntegration.dismiss());
		await expect(page.locator('.ash-search-file-path .ash-icon-label-text')).toHaveText(['main.ts']);
		await page.getByRole('button', { name: 'Refresh search', exact: true }).click();
		await expect(page.getByRole('status')).toHaveText('3 results');
	});

	test('Dismiss expands the next nested result branch and the last same-kind branch on fallback', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('focus');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('5 results');
		await page.getByRole('button', { name: 'More Actions', exact: true }).click();
		await page.evaluate(() => window.ashSearchIntegration.selectTreeView());
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		const folder = (name: string) => tree.getByRole('treeitem', { name, exact: true });
		const file = tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path').getByText('b.ts', { exact: true }) });
		await folder('b/nested').locator('.ash-tree-twistie').click();
		await folder('c').locator('.ash-tree-twistie').click();
		await tree.getByRole('treeitem', { name: 'Line 2, column 7: const needle = true;', exact: true }).click();
		await page.evaluate(() => window.ashSearchIntegration.dismiss());
		await expect(page.getByRole('status')).toHaveText('4 results');
		await expect(folder('b/nested')).toHaveAttribute('aria-expanded', 'true');
		await expect(file).toHaveAttribute('aria-expanded', 'true');
		await expect(folder('c')).toHaveAttribute('aria-expanded', 'false');
		const next = tree.getByRole('treeitem', { name: 'Line 8, column 7: const needle = true;', exact: true });
		await expect(next).toHaveAttribute('aria-selected', 'true');
		await expect(tree).toHaveAttribute('aria-activedescendant', (await next.getAttribute('id')) as string);
		await expect(tree).toBeFocused();

		await folder('b/nested').locator('.ash-tree-twistie').click();
		await folder('c').locator('.ash-tree-twistie').click();
		await tree.getByRole('treeitem', { name: 'Line 10, column 7: const needle = true;', exact: true }).click();
		await page.evaluate(() => window.ashSearchIntegration.dismiss());
		await expect(page.getByRole('status')).toHaveText('3 results');
		await expect(folder('b/nested')).toHaveAttribute('aria-expanded', 'true');
		await expect(file).toHaveAttribute('aria-expanded', 'true');
		const last = tree.getByRole('treeitem', { name: 'Line 9, column 7: const needle = true;', exact: true });
		await expect(last).toHaveAttribute('aria-selected', 'true');
		await expect(tree).toHaveAttribute('aria-activedescendant', (await last.getAttribute('id')) as string);
		await expect(tree).toBeFocused();
	});

	test('Dismiss restores file focus inside a collapsed folder without expanding the target file', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('focus');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('5 results');
		await page.getByRole('button', { name: 'More Actions', exact: true }).click();
		await page.evaluate(() => window.ashSearchIntegration.selectTreeView());
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		const folder = (name: string) => tree.getByRole('treeitem', { name, exact: true });
		const file = (name: string) => tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path').getByText(name, { exact: true }) });
		await file('b.ts').locator('.ash-tree-twistie').click();
		await folder('b/nested').locator('.ash-tree-twistie').click();
		await folder('c').locator('.ash-tree-twistie').click();
		await file('a.ts').click();
		await page.evaluate(() => window.ashSearchIntegration.dismiss());
		await expect(page.getByRole('status')).toHaveText('3 results');
		await expect(folder('b/nested')).toHaveAttribute('aria-expanded', 'true');
		await expect(file('b.ts')).toHaveAttribute('aria-expanded', 'false');
		await expect(file('b.ts')).toHaveAttribute('aria-selected', 'true');
		await expect(tree).toHaveAttribute('aria-activedescendant', (await file('b.ts').getAttribute('id')) as string);
		await expect(folder('c')).toHaveAttribute('aria-expanded', 'false');
		await expect(tree).toBeFocused();
	});

	test('Dismiss leaves a running search active and incorporates later result batches', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('slow');
		await query.press('Enter');
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		await expect(tree).toHaveAttribute('aria-busy', 'true');
		await tree.locator('.ash-search-match').click();
		await page.evaluate(() => window.ashSearchIntegration.dismiss());
		await expect(page.getByRole('status')).toHaveText('0 results…');
		await expect(tree).toHaveAttribute('aria-busy', 'true');
		expect(await page.evaluate(() => window.ashSearchIntegration.cancelled())).toBe(0);
		await page.evaluate(() => window.ashSearchIntegration.finishLateSearch());
		await expect(tree).toHaveAttribute('aria-busy', 'false');
		await expect(page.locator('.ash-search-file-path .ash-icon-label-text')).toHaveText(['late.ts']);
		await expect(page.getByRole('status')).toHaveText('1 results');
	});

	test('Dismiss handles a file and its selected child together through multiple selection', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('中文');
		await query.press('Enter');
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		const file = tree.getByRole('treeitem').filter({
			has: page.locator('.ash-search-file-path').filter({ has: page.locator('.ash-icon-label-description', { hasText: 'workspace • src' }) }),
		});
		await file.click();
		await tree
			.locator('.ash-search-match')
			.first()
			.click({ modifiers: ['ControlOrMeta'] });
		await expect(tree.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(2);
		await page.evaluate(() => window.ashSearchIntegration.dismiss());
		await expect(page.getByRole('status')).toHaveText('1 results');
		await expect(page.locator('.ash-search-file-path .ash-icon-label-text')).toHaveText(['main.ts']);
		await expect(tree).toBeFocused();
	});

	test('Dismiss and its accessibility guidance use the Chinese language catalog', async function () {
		const { page } = browserTests;

		await page.goto('/search.html?locale=zh-CN');
		const query = page.getByRole('textbox', { name: '搜索工作区', exact: true });
		await query.fill('needle');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('1 个结果');
		await page.locator('.ash-search-match').click();
		expect(await page.evaluate(() => window.ashSearchIntegration.help())).toContain('不会删除文件');
		await page.evaluate(() => window.ashSearchIntegration.dismiss());
		await expect(page.getByRole('status')).toHaveText('未找到结果。');
	});

	test('registered Search keeps query controls and labeled filters usable at the minimum sidebar width', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		const matchCase = page.getByRole('button', { name: 'Match Case', exact: true });
		const regex = page.getByRole('button', { name: 'Use Regular Expression', exact: true });
		const details = page.getByRole('button', { name: 'Toggle Search Details', exact: true });
		const include = page.getByRole('textbox', { name: 'Files to include', exact: true });
		const exclude = page.getByRole('textbox', { name: 'Files to exclude', exact: true });
		await expect(include).toBeHidden();
		await query.focus();
		await query.press('Tab');
		await expect(matchCase).toBeFocused();
		await matchCase.press('Space');
		await expect(matchCase).toHaveAttribute('aria-pressed', 'true');
		await expect(matchCase).toBeFocused();
		await matchCase.press('ArrowRight');
		await expect(page.getByRole('button', { name: 'Match Whole Word', exact: true })).toBeFocused();
		await page.getByRole('button', { name: 'Match Whole Word', exact: true }).press('ArrowRight');
		await expect(regex).toBeFocused();
		await regex.press('Space');
		await expect(regex).toHaveAttribute('aria-pressed', 'true');
		await expect(regex).toBeFocused();
		await regex.press('Tab');
		await expect(page.getByRole('textbox', { name: 'Replace', exact: true })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(page.getByRole('button', { name: 'Preserve Case', exact: true })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(details).toBeFocused();
		await details.press('Enter');
		await expect(details).toHaveAttribute('aria-expanded', 'true');
		await details.press('Tab');
		await expect(include).toBeFocused();
		await include.fill('src/**, docs/**');
		await include.press('Tab');
		await expect(exclude).toBeFocused();
		await exclude.fill('**/*.test.ts');
		await details.click();
		await expect(include).toBeHidden();
		await query.fill('needle');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('1 results');
		expect(await page.evaluate(() => window.ashSearchIntegration.queries)).toEqual([
			{
				text: 'needle',
				wholeWord: false,
				patternKind: 'regex',
				caseSensitivity: 'sensitive',
				includePatterns: ['src/**', 'docs/**'],
				excludePatterns: ['**/*.test.ts'],
				maxResults: 2000,
				freshness: 'current',
			},
		]);
		await expect(page.locator('.ash-search-preview mark')).toHaveText('needle');
		await details.click();
		await expect(include).toHaveValue('src/**, docs/**');
		for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
			await page.evaluate(theme => window.ashSearchIntegration.setTheme(theme), theme);
			for (const width of [180, 220, 280, 400, 600]) {
				await page.evaluate(width => window.ashSearchIntegration.setWidth(width), width);
				await query.focus();
				await expect.poll(() => page.locator('.ash-search-widget').evaluate(widget => widget.classList.contains('ash-search-widget-narrow'))).toBe(width < 284);
				const geometry = await page.locator('.ash-search-widget').evaluate(widget => {
					const field = widget.querySelector('.ash-search-query-field')!;
					const bounds = field.getBoundingClientRect();
					const input = field.querySelector('textarea')!.getBoundingClientRect();
					const replacement = widget.querySelector('.ash-search-replace-field textarea')!.getBoundingClientRect();
					const controls = field.querySelector('[role="toolbar"]')!.getBoundingClientRect();
					const narrow = widget.classList.contains('ash-search-widget-narrow');
					const widgetBounds = widget.getBoundingClientRect();
					return {
						inputWidth: input.width,
						aligned: Math.abs(input.left - replacement.left) < 0.01 && Math.abs(input.right - replacement.right) < 0.01,
						inside: controls.left >= bounds.left && controls.right <= bounds.right + 0.01 && controls.top >= bounds.top && controls.bottom <= bounds.bottom + 0.01,
						narrowOptions: !narrow || controls.top >= input.bottom,
						fits: widget.scrollWidth <= widget.clientWidth,
						width: widget.clientWidth,
						scrollWidth: widget.scrollWidth,
						overflowing: Array.from(widget.querySelectorAll('*'))
							.filter(element => element.getBoundingClientRect().right > widgetBounds.right + 0.01)
							.map(element => ({
								className: element.className,
								right: element.getBoundingClientRect().right,
								width: element.getBoundingClientRect().width,
							})),
					};
				});
				expect(geometry.inputWidth).toBeGreaterThanOrEqual(100);
				expect(geometry.aligned).toBe(true);
				expect(geometry.inside).toBe(true);
				expect(geometry.narrowOptions).toBe(true);
				expect(geometry.fits, JSON.stringify({ theme, requestedWidth: width, ...geometry })).toBe(true);
				await expect(include).toHaveCSS('min-height', '22px');
				await expect(include.locator('..')).toHaveCSS('min-height', '24px');
			}
		}
	});

	test('registered Search exposes Chinese labels and localized result counts', async function () {
		const { page } = browserTests;

		await page.goto('/search.html?locale=zh-CN');
		const query = page.getByRole('textbox', { name: '搜索工作区', exact: true });
		await expect(query).toHaveAttribute('placeholder', '搜索');
		await expect(page.getByRole('button', { name: '区分大小写', exact: true })).toHaveText('Aa');
		await expect(page.getByRole('button', { name: '使用正则表达式', exact: true })).toHaveText('.*');
		const details = page.getByRole('button', { name: '切换搜索详细信息', exact: true });
		await expect(details).toHaveText('搜索条件');
		await details.click();
		await expect(page.getByRole('textbox', { name: '包含的文件', exact: true })).toHaveAttribute('placeholder', '例如 *.ts、src/**/include');
		await expect(page.getByRole('textbox', { name: '排除的文件', exact: true })).toBeVisible();
		await expect(page.locator('.ash-search-filter-help')).toHaveText('用逗号分隔 glob 模式。“包含”限定搜索范围；“排除”跳过匹配的文件。');
		await page.getByRole('textbox', { name: '包含的文件', exact: true }).fill('src/**');
		await details.click();
		await expect(details).toHaveText('搜索条件 · 筛选已启用');
		await query.fill('needle');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('1 个结果');
	});

	for (const mode of ['flat', 'tree'] as const) {
		test(`Search ${mode} pane receives Sidebar widths synchronously`, async function () {
			const { page } = browserTests;

			await page.goto('/search.html');
			await page.evaluate(() => window.ashSearchIntegration.setLineNumbers(true));
			const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
			await query.fill('layout');
			await query.press('Enter');
			await expect(page.getByRole('status')).toHaveText('3 results');
			if (mode === 'tree') {
				await page.getByRole('button', { name: 'More Actions', exact: true }).click();
				await page.evaluate(() => window.ashSearchIntegration.selectTreeView());
			}
			// Resize and measure in the same browser task: a ResizeObserver cannot repair stale geometry.
			const samples = await page.evaluate(() =>
				[600, 180, 400, 220, 280, 180, 600].map(width => {
					window.ashSearchIntegration.setWidth(width);
					const sidebar = document.querySelector<HTMLElement>('[data-part="sidebar"]')!;
					const host = sidebar.querySelector<HTMLElement>('.ash-view-pane-container')!;
					const pane = host.querySelector<HTMLElement>('.ash-split-view-pane')!;
					return {
						width,
						hostWidth: host.clientWidth,
						paneWidth: pane.getBoundingClientRect().width,
						previews: Array.from(pane.querySelectorAll('.ash-search-preview')).map(preview => ({
							width: preview.getBoundingClientRect().width,
							right: preview.getBoundingClientRect().right,
						})),
						right: sidebar.getBoundingClientRect().right,
					};
				}),
			);
			for (const sample of samples) {
				expect(sample.paneWidth, JSON.stringify(sample)).toBe(sample.hostWidth);
				expect(sample.previews).toHaveLength(3);
				for (const preview of sample.previews) {
					expect(preview.width).toBeGreaterThan(0);
					expect(preview.right, JSON.stringify(sample)).toBeLessThanOrEqual(sample.right);
				}
			}
		});

		test(`Search ${mode} results preserve source paths, preview coordinates and geometry across Sidebar widths`, async function () {
			const { page } = browserTests;

			await page.goto('/search.html');
			await page.evaluate(() => window.ashSearchIntegration.setLineNumbers(true));
			const sidebar = page.locator('[data-part="sidebar"]');
			const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
			const tree = page.getByRole('tree', { name: 'Search results', exact: true });
			const toolbar = page.getByRole('toolbar', { name: 'Search result actions', exact: true });
			await query.fill('layout');
			await query.press('Enter');
			await expect(page.getByRole('status')).toHaveText('3 results');
			const snapshot = await page.evaluate(() => window.ashSearchIntegration.snapshot());
			if (mode === 'tree') {
				await page.getByRole('button', { name: 'More Actions', exact: true }).click();
				await page.evaluate(() => window.ashSearchIntegration.selectTreeView());
				await expect(tree.getByRole('treeitem', { name: 'src/ash', exact: true })).toHaveCount(1);
				await expect(tree.getByRole('treeitem', { name: 'base/browser/ui/inputbox', exact: true })).toHaveCount(1);
				await expect(tree.getByRole('treeitem', { name: 'workbench/contrib/search/browser', exact: true })).toHaveCount(1);
				await expect(tree.getByRole('treeitem', { name: 'src/ash/workbench/contrib/search/browser', exact: true })).toHaveCount(1);
			} else {
				await expect(tree.locator('.ash-search-folder-path')).toHaveCount(0);
				await expect(tree.locator('.ash-icon-label-description')).toContainText([
					'workspace • src/ash/base/browser/ui/inputbox',
					'workspace • src/ash/workbench/contrib/search/browser',
					'other • src/ash/workbench/contrib/search/browser',
				]);
			}
			await expect(tree.locator('.ash-search-file-path .ash-icon-label-text')).toHaveText(
				mode === 'tree' ? ['searchView.ts', 'inputbox.ts', 'searchView.ts'] : ['inputbox.ts', 'searchView.ts', 'searchView.ts'],
			);
			await expect(tree.locator('.ash-search-preview mark')).toHaveText(['layout', 'layout', 'layout']);
			expect((await tree.locator('.ash-search-line-number').allTextContents()).sort()).toEqual(['1000:', '3456:', '43:']);
			const late = tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-line-number').getByText('3456:', { exact: true }) });
			expect((await late.locator('.ash-search-preview').innerText()).length).toBeLessThanOrEqual(250);
			await expect(late.locator('.ash-search-preview mark')).toHaveText('layout');
			await late.dblclick();
			expect((await page.evaluate(() => window.ashSearchIntegration.opened)).at(-1)).toMatchObject({
				resource: 'file:///workspace/src/ash/workbench/contrib/search/browser/searchView.ts',
				options: {
					selection: {
						startLineNumber: 3456,
						startColumn: '中文😀 long context '.repeat(36).length + 1,
						endLineNumber: 3456,
						endColumn: '中文😀 long context '.repeat(36).length + 7,
					},
				},
			});
			for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
				await page.evaluate(value => window.ashSearchIntegration.setTheme(value), theme);
				for (const width of [180, 220, 280, 400, 600]) {
					await page.evaluate(value => window.ashSearchIntegration.setWidth(value), width);
					await query.focus();
					await expect.poll(() => page.locator('.ash-search-widget').evaluate(widget => widget.classList.contains('ash-search-widget-narrow'))).toBe(width < 284);
					const geometry = await sidebar.evaluate(element => {
						const bounds = element.getBoundingClientRect();
						const title = element.querySelector('.ash-sidebar-title-label')!.getBoundingClientRect();
						const toolbar = element.querySelector('[aria-label="Search result actions"]')!.getBoundingClientRect();
						const input = element.querySelector('.ash-search-query-field textarea')!.getBoundingClientRect();
						const replacement = element.querySelector('.ash-search-replace-field textarea')!.getBoundingClientRect();
						const previews = Array.from(element.querySelectorAll('.ash-search-match')).map(row => {
							const content = row.getBoundingClientRect();
							const line = row.querySelector('.ash-search-line-number')!.getBoundingClientRect();
							const preview = row.querySelector('.ash-search-preview')!.getBoundingClientRect();
							const highlight = row.querySelector('.ash-search-preview mark')!.getBoundingClientRect();
							return {
								lineWidth: line.width,
								origin: preview.left - content.left,
								width: preview.width,
								fits: preview.right <= bounds.right + 0.01,
								highlightFits: highlight.left >= preview.left - 0.01 && highlight.right <= preview.right + 0.01,
							};
						});
						const files = Array.from(element.querySelectorAll('.ash-search-file-heading'))
							.filter(row => row.querySelector('.ash-search-file-count'))
							.map(row => {
								const label = row.querySelector('.ash-icon-label-text')!.getBoundingClientRect();
								const count = row.querySelector('.ash-search-file-count')!.getBoundingClientRect();
								return {
									width: label.width,
									separated: label.right <= count.left + 0.01,
									fits: count.right <= bounds.right + 0.01,
								};
							});
						return {
							width: bounds.width,
							titleFits: title.right <= toolbar.left,
							toolbarAtTop: toolbar.bottom <= input.top,
							alignedInputs: input.left === replacement.left && input.right === replacement.right,
							previews,
							files,
						};
					});
					await browserTests.info.attach(`search-${mode}-${theme}-${width}px-geometry`, {
						body: JSON.stringify(geometry, null, 2),
						contentType: 'application/json',
					});
					expect(geometry.titleFits).toBe(true);
					expect(geometry.toolbarAtTop).toBe(true);
					expect(geometry.alignedInputs).toBe(true);
					expect(geometry.previews).toHaveLength(3);
					expect(geometry.files).toHaveLength(3);
					for (const preview of geometry.previews) {
						expect(preview.lineWidth).toBeCloseTo(geometry.previews[0]!.lineWidth, 2);
						expect(preview.origin).toBeCloseTo(geometry.previews[0]!.origin, 2);
						expect(preview.width).toBeGreaterThan(0);
						expect(preview.fits).toBe(true);
						expect(preview.highlightFits).toBe(true);
					}
					for (const file of geometry.files) {
						expect(file.width).toBeGreaterThan(0);
						expect(file.separated).toBe(true);
						expect(file.fits).toBe(true);
					}
					await expect(page.locator('.ash-pane-composite-title-view-actions').getByRole('toolbar', { name: 'Search result actions', exact: true })).toHaveCount(1);
					await browserTests.info.attach(`search-${mode}-${theme}-${width}px`, {
						body: await sidebar.screenshot(),
						contentType: 'image/png',
					});
				}
			}
			await expect(toolbar).toBeVisible();
			expect(await page.evaluate(() => window.ashSearchIntegration.snapshot())).toEqual(snapshot);
		});
	}

	test('Search opens each occurrence at UTF-16 columns and keeps same-path roots separate', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('中文');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('3 results');
		await expect(page.locator('.ash-search-file-path .ash-icon-label-text')).toHaveText(['main.ts', 'main.ts']);
		await expect(page.locator('.ash-search-file-count')).toHaveText(['2', '1']);
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		const rows = tree.getByRole('treeitem');
		const workspaceFile = rows.filter({
			has: page.locator('.ash-search-file-path').filter({ has: page.locator('.ash-icon-label-description', { hasText: 'workspace • src' }) }),
		});
		await workspaceFile.locator('.ash-tree-twistie').click();
		await expect(workspaceFile).toHaveAttribute('aria-expanded', 'false');
		await expect(tree.locator('.ash-search-match')).toHaveCount(1);
		await workspaceFile.locator('.ash-tree-twistie').click();
		await expect(workspaceFile).toHaveAttribute('aria-expanded', 'true');
		await tree.locator('.ash-search-match').filter({ hasText: '中文😀 needle needle' }).last().click();
		await expect(rows.filter({ has: page.locator('.ash-search-match', { hasText: '中文😀 needle needle' }) }).last()).toHaveAccessibleName('Line 1, column 13: 中文😀 needle needle');
		await expect
			.poll(() => page.evaluate(() => window.ashSearchIntegration.opened.at(-1)))
			.toMatchObject({
				resource: 'file:///workspace/src/main.ts',
				target: 'activeGroup',
				options: {
					pinned: false,
					preserveFocus: true,
					selection: { startLineNumber: 1, startColumn: 13, endLineNumber: 1, endColumn: 19 },
				},
			});
		await tree.press('ControlOrMeta+Enter');
		await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.opened.at(-1))).toMatchObject({ target: 'sideGroup', options: { pinned: true } });
		await tree.press('F4');
		await expect
			.poll(() => page.evaluate(() => window.ashSearchIntegration.opened.at(-1)))
			.toMatchObject({
				resource: 'ssh://host/other/src/main.ts',
				options: { selection: { startLineNumber: 8, startColumn: 7, endColumn: 13 } },
			});
		await expect(tree).toBeFocused();
		await page.getByRole('button', { name: 'Collapse all results', exact: true }).click();
		await expect(tree.locator('.ash-search-match')).toHaveCount(0);
		await query.press('Shift+F4');
		await expect(tree.locator('.ash-search-match')).toHaveCount(2);
		await expect
			.poll(() => page.evaluate(() => window.ashSearchIntegration.opened.at(-1)))
			.toMatchObject({ resource: 'file:///workspace/src/main.ts', options: { selection: { startColumn: 13 } } });
	});

	test('Custom tree progress follows provider loading and releases its view', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		await page.waitForFunction(() => !!window.ashSearchIntegration);
		await page.evaluate(() => window.ashSearchIntegration.openCustomTree());
		const pane = page.locator('[data-view-id="fixture.tree"]');
		const progress = pane.locator('progress');
		await expect(progress).toBeVisible();
		await page.evaluate(() => window.ashSearchIntegration.finishCustomTree());
		await expect(pane.getByRole('treeitem')).toContainText('Loaded item');
		await expect(progress).toBeHidden();
		await page.evaluate(() => window.ashSearchIntegration.closeCustomTree());
		await expect(pane).toHaveCount(0);
		expect(await page.evaluate(() => window.ashSearchIntegration.notificationCount())).toBe(0);
	});

	test('Container progress stays with its owner through switches without creating notifications', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await page.goto('/search.html');
		await page.waitForFunction(() => !!window.ashSearchIntegration);
		await page.evaluate(() => window.ashSearchIntegration.startContainerProgress());
		const bar = page.locator('.ash-composite-progress progress');
		await expect(bar).toBeVisible();
		const title = page.locator('[data-part="sidebar"] .ash-pane-composite-title');
		expect((await bar.boundingBox())!.y).toBe((await title.boundingBox())!.y + (await title.boundingBox())!.height);
		await page.evaluate(() => window.ashSearchIntegration.switchSidebar('explorer'));
		await expect(bar).toBeHidden();
		await page.evaluate(() => window.ashSearchIntegration.switchSidebar('search'));
		await expect(bar).toBeVisible();
		expect(await page.evaluate(() => window.ashSearchIntegration.notificationCount())).toBe(0);
		await page.screenshot({ path: testInfo.outputPath('container-progress.png') });
		await page.evaluate(() => window.ashSearchIntegration.finishContainerProgress());
		await expect(bar).toBeHidden();
	});

	test('Search progress stays below the title without shifting content across themes and visibility changes', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await page.clock.install();
		await page.goto('/search.html?locale=zh-CN');
		await page.waitForFunction(() => !!window.ashSearchIntegration);
		await page.clock.pauseAt(new Date(Date.now() + 1_000));
		const pane = page.locator('.ash-view-pane[data-view-id="ash.searchView"]');
		const query = page.getByRole('textbox', { name: '搜索工作区', exact: true });
		const bar = pane.locator('.ash-view-pane-progress-indicator');
		const body = pane.locator(':scope > .ash-pane-view-content');
		const original = await body.boundingBox();
		await query.fill('slow');
		await query.press('Enter');
		await expect(bar).toBeHidden();
		await page.clock.fastForward(149);
		await expect(bar).toBeHidden();
		await page.clock.fastForward(1);
		await expect(bar).toBeVisible();
		await expect(bar).toHaveAttribute('aria-label', '搜索');
		await expect(query).toBeFocused();
		for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
			await page.evaluate(theme => window.ashSearchIntegration.setTheme(theme), theme);
			const geometry = await bar.evaluate(element => {
				const bar = element.getBoundingClientRect();
				const body = element.closest('.ash-view-pane')!.querySelector('.ash-pane-view-content')!.getBoundingClientRect();
				const style = getComputedStyle(element);
				return {
					top: bar.top - body.top,
					width: bar.width - body.width,
					height: bar.height,
					color: style.color,
					accent: style.accentColor,
				};
			});
			expect(geometry).toEqual({ top: 0, width: 0, height: 2, color: geometry.accent, accent: geometry.accent });
		}
		expect(await body.boundingBox()).toEqual(original);
		await page.evaluate(() => document.body.classList.add('ash-reduce-motion'));
		await expect(bar).toHaveCSS('animation-name', 'none');
		await expect(bar).toHaveCSS('background-position', '50% 0px');
		await page.evaluate(() => window.ashSearchIntegration.setSecondView(true));
		const header = pane.locator(':scope > .ash-pane-view-header');
		await expect(header).toBeVisible();
		expect((await bar.boundingBox())!.y).toBe((await header.boundingBox())!.y + (await header.boundingBox())!.height);
		await pane.locator('.ash-pane-view-header-button').press('ArrowLeft');
		await expect(bar).toBeHidden();
		await pane.locator('.ash-pane-view-header-button').press('ArrowRight');
		await expect(bar).toBeVisible();
		await page.evaluate(() => window.ashSearchIntegration.switchSidebar('explorer'));
		await expect(bar).toBeHidden();
		await page.evaluate(() => window.ashSearchIntegration.switchSidebar('search'));
		await expect(bar).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath('pane-progress.png') });
		await query.fill('needle');
		await query.press('Enter');
		await expect(bar).toBeHidden();
		await page.evaluate(() => window.ashSearchIntegration.finishLateSearch());
		await expect(bar).toBeHidden();
	});

	test('Search lifecycle refreshes running tasks, cancels retained results, clears twice and searches again', async function () {
		const { page } = browserTests;

		await page.clock.install();
		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		const progress = page.locator('.ash-view-pane-progress-indicator');
		const refresh = page.getByRole('button', { name: 'Refresh search', exact: true });
		const cancel = page.getByRole('button', { name: 'Cancel Search', exact: true });
		const clear = page.getByRole('button', { name: 'Clear search results', exact: true });
		await expect(clear).toBeDisabled();
		await query.fill('slow');
		await query.press('Enter');
		await expect(refresh).toBeEnabled();
		await expect(cancel).toHaveCount(0);
		await expect(tree).toHaveAttribute('aria-busy', 'true');
		await refresh.focus();
		await page.clock.fastForward(2_000);
		await expect(progress).toBeVisible();
		await expect(cancel).toBeFocused();
		await expect(refresh).toHaveCount(0);
		await cancel.press('Enter');
		await expect(progress).toBeHidden();
		await expect(query).toBeFocused();
		await expect(page.getByRole('status')).toHaveText('Search stopped. 1 results retained.');
		await expect(refresh).toBeEnabled();
		await expect(tree.locator('.ash-search-match')).toHaveCount(1);
		await page.evaluate(() => window.ashSearchIntegration.finishLateSearch());
		await expect(tree.locator('.ash-search-match')).toHaveCount(1);
		await query.fill('slow');
		await query.press('Enter');
		await expect(tree).toHaveAttribute('aria-busy', 'true');
		await query.fill('needle');
		await refresh.click();
		await expect(query).toBeFocused();
		await expect(page.getByRole('status')).toHaveText('1 results');
		await page.evaluate(() => window.ashSearchIntegration.finishLateSearch());
		await expect(page.locator('.ash-search-file-path .ash-icon-label-text')).toHaveText(['main.ts']);
		expect(await page.evaluate(() => window.ashSearchIntegration.cancelled())).toBe(2);
		await expect(page.getByRole('textbox', { name: 'Replace', exact: true })).toBeVisible();
		await page.getByRole('textbox', { name: 'Replace', exact: true }).fill('replacement');
		await page.getByRole('button', { name: 'Toggle Search Details', exact: true }).click();
		const includes = page.getByRole('textbox', { name: 'Files to include', exact: true });
		const excludes = page.getByRole('textbox', { name: 'Files to exclude', exact: true });
		await includes.fill('src/**');
		await excludes.fill('**/*.test.ts');
		await clear.click();
		await expect(query).toHaveValue('');
		await expect(query).toBeFocused();
		await expect(page.getByRole('textbox', { name: 'Replace', exact: true })).toHaveValue('');
		await expect(includes).toHaveValue('src/**');
		await expect(excludes).toHaveValue('**/*.test.ts');
		await expect(tree.getByRole('treeitem')).toHaveCount(0);
		await expect(page.getByRole('status')).toBeHidden();
		await clear.click();
		await expect(includes).toHaveValue('');
		await expect(excludes).toHaveValue('');
		await expect(clear).toBeDisabled();
		await query.press('ArrowUp');
		await expect(query).toHaveValue('needle');
		await query.press('ArrowDown');
		await expect(query).toHaveValue('');
		await query.fill('slow');
		await query.press('Enter');
		await includes.focus();
		await includes.press('Escape');
		await expect(includes).toBeFocused();
		await expect(page.getByRole('status')).toHaveText('Search stopped. 1 results retained.');
		await query.press('Enter');
		await tree.focus();
		await tree.press('Escape');
		await expect(query).toBeFocused();
		await clear.click();
		await page.evaluate(() => window.ashSearchIntegration.finishLateSearch());
		await expect(tree.getByRole('treeitem')).toHaveCount(0);
		await query.fill('needle');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('1 results');
	});

	test('Search lifecycle Chinese controls and help explain cancellation and repeated clearing', async function () {
		const { page } = browserTests;

		await page.clock.install();
		await page.goto('/search.html?locale=zh-CN');
		const query = page.getByRole('textbox', { name: '搜索工作区', exact: true });
		await query.fill('slow');
		await query.press('Enter');
		await page.clock.fastForward(2_000);
		await page.getByRole('button', { name: '取消搜索', exact: true }).click();
		await expect(query).toBeFocused();
		await expect(page.getByRole('status')).toHaveText('搜索已停止，保留 1 个结果。');
		await page.getByRole('button', { name: '清空搜索结果', exact: true }).click();
		await expect(query).toHaveValue('');
		const help = await page.evaluate(() => window.ashSearchIntegration.help());
		expect(help).toContain('搜索: 刷新');
		expect(help).toContain('两项输入已为空时再次清空');
		expect(help).toContain('搜索选项和输入历史保留');
	});

	test('Search virtualizes a thousand matches and navigates to an offscreen result', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		await page.evaluate(() => window.ashSearchIntegration.setLineNumbers(true));
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('large');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('1000 results');
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		const rows = tree.getByRole('treeitem');
		expect(await rows.count()).toBeLessThan(100);
		await tree.focus();
		await tree.press('End');
		await expect
			.poll(() => page.evaluate(() => window.ashSearchIntegration.opened.at(-1)))
			.toMatchObject({
				resource: 'file:///workspace/src/main.ts',
				options: { preserveFocus: true, selection: { startLineNumber: 1000, endLineNumber: 1000 } },
			});
		await expect(tree.locator('.ash-search-line-number').last()).toHaveText('1000:');
		expect(await rows.count()).toBeLessThan(100);
	});

	test('Changing workspace cancels search and discards results from the previous roots', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		await query.fill('slow');
		await query.press('Enter');
		await expect(tree.getByRole('treeitem')).toHaveCount(2);
		await page.evaluate(() => window.ashSearchIntegration.closeWorkspace());
		await page.evaluate(() => window.ashSearchIntegration.finishLateSearch());
		await expect(tree.getByRole('treeitem')).toHaveCount(0);
		await expect(tree).toHaveAttribute('aria-busy', 'false');
		expect(await page.evaluate(() => window.ashSearchIntegration.cancelled())).toBe(1);
	});

	test('Search preserves multiline queries and restores history after recreating the page', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('first');
		await query.press('Shift+Enter');
		await page.keyboard.insertText('second');
		await expect(query).toHaveValue('first\nsecond');
		expect(await page.evaluate(() => window.ashSearchIntegration.queries.length)).toBe(0);
		await query.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.queries[0]?.text)).toBe('first\nsecond');
		await query.fill('needle');
		await query.press('Enter');
		await query.fill('draft');
		await query.press('ArrowUp');
		await expect(query).toHaveValue('needle');
		await query.press('ArrowUp');
		await expect(query).toHaveValue('first\nsecond');
		await query.press('Alt+ArrowDown');
		await expect(query).toHaveValue('needle');
		await query.press('ArrowDown');
		await expect(query).toHaveValue('draft');
		await page.reload();
		await query.focus();
		await query.press('ArrowUp');
		await expect(query).toHaveValue('needle');
		await query.press('ArrowUp');
		await expect(query).toHaveValue('first\nsecond');
	});

	test('search context snapshot preserves query, file locations and matches and excludes in-progress results', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		expect(await page.evaluate(() => window.ashSearchIntegration.snapshot())).toBeUndefined();
		await query.fill('needle');
		await query.press('Enter');
		await expect(page.getByRole('tree')).toHaveAttribute('aria-busy', 'false');
		const snapshot = await page.evaluate(() => window.ashSearchIntegration.snapshot());
		expect(snapshot).toMatchObject({ query: 'needle', matchCount: 1 });
		expect(snapshot!.content).toContain('# File: file:///workspace/src/main.ts');
		expect(snapshot!.content).toContain('1:7-1:13: needle');
		await query.fill('slow');
		await query.press('Enter');
		await expect(page.getByRole('tree')).toHaveAttribute('aria-busy', 'true');
		expect(await page.evaluate(() => window.ashSearchIntegration.snapshot())).toBeUndefined();
		await page.evaluate(() => window.ashSearchIntegration.closeWorkspace());
		expect(await page.evaluate(() => window.ashSearchIntegration.snapshot())).toBeUndefined();
		await page.evaluate(() => window.ashSearchIntegration.finishLateSearch());
	});

	test('Copy All includes collapsed retained results and excludes dismissed occurrences', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		await page.evaluate(() => window.ashSearchIntegration.copyAll());
		expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['']);
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('中文');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('3 results');
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		await tree.locator('.ash-tree-twistie').first().click();
		const before = await page.evaluate(() => window.ashSearchIntegration.snapshot());
		await page.evaluate(() => window.ashSearchIntegration.copyAll());
		expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual([
			'',
			'/workspace/src/main.ts\n  1,6: 中文😀 needle needle\n  1,13: 中文😀 needle needle\n\n/other/src/main.ts\n  8,7: const needle = true;',
		]);
		expect(await page.evaluate(() => window.ashSearchIntegration.snapshot())).toEqual(before);
		await tree.locator('.ash-tree-twistie').first().click();
		await tree.locator('.ash-search-match').first().click();
		await page.evaluate(() => window.ashSearchIntegration.dismiss());
		await page.evaluate(() => window.ashSearchIntegration.copyAll());
		expect((await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).at(-1)).toBe(
			'/workspace/src/main.ts\n  1,13: 中文😀 needle needle\n\n/other/src/main.ts\n  8,7: const needle = true;',
		);
		await page.evaluate(() => window.ashSearchIntegration.setClipboardFailure(true));
		await expect(page.evaluate(() => window.ashSearchIntegration.copyAll())).rejects.toThrow('Clipboard permission denied');
		await expect(page.getByRole('status')).toHaveText('2 results');
		expect((await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).length).toBe(3);
	});

	test('Copy All does not write while Search is inactive and resumes from its retained model', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('needle');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('1 results');
		const snapshot = await page.evaluate(() => window.ashSearchIntegration.snapshot());
		await page.evaluate(() => window.ashSearchIntegration.setSearchVisible(false));
		await expect(query).toBeHidden();
		await page.evaluate(() => window.ashSearchIntegration.copyAll());
		expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual([]);
		expect(await page.evaluate(() => window.ashSearchIntegration.snapshot())).toEqual(snapshot);
		await expect(query).toBeHidden();
		await page.evaluate(() => window.ashSearchIntegration.setSearchVisible(true));
		await expect(query).toBeVisible();
		await page.evaluate(() => window.ashSearchIntegration.copyAll());
		expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['/workspace/src/main.ts\n  1,7: const needle = true;']);
	});

	test('Copy All reads the latest incremental results and its help is translated', async function () {
		const { page } = browserTests;

		await page.goto('/search.html?locale=zh-CN');
		const query = page.getByRole('textbox', { name: '搜索工作区', exact: true });
		await query.fill('slow');
		await query.press('Enter');
		const tree = page.getByRole('tree', { name: '搜索结果', exact: true });
		await expect(tree).toHaveAttribute('aria-busy', 'true');
		await page.evaluate(() => window.ashSearchIntegration.copyAll());
		expect((await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).at(-1)).toBe('/workspace/src/main.ts\n  1,7: const needle = true;');
		await page.evaluate(() => window.ashSearchIntegration.finishLateSearch());
		await expect(tree).toHaveAttribute('aria-busy', 'false');
		await page.evaluate(() => window.ashSearchIntegration.copyAll());
		expect((await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).at(-1)).toBe(
			'/workspace/src/main.ts\n  1,7: const needle = true;\n\n/workspace/late.ts\n  1,7: const needle = true;',
		);
		expect(await page.evaluate(() => window.ashSearchIntegration.cancelled())).toBe(0);
		expect(await page.evaluate(() => window.ashSearchIntegration.help())).toContain('已移除的结果不会复制');
	});

	suite('Windows search clipboard formatting', () => {
		browserTests.use({
			userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36',
		});
		test('Copy Path uses the Windows shortcut and does not claim Control+Alt+C', async function () {
			const { page } = browserTests;

			await page.goto('/search.html?windows=1');
			const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
			await query.fill('windows');
			await query.press('Enter');
			await expect(page.getByRole('status')).toHaveText('2 results');
			await page.locator('.ash-search-file-path').filter({ hasText: 'main.ts' }).click();
			const tree = page.getByRole('tree', { name: 'Search results', exact: true });
			await tree.press('Control+Alt+c');
			expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual([]);
			await tree.press('Shift+Alt+c');
			await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['C:\\workspace\\src\\main.ts']);
			await tree.press('Control+Shift+Alt+c');
			await query.focus();
			await query.press('Shift+Alt+c');
			expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['C:\\workspace\\src\\main.ts']);
		});
		test('Copy formats a single multi-line match and its file with Windows labels and separators', async function () {
			const { page } = browserTests;

			await page.goto('/search.html?windows=1');
			const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
			await query.fill('windows');
			await query.press('Enter');
			await expect(page.getByRole('status')).toHaveText('2 results');
			await page.locator('.ash-search-match').filter({ hasText: 'next' }).click({ button: 'right' });
			await page.getByRole('menuitem', { name: 'Copy', exact: true }).click();
			await page.locator('.ash-search-file-path').filter({ hasText: 'main.ts' }).click({ button: 'right' });
			await page.getByRole('menuitem', { name: 'Copy', exact: true }).click();
			await expect
				.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites()))
				.toEqual(['9,1: needle\n10:  next', 'C:\\workspace\\src\\main.ts\r\n  9,1: needle\n  10:  next']);
		});
		test('Copy All uses Windows labels and block separators while preserving multi-line previews', async function () {
			const { page } = browserTests;

			await page.goto('/search.html?windows=1');
			const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
			await query.fill('windows');
			await query.press('Enter');
			await expect(page.getByRole('status')).toHaveText('2 results');
			await page.evaluate(() => window.ashSearchIntegration.copyAll());
			expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual([
				'C:\\workspace\\src\\main.ts\r\n  9,1: needle\n  10:  next\r\n\r\nC:\\workspace\\root.ts\r\n  2,1: needle',
			]);
		});
	});

	test('Search opens and dismisses an untitled result without workspace roots in tree and list views', async function () {
		const { page } = browserTests;

		await page.goto('/search.html');
		await page.evaluate(async () => {
			window.ashSearchIntegration.closeWorkspace();
			await window.ashSearchIntegration.setDraftText('# Search: draft_token', 'untitled:/Search-results.code-search');
			await window.ashSearchIntegration.setDraftText('中文😀 draft_token draft_token');
		});
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('draft_token');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('2 results');
		await expect(page.locator('.ash-search-file-path')).toHaveText('Untitled-1');
		await page.getByRole('toolbar', { name: 'Search result actions', exact: true }).getByRole('button', { name: 'More Actions', exact: true }).click();
		await page.evaluate(() => window.ashSearchIntegration.selectTreeView());
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		await tree.getByRole('treeitem').first().click();
		await tree.press('ArrowRight');
		await tree.press('ArrowDown');
		await tree.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.opened.at(-1)?.resource)).toBe('untitled:/Untitled-1');
		expect((await page.evaluate(() => window.ashSearchIntegration.snapshot()))?.content).toContain('# File: untitled:/Untitled-1');
		await page.evaluate(() => window.ashSearchIntegration.dismiss());
		await expect(page.getByRole('status')).toHaveText('1 results');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('2 results');
	});
});
