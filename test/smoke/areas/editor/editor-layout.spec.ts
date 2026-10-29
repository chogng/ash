import { StorageScope, StorageTarget } from '../../../../src/ash/platform/storage/common/storage.js';
import { readStorageEntries, seedStorageOnNextLoad } from '../../../automation/storage.js';
import type { Locator } from '@playwright/test';
import { parseWorkspace } from '../../../../src/ash/platform/workspace/common/workspace.js';
import { expect, test } from '../../../automation/test.js';

interface SashMeasurements {
	readonly paints: number;
	readonly editorPartDimensionReads: number;
	readonly durations: number[];
	readonly frameIntervals: number[];
	readonly initialRaster: { width: number; height: number; };
	readonly rasters: { width: number; height: number; }[];
}

test('startup omits an empty source group created by Open to the Side and preserves unsaved content', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, application, workbench, reloadWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await workbench.openExplorer();
	const file = workbench.page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true });
	await workbench.menus.select(application, () => file.click({ button: 'right' }), ['Open to the Side']);
	await expect(workbench.editors.groups).toHaveCount(2);
	await expect(workbench.editors.groupAt(0).tabs).toHaveCount(0);
	const document = workbench.editors.groupAt(1);
	await expect(document.tabs).toHaveCount(1);
	await document.editor.input.focus();
	await workbench.page.keyboard.press('ControlOrMeta+End');
	await workbench.page.keyboard.insertText('// retained after restart');
	await document.editor.waitForEditorContents(text => text === 'const value = 1;\n// retained after restart');
	for (let restart = 0; restart < 2; restart++) {
		({ workbench } = await reloadWorkbench());
		await expect(workbench.editors.groups).toHaveCount(1);
		await expect(workbench.editors.groupAt(0).tabs).toHaveCount(1);
		await expect(workbench.editors.groupAt(0).tabs).toHaveAttribute('aria-label', 'main.ts, unsaved changes');
		await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text === 'const value = 1;\n// retained after restart');
		await expect.poll(() => workbench.editors.groupAt(0).element.evaluate(element => {
			const content = element.closest('.ash-workbench-part-content')!.getBoundingClientRect();
			return Math.round(content.width - element.getBoundingClientRect().width);
		})).toBe(0);
	}
});

test('closing tabs removes empty editor groups and restores one full-width group', async ({ workbench, reloadWorkbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await page.keyboard.press('ControlOrMeta+N');
	await workbench.editors.groupAt(0).editor.input.focus();
	await expect(workbench.editors.groupAt(0).editor.input).toBeFocused();
	await workbench.quickaccess.runCommand('workbench.action.splitEditorHorizontal');
	await expect(workbench.editors.groups).toHaveCount(2);
	await workbench.editors.groupAt(1).editor.input.focus();
	await expect(workbench.editors.groupAt(1).editor.input).toBeFocused();
	await page.keyboard.press('ControlOrMeta+W');
	await expect(workbench.editors.groups).toHaveCount(1);
	await expect(workbench.editors.groupAt(0).editor.input).toBeFocused();
	await workbench.quickaccess.runCommand('workbench.action.splitEditorHorizontal');
	await expect(workbench.editors.groups).toHaveCount(2);
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await expect(workbench.editors.groups).toHaveCount(1);
	await expect(workbench.editors.groupAt(0).tabs).toHaveCount(0);
	await expect(workbench.editors.groupAt(0).title).toBeHidden();
	await expect(workbench.editors.groupAt(0).watermark).toBeVisible();
	await expect.poll(async () => workbench.editors.groupAt(0).element.evaluate(element => {
		const group = element.getBoundingClientRect();
		const content = element.closest('.ash-workbench-part-content')!.getBoundingClientRect();
		return Math.round(content.width - group.width);
	})).toBe(0);
	await workbench.quickaccess.runCommand('workbench.action.splitEditorHorizontal');
	await expect(workbench.editors.groups).toHaveCount(2);
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await expect(workbench.editors.groups).toHaveCount(1);
	({ workbench } = await reloadWorkbench());
	await expect(workbench.editors.groups).toHaveCount(1);
	await expect(workbench.editors.groupAt(0).welcome).toBeVisible();
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: /Untitled-/u })).toHaveCount(0);
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await expect(workbench.editors.groupAt(0).tabs).toHaveCount(0);
	await expect(workbench.editors.groupAt(0).title).toBeHidden();
});

test('editor group lifecycle keeps recent tabs and sticky editors and focuses empty splits', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	const group = workbench.editors.groupAt(0);
	const names: string[] = [];
	for (let index = 0; index < 3; index++) {
		await page.keyboard.press('ControlOrMeta+N');
		await expect(group.tabs).toHaveCount(index + 1);
		names.push((await group.element.locator('[role="tab"][aria-selected="true"]').getAttribute('aria-label'))!);
	}
	const first = group.tabs.filter({ hasText: names[0]! });
	const third = group.tabs.filter({ hasText: names[2]! });
	await first.click();
	await third.click();
	await group.editor.input.focus();
	await page.keyboard.press('ControlOrMeta+W');
	await expect(first).toHaveAttribute('aria-selected', 'true');
	await expect(group.tabs).toHaveCount(2);
	await workbench.quickaccess.runCommand('workbench.action.pinEditor');
	await expect(group.title.locator('.ash-sticky-editor-tabs-row .ash-tab')).toHaveCount(1);
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await expect(group.tabs).toHaveCount(1);
	await expect(first).toHaveAttribute('aria-selected', 'true');
	await group.editor.input.focus();
	await page.keyboard.press('ControlOrMeta+W');
	await expect(group.tabs).toHaveCount(0);
	await expect(group.element).toBeFocused();
	await expect(group.element).toHaveCSS('outline-style', 'none');
	await workbench.quickaccess.runCommand('workbench.action.splitEditorHorizontal');
	await expect(workbench.editors.groups).toHaveCount(2);
	await expect(workbench.editors.groupAt(1).element).toBeFocused();
	await expect(workbench.editors.groupAt(1).element).toHaveCSS('outline-style', 'solid');
	await expect(workbench.editors.groupAt(1).element).toHaveAttribute('aria-label', 'Empty editor group');
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await expect(workbench.editors.groups).toHaveCount(1);
	await expect(workbench.editors.groupAt(0).element).toBeFocused();
});

test('editor group lifecycle preserves cursor and scrolling through split and tab move', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await page.keyboard.press('ControlOrMeta+N');
	const source = workbench.editors.groupAt(0);
	await source.editor.input.focus();
	await page.keyboard.insertText(Array.from({ length: 160 }, (_, index) => `line ${index}: editor group view state`).join('\n'));
	await page.keyboard.press('ControlOrMeta+Home');
	for (let index = 0; index < 79; index++) await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
	const cursor = page.getByText('Ln 80, Col 3', { exact: true });
	await expect(cursor).toBeVisible();
	const originalName = (await source.tabs.first().getAttribute('aria-label'))!.split(',')[0]!;
	const sourceScroll = source.editor.element.locator(':scope > .ash-smooth-scrollable');
	const scrollTop = await sourceScroll.evaluate(element => element.scrollTop);
	expect(scrollTop).toBeGreaterThan(0);
	await workbench.quickaccess.runCommand('workbench.action.splitEditorHorizontal');
	await expect(workbench.editors.groups).toHaveCount(2);
	const target = workbench.editors.groupAt(1);
	await target.editor.input.focus();
	await expect(cursor).toBeVisible();
	await expect.poll(() => target.editor.element.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBeCloseTo(scrollTop, 0);
	await page.keyboard.press('ControlOrMeta+N');
	await expect(target.tabs).toHaveCount(2);
	await source.editor.input.focus();
	await page.keyboard.press('ControlOrMeta+Home');
	for (let index = 0; index < 39; index++) await page.keyboard.press('ArrowDown');
	await expect(page.getByText('Ln 40, Col 1', { exact: true })).toBeVisible();
	const movedScrollTop = await sourceScroll.evaluate(element => element.scrollTop);
	await source.tabs.filter({ hasText: originalName }).dragTo(target.tabs.last(), { targetPosition: { x: 8, y: 12 } });
	await expect(workbench.editors.groups).toHaveCount(1);
	const remaining = workbench.editors.groupAt(0);
	await expect(remaining.tabs).toHaveCount(2);
	await expect(remaining.tabs.filter({ hasText: originalName })).toHaveAttribute('aria-selected', 'true');
	await expect(remaining.editor.input).toBeFocused();
	await expect(page.getByText('Ln 40, Col 1', { exact: true })).toBeVisible();
	await expect.poll(() => remaining.editor.element.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBeCloseTo(movedScrollTop, 0);
});

test.describe('editor group lifecycle saved state', () => {
	test.use({ openWorkspace: false });
	test('startup removes a previously saved empty group without a close command and keeps one group after restart', async ({ target, application, workbench, reloadWorkbench }) => {
		const page = workbench.page;
		const workspaceId = target.kind === 'electron'
			? parseWorkspace(await page.evaluate(() => (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown>; }; }; }).ash.ipcRenderer.invoke('ash:workspace:context:read'))).id
			: await page.evaluate(() => sessionStorage.getItem('ash.workbench.emptyWorkspaceId'));
		expect(workspaceId).toBeTruthy();
		const state = {
			version: 1, active: 0, parts: [{
				id: 'lastSession', activeGroupIndex: 1, groups: [
					{ id: 'editor-group-empty', size: 0.5, activeEditorIndex: -1, editors: [] },
					{ id: 'editor-group-file', size: 0.5, activeEditorIndex: 0, editors: [{ input: { typeId: 'workbench.editorInput.resource', value: { resource: 'untitled:/restored.json', label: 'restored.json', initialText: '{ "restored": true }' } }, preview: false }] },
				]
			}],
		};
		await seedStorageOnNextLoad(application, page, { scope: StorageScope.WORKSPACE, id: workspaceId! }, { 'editorparts.state': { value: JSON.stringify(state), target: StorageTarget.MACHINE } });
		await page.reload();
		await workbench.waitForReady();
		await expect(workbench.editors.groups).toHaveCount(1);
		await expect(workbench.editors.groupAt(0).tabs).toHaveCount(1);
		await expect(workbench.editors.groupAt(0).tabs).toHaveAttribute('aria-label', 'restored.json, unsaved changes');
		await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text === '{ "restored": true }');
		await expect.poll(() => workbench.editors.groupAt(0).element.evaluate(element => {
			const content = element.closest('.ash-workbench-part-content')!.getBoundingClientRect();
			return Math.round(content.width - element.getBoundingClientRect().width);
		})).toBe(0);
		({ workbench } = await reloadWorkbench());
		await expect(workbench.editors.groups).toHaveCount(1);
		await expect(workbench.editors.groupAt(0).tabs).toHaveCount(1);
		await expect(workbench.editors.groupAt(0).tabs).toHaveAttribute('aria-label', 'restored.json, unsaved changes');
		await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text === '{ "restored": true }');
	});

	test('restores supported tabs around a missing serializer and updates the window title after reload', async ({ target, application, workbench, reloadWorkbench }) => {
		const page = workbench.page;
		const workspaceId = target.kind === 'electron'
			? parseWorkspace(await page.evaluate(() => (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown>; }; }; }).ash.ipcRenderer.invoke('ash:workspace:context:read'))).id
			: await page.evaluate(() => sessionStorage.getItem('ash.workbench.emptyWorkspaceId'));
		expect(workspaceId).toBeTruthy();
		const identity = { scope: StorageScope.WORKSPACE, id: workspaceId! };
		const saved = {
			version: 1, active: 0, parts: [{
				id: 'lastSession', activeGroupIndex: 0, groups: [{
					id: 'editor-group-restored', size: 1, activeEditorIndex: 2, editors: [
						{ input: { typeId: 'workbench.removedSerializer', value: {} }, preview: false },
						{ input: { typeId: 'workbench.editorInput.resource', value: { resource: 'untitled:/restore-first.ts', label: 'restore-first.ts', initialText: '' } }, preview: false, sticky: true },
						{ input: { typeId: 'workbench.editorInput.resource', value: { resource: 'untitled:/restore-second.ts', label: 'restore-second.ts', initialText: '' } }, preview: true },
					]
				}]
			}]
		};
		await seedStorageOnNextLoad(application, page, identity, { 'editorparts.state': { value: JSON.stringify(saved), target: StorageTarget.MACHINE } });
		await page.reload();
		const restored = { application, workbench };
		const group = restored.workbench.editors.groupAt(0);
		await expect(group.tabs).toHaveCount(2);
		await expect(group.tabs.filter({ hasText: 'restore-second.ts' })).toHaveAttribute('aria-selected', 'true');
		await expect(group.title.locator('.ash-sticky-editor-tabs-row .ash-tab')).toHaveCount(1);
		await expect(restored.workbench.page).toHaveTitle(/restore-second.ts/u);
		await group.tabs.filter({ hasText: 'restore-first.ts' }).click();
		await expect(restored.workbench.page).toHaveTitle(/restore-first.ts/u);
		await restored.workbench.page.keyboard.press('ControlOrMeta+N');
		await expect(restored.workbench.page).toHaveTitle(/Untitled-/u);
		await expect.poll(async () => (await readStorageEntries(restored.application, restored.workbench.page, identity))['editorparts.state']).toBeTruthy();
		const restarted = await reloadWorkbench();
		await expect(restarted.workbench.editors.groupAt(0).tabs).toHaveCount(3);
		await expect(restarted.workbench.page).toHaveTitle(/Untitled-/u);
	});
});

for (const groupCount of [1, 2]) {
	test(`sash dragging reuses document rendering with ${groupCount} editor groups`, { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ driver, workbench }, testInfo) => {
		const page = workbench.page;
		await driver.setWindowSize({ width: 1500, height: 900 });
		const sidebar = page.locator('[data-part="sidebar"]');
		if (await sidebar.isHidden()) {
			await page.locator('[data-action-id="workbench.action.toggleSideBar"] button').click();
		}
		await page.keyboard.press('ControlOrMeta+N');
		const editor = workbench.editors.groupAt(0).content.locator('.stanza-editor');
		await editor.locator('.stanza-editor-input').focus();
		await page.keyboard.insertText(Array.from({ length: 100 }, (_, index) => `line ${index}: resize`).join('\n'));
		await page.keyboard.press('ControlOrMeta+Home');
		await expect(editor.locator('.stanza-editor-line-text').first()).toContainText('line 0:');
		if (groupCount === 2) {
			await workbench.quickaccess.runCommand('workbench.action.splitEditorHorizontal');
			await expect(workbench.editors.groups).toHaveCount(2);
			await expect(workbench.editors.groupAt(1).content.locator('.stanza-editor-line-text').first()).toContainText('line 0:');
		}
		const canvas = editor.locator('.minimap canvas');
		await expect(canvas).toBeVisible();
		const before = await sidebar.boundingBox();
		const sash = sidebar.locator('xpath=../../..').locator(':scope > .ash-sash').first();
		const bounds = await sash.boundingBox();
		if (!before || !bounds) throw new Error('Sash drag requires visible sidebar bounds');
		const x = bounds.x + bounds.width / 2;
		const y = bounds.y + bounds.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await canvas.evaluate(element => {
			const canvas = element as HTMLCanvasElement;
			const painter = canvas.getContext('2d')!;
			const original = painter.clearRect;
			const initialRaster = { width: canvas.width, height: canvas.height };
			const durations: number[] = [];
			const frameIntervals: number[] = [];
			const rasters: { width: number; height: number; }[] = [];
			let paints = 0;
			let editorPartDimensionReads = 0;
			const part = canvas.ownerDocument.querySelector<HTMLElement>('[data-part="editor"]')!;
			const dimensionProperties = ['offsetWidth', 'clientWidth', 'offsetHeight', 'clientHeight'] as const;
			for (const name of dimensionProperties) {
				let prototype = Object.getPrototypeOf(part);
				while (!Object.getOwnPropertyDescriptor(prototype, name)) prototype = Object.getPrototypeOf(prototype);
				const getter = Object.getOwnPropertyDescriptor(prototype, name)!.get!;
				Object.defineProperty(part, name, { configurable: true, get() { editorPartDimensionReads++; return getter.call(this); } });
			}
			let start = 0;
			let previousFrame: number | undefined;
			let frame: number;
			const sampleFrame = (time: number): void => {
				if (previousFrame !== undefined) frameIntervals.push(time - previousFrame);
				previousFrame = time;
				frame = requestAnimationFrame(sampleFrame);
			};
			frame = requestAnimationFrame(sampleFrame);
			const begin = (): void => { start = performance.now(); };
			const measure = (): void => { durations.push(performance.now() - start); };
			painter.clearRect = function (...args): void {
				paints += 1;
				rasters.push({ width: canvas.width, height: canvas.height });
				original.apply(this, args);
			};
			window.addEventListener('pointermove', begin, true);
			window.addEventListener('pointermove', measure);
			Object.assign(canvas, {
				finishMeasurement: () => {
					cancelAnimationFrame(frame);
					painter.clearRect = original;
					window.removeEventListener('pointermove', begin, true);
					window.removeEventListener('pointermove', measure);
					for (const name of dimensionProperties) delete (part as unknown as Record<string, unknown>)[name];
					delete (canvas as HTMLCanvasElement & { finishMeasurement?: unknown; }).finishMeasurement;
					return { paints, editorPartDimensionReads, durations, frameIntervals, initialRaster, rasters };
				}
			});
		});
		let metrics: SashMeasurements;
		try {
			await page.mouse.move(x + 120, y, { steps: 24 });
			await page.mouse.up();
			await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(before.width + 120, 0);
			await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
		} finally {
			await page.mouse.up();
			metrics = await canvas.evaluate(element => (element as HTMLCanvasElement & { finishMeasurement(): typeof metrics; }).finishMeasurement());
		}
		await testInfo.attach('sash-performance', { body: JSON.stringify(metrics), contentType: 'application/json' });
		expect(metrics.paints).toBeLessThanOrEqual(24);
		expect(metrics.editorPartDimensionReads).toBe(0);
		expect(new Set([metrics.initialRaster.height, ...metrics.rasters.map(raster => raster.height)]).size).toBe(1);
		await expect(editor.locator('.stanza-editor-line-text').first()).toContainText('line 0:');
		const geometry = await editor.evaluate(element => {
			const editorBounds = element.getBoundingClientRect();
			const contentBounds = element.closest('.ash-editor-group-content')!.getBoundingClientRect();
			return { width: Math.round(editorBounds.width), contentWidth: Math.round(contentBounds.width), scrollTop: element.scrollTop };
		});
		expect(geometry).toEqual({ width: geometry.contentWidth, contentWidth: geometry.contentWidth, scrollTop: 0 });
		for (let index = 0; index < groupCount; index += 1) {
			const resizedEditor = workbench.editors.groupAt(index).content.locator('.stanza-editor');
			await expect(resizedEditor.locator('.stanza-editor-line-text').first()).toContainText('line 0:');
			await expect.poll(async () => resizedEditor.evaluate(element => Math.round(element.getBoundingClientRect().width - element.closest('.ash-editor-group-content')!.getBoundingClientRect().width))).toBe(0);
		}
		await sash.focus();
		await page.keyboard.press('ArrowRight');
		await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(before.width + 130, 0);
	});
}

test.describe('startup layout defaults', () => {
	test.use({ openWorkspace: false });

	test('empty window shows Welcome with sidebars and Panel hidden', { tag: ['@browser-ui', '@electron-ui', '@electron-app-server'] }, async ({ target, workbench }) => {
		const page = workbench.page;
		const workspaceId = target.kind === 'electron'
			? parseWorkspace(await page.evaluate(() => {
				const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown>; }; }; }).ash.ipcRenderer;
				return ipc.invoke('ash:workspace:context:read');
			})).id
			: await page.evaluate(() => sessionStorage.getItem('ash.workbench.emptyWorkspaceId'));
		expect(workspaceId).toMatch(/^empty-window-[0-9a-f-]{36}$/u);
		await expect(page.locator("[data-part='sidebar']")).toBeHidden();
		await expect(page.locator("[data-part='panel']")).toBeHidden();
		await expect(page.locator("[data-part='auxiliarybar']")).toBeHidden();
		await expect(workbench.editors.groupAt(0).welcome).toBeVisible();
	});

	test('opening a browser folder shows Welcome before and after reload', { tag: ['@browser-ui'] }, async ({ target, workbench }) => {
		const page = workbench.page;
		const group = workbench.editors.groupAt(0);
		await expect(group.welcome).toBeVisible();
		await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const folder = await root.getDirectoryHandle(`ash-welcome-${crypto.randomUUID()}`, { create: true });
			await folder.getFileHandle('startup.txt', { create: true });
			Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
		});
		await group.welcome.getByRole('button', { name: 'Open folder', exact: true }).click();
		await expect(page.locator('.ash-explorer').getByRole('treeitem', { name: 'startup.txt', exact: true })).toHaveCount(1);
		await expect(group.welcome).toBeVisible();
		await expect(group.tabs).toHaveCount(1);
		await page.reload();
		await workbench.waitForReady();
		await expect(group.welcome).toBeVisible();
		await expect(group.tabs).toHaveCount(1);
	});

	test('Source Control explains missing providers and empty workspaces', async ({ target, workbench }) => {
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
		await expect(page.locator('[data-view-container-id="ash.git"]')).toHaveClass(/ash-scm-viewlet/u);
		const welcome = page.locator('[data-view-id="ash.gitView"]').getByRole('region', { name: 'Welcome', exact: true });
		await expect(welcome).toContainText(target.appServerMode === 'disabled'
			? 'No source control providers registered.'
			: target.kind === 'browser'
				? 'The open folder does not contain a Git repository.'
				: 'Open a folder containing a Git repository to use source control.');
		await expect(page.locator('.ash-scm-change')).toHaveCount(0);
		const sidebar = page.locator('[data-part="sidebar"]');
		const sash = sidebar.locator('xpath=../../..').locator(':scope > .ash-sash').first();
		await sash.dblclick();
		await expect.poll(async () => sidebar.evaluate(element => element.getBoundingClientRect().width)).toBe(400);
	});

	test('new browser tab starts empty while reload keeps the current layout', async ({ target, workbench }) => {
		if (target.kind !== 'browser' || target.appServerMode !== 'disabled') {
			test.skip();
			return;
		}
		const page = workbench.page;
		const sidebar = page.locator("[data-part='sidebar']");
		await page.locator('[data-action-id="workbench.action.toggleSideBar"] button').click();
		await expect(sidebar).toBeVisible();

		await page.reload();
		await workbench.waitForReady();
		await expect(sidebar).toBeVisible();

		const newTab = await page.context().newPage();
		try {
			await newTab.goto(workbench.page.url());
			await expect(newTab.locator("[data-part='sidebar']")).toBeHidden();
			await expect(newTab.locator('.ash-getting-started')).toBeVisible();
		} finally {
			await newTab.close();
		}
	});
});

test('new desktop workspace shows Explorer and Chat with Panel hidden', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	await expect(page.locator("[data-part='sidebar']")).toBeVisible();
	await expect(page.locator("[data-part='auxiliarybar']")).toBeVisible();
	await expect(page.locator("[data-part='panel']")).toBeHidden();
});

test('Git explains when the open folder has no repository', { tag: ['@electron-app-server'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
	await expect(page.getByText('The open folder does not contain a Git repository. Initialize a repository to start tracking changes.', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Initialize Repository', exact: true })).toBeVisible();
	await expect(page.locator('.ash-scm-change')).toHaveCount(0);
});

test.describe('welcome brand', () => {
	test.use({ openWorkspace: false });

	test('Welcome starts without focusing an action and shows focus during keyboard navigation', async ({ workbench }) => {
		const page = workbench.page;
		const welcome = workbench.editors.groupAt(0).welcome;
		const openFolder = welcome.getByRole('button', { name: 'Open folder', exact: true });
		await expect(welcome).toBeFocused();
		await expect(welcome).toHaveCSS('outline-style', 'none');
		await expect(welcome.locator('button:focus')).toHaveCount(0);

		await page.keyboard.press('Tab');
		await expect(openFolder).toBeFocused();
		await expect(openFolder).toHaveCSS('outline-style', 'solid');
		await expect.poll(() => openFolder.evaluate(element => element.matches(':focus-visible'))).toBe(true);
		await page.keyboard.press('Tab');
		await expect(openFolder).not.toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(openFolder).toBeFocused();
	});

	test('Welcome reopens as an editor from the command palette', async ({ workbench }) => {
		const group = workbench.editors.groupAt(0);
		await expect(group.tabs).toHaveCount(1);
		await group.tabs.first().hover();
		await group.element.locator('.ash-tab-close-action button').click();
		await expect(group.tabs).toHaveCount(0);
		await expect(group.welcome).toHaveCount(0);
		await expect(group.content.locator('.ash-editor-group-watermark-shortcuts')).toBeVisible();
		await workbench.quickaccess.runCommand('workbench.action.openWelcome');
		await expect(group.tabs).toHaveCount(1);
		await expect(group.welcome).toBeVisible();
		await expect(group.title.getByRole('button', { name: 'Reveal in File Explorer' })).toHaveCount(0);
	});

	test('Settings persists empty-editor tips independently of Welcome', async ({ workbench }) => {
		const page = workbench.page;
		const group = workbench.editors.groupAt(0);
		const shortcuts = group.content.locator('.ash-editor-group-watermark-shortcuts');
		await group.tabs.first().hover();
		await group.element.locator('.ash-tab-close-action button').click();
		await expect(shortcuts).toBeVisible();

		await page.keyboard.press('F1');
		await page.locator('.ash-quick-pick').getByRole('combobox').fill('>Ash Settings');
		await page.keyboard.press('Enter');
		const settings = page.locator('.ash-settings-editor');
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('appearance');
		const tips = settings.getByRole('switch', { name: 'Empty editor tips', exact: true });
		await expect(tips).toBeChecked();
		await tips.focus();
		await page.keyboard.press('Space');
		await expect(tips).not.toBeChecked();
		await expect(tips).not.toHaveAttribute('aria-busy', 'true');
		await page.locator('.ash-modal-editor-close').click();
		await expect(shortcuts).toBeHidden();
		await expect(shortcuts.locator('.ash-editor-group-watermark-entry')).toHaveCount(0);

		await page.reload();
		await workbench.waitForReady();
		await expect(group.welcome).toBeVisible();
		await group.tabs.first().hover();
		await group.element.locator('.ash-tab-close-action button').click();
		await expect(shortcuts).toBeHidden();
		await page.keyboard.press('F1');
		await page.locator('.ash-quick-pick').getByRole('combobox').fill('>Welcome');
		await page.keyboard.press('Enter');
		await expect(group.welcome).toBeVisible();
		await page.keyboard.press('F1');
		await page.locator('.ash-quick-pick').getByRole('combobox').fill('>Ash Settings');
		await page.keyboard.press('Enter');
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('appearance');
		await expect(tips).not.toBeChecked();
		await tips.focus();
		await page.keyboard.press('Space');
		await expect(tips).toBeChecked();
		await expect(tips).not.toHaveAttribute('aria-busy', 'true');
		await page.locator('.ash-modal-editor-close').click();
		await expect(group.welcome).toBeVisible();
		await expect(shortcuts).toBeHidden();
		await group.tabs.first().hover();
		await group.element.locator('.ash-tab-close-action button').click();
		await expect(shortcuts).toBeVisible();
	});

	test('Welcome provides keyboard accessibility help', async ({ workbench }) => {
		const page = workbench.page;
		const openFolder = workbench.editors.groupAt(0).welcome.getByRole('button', { name: 'Open folder' });
		await openFolder.focus();
		await page.keyboard.press('Alt+F1');
		const help = page.getByRole('dialog', { name: 'Accessibility Help' });
		await expect(help.getByRole('textbox', { name: 'Accessibility Help' })).toHaveValue(/Use Tab and Shift\+Tab/);
		await page.keyboard.press('Escape');
		await expect(openFolder).toBeFocused();
	});

	test('Clone repo and the Git command open the repository URL input in a desktop window', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench }) => {
		const clone = workbench.editors.groupAt(0).welcome.getByRole('button', { name: 'Clone repo' });
		if (target.kind !== 'electron') {
			await expect(clone).toBeDisabled();
			return;
		}
		await expect(clone).toBeEnabled();
		await clone.click();
		const input = workbench.page.locator('.ash-quick-pick').getByRole('textbox', { name: 'Clone Repository' });
		await expect(input).toBeFocused();
		await workbench.page.keyboard.press('Escape');
		await expect(workbench.page.locator('.ash-quick-pick')).toHaveCount(0);
		await expect(clone).toBeFocused();
		await workbench.quickaccess.runCommand('git.clone');
		await expect(input).toBeFocused();
		await workbench.page.keyboard.press('Escape');
	});

	test('welcome omits command hints and only shows existing recent projects', async ({ target, workbench }) => {
		const welcome = workbench.editors.groupAt(0).welcome;
		await expect(welcome.locator('.ash-editor-group-watermark-shortcuts')).toHaveCount(0);
		if (target.kind === 'browser' && target.appServerMode === 'required') {
			await expect(welcome.locator('.ash-getting-started-recent').getByRole('button')).toHaveCount(1);
		} else {
			await expect(welcome.locator('.ash-getting-started-recent')).toBeHidden();
		}
	});

	test('Connect GitHub reports when account service is unavailable', { tag: ['@browser-ui'] }, async ({ target, workbench }) => {
		await workbench.editors.groupAt(0).welcome.getByRole('button', { name: 'Connect GitHub' }).click();
		const dialog = workbench.page.getByRole('dialog', { name: 'Connect GitHub' });
		await expect(dialog).toContainText('Could not connect GitHub. Try again.');
		await expect(workbench.page.locator('.ash-notification')).toHaveCount(0);
		const [bounds, titlebarBounds] = await Promise.all([dialog.boundingBox(), workbench.page.locator('[data-part="titlebar"]').boundingBox()]);
		const viewport = workbench.page.viewportSize();
		expect(bounds && titlebarBounds && viewport ? {
			centered: Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2) < 8,
			clearOfTitlebar: bounds.y > titlebarBounds.y + titlebarBounds.height,
		} : null).toEqual({ centered: true, clearOfTitlebar: true });
	});

	test('secondary sidebar narrows welcome cards without rearranging them', async ({ driver, workbench }) => {
		await driver.setWindowSize({ width: 1050, height: 800 });
		const page = workbench.page;
		const welcome = workbench.editors.groupAt(0).welcome;
		const primaryBar = page.locator("[data-part='sidebar']");
		const auxiliaryBar = page.locator("[data-part='auxiliarybar']");
		const toggle = page.locator('[data-action-id="workbench.action.toggleAuxiliaryBar"] button');
		const geometry = async () => welcome.evaluate(element => {
			const content = element.querySelector('.ash-getting-started-content')!.getBoundingClientRect();
			const cards = [...element.querySelectorAll('.ash-getting-started-card')].map(card => card.getBoundingClientRect());
			const viewport = element.getBoundingClientRect();
			return {
				editorWidth: Math.round(viewport.width),
				contentTop: Math.round(content.top - viewport.top),
				cardsTop: Math.round(cards[0].top - content.top),
				cardWidth: Math.round(cards[0].width),
				secondCardOnFirstRow: cards[0].top === cards[1].top,
			};
		});

		if (await primaryBar.isHidden()) {
			await page.locator('[data-action-id="workbench.action.toggleSideBar"] button').click();
		}
		await expect(primaryBar).toBeVisible();
		if (await auxiliaryBar.isHidden()) {
			await toggle.click();
		}
		await expect(auxiliaryBar).toBeVisible();
		await expect(toggle.locator('[data-ash-icon-id="layout-sidebar-right-1"]')).toBeVisible();
		const expanded = await geometry();
		await toggle.click();
		await expect(auxiliaryBar).toBeHidden();
		await expect(toggle.locator('[data-ash-icon-id="layout-sidebar-right-off-1"]')).toBeVisible();
		const collapsed = await geometry();
		expect(expanded.editorWidth).toBeLessThan(collapsed.editorWidth);
		expect(expanded.cardWidth).toBeGreaterThanOrEqual(160);
		expect(expanded.cardWidth).toBeLessThan(180);
		expect(collapsed.cardWidth).toBe(180);
		expect({
			contentTop: collapsed.contentTop,
			cardsTop: collapsed.cardsTop,
			secondCardOnFirstRow: collapsed.secondCardOnFirstRow,
		}).toEqual({
			contentTop: expanded.contentTop,
			cardsTop: expanded.cardsTop,
			secondCardOnFirstRow: true,
		});
	});
});

test('editor layout remains valid across workbench window sizes', async ({ driver, workbench }) => {
	const editors = workbench.editors;
	const group = editors.groupAt(0);
	const observedSizes = new Set<string>();

	for (const size of [{ width: 900, height: 700 }, { width: 1200, height: 800 }, { width: 1494, height: 1104 }]) {
		const actualSize = await driver.setWindowSize(size);
		observedSizes.add(`${actualSize.width}x${actualSize.height}`);
		await expect.poll(async () => editorGeometry(editors.element, group.element, group.title, group.content, group.welcome), { message: `editor geometry at ${size.width}x${size.height}` }).toEqual({
			groupFillsEditorClient: true,
			titleAboveContent: true,
			titleHasHeight: true,
			contentHasArea: true,
			welcomeInsideContent: true,
		});
	}

	expect(observedSizes.size).toBe(3);
});

test('split editor groups keep visible boundaries', async ({ workbench }) => {
	const editors = workbench.editors;
	const page = workbench.page;

	for (const command of ['Split Editor Horizontal', 'Split Editor Vertical']) {
		await page.keyboard.press('F1');
		const picker = page.locator('.ash-quick-pick');
		await picker.getByRole('combobox').fill(`>${command}`);
		await expect(picker.locator('.ash-quick-pick-row-label').filter({ hasText: command })).toBeVisible();
		await page.keyboard.press('Enter');
	}

	await expect(editors.groups).toHaveCount(3);
	const borderedPanes = editors.element.locator('.ash-split-view-separator-border > .ash-split-view-pane:not(:first-child)');
	await expect(borderedPanes).toHaveCount(2);
	const borderColor = await editors.element.evaluate(element => {
		const probe = element.ownerDocument.createElement('span');
		probe.style.color = 'var(--ash-editorGroup-border)';
		element.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	});
	await expect.poll(() => borderedPanes.evaluateAll(elements => elements.map(element => {
		const style = getComputedStyle(element, '::before');
		return { color: style.backgroundColor, thickness: element.parentElement?.classList.contains('ash-split-view-horizontal') ? style.width : style.height };
	}))).toEqual([
		{ color: borderColor, thickness: '1px' },
		{ color: borderColor, thickness: '1px' },
	]);
});

async function editorGeometry(editor: Locator, group: Locator, title: Locator, content: Locator, welcome: Locator) {
	const [editorBox, editorClient, groupBox, titleBox, contentBox, welcomeCount] = await Promise.all([
		editor.boundingBox(),
		editor.evaluate(element => {
			const editorElement = element as HTMLElement;
			return {
				x: editorElement.clientLeft,
				y: editorElement.clientTop,
				width: editorElement.clientWidth,
				height: editorElement.clientHeight,
			};
		}),
		group.boundingBox(),
		title.boundingBox(),
		content.boundingBox(),
		welcome.count(),
	]);
	// A closed Welcome editor has no geometry to compare with its content area.
	const welcomeBox = welcomeCount > 0 ? await welcome.boundingBox() : null;
	if (!editorBox || !groupBox || !titleBox || !contentBox) {
		return null;
	}
	const tolerance = 1;
	return {
		groupFillsEditorClient: approximatelyEqual(groupBox.x, editorBox.x + editorClient.x, tolerance)
			&& approximatelyEqual(groupBox.y, editorBox.y + editorClient.y, tolerance)
			&& approximatelyEqual(groupBox.width, editorClient.width, tolerance)
			&& approximatelyEqual(groupBox.height, editorClient.height, tolerance),
		titleAboveContent: titleBox.y + titleBox.height <= contentBox.y + tolerance,
		titleHasHeight: titleBox.height > 0,
		contentHasArea: contentBox.width > 0 && contentBox.height > 0,
		welcomeInsideContent: welcomeBox ? contains(contentBox, welcomeBox, tolerance) : null,
	};
}

function approximatelyEqual(first: number, second: number, tolerance: number): boolean {
	return Math.abs(first - second) <= tolerance;
}

function contains(container: { x: number; y: number; width: number; height: number; }, child: { x: number; y: number; width: number; height: number; }, tolerance: number): boolean {
	return child.x >= container.x - tolerance
		&& child.y >= container.y - tolerance
		&& child.x + child.width <= container.x + container.width + tolerance
		&& child.y + child.height <= container.y + container.height + tolerance;
}
