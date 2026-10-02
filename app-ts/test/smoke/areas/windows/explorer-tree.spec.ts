import { cp, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test.describe('Git ignore decorations', () => {
	test.use({ gitRepository: true });
	test.beforeEach(async ({ target, testWorkspace }) => {
		if (target.kind !== 'electron' || target.appServerMode !== 'required') return;
		const root = testWorkspace.directory;
		await mkdir(join(root, 'ignored-dir'));
		await writeFile(join(root, 'ignored-dir', 'child.txt'), 'ignored');
		await writeFile(join(root, 'ignored.log'), 'ignored');
		await writeFile(join(root, 'keep.tmp'), 'kept');
		await writeFile(join(root, '.gitignore'), 'ignored.log\nignored-dir/\n*.tmp\n!keep.tmp\nmain.ts\n');
	});

	test('Explorer grays ignored files and expanded directories and updates after ignore rules change', async ({ target, testWorkspace, workbench }) => {
		test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'Requires the desktop Git backend');
		const page = workbench.page;
		const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
		if (await showSidebar.isVisible()) await showSidebar.click();
		const explorer = page.locator('.ash-explorer');
		const ignored = explorer.locator('.ash-icon-label').filter({ has: page.getByText('ignored.log', { exact: true }) });
		const folder = explorer.getByRole('treeitem').filter({ has: page.getByText('ignored-dir', { exact: true }) });
		await expect(ignored).toHaveAttribute('aria-label', 'ignored.log, Ignored by Git');
		await expect(ignored.locator('.ash-icon-label-text')).toHaveCSS('color', 'rgb(140, 140, 140)');
		await expect(folder.locator('.ash-icon-label')).toHaveAttribute('aria-label', 'ignored-dir, Ignored by Git');
		await folder.locator('.ash-tree-twistie').click();
		const child = explorer.locator('.ash-icon-label').filter({ has: page.getByText('child.txt', { exact: true }) });
		await expect(child).toHaveAttribute('aria-label', 'child.txt, Ignored by Git');
		await expect(child.locator('.ash-icon-label-text')).toHaveCSS('color', 'rgb(140, 140, 140)');
		for (const name of ['main.ts', 'keep.tmp']) {
			await expect(explorer.locator('.ash-icon-label').filter({ has: page.getByText(name, { exact: true }) })).not.toHaveAttribute('aria-label', /Ignored by Git/u);
		}
		await writeFile(join(testWorkspace.directory, '.gitignore'), '*.tmp\n!keep.tmp\nmain.ts\n');
		await expect(ignored).not.toHaveAttribute('aria-label', /Ignored by Git/u);
		await expect(child).not.toHaveAttribute('aria-label', /Ignored by Git/u);
		await expect(ignored.locator('.ash-icon-label-text')).not.toHaveCSS('color', 'rgb(140, 140, 140)');
		const run = promisify(execFile);
		const status = await run('git', ['status', '--porcelain'], { cwd: testWorkspace.directory });
		expect(status.stdout).toContain('keep.tmp');
	});
});

test.beforeEach(async ({ target, testWorkspace }) => {
	if (target.kind !== 'electron' || target.appServerMode !== 'required') return;
	await mkdir(join(testWorkspace.directory, 'tree-parent', 'tree-child'), { recursive: true });
	await writeFile(join(testWorkspace.directory, 'root.ts'), 'root');
	await writeFile(join(testWorkspace.directory, 'tree-parent', 'tree-child', 'leaf.ts'), 'leaf');
	await mkdir(join(testWorkspace.directory, 'tree-other'));
	await writeFile(join(testWorkspace.directory, 'tree-other', 'other.txt'), 'other');
});

test('Explorer scrollbar stays at the pane edge while rows remain inset', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'Requires the Code Explorer');
	test.skip(target.kind === 'electron' && target.appServerMode !== 'required', 'Directory reads require App Server on desktop');
	const names = Array.from({ length: 100 }, (_, index) => `scroll-${String(index).padStart(3, '0')}.txt`);
	if (target.kind === 'electron') {
		await Promise.all(names.map(name => writeFile(join(testWorkspace.directory, name), name)));
	}
	const page = workbench.page;
	const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
	if (await showSidebar.isVisible()) await showSidebar.click();
	if (target.kind === 'browser') {
		await page.evaluate(async names => {
			const root = await navigator.storage.getDirectory();
			const workspace = await root.getDirectoryHandle(`scroll-edge-${crypto.randomUUID()}`, { create: true });
			for (const name of names) await workspace.getFileHandle(name, { create: true });
			Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => workspace });
		}, names);
		await page.getByRole('button', { name: 'Open Folder', exact: true }).click();
	}
	const explorer = page.locator('.ash-explorer');
	const tree = explorer.getByRole('tree');
	const first = tree.getByRole('treeitem', { name: names[0], exact: true });
	await expect(first).toBeVisible();
	const track = explorer.locator('.ash-scrollbar-track-vertical');
	const viewport = explorer.locator('.ash-scrollbar-viewport');
	const sidebar = page.locator('.ash-workbench-sidebar');
	const geometry = () => sidebar.evaluate(sidebar => {
		const bounds = sidebar.getBoundingClientRect();
		const edge = bounds.right - parseFloat(getComputedStyle(sidebar).borderRightWidth);
		const track = sidebar.querySelector('.ash-explorer .ash-scrollbar-track-vertical')!.getBoundingClientRect();
		const tree = sidebar.querySelector('.ash-explorer [role="tree"]')!.getBoundingClientRect();
		const row = sidebar.querySelector('.ash-explorer [role="treeitem"]')!.getBoundingClientRect();
		const header = sidebar.querySelector('.ash-explorer-view-pane > .ash-pane-view-header')!.getBoundingClientRect();
		return {
			trackGap: edge - track.right,
			treeGap: edge - tree.right,
			rowInset: row.left - tree.left,
			rowRightInset: tree.right - row.right,
			headerInset: header.left - bounds.left,
			outerScroll: sidebar.querySelector('.ash-composite-content')!.scrollTop,
		};
	});
	await expect.poll(geometry).toEqual({ trackGap: 0, treeGap: 0, rowInset: 8, rowRightInset: 8, headerInset: 8, outerScroll: 0 });
	await expect(track).toHaveAttribute('aria-valuemax', /[1-9]\d*/u);
	await first.hover();
	await page.mouse.wheel(0, 400);
	await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	await tree.focus();
	await tree.press('End');
	await expect(tree.getByRole('treeitem', { name: names.at(-1), exact: true })).toBeVisible();
	await tree.press('Home');
	await expect(first).toBeVisible();
	for (const theme of ['Ash Light', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		await workbench.quickaccess.select(theme);
		await expect.poll(geometry).toEqual({ trackGap: 0, treeGap: 0, rowInset: 8, rowRightInset: 8, headerInset: 8, outerScroll: 0 });
	}
	await workbench.quickaccess.runCommand('workbench.action.openSettings');
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await settings.locator('[data-settings-group-id="workbench"]').click();
	await settings.locator('[data-settings-category-id="layout"]').click();
	const style = settings.locator('[data-configuration-key="workbench.layoutStyle"]').getByRole('combobox');
	for (const label of ['Flat', 'Modern']) {
		await style.click();
		await page.getByRole('option', { name: label, exact: true }).click();
		const inset = label === 'Modern' ? 8 : 0;
		await expect.poll(geometry).toEqual({ trackGap: 0, treeGap: 0, rowInset: inset, rowRightInset: inset, headerInset: inset, outerScroll: 0 });
	}
	await settings.locator('.ash-modal-editor-close').click();
});

test('Explorer tree guides align with ancestor arrows and settings update without replacing rows', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'Requires the Code Explorer');
	test.skip(target.kind === 'electron' && target.appServerMode !== 'required', 'Directory reads require App Server on desktop');
	const page = workbench.page;
	const hasFileIcons = target.kind === 'electron';
	if (target.kind === 'electron' && 'windows' in application) {
		const home = await application.evaluate(() => process.env.ASH_HOME!);
		await cp('../extensions/theme-seti', join(home, 'extensions', 'theme-seti'), { recursive: true });
		await page.reload();
		await workbench.waitForReady();
	}
	const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
	if (await showSidebar.isVisible()) await showSidebar.click();
	if (target.kind === 'browser') {
		await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const workspace = await root.getDirectoryHandle(`tree-guides-${crypto.randomUUID()}`, { create: true });
			await workspace.getFileHandle('root.ts', { create: true });
			const parent = await workspace.getDirectoryHandle('tree-parent', { create: true });
			const child = await parent.getDirectoryHandle('tree-child', { create: true });
			await child.getFileHandle('leaf.ts', { create: true });
			const other = await workspace.getDirectoryHandle('tree-other', { create: true });
			await other.getFileHandle('other.txt', { create: true });
			Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => workspace });
		});
		await page.getByRole('button', { name: 'Open Folder', exact: true }).click();
	}
	const explorer = page.locator('.ash-explorer');
	const parent = explorer.getByRole('treeitem', { name: 'tree-parent', exact: true });
	const child = explorer.getByRole('treeitem').filter({ has: page.getByText('tree-child', { exact: true }) });
	const leaf = explorer.getByRole('treeitem').filter({ has: page.getByText('leaf.ts', { exact: true }) });
	const other = explorer.getByRole('treeitem', { name: 'tree-other', exact: true });
	await parent.locator('.ash-tree-twistie').click();
	await child.locator('.ash-tree-twistie').click();
	await other.locator('.ash-tree-twistie').click();
	const rootFile = explorer.getByRole('treeitem').filter({ has: page.getByText('root.ts', { exact: true }) });
	const guide = leaf.locator('.ash-tree-indent-guide').first();
	await page.mouse.move(0, 0);
	await expect(guide).toHaveCSS('border-left-color', 'rgba(0, 0, 0, 0)');
	await leaf.hover();
	await expect(guide).not.toHaveCSS('border-left-color', 'rgba(0, 0, 0, 0)');
	const geometry = async () => {
		const arrow = await parent.locator('.ash-tree-twistie .ash-icon').boundingBox();
		const childArrow = await child.locator('.ash-tree-twistie .ash-icon').boundingBox();
		const line = await guide.boundingBox();
		const rootContent = await rootFile.locator('.ash-tree-contents').boundingBox();
		const leafContent = await leaf.locator('.ash-tree-contents').boundingBox();
		const folderText = await parent.locator('.ash-icon-label-text').boundingBox();
		const childText = await child.locator('.ash-icon-label-text').boundingBox();
		const rootText = await rootFile.locator('.ash-icon-label-text').boundingBox();
		const leafText = await leaf.locator('.ash-icon-label-text').boundingBox();
		return { alignment: line!.x - arrow!.x - arrow!.width / 2, indent: childArrow!.x - arrow!.x, rootContent: rootContent!.x - arrow!.x, leafContent: leafContent!.x - childArrow!.x, rootText: rootText!.x - folderText!.x, leafText: leafText!.x - childText!.x };
	};
	const reservedTwistieWidth = hasFileIcons ? 0 : 22;
	if (hasFileIcons) {
		await expect(rootFile.locator('.ash-file-icon')).toBeVisible();
		const metrics = await leaf.locator('.ash-file-icon').evaluate(async icon => {
			const style = getComputedStyle(icon);
			await document.fonts.load(`${style.fontSize} ${style.fontFamily}`);
			const range = document.createRange();
			range.selectNodeContents(icon);
			const context = document.createElement('canvas').getContext('2d')!;
			context.font = `${style.fontSize} ${style.fontFamily}`;
			const text = context.measureText(icon.textContent!);
			const guide = icon.closest('.ash-tree-row')!.querySelector('.ash-tree-indent-guide:last-child')!.getBoundingClientRect();
			return { content: icon.textContent, family: style.fontFamily, fontSize: style.fontSize, advance: text.width, originOffset: range.getBoundingClientRect().x - icon.getBoundingClientRect().x, inkGap: range.getBoundingClientRect().x - text.actualBoundingBoxLeft - guide.x - 1, expectedInkGap: -text.actualBoundingBoxLeft - 1 };
		});
		console.log('Seti guide clearance', metrics);
		expect(metrics.originOffset).toBeCloseTo(0, 2);
		expect(metrics.inkGap).toBeCloseTo(metrics.expectedInkGap, 2);
	}
	expect(await geometry()).toEqual({ alignment: 0, indent: 8, rootContent: reservedTwistieWidth, leafContent: 8 + reservedTwistieWidth, rootText: 0, leafText: 8 });
	await expect(explorer.locator('.ash-icon-label-description:visible')).toHaveCount(0);
	await leaf.locator('.ash-icon-label').hover();
	await expect(page.locator('.ash-hover').filter({ hasText: /tree-parent\/tree-child\/leaf\.ts/u })).toBeVisible();
	await page.mouse.move(0, 0);
	const leafRow = await leaf.elementHandle();
	await leaf.locator('.ash-tree-contents').click();
	await expect(leaf.locator('.ash-tree-indent-guide.active')).toHaveCount(1);
	await page.mouse.move(0, 0);
	await expect(leaf.locator('.ash-tree-indent-guide.active')).not.toHaveCSS('border-left-color', 'rgba(0, 0, 0, 0)');

	await workbench.quickaccess.runCommand('workbench.action.openSettings');
	await page.locator('[data-settings-group-id="workbench"]').click();
	await page.locator('[data-settings-category-id="layout"]').click();
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	const search = settings.getByRole('searchbox', { name: 'Search settings' });
	await search.fill('@id:workbench.tree.indent');
	const indent = settings.getByRole('spinbutton', { name: 'Tree indentation', exact: true });
	await expect(indent).toHaveValue('8');
	await expect(indent).toHaveAttribute('min', '4');
	await expect(indent).toHaveAttribute('max', '40');
	for (const value of [4, 5, 6, 16, 40, 20]) {
		await indent.fill(String(value));
		await indent.press('Tab');
		await expect(indent).toHaveValue(String(value));
		await expect.poll(geometry).toEqual({ alignment: 0, indent: value, rootContent: reservedTwistieWidth, leafContent: value + reservedTwistieWidth, rootText: 0, leafText: value });
	}
	await indent.fill('6');
	for (const value of [5, 4]) {
		await indent.press('ArrowDown');
		await indent.press('Tab');
		await expect(indent).toHaveValue(String(value));
		await expect.poll(geometry).toEqual({ alignment: 0, indent: value, rootContent: reservedTwistieWidth, leafContent: value + reservedTwistieWidth, rootText: 0, leafText: value });
	}
	await search.fill('@id:workbench.tree.renderIndentGuides');
	const mode = settings.locator('[data-configuration-key="workbench.tree.renderIndentGuides"]').getByRole('combobox');
	await mode.click();
	await page.getByRole('option', { name: 'None', exact: true }).click();
	await expect(explorer.getByRole('tree')).toHaveClass(/ash-tree-indent-guides-none/u);
	await expect(leaf.locator('.ash-tree-indent-guide.active')).toHaveCSS('border-left-color', 'rgba(0, 0, 0, 0)');
	await mode.click();
	await page.getByRole('option', { name: 'Always', exact: true }).click();
	await settings.locator('.ash-modal-editor-close').click();
	await page.mouse.move(0, 0);
	await expect(guide).not.toHaveCSS('border-left-color', 'rgba(0, 0, 0, 0)');
	expect(await leafRow!.evaluate(row => row.isConnected)).toBe(true);
	await leaf.locator('.ash-tree-contents').click();
	await page.keyboard.press('ArrowLeft');
	await page.keyboard.press('ArrowLeft');
	await expect(child).toHaveAttribute('aria-expanded', 'false');
	await page.keyboard.press('ArrowRight');
	await expect(leaf).toBeVisible();
	if (hasFileIcons) {
		for (const id of [null, 'vs-seti']) {
			await page.evaluate(async id => {
				const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
				const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { source: string } };
				const values = JSON.parse(snapshot.document.source);
				values['workbench.iconTheme'] = id;
				await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(values) } });
			}, id);
			await expect.poll(geometry).toEqual({ alignment: 0, indent: 4, rootContent: id === null ? 22 : 0, leafContent: id === null ? 26 : 4, rootText: 0, leafText: 4 });
			expect(await leafRow!.evaluate(row => row.isConnected)).toBe(true);
		}
	}

});

test('Tree settings controls persist their values across a window reload', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'Settings reload is covered by the standalone UI projects');
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.openSettings');
	await page.locator('[data-settings-group-id="workbench"]').click();
	await page.locator('[data-settings-category-id="layout"]').click();
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	const search = settings.getByRole('searchbox', { name: 'Search settings' });
	await search.fill('@id:workbench.tree.indent');
	const indent = settings.getByRole('spinbutton', { name: 'Tree indentation', exact: true });
	await expect(indent).toHaveValue('8');
	await indent.fill('16');
	await indent.press('Tab');
	await search.fill('@id:workbench.tree.renderIndentGuides');
	const mode = settings.locator('[data-configuration-key="workbench.tree.renderIndentGuides"]').getByRole('combobox');
	await mode.click();
	await page.getByRole('option', { name: 'Always', exact: true }).click();
	await settings.locator('.ash-modal-editor-close').click();
	await page.reload();
	await workbench.waitForReady();

	await workbench.quickaccess.runCommand('workbench.action.openSettings');
	await page.locator('[data-settings-group-id="workbench"]').click();
	await page.locator('[data-settings-category-id="layout"]').click();
	await search.fill('@id:workbench.tree.indent');
	await expect(indent).toHaveValue('16');
	await search.fill('@id:workbench.tree.renderIndentGuides');
	await expect(mode).toHaveText('Always');
});
