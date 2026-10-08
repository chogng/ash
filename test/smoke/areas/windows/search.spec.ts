import { expect, test } from '../../../automation/test.js';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { ElectronApplication } from '@playwright/test';

interface SearchLifecycleBoundary {
	holdStart: boolean;
	holdRead: boolean;
	blocked: { method: string; searchId?: string; }[];
	created: string[];
	released: string[];
	readErrors: number;
	release(): void;
	dispose(): void;
}

test('Search lifecycle cancels creation and partial results, refreshes a running job and clears before searching again', async ({ target, workbench, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Uses actual backend jobs, files and protocol responses.');
	const path = join(testWorkspace.directory, 'src/lifecycle.txt');
	const token = 'ash_lifecycle_token';
	await mkdir(dirname(path), { recursive: true });
	const initial = Array.from({ length: 150 }, (_, index) => `${token} ${index + 1}`).join('\n') + '\n';
	await writeFile(path, initial);
	const page = workbench.page;
	await workbench.search.open();
	await page.getByRole('button', { name: 'Toggle Search Details', exact: true }).click();
	const includes = workbench.search.element.getByRole('textbox', { name: 'Files to include', exact: true });
	const excludes = workbench.search.element.getByRole('textbox', { name: 'Files to exclude', exact: true });
	await includes.fill('src/**');
	await excludes.fill('**/*.skip');
	await page.getByRole('button', { name: 'Match Case', exact: true }).click();
	const tree = workbench.search.element.getByRole('tree');
	// Delay requests at the existing transport boundary; all jobs and responses still come from the real server.
	await page.evaluate(() => {
		const owner = globalThis as typeof globalThis & { searchLifecycleBoundary?: SearchLifecycleBoundary; };
		const socketSend = WebSocket.prototype.send;
		const portSend = MessagePort.prototype.postMessage;
		const pending = new Map<number, { method: string; searchId?: string; }>();
		const observers = new Map<WebSocket | MessagePort, EventListener>();
		const held: (() => void)[] = [];
		const frame = (value: unknown): string | undefined => typeof value === 'string' ? value : value && typeof value === 'object' && 'frame' in value && typeof value.frame === 'string' ? value.frame : undefined;
		const state: SearchLifecycleBoundary = {
			holdStart: true, holdRead: false, blocked: [], created: [], released: [], readErrors: 0,
			release() { state.holdStart = false; state.holdRead = false; for (const send of held.splice(0)) { send(); } },
			dispose() {
				state.release();
				WebSocket.prototype.send = socketSend;
				MessagePort.prototype.postMessage = portSend;
				for (const [transport, observer] of observers) { transport.removeEventListener('message', observer); }
				delete owner.searchLifecycleBoundary;
			},
		};
		const route = (transport: WebSocket | MessagePort, value: unknown, send: () => void): void => {
			const source = frame(value);
			if (!source) { send(); return; }
			let request: { id?: number; method?: string; params?: { query?: string; searchId?: string; afterMatch?: number; }; };
			try { request = JSON.parse(source); } catch { send(); return; }
			if (typeof request.id !== 'number' || !request.method?.startsWith('grep/search/')) { send(); return; }
			pending.set(request.id, { method: request.method, searchId: request.params?.searchId });
			if (!observers.has(transport)) {
				const observer: EventListener = event => {
					if (!(event instanceof MessageEvent)) { return; }
					const source = frame(event.data);
					if (!source) { return; }
					const response = JSON.parse(source) as { id?: number; result?: { searchId?: string; }; error?: unknown; };
					if (typeof response.id !== 'number') { return; }
					const request = pending.get(response.id);
					if (!request) { return; }
					pending.delete(response.id);
					if (request.method === 'grep/search/start' && response.result?.searchId) { state.created.push(response.result.searchId); }
					if (request.method === 'grep/search/cancel' && !response.error && request.searchId) { state.released.push(request.searchId); }
					if (request.method === 'grep/search/read' && response.error) { state.readErrors++; }
				};
				observers.set(transport, observer);
				transport.addEventListener('message', observer);
			}
			if ((state.holdStart && request.method === 'grep/search/start') || (state.holdRead && request.method === 'grep/search/read' && (request.params?.afterMatch ?? 0) >= 100)) {
				state.blocked.push({ method: request.method, searchId: request.params?.searchId }); held.push(send);
			} else { send(); }
		};
		WebSocket.prototype.send = function (data) { route(this, data, () => socketSend.call(this, data)); };
		MessagePort.prototype.postMessage = function (message: unknown, options?: Transferable[] | StructuredSerializeOptions) { route(this, message, () => { Reflect.apply(portSend, this, options === undefined ? [message] : [message, options]); }); };
		owner.searchLifecycleBoundary = state;
	});
	const boundary = () => page.evaluate(() => {
		const state = (globalThis as typeof globalThis & { searchLifecycleBoundary: SearchLifecycleBoundary; }).searchLifecycleBoundary;
		return { blocked: state.blocked, created: state.created, released: state.released, readErrors: state.readErrors };
	});
	const release = () => page.evaluate(() => (globalThis as typeof globalThis & { searchLifecycleBoundary: SearchLifecycleBoundary; }).searchLifecycleBoundary.release());
	const holdReads = () => page.evaluate(() => { (globalThis as typeof globalThis & { searchLifecycleBoundary: SearchLifecycleBoundary; }).searchLifecycleBoundary.holdRead = true; });
	try {
		await workbench.search.query.fill(token);
		await workbench.search.query.press('Enter');
		await expect.poll(async () => (await boundary()).blocked.map(request => request.method)).toEqual(['grep/search/start']);
		await expect(tree).toHaveAttribute('aria-busy', 'true');
		await workbench.quickaccess.runCommand('search.action.cancel');
		await expect(workbench.search.status).toHaveText('Search stopped. 0 results retained.');
		await expect(workbench.search.query).toBeFocused();
		expect((await boundary()).created).toEqual([]);
		await release();
		await expect.poll(async () => (await boundary()).released.length).toBe(1);
		await holdReads();
		await workbench.search.query.press('Enter');
		await expect.poll(async () => (await boundary()).blocked.length).toBe(2);
		await expect(workbench.search.status).toHaveText('100 results…');
		await tree.focus();
		await tree.press('Escape');
		await expect(workbench.search.status).toHaveText('Search stopped. 100 results retained.');
		await expect(workbench.search.query).toBeFocused();
		await expect.poll(async () => (await boundary()).released.length).toBe(2);
		await release();
		await expect.poll(async () => (await boundary()).readErrors).toBe(1);
		await holdReads();
		await workbench.search.query.press('Enter');
		await expect.poll(async () => (await boundary()).blocked.length).toBe(3);
		await expect(workbench.search.status).toHaveText('100 results…');
		const refreshed = `${token} refreshed\n${token} second\n`;
		await writeFile(path, refreshed);
		await page.evaluate(() => { (globalThis as typeof globalThis & { searchLifecycleBoundary: SearchLifecycleBoundary; }).searchLifecycleBoundary.holdRead = false; });
		await workbench.quickaccess.runCommand('search.action.refreshSearchResults');
		await expect(workbench.search.status).toHaveText('2 results');
		await expect(workbench.search.query).toBeFocused();
		await expect.poll(async () => (await boundary()).released.length).toBe(4);
		await release();
		await expect.poll(async () => (await boundary()).readErrors).toBe(2);
		await expect(workbench.search.status).toHaveText('2 results');
		await workbench.openExplorer();
		await workbench.quickaccess.runCommand('search.action.clearSearchResults');
		await workbench.quickaccess.runCommand('search.action.refreshSearchResults');
		await expect(workbench.search.element).toBeHidden();
		expect((await boundary()).created).toHaveLength(4);
		await workbench.search.open();
		await expect(workbench.search.status).toHaveText('2 results');
		await workbench.quickaccess.runCommand('search.action.clearSearchResults');
		await expect(workbench.search.query).toHaveValue('');
		await expect(includes).toHaveValue('src/**');
		await expect(excludes).toHaveValue('**/*.skip');
		await expect(tree.getByRole('treeitem')).toHaveCount(0);
		await workbench.quickaccess.runCommand('search.action.clearSearchResults');
		await expect(includes).toHaveValue('');
		await expect(excludes).toHaveValue('');
		await expect(page.getByRole('button', { name: 'Match Case', exact: true })).toHaveAttribute('aria-pressed', 'true');
		await workbench.search.query.press('ArrowUp');
		await expect(workbench.search.query).toHaveValue(token);
		await workbench.search.query.press('Enter');
		await expect(workbench.search.status).toHaveText('2 results');
		await expect.poll(async () => (await boundary()).released.length).toBe(5);
		const evidence = await boundary();
		expect(new Set(evidence.created).size).toBe(5);
		expect([...evidence.released].sort()).toEqual([...evidence.created].sort());
		expect(await readFile(path, 'utf8')).toBe(refreshed);
	} finally {
		await page.evaluate(() => (globalThis as typeof globalThis & { searchLifecycleBoundary?: SearchLifecycleBoundary; }).searchLifecycleBoundary?.dispose());
	}
});

test('Search Dismiss removes retained matches, files and folders without changing disk contents', async ({ target, application, workbench, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Uses actual workspace content searches.');
	const contents = [
		['main.ts', 'ash_dismiss_token first\nash_dismiss_token second\n'],
		['src/source.ts', 'ash_dismiss_token source\n'],
		['docs/notes.md', 'ash_dismiss_token docs\n'],
	] as const;
	await mkdir(join(testWorkspace.directory, 'src'), { recursive: true });
	await mkdir(join(testWorkspace.directory, 'docs'), { recursive: true });
	for (const [path, content] of contents) { await writeFile(join(testWorkspace.directory, path), content); }
	await workbench.search.open();
	await workbench.search.search('ash_dismiss_token');
	const page = workbench.page;
	const search = workbench.search.element;
	const tree = search.getByRole('tree');
	const toolbar = page.getByRole('toolbar', { name: 'Search result actions', exact: true });
	const openMoreActions = () => toolbar.getByRole('button', { name: 'More Actions', exact: true }).click();
	const dismissKey = process.platform === 'darwin' ? 'Meta+Backspace' : 'Delete';
	await expect(workbench.search.status).toHaveText('4 results');
	await workbench.search.query.press(dismissKey);
	await expect(workbench.search.status).toHaveText('4 results');
	await workbench.search.query.fill('ash_dismiss_token');
	await search.locator('.ash-search-match', { hasText: 'ash_dismiss_token first' }).click();
	await tree.press(dismissKey);
	await expect(workbench.search.status).toHaveText('3 results');
	await expect(tree).toBeFocused();
	const next = tree.getByRole('treeitem', { name: 'Line 2, column 1: ash_dismiss_token second', exact: true });
	await expect(next).toHaveAttribute('aria-selected', 'true');
	await expect(tree).toHaveAttribute('aria-activedescendant', (await next.getAttribute('id'))!);
	await workbench.menus.select(application, openMoreActions, ['View as tree']);
	await tree.getByRole('treeitem', { name: 'src', exact: true }).click();
	await workbench.menus.select(application, openMoreActions, ['Dismiss']);
	await expect(workbench.search.status).toHaveText('2 results');
	await expect(tree.getByRole('treeitem', { name: 'src', exact: true })).toHaveCount(0);
	await tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path', { hasText: 'main.ts' }) }).click();
	await workbench.menus.select(application, openMoreActions, ['Dismiss']);
	await expect(workbench.search.files).toHaveText(['notes.md']);
	await expect(workbench.search.status).toHaveText('1 results');
	await workbench.menus.select(application, openMoreActions, ['Open results in Search Editor']);
	const resultEditor = page.locator('.ash-search-editor');
	await expect(resultEditor).toBeVisible();
	await expect(resultEditor).toContainText('notes.md');
	await expect(resultEditor).not.toContainText('source.ts');
	await expect(resultEditor).not.toContainText('main.ts');
	await search.locator('.ash-search-match', { hasText: 'ash_dismiss_token docs' }).click();
	await tree.press(dismissKey);
	await expect(workbench.search.status).toHaveText('No results found.');
	await expect(tree.getByRole('treeitem')).toHaveCount(0);
	await expect(tree).toBeFocused();
	await page.getByRole('button', { name: 'Refresh search', exact: true }).click();
	await expect(workbench.search.status).toHaveText('4 results');
	for (const [path, content] of contents) { expect(await readFile(join(testWorkspace.directory, path), 'utf8')).toBe(content); }
});

test('Search Dismiss restores match focus across collapsed branches through the actual result tree', async ({ target, application, workbench, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Uses actual workspace content searches.');
	const contents = [
		['a/a.ts', 'ash_focus_token first\nash_focus_token second\n'],
		['b/nested/b.ts', 'ash_focus_token next\nash_focus_token last\n'],
		['c/c.ts', 'ash_focus_token tail\n'],
	] as const;
	for (const [path, content] of contents) {
		await mkdir(join(testWorkspace.directory, dirname(path)), { recursive: true });
		await writeFile(join(testWorkspace.directory, path), content);
	}
	await workbench.search.open();
	await workbench.search.search('ash_focus_token');
	await expect(workbench.search.status).toHaveText('5 results');
	const page = workbench.page;
	const tree = workbench.search.element.getByRole('tree');
	const toolbar = page.getByRole('toolbar', { name: 'Search result actions', exact: true });
	await workbench.menus.select(application, () => toolbar.getByRole('button', { name: 'More Actions', exact: true }).click(), ['View as tree']);
	const folder = (name: string) => tree.getByRole('treeitem', { name, exact: true });
	const file = tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path').getByText('b.ts', { exact: true }) });
	await folder('b').locator('.ash-tree-twistie').click();
	await folder('c').locator('.ash-tree-twistie').click();
	const dismissKey = process.platform === 'darwin' ? 'Meta+Backspace' : 'Delete';
	await tree.locator('.ash-search-match', { hasText: 'ash_focus_token second' }).click();
	await tree.press(dismissKey);
	await expect(workbench.search.status).toHaveText('4 results');
	for (const name of ['b', 'nested']) { await expect(folder(name)).toHaveAttribute('aria-expanded', 'true'); }
	await expect(file).toHaveAttribute('aria-expanded', 'true');
	await expect(folder('c')).toHaveAttribute('aria-expanded', 'false');
	const next = tree.getByRole('treeitem', { name: 'Line 1, column 1: ash_focus_token next', exact: true });
	await expect(next).toHaveAttribute('aria-selected', 'true');
	await expect(tree).toHaveAttribute('aria-activedescendant', (await next.getAttribute('id'))!);
	await expect(tree).toBeFocused();
	await folder('b').locator('.ash-tree-twistie').click();
	await folder('c').locator('.ash-tree-twistie').click();
	await tree.locator('.ash-search-match', { hasText: 'ash_focus_token tail' }).click();
	await tree.press(dismissKey);
	await expect(workbench.search.status).toHaveText('3 results');
	const last = tree.getByRole('treeitem', { name: 'Line 2, column 1: ash_focus_token last', exact: true });
	await expect(last).toHaveAttribute('aria-selected', 'true');
	await expect(tree).toHaveAttribute('aria-activedescendant', (await last.getAttribute('id'))!);
	await expect(tree).toBeFocused();
	for (const [path, content] of contents) { expect(await readFile(join(testWorkspace.directory, path), 'utf8')).toBe(content); }
});

test('Search submits case, regex and file filters to workspace search', async ({ target, workbench, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Uses the real workspace search service.');
	await workbench.search.open();
	const search = workbench.search.element;
	const mainFileLabel = 'main.ts';
	await search.getByRole('button', { name: 'Toggle Search Details', exact: true }).click();
	await search.getByRole('textbox', { name: 'Files to include', exact: true }).fill('**/*.ts');
	await search.getByRole('button', { name: 'Match Case', exact: true }).click();
	await workbench.search.search('value');
	await expect(workbench.search.files).toHaveText([mainFileLabel]);
	await expect(search.locator('.ash-search-preview mark')).toHaveText('value');
	await workbench.search.search('VALUE');
	await expect(workbench.search.status).toHaveText('No results found.');
	await search.getByRole('button', { name: 'Use Regular Expression', exact: true }).click();
	await workbench.search.search('[v]alue');
	await expect(workbench.search.files).toHaveText([mainFileLabel]);
	await search.getByRole('textbox', { name: 'Files to exclude', exact: true }).fill('main.ts');
	await search.getByRole('textbox', { name: 'Files to exclude', exact: true }).press('Enter');
	await expect(workbench.search.status).toHaveText('No results found.');
});

test('Search selects exact matches, opens beside the editor and supports result controls', async ({ target, workbench, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Uses the real workspace search service and editors.');
	await writeFile(join(testWorkspace.directory, 'main.ts'), 'const text = "中文😀 needle needle";\n');
	await workbench.search.open();
	await workbench.search.search('needle');
	const page = workbench.page;
	const search = workbench.search.element;
	const tree = search.getByRole('tree');
	await expect(workbench.search.status).toHaveText('2 results');
	await expect(search.locator('.ash-search-match')).toHaveCount(2);
	await search.locator('.ash-search-match').last().dblclick();
	await expect(workbench.editors.groupAt(0).editor.element).toBeVisible();
	const cursor = page.locator('[data-statusbar-item-id="ash.status.editor.cursor"]');
	await expect(cursor).toContainText('Ln 1, Col 33');
	await expect(workbench.editors.groupAt(0).editor.element.locator('.stanza-editor-selection').first()).toBeVisible();
	await tree.focus();
	await tree.press('ControlOrMeta+Enter');
	await expect(workbench.editors.groups).toHaveCount(2);
	await expect(workbench.editors.groupAt(1).editor.element).toBeVisible();
	await expect(cursor).toContainText('Ln 1, Col 33');
	await workbench.search.query.press('Shift+F4');
	await expect(tree).toBeFocused();
	await expect(cursor).toContainText('Ln 1, Col 26');
	await page.getByRole('button', { name: 'Collapse all results', exact: true }).click();
	await expect(search.locator('.ash-search-match')).toHaveCount(0);
	await tree.focus();
	await tree.press('ArrowRight');
	await expect(search.locator('.ash-search-match')).toHaveCount(2);
	await page.getByRole('button', { name: 'Refresh search', exact: true }).click();
	await expect(workbench.search.status).toHaveText('2 results');
	await page.getByRole('button', { name: 'Clear search results', exact: true }).click();
	await expect(tree.getByRole('treeitem')).toHaveCount(0);
	await expect(workbench.search.query).toHaveValue('');
	await expect(workbench.search.query).toBeFocused();
});

test('Search offers tree view, sorting and accessible help through actual workbench controls', async ({ target, application, workbench, testWorkspace }) => {
	await workbench.search.open();
	const query = workbench.search.query;
	await query.focus();
	await query.press('Alt+F1');
	const help = workbench.page.getByRole('dialog');
	await expect(help).toBeVisible();
	await expect(help.getByRole('textbox')).toHaveValue(/Search across files[\s\S]*Shift\+F4/);
	await workbench.page.keyboard.press('Escape');
	await expect(query).toBeFocused();
	if (target.appServerMode !== 'required') { return; }
	await mkdir(join(testWorkspace.directory, 'src'), { recursive: true });
	await writeFile(join(testWorkspace.directory, 'a.ts'), 'value\n');
	await writeFile(join(testWorkspace.directory, 'src', 'z.ts'), 'value value value\n');
	await workbench.search.search('value');
	const toolbar = workbench.page.getByRole('toolbar', { name: 'Search result actions', exact: true });
	const files = workbench.search.element.locator('.ash-search-file-path .ash-icon-label-text');
	await expect(files).toHaveText(['a.ts', 'main.ts', 'z.ts']);
	await expect(workbench.search.element.locator('.ash-search-file-path .ash-icon-label-description').last()).toContainText('src');
	const openMoreActions = () => toolbar.getByRole('button', { name: 'More Actions', exact: true }).click();
	await workbench.menus.select(application, openMoreActions, ['Sort by match count']);
	await expect(files).toHaveText(['z.ts', 'a.ts', 'main.ts']);
	await workbench.menus.select(application, openMoreActions, ['View as tree']);
	await expect(files).toHaveText(['z.ts', 'a.ts', 'main.ts']);
	const folder = workbench.search.element.getByRole('treeitem', { name: 'src', exact: true });
	await folder.locator('.ash-tree-twistie').click();
	await expect(files).toHaveText(['a.ts', 'main.ts']);
	await folder.locator('.ash-tree-twistie').click();
	await expect(files).toHaveText(['z.ts', 'a.ts', 'main.ts']);
	await expect(workbench.search.element.locator('.ash-search-match')).toHaveCount(5);
});

test('Search title and input geometry remain usable while resizing the actual Sidebar', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Uses the actual Workbench search service.');
	await workbench.search.open();
	const page = workbench.page;
	const sidebar = page.locator('[data-part="sidebar"]');
	const title = sidebar.locator('.ash-pane-composite-title');
	const toolbar = page.getByRole('toolbar', { name: 'Search result actions', exact: true });
	const query = workbench.search.query;
	const replacement = workbench.search.element.getByRole('textbox', { name: 'Replace', exact: true });
	await expect(sidebar.locator('.ash-sidebar-title-label')).toHaveText('Search');
	await expect(workbench.search.element.locator('..').locator('.ash-pane-view-header')).toBeHidden();
	await expect(title.getByRole('toolbar', { name: 'Search result actions', exact: true })).toHaveCount(1);
	await expect(replacement).toBeVisible();
	await workbench.search.search('value');
	await expect(workbench.search.status).toHaveText('1 results');
	const originalToolbar = await toolbar.elementHandle();
	expect(originalToolbar).not.toBeNull();
	await workbench.openExplorer();
	await expect(toolbar).toBeHidden();
	await workbench.search.open();
	await expect(query).toHaveValue('value');
	expect(await originalToolbar!.evaluate(node => node === document.querySelector('.ash-pane-composite-title [aria-label="Search result actions"]'))).toBe(true);
	for (const width of [180, 220, 280, 400, 600]) {
		const frame = await sidebar.locator('..').boundingBox();
		expect(frame).not.toBeNull();
		const sashes = page.locator('.ash-sash-vertical');
		const index = await sashes.evaluateAll((nodes, right) => nodes.findIndex(node => {
			const bounds = node.getBoundingClientRect();
			return bounds.height > 300 && Math.abs(bounds.left + bounds.width / 2 - right) < 12;
		}), frame!.x + frame!.width);
		expect(index, 'The production Sidebar resize boundary is visible').toBeGreaterThanOrEqual(0);
		const sash = await sashes.nth(index).boundingBox();
		expect(sash).not.toBeNull();
		await page.mouse.move(sash!.x + sash!.width / 2, sash!.y + sash!.height / 2);
		await page.mouse.down();
		await page.mouse.move(sash!.x + sash!.width / 2 + width - frame!.width, sash!.y + sash!.height / 2, { steps: 5 });
		await page.mouse.up();
		await expect.poll(async () => (await sidebar.locator('..').boundingBox())!.width).toBeCloseTo(width, 0);
		await workbench.waitForUiIdle();
		const geometry = await sidebar.evaluate(element => {
			const heading = element.querySelector('.ash-pane-composite-title')!;
			const title = heading.querySelector('.ash-sidebar-title-label')!.getBoundingClientRect();
			const actions = heading.querySelector('[aria-label="Search result actions"]')!.getBoundingClientRect();
			const bounds = heading.getBoundingClientRect();
			const widget = element.querySelector('.ash-search-widget')!;
			const query = widget.querySelector('.ash-search-query-field textarea')!.getBoundingClientRect();
			const replacement = widget.querySelector('.ash-search-replace-field textarea')!.getBoundingClientRect();
			return {
				inputWidth: query.width, aligned: Math.abs(query.left - replacement.left) < 0.01 && Math.abs(query.right - replacement.right) < 0.01,
				titleFits: title.right <= actions.left + 0.01 && actions.right <= bounds.right + 0.01,
				toolbarAtTop: actions.bottom <= query.top, fits: widget.scrollWidth <= widget.clientWidth
			};
		});
		expect(geometry.inputWidth).toBeGreaterThanOrEqual(100);
		expect(geometry.aligned).toBe(true);
		expect(geometry.titleFits).toBe(true);
		expect(geometry.toolbarAtTop).toBe(true);
		expect(geometry.fits).toBe(true);
		await test.info().attach(`search-sidebar-${width}px`, { body: await sidebar.screenshot(), contentType: 'image/png' });
	}
	await query.fill('中文😀 long query '.repeat(60));
	await expect.poll(async () => (await query.boundingBox())!.height).toBe(134);
	await query.press('ControlOrMeta+End');
	await expect.poll(() => query.evaluate((input: HTMLTextAreaElement) => input.scrollTop)).toBeGreaterThan(0);
	await expect(query).toHaveCSS('scrollbar-width', 'none');
	await originalToolbar!.dispose();
});

test('Search keeps query options and preserves collapsed file filters', async ({ workbench }) => {
	await workbench.search.open();
	const page = workbench.page;
	const search = workbench.search.element;
	const query = workbench.search.query;
	const matchCase = search.getByRole('button', { name: 'Match Case', exact: true });
	const regex = search.getByRole('button', { name: 'Use Regular Expression', exact: true });
	const details = search.getByRole('button', { name: 'Toggle Search Details', exact: true });
	const include = search.getByRole('textbox', { name: 'Files to include', exact: true });
	const exclude = search.getByRole('textbox', { name: 'Files to exclude', exact: true });
	await expect(search.getByRole('button', { name: 'Search', exact: true })).toHaveCount(0);
	await expect(search.getByRole('checkbox')).toHaveCount(0);
	await expect(details).toHaveAttribute('aria-expanded', 'false');
	await expect(include).toBeHidden();
	await expect(exclude).toBeHidden();

	for (const theme of ['Ash Light', 'Ash Dark', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const themeQuery = page.locator('.ash-quick-pick').getByRole('combobox');
		await themeQuery.fill(theme);
		await themeQuery.press('Enter');
		await expect(page.locator('.ash-quick-pick')).toHaveCount(0);
		await query.focus();
		await expect(query).toBeFocused();
		const geometry = await search.evaluate(element => {
			const field = element.querySelector('.ash-search-query-field')!;
			const bounds = field.getBoundingClientRect();
			const inputBox = field.querySelector('.ash-input-box')!;
			const input = inputBox.querySelector('textarea')!.getBoundingClientRect();
			const options = element.querySelector('.ash-search-query-options')!.getBoundingClientRect();
			const style = getComputedStyle(inputBox);
			const probe = document.createElement('span');
			probe.style.color = 'var(--ash-focusBorder)';
			element.append(probe);
			const focusBorder = getComputedStyle(probe).color;
			probe.remove();
			return {
				height: inputBox.getBoundingClientRect().height,
				inputWidth: input.width,
				// Chromium rects use floats; adjacent edges can differ by a few millionths at 125% scale.
				optionsInside: options.left >= bounds.left && options.right <= bounds.right + 0.01 && options.top >= bounds.top && options.bottom <= bounds.bottom + 0.01,
				border: style.borderColor,
				focusBorder,
				fits: element.scrollWidth <= element.clientWidth,
			};
		});
		expect(geometry.height).toBe(26);
		expect(geometry.inputWidth).toBeGreaterThanOrEqual(100);
		expect(geometry.optionsInside).toBe(true);
		expect(geometry.fits).toBe(true);
		expect(geometry.border).toBe(geometry.focusBorder);
	}

	await query.press('Tab');
	await expect(matchCase).toBeFocused();
	await matchCase.press('Space');
	await expect(matchCase).toBeFocused();
	await expect(matchCase).toHaveAttribute('aria-pressed', 'true');
	await matchCase.press('ArrowRight');
	await expect(search.getByRole('button', { name: 'Match Whole Word', exact: true })).toBeFocused();
	await search.getByRole('button', { name: 'Match Whole Word', exact: true }).press('ArrowRight');
	await expect(regex).toBeFocused();
	await regex.press('Space');
	await expect(regex).toBeFocused();
	await expect(regex).toHaveAttribute('aria-pressed', 'true');
	await regex.press('Tab');
	await expect(search.getByRole('textbox', { name: 'Replace', exact: true })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(search.getByRole('button', { name: 'Preserve Case', exact: true })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(details).toBeFocused();
	await details.press('Enter');
	await expect(details).toHaveAttribute('aria-expanded', 'true');
	await details.press('Tab');
	await expect(include).toBeFocused();
	await include.fill('src/**');
	await include.press('Tab');
	await expect(exclude).toBeFocused();
	await exclude.fill('**/*.test.ts');
	await details.click();
	await expect(include).toBeHidden();
	await details.click();
	await expect(include).toHaveValue('src/**');
	await expect(exclude).toHaveValue('**/*.test.ts');
	await expect(include).toHaveAccessibleName('Files to include');
});

test('Search Editor opens from its command and provides keyboard help', async ({ workbench }) => {
	await workbench.quickaccess.runCommand('search.action.openNewEditor');
	const pane = workbench.page.locator('.ash-search-editor');
	const query = pane.getByRole('textbox', { name: 'Search editor query', exact: true });
	await expect(query).toBeVisible();
	await expect(pane.locator('.stanza-editor')).toBeVisible();
	await query.fill('first\nsecond');
	await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text.includes('first\\nsecond'));
	await query.press('Alt+F1');
	const help = workbench.page.getByRole('dialog');
	await expect(help.getByRole('textbox')).toHaveValue(/search editor[\s\S]*\.code-search/);
	await workbench.page.keyboard.press('Escape');
	await expect(query).toBeFocused();
});

test('Search replaces across lines on disk and undo restores the searched contents', async ({ target, application, workbench, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Uses real workspace files and search engines.');
	const path = join(testWorkspace.directory, 'main.ts');
	await writeFile(path, '中文😀 first\r\nsecond end\r\n');
	if (target.kind === 'electron') {
		await (application as ElectronApplication).evaluate(({ dialog }) => {
			dialog.showMessageBox = async (...args: unknown[]) => {
				(globalThis as typeof globalThis & { searchConfirmation?: unknown; }).searchConfirmation = args.at(-1);
				return { response: 0, checkboxChecked: false };
			};
		});
	}
	await workbench.search.open();
	await workbench.search.search('first\nsecond');
	await expect(workbench.search.status).toHaveText('1 results');
	await workbench.search.element.locator('.ash-search-match').dblclick();
	await expect(workbench.page.locator('[data-statusbar-item-id="ash.status.editor.cursor"]')).toContainText('Ln 2, Col 7');
	await expect(workbench.search.element.getByRole('textbox', { name: 'Replace', exact: true })).toBeVisible();
	await workbench.search.element.getByRole('textbox', { name: 'Replace', exact: true }).fill('updated');
	await workbench.search.element.getByRole('button', { name: 'Replace All', exact: true }).click();
	if (target.kind === 'electron') {
		await expect.poll(() => (application as ElectronApplication).evaluate(() => (globalThis as typeof globalThis & { searchConfirmation?: unknown; }).searchConfirmation)).toMatchObject({ message: 'Replace 1 matches in 1 files?' });
	} else {
		const dialog = workbench.page.getByRole('dialog');
		await expect(dialog).toContainText('Replace 1 matches in 1 files?');
		await dialog.getByRole('button', { name: 'Replace All', exact: true }).click();
	}
	await expect(workbench.search.status).toHaveText('No results found.');
	expect((await readFile(path, 'utf8')).replace(/\r\n/g, '\n')).toBe('中文😀 updated end\n');
	const toolbar = workbench.page.getByRole('toolbar', { name: 'Search result actions', exact: true });
	await workbench.menus.select(application, () => toolbar.getByRole('button', { name: 'More Actions', exact: true }).click(), ['Undo replacement']);
	await expect(workbench.search.status).toHaveText('1 results');
	expect((await readFile(path, 'utf8')).replace(/\r\n/g, '\n')).toBe('中文😀 first\nsecond end\n');
	await workbench.search.element.getByRole('button', { name: 'Use Regular Expression', exact: true }).click();
	await workbench.search.search('(first)\n(second)');
	await expect(workbench.search.status).toHaveText('1 results');
	await workbench.search.element.getByRole('textbox', { name: 'Replace', exact: true }).fill('$2 $1');
	await workbench.search.element.getByRole('button', { name: 'Replace All', exact: true }).click();
	if (target.kind !== 'electron') {
		await workbench.page.getByRole('dialog').getByRole('button', { name: 'Replace All', exact: true }).click();
	}
	await expect(workbench.search.status).toHaveText('No results found.');
	expect((await readFile(path, 'utf8')).replace(/\r\n/g, '\n')).toBe('中文😀 second first end\n');
});

test.describe('Search with a granted browser folder', () => {
	test.use({ openWorkspace: false });
	test('preview, undo, Search Editor source navigation and saved searches use the real browser filesystem', async ({ target, workbench }) => {
		test.skip(target.kind !== 'browser' || target.appServerMode !== 'disabled');
		const page = workbench.page;
		await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const folder = await root.getDirectoryHandle(`search-${crypto.randomUUID()}`, { create: true });
			const writer = await (await folder.getFileHandle('main.txt', { create: true })).createWritable();
			await writer.write('中文😀 first\r\nsecond end\r\nneedle needle\r\n');
			await writer.close();
			Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
		});
		await workbench.quickaccess.runCommand('workbench.action.files.openFolderViaWorkspace');
		// Opening the folder rebuilds Workbench; wait for its new Explorer before navigation.
		await expect(page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.txt', exact: true })).toBeVisible();
		await workbench.search.open();
		await workbench.search.search('needle');
		await expect(workbench.search.status).toHaveText('2 results');
		await expect(workbench.search.element.getByRole('textbox', { name: 'Replace', exact: true })).toBeVisible();
		await workbench.search.element.getByRole('textbox', { name: 'Replace', exact: true }).fill('value');
		const toolbar = page.getByRole('toolbar', { name: 'Search result actions', exact: true });
		await toolbar.getByRole('button', { name: 'More Actions', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Preview replacement', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Apply selected', exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Apply selected', exact: true }).click();
		await expect(workbench.search.status).toHaveText('No results found.');
		await toolbar.getByRole('button', { name: 'More Actions', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Undo replacement', exact: true }).click();
		await expect(workbench.search.status).toHaveText('2 results');
		await toolbar.getByRole('button', { name: 'More Actions', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Open results in Search Editor', exact: true }).click();
		const pane = page.locator('.ash-search-editor:visible');
		const query = pane.getByRole('textbox', { name: 'Search editor query', exact: true });
		await expect(query).toHaveValue('needle');
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorContents(text => text.includes('3:8-3:14: needle'));
		await editor.waitForEditorFocus();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.press('ArrowUp');
		await page.keyboard.press('ControlOrMeta+Enter');
		await expect(page.locator('[data-statusbar-item-id="ash.status.editor.cursor"]')).toContainText('Ln 3, Col 14');
		await workbench.editors.groupAt(0).tabs.filter({ hasText: 'Search Editor' }).click();
		await query.fill('first\nsecond');
		await query.press('ControlOrMeta+Enter');
		await expect(pane.getByRole('status')).toHaveText('1 results');
		await editor.waitForEditorContents(text => text.includes('1:6-2:7: first ↵ second'));
		await workbench.quickaccess.runCommand('workbench.action.files.save');
		const save = page.getByRole('dialog');
		await save.getByRole('textbox').fill('results.code-search');
		await save.getByRole('button').filter({ hasText: /^OK$|^Save$/ }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(query).toHaveValue('first\nsecond');
		await page.getByRole('button', { name: 'Close results.code-search', exact: true }).click();
		await expect(pane).toHaveCount(0);
		await page.getByRole('tab', { name: 'Explorer', exact: true }).click();
		await page.locator('.ash-explorer').getByRole('treeitem', { name: 'results.code-search', exact: true }).dblclick();
		await expect(query).toHaveValue('first\nsecond');
		await editor.waitForEditorContents(text => text.includes('first ↵ second'));

		// Hold the filesystem boundary to switch documents while the old search is still running.
		await page.evaluate(() => {
			const original = FileSystemFileHandle.prototype.getFile;
			let release!: () => void;
			const pending = new Promise<void>(resolve => { release = resolve; });
			FileSystemFileHandle.prototype.getFile = async function () { await pending; return original.call(this); };
			(globalThis as typeof globalThis & { resumeSearchRead?: () => void; }).resumeSearchRead = () => {
				FileSystemFileHandle.prototype.getFile = original;
				release();
			};
		});
		try {
			await query.press('ControlOrMeta+Enter');
			await expect(pane.getByRole('button', { name: 'Search again', exact: true })).toBeDisabled();
			await workbench.quickaccess.runCommand('search.action.openNewEditor');
			await expect(query).toHaveValue('');
			await expect(pane.getByRole('button', { name: 'Search again', exact: true })).toBeEnabled();
		} finally {
			await page.evaluate(() => {
				const boundary = globalThis as typeof globalThis & { resumeSearchRead?: () => void; };
				boundary.resumeSearchRead!();
				delete boundary.resumeSearchRead;
			});
		}
	});
});

test('Search translates query options and file filters into Chinese', async ({ target, workbench, restartWorkbench }) => {
	test.skip(target.appServerMode === 'required', 'Locale restart is covered by the UI projects.');
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectCategory('general');
	await workbench.page.getByRole('combobox', { name: 'Interface language', exact: true }).click();
	await workbench.page.getByRole('option', { name: '简体中文', exact: true }).click();
	({ workbench } = await restartWorkbench());
	await workbench.page.locator('[data-part="activitybar"]').getByRole('tab', { name: '搜索', exact: true }).click();
	const search = workbench.page.locator('.ash-search');
	await expect(search.getByRole('textbox', { name: '搜索工作区', exact: true })).toHaveAttribute('placeholder', '搜索');
	await expect(search.getByRole('button', { name: '区分大小写', exact: true })).toHaveText('Aa');
	await expect(search.getByRole('button', { name: '使用正则表达式', exact: true })).toHaveText('.*');
	await expect(search.getByRole('button', { name: '全字匹配', exact: true })).toHaveText('ab');
	await search.getByRole('button', { name: '切换替换', exact: true }).click();
	await expect(search.getByRole('textbox', { name: '替换', exact: true })).toBeVisible();
	await expect(search.getByRole('button', { name: '保留大小写', exact: true })).toHaveText('AB');
	await search.getByRole('button', { name: '切换搜索详细信息', exact: true }).click();
	await expect(search.getByRole('textbox', { name: '包含的文件', exact: true })).toHaveAttribute('placeholder', '例如 *.ts、src/**/include');
	await expect(search.getByRole('textbox', { name: '排除的文件', exact: true })).toBeVisible();
	const query = search.getByRole('textbox', { name: '搜索工作区', exact: true });
	await query.focus();
	await query.press('Alt+F1');
	await expect(workbench.page.getByRole('dialog').getByRole('textbox')).toHaveValue(/跨文件搜索[\s\S]*移除结果[\s\S]*不会删除文件/);
	await workbench.page.keyboard.press('Escape');
	await expect(query).toBeFocused();
	await workbench.page.getByRole('toolbar', { name: '搜索结果操作', exact: true }).getByRole('button', { name: '更多操作', exact: true }).click();
	await expect(workbench.page.getByRole('menuitem', { name: '移除结果', exact: true })).toBeVisible();
	await expect(workbench.page.getByRole('menuitem', { name: '复制全部结果', exact: true })).toBeVisible();
	await workbench.page.keyboard.press('Escape');
	await workbench.quickaccess.runCommand('search.action.openNewEditor');
	const editorQuery = workbench.page.getByRole('textbox', { name: '搜索编辑器查询', exact: true });
	await expect(editorQuery).toBeVisible();
	await expect(workbench.page.locator('.ash-search-editor').getByRole('button', { name: '重新搜索', exact: true })).toBeVisible();
	await editorQuery.press('Alt+F1');
	await expect(workbench.page.getByRole('dialog').getByRole('textbox')).toHaveValue(/搜索编辑器[\s\S]*\.code-search/);
	await workbench.page.keyboard.press('Escape');
	await expect(editorQuery).toBeFocused();
});

test('Search Copy All leaves the host clipboard intact when its view container is inactive', async ({ target, application, workbench, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Uses actual workspace searches, keybindings and the host clipboard.');
	await writeFile(join(testWorkspace.directory, 'main.ts'), 'ash_active_copy_token\n');
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	const editor = workbench.editors.groupAt(0).editor;
	const binding = '[{"key":"ctrl+alt+y","command":"search.action.copyAll"}]';
	await editor.input.press('ControlOrMeta+A');
	await editor.input.evaluate((element, source) => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', source);
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	}, binding);
	await editor.waitForEditorContents(content => content === binding);
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	const page = workbench.page;
	const seedClipboard = async (): Promise<void> => {
		// The marker belongs to this test; previous clipboard contents are never read.
		if (target.kind === 'browser') {
			await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
			await page.evaluate(() => navigator.clipboard.writeText('ash-inactive-copy-fixture'));
		} else {
			await (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.writeText('ash-inactive-copy-fixture'));
		}
	};
	const readCopied = () => target.kind === 'browser'
		? page.evaluate(() => navigator.clipboard.readText())
		: (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.readText());
	await workbench.search.open();
	await workbench.search.search('ash_active_copy_token');
	await expect(workbench.search.status).toHaveText('1 results');
	await seedClipboard();
	await workbench.search.query.press('Control+Alt+Y');
	const delimiter = process.platform === 'win32' ? '\r\n' : '\n';
	const path = join(testWorkspace.directory, 'main.ts').replace(/^([a-z]):/i, (_prefix, drive: string) => drive.toUpperCase() + ':');
	const expected = path + delimiter + '  1,1: ash_active_copy_token';
	await expect.poll(readCopied).toBe(expected);
	await workbench.openExplorer();
	await expect(workbench.search.element).toBeHidden();
	await seedClipboard();
	await page.keyboard.press('Control+Alt+Y');
	await workbench.waitForUiIdle();
	expect(await readCopied()).toBe('ash-inactive-copy-fixture');
	await expect(workbench.search.element).toBeHidden();
	await workbench.search.open();
	await expect(workbench.search.status).toHaveText('1 results');
	await workbench.search.query.press('Control+Alt+Y');
	await expect.poll(readCopied).toBe(expected);
});

test('Search Copy All copies current retained results through the host clipboard', async ({ target, workbench, testWorkspace, application }) => {
	test.skip(target.appServerMode !== 'required', 'Uses actual workspace searches and the host clipboard.');
	const contents = [
		['src/file10.ts', 'ash_copy_token ten\n'],
		['src/file2.ts', 'ash_copy_token first\nash_copy_token second\n'],
		['root.ts', 'ash_copy_token root\n'],
	] as const;
	await mkdir(join(testWorkspace.directory, 'src'), { recursive: true });
	for (const [path, content] of contents) { await writeFile(join(testWorkspace.directory, path), content); }
	const page = workbench.page;
	// Seed known test content before any clipboard read; never inspect the user's previous clipboard.
	if (target.kind === 'browser') {
		await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.evaluate(() => navigator.clipboard.writeText('ash-search-copy-fixture'));
	} else {
		await (application as ElectronApplication).evaluate(async ({ clipboard }) => { await clipboard.writeText('ash-search-copy-fixture'); });
	}
	const readCopied = () => target.kind === 'browser'
		? page.evaluate(() => navigator.clipboard.readText())
		: (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.readText());
	await workbench.search.open();
	const toolbar = page.getByRole('toolbar', { name: 'Search result actions', exact: true });
	const openMoreActions = () => toolbar.getByRole('button', { name: 'More Actions', exact: true }).click();
	expect(await workbench.menus.inspect(application, openMoreActions)).toContainEqual(expect.objectContaining({ label: 'Copy All', enabled: false }));
	await workbench.search.search('ash_copy_token');
	await expect(workbench.search.status).toHaveText('4 results');
	const copyAll = () => workbench.menus.select(application, openMoreActions, ['Copy All']);
	const delimiter = process.platform === 'win32' ? '\r\n' : '\n';
	const pathLabel = (path: string) => join(testWorkspace.directory, path).replace(/^([a-z]):/i, (_prefix, drive: string) => drive.toUpperCase() + ':');
	const blocks = [
		[pathLabel('src/file2.ts'), '  1,1: ash_copy_token first', '  2,1: ash_copy_token second'].join(delimiter),
		[pathLabel('src/file10.ts'), '  1,1: ash_copy_token ten'].join(delimiter),
		[pathLabel('root.ts'), '  1,1: ash_copy_token root'].join(delimiter),
	];
	await page.getByRole('button', { name: 'Collapse all results', exact: true }).click();
	await copyAll();
	await expect.poll(readCopied).toBe(blocks.join(delimiter + delimiter));
	const tree = workbench.search.element.getByRole('tree');
	await tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path', { hasText: 'file10.ts' }) }).click();
	await workbench.menus.select(application, openMoreActions, ['Dismiss']);
	await expect(workbench.search.status).toHaveText('3 results');
	await copyAll();
	await expect.poll(readCopied).toBe([blocks[0], blocks[2]].join(delimiter + delimiter));
	await writeFile(join(testWorkspace.directory, 'root.ts'), 'ash_copy_token root\nash_copy_token latest\n');
	await page.getByRole('button', { name: 'Refresh search', exact: true }).click();
	await expect(workbench.search.status).toHaveText('5 results');
	await copyAll();
	await expect.poll(readCopied).toBe([blocks[0], blocks[1], blocks[2] + delimiter + '  2,1: ash_copy_token latest'].join(delimiter + delimiter));
	for (const [path, content] of contents.slice(0, 2)) { expect(await readFile(join(testWorkspace.directory, path), 'utf8')).toBe(content); }
	expect(await readFile(join(testWorkspace.directory, 'root.ts'), 'utf8')).toBe('ash_copy_token root\nash_copy_token latest\n');
});

test('Search Copy uses result selection, explicit context rows and collapsed folders through the host clipboard', async ({ target, workbench, testWorkspace, application }) => {
	test.skip(target.appServerMode !== 'required', 'Uses actual workspace searches and the host clipboard.');
	const contents = [['src/file2.ts', '中文😀 ash_copy_selected_token one\nash_copy_selected_token two\n'], ['src/file10.ts', 'ash_copy_selected_token ten\n'], ['root.ts', 'ash_copy_selected_token root\n']] as const;
	await mkdir(join(testWorkspace.directory, 'src'), { recursive: true });
	for (const [path, content] of contents) { await writeFile(join(testWorkspace.directory, path), content); }
	const page = workbench.page;
	// Only read clipboard values after writing a marker owned by this test.
	if (target.kind === 'browser') {
		await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.evaluate(() => navigator.clipboard.writeText('ash-selected-copy-fixture'));
	} else {
		await (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.writeText('ash-selected-copy-fixture'));
	}
	const readCopied = () => target.kind === 'browser' ? page.evaluate(() => navigator.clipboard.readText()) : (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.readText());
	await workbench.search.open();
	await workbench.search.search('ash_copy_selected_token');
	await expect(workbench.search.status).toHaveText('4 results');
	const tree = workbench.search.element.getByRole('tree');
	const first = tree.getByRole('treeitem', { name: 'Line 1, column 6: 中文😀 ash_copy_selected_token one', exact: true });
	const second = tree.getByRole('treeitem', { name: 'Line 2, column 1: ash_copy_selected_token two', exact: true });
	const other = tree.getByRole('treeitem', { name: 'Line 1, column 1: ash_copy_selected_token ten', exact: true });
	await first.click();
	await second.click({ modifiers: ['ControlOrMeta'] });
	await expect(tree.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(2);
	await tree.focus();
	await tree.press('ControlOrMeta+c');
	await expect.poll(readCopied).toBe('1,6: 中文😀 ash_copy_selected_token one');
	await workbench.menus.select(application, () => other.click({ button: 'right' }), ['Copy']);
	await expect.poll(readCopied).toBe('1,1: ash_copy_selected_token ten');
	const delimiter = process.platform === 'win32' ? '\r\n' : '\n';
	const pathLabel = (path: string) => join(testWorkspace.directory, path).replace(/^([a-z]):/i, (_prefix, drive: string) => drive.toUpperCase() + ':');
	const file2 = [pathLabel('src/file2.ts'), '  1,6: 中文😀 ash_copy_selected_token one', '  2,1: ash_copy_selected_token two'].join(delimiter);
	const file10 = [pathLabel('src/file10.ts'), '  1,1: ash_copy_selected_token ten'].join(delimiter);
	const header = tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path', { hasText: 'file2.ts' }) });
	await header.locator('.ash-tree-twistie').click();
	await workbench.menus.select(application, () => header.click({ button: 'right' }), ['Copy']);
	await expect.poll(readCopied).toBe(file2);
	const toolbar = page.getByRole('toolbar', { name: 'Search result actions', exact: true });
	await workbench.menus.select(application, () => toolbar.getByRole('button', { name: 'More Actions', exact: true }).click(), ['View as tree']);
	const folder = tree.getByRole('treeitem', { name: 'src', exact: true });
	await folder.locator('.ash-tree-twistie').click();
	await workbench.menus.select(application, () => folder.click({ button: 'right' }), ['Copy']);
	await expect.poll(readCopied).toBe(file2 + delimiter + delimiter + file10);
	await expect(folder).toHaveAttribute('aria-expanded', 'false');
	await expect(workbench.search.status).toHaveText('4 results');
	for (const [path, content] of contents) { expect(await readFile(join(testWorkspace.directory, path), 'utf8')).toBe(content); }
});

test('Search Copy menus release old row callbacks and follow focus contracts in Electron', async ({ target, application, workbench, testWorkspace }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Exercises Electron Browser menus with an actual workspace search.');
	const page = workbench.page;
	await writeFile(join(testWorkspace.directory, 'main.ts'), 'ash_copy_focus_token original\n');
	await writeFile(join(testWorkspace.directory, 'other.ts'), 'ash_copy_focus_token other\n');
	await page.evaluate(async () => {
		const snapshot = await globalThis.ashTestMainProcess.call('configuration', 'read') as { revision: number; document: { version: 1; source: string; }; };
		const source = JSON.stringify({ ...JSON.parse(snapshot.document.source), 'window.menuStyle': 'custom' });
		await globalThis.ashTestMainProcess.call('configuration', 'update', { expectedRevision: snapshot.revision, document: { version: 1, source } });
	});
	await expect.poll(() => workbench.menus.isSystemMenu(application)).toBe(false);
	await (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.writeText('ash-copy-focus-fixture'));
	const readCopied = () => (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.readText());
	await workbench.search.open();
	await workbench.search.search('ash_copy_focus_token');
	await expect(workbench.search.status).toHaveText('2 results');
	const tree = workbench.search.element.getByRole('tree');
	const first = tree.getByRole('treeitem', { name: 'Line 1, column 1: ash_copy_focus_token original', exact: true });
	const other = tree.getByRole('treeitem', { name: 'Line 1, column 1: ash_copy_focus_token other', exact: true });
	await first.click();
	await tree.press('Enter');
	const editor = workbench.editors.groupAt(0).editor;
	await expect(editor.input).toBeVisible();
	const openCopy = async () => {
		await tree.focus();
		await tree.press('Shift+F10');
		await expect(page.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible();
	};
	await openCopy();
	await page.keyboard.press('Escape');
	await expect(tree).toBeFocused();
	await openCopy();
	await workbench.search.query.focus();
	await page.keyboard.press('Escape');
	await expect(workbench.search.query).toBeFocused();
	await openCopy();
	await workbench.search.query.focus();
	// Dispatch to the result's own content without moving the outside focus first.
	await other.locator('.ash-search-result').dispatchEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 });
	await expect(page.getByRole('menu')).toHaveCount(1);
	await page.keyboard.press('Escape');
	await expect(workbench.search.query).toBeFocused();
	await workbench.menus.select(application, () => other.click({ button: 'right' }), ['Copy']);
	await expect.poll(readCopied).toBe('1,1: ash_copy_focus_token other');
	await first.click();
	const removedContent = await first.locator('.ash-search-result').elementHandle();
	expect(removedContent).not.toBeNull();
	await openCopy();
	await editor.input.focus();
	await writeFile(join(testWorkspace.directory, 'main.ts'), 'ash_copy_focus_token fresh\n');
	await page.getByRole('button', { name: 'Refresh search', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
	await expect(workbench.search.status).toHaveText('2 results');
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(workbench.search.query).toBeFocused();
	// A retained old DOM handle must not reopen a menu after its listeners are released.
	await removedContent!.dispatchEvent('contextmenu', { bubbles: true, cancelable: true });
	await expect(page.getByRole('menu')).toHaveCount(0);
	expect(await readCopied()).toBe('1,1: ash_copy_focus_token other');
	await removedContent!.dispose();
	await tree.getByRole('treeitem', { name: 'Line 1, column 1: ash_copy_focus_token fresh', exact: true }).click();
	await openCopy();
	await editor.input.focus();
	await workbench.openExplorer();
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(workbench.search.element).toBeHidden();
	await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('.ash-search')))).toBe(false);
	expect(await readFile(join(testWorkspace.directory, 'main.ts'), 'utf8')).toBe('ash_copy_focus_token fresh\n');
});

test('Search Copy Path copies file and folder paths through real search and the host clipboard', async ({ target, application, workbench, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Uses an actual workspace search backend.');
	const page = workbench.page;
	const contents = [['src/main.ts', 'ash_copy_path_token main\n'], ['src/other.ts', 'ash_copy_path_token other\n']] as const;
	for (const [path, content] of contents) {
		await mkdir(dirname(join(testWorkspace.directory, path)), { recursive: true });
		await writeFile(join(testWorkspace.directory, path), content);
	}
	if (target.kind === 'browser') {
		await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.evaluate(() => navigator.clipboard.writeText('ash-copy-path-fixture'));
	} else {
		await (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.writeText('ash-copy-path-fixture'));
	}
	const readCopied = () => target.kind === 'browser' ? page.evaluate(() => navigator.clipboard.readText()) : (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.readText());
	const pathLabel = (path: string) => join(testWorkspace.directory, path).replace(/^([a-z]):/i, (_prefix, drive: string) => drive.toUpperCase() + ':');
	await workbench.search.open();
	await workbench.search.search('ash_copy_path_token');
	await expect(workbench.search.status).toHaveText('2 results');
	const tree = workbench.search.element.getByRole('tree');
	const main = tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path', { hasText: 'main.ts' }) });
	const other = tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path', { hasText: 'other.ts' }) });
	await main.click();
	await other.click({ modifiers: ['ControlOrMeta'] });
	const shortcut = process.platform === 'win32' ? 'Shift+Alt+c' : 'ControlOrMeta+Alt+c';
	await tree.press(shortcut);
	await expect.poll(readCopied).toBe(pathLabel('src/main.ts'));
	await workbench.menus.select(application, () => other.click({ button: 'right' }), ['Copy Path']);
	await expect.poll(readCopied).toBe(pathLabel('src/other.ts'));
	await workbench.search.query.focus();
	await workbench.search.query.press(shortcut);
	expect(await readCopied()).toBe(pathLabel('src/other.ts'));
	const toolbar = page.getByRole('toolbar', { name: 'Search result actions', exact: true });
	await workbench.menus.select(application, () => toolbar.getByRole('button', { name: 'More Actions', exact: true }).click(), ['View as tree']);
	const folder = tree.getByRole('treeitem', { name: 'src', exact: true });
	await folder.click();
	await tree.press(shortcut);
	expect(await readCopied()).toBe(pathLabel('src/other.ts'));
	await workbench.menus.select(application, () => folder.click({ button: 'right' }), ['Copy Path']);
	await expect.poll(readCopied).toBe(pathLabel('src'));
	await expect(workbench.search.status).toHaveText('2 results');
	for (const [path, content] of contents) { expect(await readFile(join(testWorkspace.directory, path), 'utf8')).toBe(content); }
});

test('Search Expand All exposes its command only for fully collapsed results and expands the actual backend tree', async ({ target, application, workbench, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Uses an actual workspace search backend.');
	const contents = [['a/main.ts', 'ash_expand_all_token main\n'], ['b/nested/other.ts', 'ash_expand_all_token other\n']] as const;
	for (const [path, content] of contents) {
		await mkdir(dirname(join(testWorkspace.directory, path)), { recursive: true });
		await writeFile(join(testWorkspace.directory, path), content);
	}
	const page = workbench.page;
	await workbench.search.open();
	await workbench.search.search('ash_expand_all_token');
	await expect(workbench.search.status).toHaveText('2 results');
	const tree = workbench.search.element.getByRole('tree');
	const toolbar = page.getByRole('toolbar', { name: 'Search result actions', exact: true });
	await workbench.menus.select(application, () => toolbar.getByRole('button', { name: 'More Actions', exact: true }).click(), ['View as tree']);
	await workbench.quickaccess.open('>search.action.expandSearchResults');
	await expect(workbench.quickaccess.items).toHaveCount(0);
	await workbench.quickaccess.close();
	const collapse = toolbar.getByRole('button', { name: 'Collapse all results', exact: true });
	await collapse.focus();
	await collapse.press('Enter');
	await expect(toolbar.getByRole('button', { name: 'Expand All', exact: true })).toBeFocused();
	await expect(tree.locator('.ash-search-match')).toHaveCount(0);
	await workbench.quickaccess.runCommand('search.action.expandSearchResults');
	await expect(tree.locator('.ash-search-match')).toHaveCount(2);
	await expect(tree.locator('[aria-expanded="false"]')).toHaveCount(0);
	await expect(collapse).toBeFocused();
	await tree.getByRole('treeitem', { name: 'b', exact: true }).locator('.ash-tree-twistie').click();
	await expect(tree).toBeFocused();
	await expect(collapse).toBeVisible();
	await expect(toolbar.getByRole('button', { name: 'Expand All', exact: true })).toHaveCount(0);
	await workbench.search.query.focus();
	await collapse.evaluate((button: HTMLButtonElement) => button.click());
	await expect(workbench.search.query).toBeFocused();
	await toolbar.getByRole('button', { name: 'Expand All', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
	await expect(workbench.search.query).toBeFocused();
	await expect(tree.locator('.ash-search-match')).toHaveCount(2);
	await expect(workbench.search.status).toHaveText('2 results');
	await collapse.click();
	await expect(tree.locator('.ash-search-match')).toHaveCount(0);
	await workbench.openExplorer();
	await expect(workbench.search.element).toBeHidden();
	await workbench.quickaccess.runCommand('search.action.expandSearchResults');
	await expect(workbench.search.element).toBeHidden();
	await expect(workbench.search.element.locator('.ash-search-match')).toHaveCount(0);
	await workbench.search.open();
	await toolbar.getByRole('button', { name: 'Expand All', exact: true }).click();
	await expect(tree.locator('.ash-search-match')).toHaveCount(2);
	for (const [path, content] of contents) { expect(await readFile(join(testWorkspace.directory, path), 'utf8')).toBe(content); }
});
