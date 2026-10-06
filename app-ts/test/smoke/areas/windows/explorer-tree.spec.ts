import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test.describe('Git ignore decorations', () => {
	test.use({ gitRepository: true });
	test.beforeEach(async ({ target, testWorkspace }) => {
		if (target.appServerMode !== 'required') return;
		const root = testWorkspace.directory;
		await mkdir(join(root, 'ignored-dir'));
		await writeFile(join(root, 'ignored-dir', 'child.txt'), 'ignored');
		await writeFile(join(root, 'ignored.log'), 'ignored');
		await writeFile(join(root, 'keep.tmp'), 'kept');
		await writeFile(join(root, '.gitignore'), 'ignored.log\nignored-dir/\n*.tmp\n!keep.tmp\nmain.ts\n');
	});

	test('Explorer grays ignored files and expanded directories and updates after ignore rules change', async ({ target, testWorkspace, workbench }) => {
		test.skip(target.appServerMode !== 'required', 'Requires the Git backend');
		const page = workbench.page;
		const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
		if (await showSidebar.isVisible()) await showSidebar.click();
		const explorer = page.locator('.ash-explorer');
		const ignored = explorer.locator('.ash-icon-label').filter({ has: page.getByText('ignored.log', { exact: true }) });
		const folder = explorer.getByRole('treeitem').filter({ has: page.getByText('ignored-dir', { exact: true }) });
		await expect(ignored).toHaveAttribute('aria-label', 'ignored.log, Ignored by Git');
		const ignoredColor = await ignored.evaluate(element => {
			const reference = document.createElement('span');
			reference.style.color = 'var(--ash-git-decoration-ignored-resource-foreground)';
			element.append(reference);
			const color = getComputedStyle(reference).color;
			reference.remove();
			return color;
		});
		await expect(ignored.locator('.ash-icon-label-text')).toHaveCSS('color', ignoredColor);
		await expect(folder.locator('.ash-icon-label')).toHaveAttribute('aria-label', 'ignored-dir, Ignored by Git');
		await folder.locator('.ash-tree-twistie').click();
		const child = explorer.locator('.ash-icon-label').filter({ has: page.getByText('child.txt', { exact: true }) });
		await expect(child).toHaveAttribute('aria-label', 'child.txt, Ignored by Git');
		await expect(child.locator('.ash-icon-label-text')).toHaveCSS('color', ignoredColor);
		for (const name of ['main.ts', 'keep.tmp']) {
			await expect(explorer.locator('.ash-icon-label').filter({ has: page.getByText(name, { exact: true }) })).not.toHaveAttribute('aria-label', /Ignored by Git/u);
		}
		await page.evaluate(ignoredColor => {
			const explorer = document.querySelector('.ash-explorer')!;
			const failures = new Set<string>();
			let samples = 0;
			let frame = 0;
			const sample = () => {
				for (const label of explorer.querySelectorAll('.ash-icon-label')) {
					const text = label.querySelector('.ash-icon-label-text');
					if (!text || !['ignored.log', 'ignored-dir', 'child.txt'].includes(text.textContent!)) continue;
					samples += 1;
					const color = getComputedStyle(text).color;
					if (color !== ignoredColor || !label.getAttribute('aria-label')?.includes('Ignored by Git')) {
						failures.add(`${text.textContent}: ${color}, ${label.getAttribute('aria-label')}`);
					}
				}
			};
			// Retrying a final CSS assertion misses the undecorated interval between queries.
			const observer = new MutationObserver(sample);
			observer.observe(explorer, { attributes: true, childList: true, subtree: true });
			const tick = () => { sample(); frame = requestAnimationFrame(tick); };
			frame = requestAnimationFrame(tick);
			(window as typeof window & { stopIgnoreColorMonitor: () => { samples: number; failures: string[]; }; }).stopIgnoreColorMonitor = () => {
				observer.disconnect();
				cancelAnimationFrame(frame);
				return { samples, failures: [...failures] };
			};
		}, ignoredColor);
		for (let index = 0; index < 4; index += 1) {
			await writeFile(join(testWorkspace.directory, 'ignored-dir', 'child.txt'), `build output ${index}`);
			const name = `refresh-${index}.txt`;
			await writeFile(join(testWorkspace.directory, name), `change ${index}`);
			await expect(explorer.locator('.ash-icon-label').filter({ has: page.getByText(name, { exact: true }) })).toHaveAttribute('aria-label', `${name}, Untracked`);
		}
		const observation = await page.evaluate(() => (window as typeof window & { stopIgnoreColorMonitor: () => { samples: number; failures: string[]; }; }).stopIgnoreColorMonitor());
		expect(observation.samples).toBeGreaterThan(0);
		expect(observation.failures).toEqual([]);
		await writeFile(join(testWorkspace.directory, '.gitignore'), '*.tmp\n!keep.tmp\nmain.ts\n');
		await expect(ignored).not.toHaveAttribute('aria-label', /Ignored by Git/u);
		await expect(child).not.toHaveAttribute('aria-label', /Ignored by Git/u);
		await expect(ignored.locator('.ash-icon-label-text')).not.toHaveCSS('color', ignoredColor);
		const run = promisify(execFile);
		// Rules outside the workspace have no file-service event; the Git watcher owns them.
		const external = await mkdtemp(join(tmpdir(), 'ash-ignore-rules-'));
		try {
			const rules = join(external, 'ignore');
			await writeFile(rules, 'ignored.log\n');
			await run('git', ['config', 'core.excludesFile', rules], { cwd: testWorkspace.directory });
			await expect(ignored).toHaveAttribute('aria-label', 'ignored.log, Ignored by Git');
			await writeFile(rules, '');
			await expect(ignored).not.toHaveAttribute('aria-label', /Ignored by Git/u);
			await writeFile(join(testWorkspace.directory, 'ignored-dir', '.gitignore'), 'child.txt\n');
			await expect(child).toHaveAttribute('aria-label', 'child.txt, Ignored by Git');
			await writeFile(join(testWorkspace.directory, 'ignored-dir', '.gitignore'), '');
			await expect(child).not.toHaveAttribute('aria-label', /Ignored by Git/u);
			await writeFile(join(testWorkspace.directory, '.git', 'info', 'exclude'), 'ignored.log\n');
			await expect(ignored).toHaveAttribute('aria-label', 'ignored.log, Ignored by Git');
			await run('git', ['add', '-f', 'ignored.log'], { cwd: testWorkspace.directory });
			await expect(ignored).not.toHaveAttribute('aria-label', /Ignored by Git/u);
		} finally {
			await run('git', ['config', '--unset', 'core.excludesFile'], { cwd: testWorkspace.directory });
			await rm(external, { recursive: true, force: true });
		}
		const status = await run('git', ['status', '--porcelain'], { cwd: testWorkspace.directory });
		expect(status.stdout).toContain('keep.tmp');
	});
});

test.beforeEach(async ({ target, testWorkspace }) => {
	if (target.appServerMode !== 'required') return;
	await mkdir(join(testWorkspace.directory, 'tree-parent', 'tree-child'), { recursive: true });
	await writeFile(join(testWorkspace.directory, 'root.ts'), 'root');
	await writeFile(join(testWorkspace.directory, 'tree-parent', 'tree-child', 'leaf.ts'), 'leaf');
	await mkdir(join(testWorkspace.directory, 'tree-other'));
	await writeFile(join(testWorkspace.directory, 'tree-other', 'other.txt'), 'other');
});

test('Explorer scrollbar stays at the pane edge while rows remain inset', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind === 'electron' && target.appServerMode !== 'required', 'Directory reads require App Server on desktop');
	const names = Array.from({ length: 100 }, (_, index) => `scroll-${String(index).padStart(3, '0')}.txt`);
	if (target.appServerMode === 'required') {
		await Promise.all(names.map(name => writeFile(join(testWorkspace.directory, name), name)));
	}
	const page = workbench.page;
	const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
	if (await showSidebar.isVisible()) await showSidebar.click();
	if (target.kind === 'browser' && target.appServerMode === 'disabled') {
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
		const content = sidebar.querySelector(':scope > .ash-workbench-part-content')!.getBoundingClientRect();
		// Fractional borders and SplitView sizing can quantize differently; compare rendered device-pixel edges.
		const edge = Math.round(content.right * devicePixelRatio);
		const track = sidebar.querySelector('.ash-explorer .ash-scrollbar-track-vertical')!.getBoundingClientRect();
		const tree = sidebar.querySelector('.ash-explorer [role="tree"]')!.getBoundingClientRect();
		const row = sidebar.querySelector('.ash-explorer [role="treeitem"]')!.getBoundingClientRect();
		const header = sidebar.querySelector('.ash-explorer-view-pane > .ash-pane-view-header')!.getBoundingClientRect();
		return {
			trackGap: edge - Math.round(track.right * devicePixelRatio),
			treeGap: edge - Math.round(tree.right * devicePixelRatio),
			rowInset: row.left - tree.left,
			rowRightInset: tree.right - row.right,
			headerInset: header.left - bounds.left,
			outerScroll: sidebar.querySelector('.ash-composite-content')!.scrollTop,
		};
	});
	await expect.poll(geometry).toEqual({ trackGap: 0, treeGap: 0, rowInset: 8, rowRightInset: 8, headerInset: 8, outerScroll: 0 });
	const originalTransform = await track.evaluate(element => {
		const transform = element.style.transform;
		element.style.transform = `translateX(-${1 / devicePixelRatio}px)`;
		return transform;
	});
	try {
		await expect.poll(async () => (await geometry()).trackGap).toBe(1);
	} finally {
		await track.evaluate((element, transform) => { element.style.transform = transform; }, originalTransform);
	}
	await expect(track).toHaveAttribute('aria-valuemax', /[1-9]\d*/u);
	await first.hover();
	await page.mouse.wheel(0, 400);
	await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	await tree.focus();
	await tree.press('End');
	await expect(tree.getByRole('treeitem', { name: names.at(-1), exact: true })).toBeVisible();
	await tree.press('Home');
	await expect(first).toBeVisible();
	await page.keyboard.type('scroll-075');
	const typedMatch = tree.getByRole('treeitem', { name: names[75], exact: true });
	await expect(tree).toHaveAttribute('aria-activedescendant', (await typedMatch.getAttribute('id'))!);
	await expect(typedMatch).toBeInViewport();
	await expect(tree).toBeFocused();
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

test('Explorer smooth scrolling accumulates wheel input, keeps touchpad input immediate and honors reduced motion', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind === 'electron' && target.appServerMode !== 'required', 'Directory reads require App Server on desktop');
	const names = Array.from({ length: 100 }, (_, index) => `smooth-${String(index).padStart(3, '0')}.txt`);
	if (target.appServerMode === 'required') await Promise.all(names.map(name => writeFile(join(testWorkspace.directory, name), name)));
	const page = workbench.page;
	const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
	if (await showSidebar.isVisible()) await showSidebar.click();
	if (target.kind === 'browser' && target.appServerMode === 'disabled') {
		await page.evaluate(async names => {
			const root = await navigator.storage.getDirectory();
			const workspace = await root.getDirectoryHandle(`smooth-scroll-${crypto.randomUUID()}`, { create: true });
			for (const name of names) await workspace.getFileHandle(name, { create: true });
			Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => workspace });
		}, names);
		await page.getByRole('button', { name: 'Open Folder', exact: true }).click();
	}
	const explorer = page.locator('.ash-explorer');
	const tree = explorer.getByRole('tree');
	const viewport = explorer.locator('.ash-scrollbar-viewport');
	await expect(tree.getByRole('treeitem', { name: names[0], exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.openSettings');
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await settings.locator('[data-settings-group-id="workbench"]').click();
	await settings.locator('[data-settings-category-id="layout"]').click();
	const smoothScrolling = settings.getByRole('switch', { name: 'Smooth scrolling in lists', exact: true });
	await expect(smoothScrolling).not.toBeChecked();
	await smoothScrolling.focus();
	await smoothScrolling.press('Space');
	await expect(smoothScrolling).toBeChecked();
	await expect(smoothScrolling).not.toHaveAttribute('aria-busy', 'true');
	await settings.locator('.ash-modal-editor-close').click();
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await tree.focus();
	await tree.press('Home');
	await viewport.hover();
	// Sample rendered positions through the actual wheel handler, including its synchronous result.
	await viewport.evaluate(element => {
		const state = window as typeof window & { scrollSamples: Promise<number[]>; };
		state.scrollSamples = new Promise(resolve => {
			element.addEventListener('wheel', () => {
				const values = [element.scrollTop];
				const started = performance.now();
				const sample = () => {
					values.push(element.scrollTop);
					if (performance.now() - started >= 250) resolve(values);
					else requestAnimationFrame(sample);
				};
				requestAnimationFrame(sample);
			}, { once: true });
		});
	});
	await page.mouse.wheel(0, 120);
	await page.mouse.wheel(0, 120);
	const samples = await page.evaluate(() => (window as typeof window & { scrollSamples: Promise<number[]>; }).scrollSamples);
	expect(samples[0]).toBe(0);
	expect(samples.at(-1)).toBe(240);
	expect(new Set(samples.filter(value => value > 0 && value < 240)).size).toBeGreaterThan(1);
	await tree.press('Home');
	await viewport.evaluate(element => {
		element.addEventListener('wheel', () => { (window as typeof window & { immediateWheelPosition: number; }).immediateWheelPosition = element.scrollTop; }, { once: true });
	});
	await page.mouse.wheel(0, 8);
	expect(await page.evaluate(() => (window as typeof window & { immediateWheelPosition: number; }).immediateWheelPosition)).toBe(8);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(page.locator('.ash-workbench')).toHaveClass(/ash-reduce-motion/u);
	for (let index = 0; index < 2; index += 1) {
		await tree.press('Home');
		await viewport.evaluate(element => {
			element.addEventListener('wheel', () => { (window as typeof window & { immediateWheelPosition: number; }).immediateWheelPosition = element.scrollTop; }, { once: true });
		});
		await page.mouse.wheel(0, 120);
		expect(await page.evaluate(() => (window as typeof window & { immediateWheelPosition: number; }).immediateWheelPosition)).toBe(120);
	}
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await tree.press('Home');
	await page.mouse.wheel(0, 120);
	await tree.press('End');
	const end = await viewport.evaluate(element => element.scrollTop);
	await expect(tree.getByRole('treeitem', { name: names.at(-1), exact: true })).toBeVisible();
	await viewport.evaluate(() => new Promise<void>(resolve => {
		const started = performance.now();
		const sample = () => performance.now() - started > 200 ? resolve() : requestAnimationFrame(sample);
		requestAnimationFrame(sample);
	}));
	expect(await viewport.evaluate(element => element.scrollTop)).toBe(end);
	await tree.press('Home');
	await expect(tree.getByRole('treeitem', { name: names[0], exact: true })).toBeVisible();
});

test('Explorer keeps logical row focus when scrolling removes the focused row from the DOM', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind === 'electron' && target.appServerMode !== 'required', 'Directory reads require App Server on desktop');
	const names = Array.from({ length: 100 }, (_, index) => `focus-${String(index).padStart(3, '0')}.txt`);
	if (target.appServerMode === 'required') {
		await Promise.all(names.map(name => writeFile(join(testWorkspace.directory, name), name)));
	}
	const page = workbench.page;
	const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
	if (await showSidebar.isVisible()) await showSidebar.click();
	if (target.kind === 'browser' && target.appServerMode === 'disabled') {
		await page.evaluate(async names => {
			const root = await navigator.storage.getDirectory();
			const workspace = await root.getDirectoryHandle(`focus-scroll-${crypto.randomUUID()}`, { create: true });
			for (const name of names) await workspace.getFileHandle(name, { create: true });
			Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => workspace });
		}, names);
		await page.getByRole('button', { name: 'Open Folder', exact: true }).click();
	}
	const explorer = page.locator('.ash-explorer');
	const tree = explorer.getByRole('tree');
	const viewport = explorer.locator('.ash-scrollbar-viewport');
	await expect(tree.getByRole('treeitem', { name: names[0], exact: true })).toBeVisible();
	for (const theme of ['Ash Dark', 'Ash Light', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		await workbench.quickaccess.select(theme);
		await page.keyboard.press('Tab');
		await tree.focus();
		await tree.press('Home');
		const focused = tree.locator('.ash-tree-row.focused');
		const focusedRowId = await focused.getAttribute('id');
		await expect(focused).toHaveCSS('outline-style', 'solid');
		await expect(tree).toHaveCSS('outline-style', 'none');
		await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
		await expect(focused).toHaveCount(0);
		await expect(tree).toBeFocused();
		expect(await tree.evaluate(element => element.matches(':focus-visible'))).toBe(true);
		await expect(tree).toHaveCSS('outline-style', 'none');
		await viewport.evaluate(element => { element.scrollTop = 0; });
		await expect(focused).toHaveAttribute('id', focusedRowId!);
		await expect(focused).toHaveCSS('outline-style', 'solid');
		await tree.press('End');
		await expect(focused).toBeVisible();
		expect(await focused.getAttribute('id')).not.toBe(focusedRowId);
		await expect(focused).toHaveCSS('outline-style', 'solid');
		await tree.press('Home');
		await expect(focused).toHaveAttribute('id', focusedRowId!);
	}
});

test('Explorer tree guides align with ancestor arrows and settings update without replacing rows', async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.kind === 'electron' && target.appServerMode !== 'required', 'Directory reads require App Server on desktop');
	const page = workbench.page;
	const hasFileIcons = target.appServerMode === 'required';
	if (target.kind === 'electron' && 'windows' in application) {
		const home = await application.evaluate(() => process.env.ASH_HOME!);
		await cp('../extensions/theme-seti', join(home, 'extensions', 'theme-seti'), { recursive: true });
		await page.reload();
		await workbench.waitForReady();
	}
	const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
	if (await showSidebar.isVisible()) await showSidebar.click();
	if (target.kind === 'browser' && target.appServerMode === 'disabled') {
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
			await workbench.quickaccess.runCommand('workbench.action.selectIconTheme');
			await page.getByRole('option', { name: id === null ? 'None' : 'Seti', exact: true }).click();
			await page.keyboard.press('Escape');
			await expect(leaf).toBeVisible();
			await expect(async () => {
				expect(await geometry()).toEqual({ alignment: 0, indent: 4, rootContent: id === null ? 22 : 0, leafContent: id === null ? 26 : 4, rootText: 0, leafText: 4 });
			}).toPass({ timeout: 10_000 });
			expect(await leafRow!.evaluate(row => row.isConnected)).toBe(true);
		}
	}

});

test('Tree settings controls persist their values across a window reload', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'disabled', 'Settings reload is covered by the standalone UI projects');
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

test('List smooth scrolling settings persist and display their Chinese translation', async ({ target, workbench, restartWorkbench }) => {
	test.skip(target.appServerMode !== 'disabled', 'Settings reload is covered by the standalone UI projects');
	let page = workbench.page;
	const openSetting = async (dialogName: string, title: string) => {
		await workbench.quickaccess.runCommand('workbench.action.openSettings');
		const settings = page.getByRole('dialog', { name: dialogName });
		await settings.locator('[data-settings-group-id="workbench"]').click();
		await settings.locator('[data-settings-category-id="layout"]').click();
		return { settings, control: settings.getByRole('switch', { name: title, exact: true }) };
	};
	let setting = await openSetting('Ash Settings', 'Smooth scrolling in lists');
	await expect(setting.control).not.toBeChecked();
	await setting.control.focus();
	await setting.control.press('Space');
	await expect(setting.control).toBeChecked();
	await expect(setting.control).not.toHaveAttribute('aria-busy', 'true');
	await setting.settings.locator('.ash-modal-editor-close').click();
	await page.reload();
	await workbench.waitForReady();
	setting = await openSetting('Ash Settings', 'Smooth scrolling in lists');
	await expect(setting.control).toBeChecked();
	await setting.settings.locator('.ash-modal-editor-close').click();
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ workbench } = await restartWorkbench());
	page = workbench.page;
	setting = await openSetting('Ash 设置', '列表平滑滚动');
	await expect(setting.control).toBeChecked();
	await expect(setting.settings.locator('[data-settings-item-id="workbench.list.smoothScrolling"]')).toContainText('控制列表和树形列表是否使用短动画滚动。');
});
