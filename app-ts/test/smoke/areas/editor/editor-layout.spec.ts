import type { Locator } from "@playwright/test";
import { parseWorkspace } from "../../../../src/ash/platform/workspace/common/workspace.js";
import { expect, test } from "../../../automation/test.js";

interface SashMeasurements {
	readonly paints: number;
	readonly editorPartDimensionReads: number;
	readonly durations: number[];
	readonly frameIntervals: number[];
	readonly initialRaster: { width: number; height: number };
	readonly rasters: { width: number; height: number }[];
}

for (const groupCount of [1, 2]) {
	test(`sash dragging reuses document rendering with ${groupCount} editor groups`, async ({ driver, workbench }, testInfo) => {
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
			const rasters: { width: number; height: number }[] = [];
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
			Object.assign(canvas, { finishMeasurement: () => {
				cancelAnimationFrame(frame);
				painter.clearRect = original;
				window.removeEventListener('pointermove', begin, true);
				window.removeEventListener('pointermove', measure);
				for (const name of dimensionProperties) delete (part as unknown as Record<string, unknown>)[name];
				delete (canvas as HTMLCanvasElement & { finishMeasurement?: unknown }).finishMeasurement;
				return { paints, editorPartDimensionReads, durations, frameIntervals, initialRaster, rasters };
			} });
		});
		let metrics: SashMeasurements;
		try {
			await page.mouse.move(x + 120, y, { steps: 24 });
			await page.mouse.up();
			await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(before.width + 120, 0);
			await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
		} finally {
			await page.mouse.up();
			metrics = await canvas.evaluate(element => (element as HTMLCanvasElement & { finishMeasurement(): typeof metrics }).finishMeasurement());
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

	test('empty window shows Welcome with sidebars and Panel hidden', async ({ target, workbench }) => {
		test.skip(target.kind === 'browser' && target.appServerMode === 'required');
		const page = workbench.page;
		const workspaceId = target.kind === 'electron'
			? parseWorkspace(await page.evaluate(() => {
				const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
				return ipc.invoke('ash:workspace:context:read');
			})).id
			: await page.evaluate(() => sessionStorage.getItem('ash.workbench.emptyWorkspaceId'));
		expect(workspaceId).toMatch(/^empty-window-[0-9a-f-]{36}$/u);
		await expect(page.locator("[data-part='sidebar']")).toBeHidden();
		await expect(page.locator("[data-part='panel']")).toBeHidden();
		await expect(page.locator("[data-part='auxiliarybar']")).toBeHidden();
		await expect(workbench.editors.groupAt(0).welcome).toBeVisible();
	});

	test('opening a browser folder shows Welcome before and after reload', async ({ target, workbench }) => {
		test.skip(target.kind !== 'browser' || target.appServerMode !== 'disabled', 'Requires the standalone browser folder picker.');
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

	test('Git explains that an empty window needs a folder', async ({ workbench }) => {
		const page = workbench.page;
		await page.getByRole('tab', { name: 'Git', exact: true }).click();
		await expect(page.locator('[data-view-container-id="ash.git"]')).toHaveClass(/ash-scm-viewlet/u);
		await expect(page.locator('.ash-scm-status')).toHaveText('Open a folder to use source control.');
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
			await newTab.goto(target.baseURL);
			await expect(newTab.locator("[data-part='sidebar']")).toBeHidden();
			await expect(newTab.locator('.ash-getting-started')).toBeVisible();
		} finally {
			await newTab.close();
		}
	});
});

test('new desktop workspace shows Explorer and Chat with Panel hidden', async ({ target, workbench }) => {
	test.skip(target.kind !== 'electron');
	const page = workbench.page;
	await expect(page.locator("[data-part='sidebar']")).toBeVisible();
	await expect(page.locator("[data-part='auxiliarybar']")).toBeVisible();
	await expect(page.locator("[data-part='panel']")).toBeHidden();
});

test('Git explains when the open folder has no repository', async ({ target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop App Server workspace.');
	const page = workbench.page;
	await page.getByRole('tab', { name: 'Git', exact: true }).click();
	await expect(page.locator('.ash-scm-status')).toHaveText('No Git repository found in the open folder.');
	await expect(page.locator('.ash-scm-change')).toHaveCount(0);
});

test("startup shows Welcome in both empty windows and open workspaces", async ({ workbench }) => {
	const editors = workbench.editors;
	const group = editors.groupAt(0);

	await expect(editors.element).toBeVisible();
	await expect(group.element).toBeVisible();
	await expect(group.title).toBeVisible();
	await expect(group.content).toBeVisible();
	await expect(group.welcome).toBeVisible();
	await expect(group.tabs).toHaveCount(1);

	await expect.poll(async () => editorGeometry(editors.element, group.element, group.title, group.content, group.welcome)).toEqual({
		groupFillsEditorClient: true,
		titleAboveContent: true,
		titleHasHeight: true,
		contentHasArea: true,
		welcomeInsideContent: true,
	});
});

test.describe('welcome brand', () => {
	test.use({ openWorkspace: false });

	test('Welcome reopens as an editor from the command palette', async ({ workbench }) => {
		const group = workbench.editors.groupAt(0);
		await expect(group.tabs).toHaveCount(1);
		await group.tabs.first().hover();
		await group.element.locator('.ash-tab-close-action button').click();
		await expect(group.tabs).toHaveCount(0);
		await expect(group.welcome).toHaveCount(0);
		await expect(group.content.locator('.ash-editor-group-watermark-shortcuts')).toBeVisible();
		await workbench.page.keyboard.press('F1');
		await workbench.page.locator('.ash-quick-pick').getByRole('combobox').fill('Welcome');
		await workbench.page.keyboard.press('Enter');
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
		await page.locator('.ash-quick-pick').getByRole('combobox').fill('Ash Settings');
		await page.keyboard.press('Enter');
		const settings = page.locator('.ash-settings-editor');
		await settings.locator('[data-settings-group-id="workbench"]').click();
		await settings.locator('[data-settings-category-id="appearance"]').click();
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
		await page.locator('.ash-quick-pick').getByRole('combobox').fill('Welcome');
		await page.keyboard.press('Enter');
		await expect(group.welcome).toBeVisible();
		await page.keyboard.press('F1');
		await page.locator('.ash-quick-pick').getByRole('combobox').fill('Ash Settings');
		await page.keyboard.press('Enter');
		await settings.locator('[data-settings-group-id="workbench"]').click();
		await settings.locator('[data-settings-category-id="appearance"]').click();
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

	test('welcome displays only the Ash name above the actions', async ({ workbench }) => {
		const welcome = workbench.editors.groupAt(0).welcome;
		await expect(welcome.locator('.ash-getting-started-name')).toHaveText('ASH');
		await expect(welcome.locator('.ash-getting-started-plan')).toHaveCount(0);
		await expect(welcome.getByRole('button', { name: 'Open folder' })).toBeVisible();
	});

	test('Clone repo and the Git command open the repository URL input in a desktop window', async ({ target, workbench }) => {
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
		await workbench.page.keyboard.press('F1');
		await workbench.page.locator('.ash-quick-pick').getByRole('combobox').fill('Git: Clone Repository');
		await workbench.page.keyboard.press('Enter');
		await expect(input).toBeFocused();
		await workbench.page.keyboard.press('Escape');
	});

	test('welcome omits the command hint and empty recent projects', async ({ workbench }) => {
		const welcome = workbench.editors.groupAt(0).welcome;
		await expect(welcome.locator('.ash-editor-group-watermark-shortcuts')).toHaveCount(0);
		await expect(welcome.locator('.ash-getting-started-recent')).toBeHidden();
	});

	test('welcome actions use gray cards and a black GitHub card', async ({ workbench }) => {
		const cards = workbench.editors.groupAt(0).welcome.locator('.ash-getting-started-card');
		await expect(cards).toHaveCount(4);
		await expect(cards.locator('.ash-getting-started-card-label')).toHaveText(['Open folder', 'Clone repo', 'Connect via SSH', 'Connect GitHub']);
		for (const index of [0, 1, 2]) {
			const card = cards.nth(index);
			await expect(card).toHaveCSS('background-color', 'rgb(243, 243, 243)');
			await expect(card).toHaveCSS('border-color', 'rgb(212, 212, 212)');
			await expect(card).toHaveCSS('opacity', '1');
			await expect(card.locator('svg.ash-icon')).toHaveCSS('width', '16px');
			await card.hover();
			await expect(card).toHaveCSS('background-color', 'rgb(228, 228, 228)');
		}
		const github = cards.nth(3);
		await expect(github).toBeEnabled();
		await expect(github.locator('.ash-getting-started-card-arrow')).toHaveCount(0);
		await expect(github).toHaveCSS('background-color', 'rgb(0, 0, 0)');
		await expect(github).toHaveCSS('color', 'rgb(255, 255, 255)');
		await expect(github.locator('svg.ash-icon')).toHaveCSS('color', 'rgb(255, 255, 255)');
		await expect(github.locator('svg.ash-icon path').first()).toHaveCSS('fill', 'rgb(255, 255, 255)');
		await github.hover();
		await expect(github).toHaveCSS('background-color', 'rgb(38, 38, 38)');
	});

	test('Connect GitHub reports when account service is unavailable', async ({ target, workbench }) => {
		test.skip(target.kind !== 'browser' || target.appServerMode !== 'disabled');
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

	test('welcome actions have compact, even spacing', async ({ workbench }) => {
		const cards = workbench.editors.groupAt(0).welcome.locator('.ash-getting-started-card');
		await expect(cards).toHaveCount(4);
		const boxes = await Promise.all([0, 1, 2, 3].map(index => cards.nth(index).boundingBox()));
		const [topLeft, topRight, bottomLeft, bottomRight] = boxes;
		expect(topLeft && topRight && bottomLeft && bottomRight ? {
			columnGap: Math.round(topRight.x - topLeft.x - topLeft.width),
			rowGap: Math.round(bottomLeft.y - topLeft.y - topLeft.height),
			leftColumnAligned: topLeft.x === bottomLeft.x,
			rightColumnAligned: topRight.x === bottomRight.x,
		} : null).toEqual({
			columnGap: 12,
			rowGap: 12,
			leftColumnAligned: true,
			rightColumnAligned: true,
		});
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
		await expect(toggle.locator('svg[data-ash-icon-id="layout-sidebar-right-1"]')).toBeVisible();
		const expanded = await geometry();
		await toggle.click();
		await expect(auxiliaryBar).toBeHidden();
		await expect(toggle.locator('svg[data-ash-icon-id="layout-sidebar-right-off-1"]')).toBeVisible();
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

	test('welcome cards shrink before wrapping in a narrow editor', async ({ workbench }) => {
		const welcome = workbench.editors.groupAt(0).welcome;
		const cardGeometry = async () => welcome.evaluate(element => {
			const cards = [...element.querySelectorAll<HTMLElement>('.ash-getting-started-card')];
			const [first, second] = cards.map(card => card.getBoundingClientRect());
			return {
				cardWidth: Math.round(first.width),
				secondCardOnFirstRow: first.top === second.top,
				labelsFitCards: cards.every(card => {
					const label = card.querySelector<HTMLElement>('.ash-getting-started-card-label')!;
					const labelBounds = label.getBoundingClientRect();
					const cardBounds = card.getBoundingClientRect();
					return labelBounds.width > 0 && labelBounds.left >= cardBounds.left && labelBounds.right <= cardBounds.right;
				}),
				labelsUseEllipsis: cards.every(card => {
					const label = card.querySelector<HTMLElement>('.ash-getting-started-card-label')!;
					const style = getComputedStyle(label);
					return style.overflowX === 'hidden' && style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap';
				}),
			};
		});

		await welcome.evaluate(element => { element.style.width = '364px'; });
		expect(await cardGeometry()).toEqual({ cardWidth: 160, secondCardOnFirstRow: true, labelsFitCards: true, labelsUseEllipsis: true });
		await welcome.evaluate(element => { element.style.width = '350px'; });
		expect(await cardGeometry()).toEqual({ cardWidth: 180, secondCardOnFirstRow: false, labelsFitCards: true, labelsUseEllipsis: true });
	});

	test('welcome uses the theme-colored mark without a filled icon tile', async ({ workbench }) => {
		const mark = workbench.editors.groupAt(0).welcome.locator('.ash-getting-started-mark');
		await expect(mark).toBeVisible();
		await expect(mark).toHaveAttribute('aria-hidden', 'true');
		await expect(mark).toHaveCSS('mask-image', /ash-mark.*\.svg/u);
		await expect(mark).toHaveCSS('background-image', 'none');
		await expect(mark).toHaveCSS('background-color', await mark.evaluate(element => getComputedStyle(element).color));
	});
});

test('recent projects align with the welcome action cards', async ({ target, workbench }) => {
	test.skip(target.kind !== 'electron', 'This scenario requires a local workspace');
	const page = workbench.page;
	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Welcome');
	await page.keyboard.press('Enter');
	const welcome = workbench.editors.groupAt(0).welcome;
	const recent = welcome.locator('.ash-getting-started-recent');
	await expect(recent).toBeVisible();
	await expect(recent.locator('.ash-getting-started-recent-item')).toHaveCount(1);
	const [leftCard, rightCard, heading, name, path] = await Promise.all([
		welcome.locator('.ash-getting-started-card').first().boundingBox(),
		welcome.locator('.ash-getting-started-card').nth(1).boundingBox(),
		recent.locator('h2').boundingBox(),
		recent.locator('.ash-getting-started-recent-name').boundingBox(),
		recent.locator('.ash-getting-started-recent-path').boundingBox(),
	]);
	expect(leftCard && rightCard && heading && name && path ? {
		headingLeft: Math.round(heading.x - leftCard.x),
		nameLeft: Math.round(name.x - leftCard.x),
		pathRight: Math.round(path.x + path.width - rightCard.x - rightCard.width),
	} : null).toEqual({ headingLeft: 0, nameLeft: 0, pathRight: 0 });
	await expect(recent.locator('.ash-getting-started-recent-path')).toHaveCSS('text-align', 'right');
});

test("editor layout remains valid across workbench window sizes", async ({ driver, workbench }) => {
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

test("split editor groups keep visible boundaries", async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== "code", "This scenario requires the Code product");
	const editors = workbench.editors;
	const page = workbench.page;

	for (const command of ["Split Editor Horizontal", "Split Editor Vertical"]) {
		await page.keyboard.press("F1");
		const picker = page.locator(".ash-quick-pick");
		await picker.getByRole("combobox").fill(command);
		await expect(picker.locator(".ash-quick-pick-row-label").filter({ hasText: command })).toBeVisible();
		await page.keyboard.press("Enter");
	}

	await expect(editors.groups).toHaveCount(3);
	const borderedPanes = editors.element.locator(".ash-split-view-separator-border > .ash-split-view-pane:not(:first-child)");
	await expect(borderedPanes).toHaveCount(2);
	const borderColor = await editors.element.evaluate(element => {
		const probe = element.ownerDocument.createElement("span");
		probe.style.color = "var(--ash-editor-group-border)";
		element.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	});
	await expect.poll(() => borderedPanes.evaluateAll(elements => elements.map(element => {
		const style = getComputedStyle(element, "::before");
		return { color: style.backgroundColor, thickness: element.parentElement?.classList.contains("ash-split-view-horizontal") ? style.width : style.height };
	}))).toEqual([
		{ color: borderColor, thickness: "1px" },
		{ color: borderColor, thickness: "1px" },
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

function contains(container: { x: number; y: number; width: number; height: number }, child: { x: number; y: number; width: number; height: number }, tolerance: number): boolean {
	return child.x >= container.x - tolerance
		&& child.y >= container.y - tolerance
		&& child.x + child.width <= container.x + container.width + tolerance
		&& child.y + child.height <= container.y + container.height + tolerance;
}
