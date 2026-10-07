import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('region navigation visits editor splits, skips hidden parts and follows sidebar placement', async ({ workbench, application }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	await workbench.editors.groupAt(0).editor.waitForEditorFocus();
	await workbench.quickaccess.runCommand('workbench.action.splitEditorHorizontal');
	await expect(workbench.editors.groups).toHaveCount(2);
	const first = workbench.editors.groupAt(0).editor.input;
	const second = workbench.editors.groupAt(1).editor.input;
	await expect(second).toBeFocused();
	await workbench.quickaccess.runCommand('workbench.action.navigateLeft');
	await expect(first).toBeFocused();
	await workbench.quickaccess.runCommand('workbench.action.navigateRight');
	await expect(second).toBeFocused();

	await workbench.quickaccess.runCommand('workbench.action.output.show');
	const panel = page.locator('[data-part="panel"]');
	await expect.poll(() => panel.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
	await workbench.quickaccess.runCommand('workbench.action.navigateUp');
	await expect(second).toBeFocused();
	await page.keyboard.press('F6');
	await expect.poll(() => panel.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
	await page.keyboard.press('Shift+F6');
	await expect(second).toBeFocused();
	await workbench.quickaccess.runCommand('workbench.action.closePanel');
	await expect(panel).toBeHidden();
	await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	const auxiliary = page.locator('[data-part="auxiliarybar"]');
	await expect(auxiliary).toBeVisible();
	await second.focus();
	await page.keyboard.press('F6');
	await expect.poll(() => auxiliary.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
	await expect(panel).toBeHidden();
	await page.keyboard.press('Shift+F6');
	await expect(second).toBeFocused();

	await workbench.quickaccess.runCommand('workbench.files.action.focusOpenEditorsView');
	await workbench.menus.select(application, () => page.locator('[data-part="activitybar"]').getByRole('button', { name: 'Manage', exact: true }).click({ button: 'right' }), ['Move Primary Side Bar Right']);
	await expect(page.locator('[data-part="sidebar"]')).toHaveClass(/sidebar-right/u);
	await second.focus();
	await workbench.quickaccess.runCommand('workbench.action.navigateRight');
	const sidebar = page.locator('[data-part="sidebar"]');
	await expect.poll(() => sidebar.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
	await workbench.quickaccess.runCommand('workbench.action.navigateLeft');
	await expect(second).toBeFocused();
});

test('panel commands focus the retained view and restore editor geometry after maximizing', async ({ workbench }) => {
	const page = workbench.page;
	const panel = page.locator('[data-part="panel"]');
	const editor = page.locator('[data-part="editor"]');
	const output = page.locator('[data-view-id="ash.output"]');
	await workbench.quickaccess.runCommand('workbench.action.output.show');
	const retained = await output.elementHandle();
	const height = await panel.evaluate(element => element.getBoundingClientRect().height);
	try {
		await panel.getByRole('button', { name: 'Close Panel', exact: true }).click();
		await expect(panel).toBeHidden();
		await workbench.quickaccess.runCommand('workbench.action.focusPanel');
		await expect(output).toBeVisible();
		await expect.poll(() => output.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
		expect(await output.evaluate((element, previous) => element === previous, retained)).toBe(true);
		await workbench.quickaccess.runCommand('workbench.action.toggleMaximizedPanel');
		await expect(editor).toBeHidden();
		await expect(panel).toBeVisible();
		await workbench.quickaccess.runCommand('workbench.action.closePanel');
		await expect(editor).toBeVisible();
		await expect(panel).toBeHidden();
		await workbench.quickaccess.runCommand('workbench.action.focusPanel');
		await expect(editor).toBeHidden();
		await expect.poll(() => output.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
		await workbench.quickaccess.runCommand('workbench.action.toggleMaximizedPanel');
		await expect(editor).toBeVisible();
		await expect.poll(() => panel.evaluate(element => element.getBoundingClientRect().height)).toBeCloseTo(height, 0);
		await expect.poll(() => output.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
		for (const theme of ['Ash Light', 'Ash Dark', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
			await workbench.quickaccess.runCommand('workbench.action.selectTheme');
			const picker = page.locator('.ash-quick-pick');
			await picker.getByRole('combobox').fill(theme);
			await picker.getByRole('combobox').press('Enter');
			await expect(picker).toHaveCount(0);
			const tab = panel.getByRole('tab', { name: 'Output', exact: true });
			await tab.focus();
			await expect(tab).toBeFocused();
			await expect.poll(() => panel.evaluate(element => {
				const title = element.querySelector<HTMLElement>('.ash-panel-title-control')!;
				const bar = title.querySelector<HTMLElement>('.ash-composite-bar')!;
				const actions = title.querySelector<HTMLElement>('.ash-pane-composite-title-actions')!;
				const style = getComputedStyle(title);
				return {
					display: style.display,
					border: style.borderBottomStyle,
					fits: bar.getBoundingClientRect().right <= actions.getBoundingClientRect().left + 1,
					height: bar.getBoundingClientRect().height > 0,
				};
			})).toEqual({ display: 'flex', border: 'solid', fits: true, height: true });
		}
	} finally {
		await retained?.dispose();
	}
});

test('view commands reveal retained containers and focus the requested view', async ({ workbench }) => {
	const page = workbench.page;
	const output = page.locator('[data-view-id="ash.output"]');
	await workbench.quickaccess.runCommand('workbench.action.output.show');
	await expect(output).toBeVisible();
	await expect.poll(() => output.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
	const retained = await output.elementHandle();
	try {
		await workbench.quickaccess.runCommand('workbench.action.togglePanel');
		await expect(output).toBeHidden();
		await workbench.quickaccess.runCommand('workbench.action.output.show');
		await expect(output).toBeVisible();
		await expect.poll(() => output.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
		expect(await output.evaluate((element, previous) => element === previous, retained)).toBe(true);
		await workbench.quickaccess.runCommand('workbench.files.action.focusOpenEditorsView');
		const files = page.locator('[data-view-id="workbench.explorer.openEditorsView"]');
		await expect(files).toBeVisible();
		await expect.poll(() => files.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
	} finally {
		await retained?.dispose();
	}
});

test('multiple view panes resize independently and restore their layout after reload', async ({ workbench, reloadWorkbench }) => {
	let page = workbench.page;
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	let container = page.locator('[data-view-container-id="ash.git"]');
	let changes = container.locator('[data-view-id="ash.gitView"]');
	let review = container.locator('[data-view-id="ash.gitAgentReview"]');
	let graph = container.locator('[data-view-id="ash.gitGraph"]');
	await expect(container.locator('[data-view-id="workbench.scm.repositories"]')).toBeHidden();
	await expect(changes.getByRole('combobox')).toHaveCount(0);
	const header = (pane: typeof graph) => pane.locator('.ash-pane-view-header-button');
	const height = (pane: typeof graph) => pane.evaluate(element => element.getBoundingClientRect().height);
	await expect(header(changes)).toHaveAttribute('aria-expanded', 'true');
	await expect(header(review)).toHaveAttribute('aria-expanded', 'false');
	await expect(header(graph)).toHaveAttribute('aria-expanded', 'false');
	await expect.poll(() => height(review)).toBe(28);

	await header(graph).focus();
	await header(graph).press('ArrowRight');
	await expect(header(graph)).toHaveAttribute('aria-expanded', 'true');
	await expect.poll(() => height(graph)).toBe(200);
	const sash = container.locator('.ash-sash').last();
	await expect(sash).toBeVisible();
	await expect(sash).toHaveAttribute('role', 'separator');
	await expect(sash).toHaveAttribute('aria-label', 'Resize panes');
	await expect(sash).toHaveAttribute('aria-description', /arrow keys/);
	await sash.focus();
	const originalHeight = await height(graph);
	await sash.press('ArrowUp');
	await expect.poll(() => height(graph)).toBeGreaterThan(originalHeight);
	await expect(sash).toBeFocused();

	const box = await sash.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
	await page.mouse.down();
	await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 - 45, { steps: 3 });
	await page.mouse.up();
	let resizedHeight = await height(graph);
	expect(resizedHeight).toBeGreaterThan(originalHeight + 40);
	await expect.poll(() => height(review)).toBe(28);
	const total = await container.evaluate(element => [...element.querySelectorAll('.ash-view-pane')].reduce((sum, pane) => sum + pane.getBoundingClientRect().height, 0) - element.getBoundingClientRect().height);
	expect(Math.abs(total)).toBeLessThan(1);
	await sash.dblclick();
	await expect.poll(async () => (await height(changes)) - (await height(graph))).toBeCloseTo(0, 0);
	await expect.poll(() => height(review)).toBe(28);
	resizedHeight = await height(graph);

	await header(graph).focus();
	await header(graph).press('ArrowLeft');
	await expect.poll(() => height(graph)).toBe(28);
	await header(graph).press('ArrowUp');
	await expect(header(review)).toBeFocused();
	await header(review).press('Home');
	await expect(header(changes)).toBeFocused();
	await page.getByRole('tab', { name: 'Search', exact: true }).first().click();
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	await expect(header(graph)).toHaveAttribute('aria-expanded', 'false');
	await header(graph).press('ArrowRight');
	await expect.poll(() => height(graph)).toBeCloseTo(resizedHeight, 0);

	for (const theme of ['Ash Light', 'Ash Dark', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const picker = page.locator('.ash-quick-pick');
		await picker.getByRole('combobox').fill(theme);
		await picker.getByRole('combobox').press('Enter');
		await expect(picker).toHaveCount(0);
		await header(graph).focus();
		await expect(header(graph)).toHaveCSS('outline-style', 'solid');
	}

	await header(graph).press('ArrowLeft');
	({ workbench } = await reloadWorkbench());
	page = workbench.page;
	container = page.locator('[data-view-container-id="ash.git"]');
	changes = container.locator('[data-view-id="ash.gitView"]');
	review = container.locator('[data-view-id="ash.gitAgentReview"]');
	graph = container.locator('[data-view-id="ash.gitGraph"]');
	await workbench.waitForReady();
	await expect(container).toBeVisible();
	await expect(header(graph)).toHaveAttribute('aria-expanded', 'false');
	await header(graph).press('ArrowRight');
	await expect.poll(() => height(graph)).toBeCloseTo(resizedHeight, 0);
});

test('SCM panes retain usable bodies when resized and scroll when the window is too short', async ({ driver, workbench }) => {
	const page = workbench.page;
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	const container = page.locator('[data-view-container-id="ash.git"]');
	const changes = container.locator('[data-view-id="ash.gitView"]');
	const review = container.locator('[data-view-id="ash.gitAgentReview"]');
	const graph = container.locator('[data-view-id="ash.gitGraph"]');
	await review.locator('.ash-pane-view-header-button').press('ArrowRight');
	await graph.locator('.ash-pane-view-header-button').press('ArrowRight');
	const sash = container.locator('.ash-sash').last();
	const box = await sash.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
	await page.mouse.down();
	await page.mouse.move(box!.x + box!.width / 2, box!.y - 500, { steps: 3 });
	await page.mouse.up();
	await expect.poll(() => review.evaluate(element => element.getBoundingClientRect().height)).toBe(148);
	const findIssues = review.getByRole('button', { name: 'Find Issues', exact: true });
	await expect(findIssues).toBeVisible();
	await expect.poll(() => findIssues.evaluate(element => {
		const button = element.getBoundingClientRect();
		const body = element.closest('.ash-pane-view-content')!.getBoundingClientRect();
		return button.top >= body.top && button.bottom <= body.bottom;
	})).toBe(true);
	await review.locator('.ash-pane-view-header-button').focus();
	await page.keyboard.press('Tab');
	await expect(findIssues).toBeFocused();

	await driver.setWindowSize({ width: 1000, height: 400 });
	const scrollContainer = container.locator('.ash-pane-view-container');
	await expect.poll(() => scrollContainer.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
	for (const pane of [changes, review, graph]) {
		await expect.poll(() => pane.locator('.ash-pane-view-content').evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(120);
	}
	const graphHeader = graph.locator('.ash-pane-view-header-button');
	await graphHeader.focus();
	await expect(graphHeader).toBeFocused();
	await expect(graphHeader).toBeInViewport();
	await expect.poll(() => scrollContainer.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
});

test.describe('Pane motion', () => {
	test.use({ openWorkspace: true, gitRepository: true });

	test('pane motion preserves content, resize handles and the final state when interrupted', async ({ target, workbench }) => {
		const page = workbench.page;
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const graph = page.locator('[data-view-id="ash.gitGraph"]');
		const header = graph.locator('.ash-pane-view-header-button');
		const body = graph.locator('.ash-pane-view-content');
		await expect(header).toHaveAttribute('aria-expanded', 'false');
		const opening = await graph.evaluate(element => {
			const wrapper = element.parentElement!;
			const split = wrapper.parentElement!;
			const before = wrapper.getBoundingClientRect().height;
			const sashes = [...split.querySelectorAll('.ash-sash')];
			(element.querySelector('.ash-pane-view-header-button') as HTMLButtonElement).click();
			const target = Number.parseFloat(wrapper.style.height);
			const animations = split.getAnimations({ subtree: true }).filter(animation =>
				animation.effect instanceof KeyframeEffect && animation.effect.getKeyframes().some(frame => frame.height !== undefined || frame.top !== undefined),
			);
			for (const animation of animations) {
				animation.pause();
				animation.currentTime = Number(animation.effect!.getComputedTiming().duration) / 2;
			}
			const midway = wrapper.getBoundingClientRect().height;
			const contentHeight = element.querySelector('.ash-pane-view-content')!.getBoundingClientRect().height;
			const sash = split.querySelector<HTMLElement>('.ash-sash:last-child')!;
			const boundaryError = Math.abs(sash.getBoundingClientRect().top + sash.getBoundingClientRect().height / 2 - wrapper.getBoundingClientRect().top);
			for (const animation of animations) animation.finish();
			return { before, target, midway, contentHeight, boundaryError, animationCount: animations.length, stableSashes: sashes.every(sash => sash.isConnected) };
		});
		expect(opening.animationCount).toBeGreaterThan(0);
		expect(opening.midway).toBeGreaterThan(opening.before);
		expect(opening.midway).toBeLessThan(opening.target);
		expect(opening.contentHeight).toBeCloseTo(opening.target - 28, 0);
		expect(opening.boundaryError).toBeLessThan(1);
		expect(opening.stableSashes).toBe(true);
		await expect.poll(() => graph.evaluate(element => element.getBoundingClientRect().height)).toBeCloseTo(opening.target, 0);
		if (target.appServerMode === 'required') {
			await expect(graph.getByRole('treeitem').first()).toBeVisible();
		}
		if (target.appServerMode === 'required') {
			await graph.getByRole('treeitem').first().focus();
		} else {
			await header.focus();
		}
		await header.evaluate(element => (element as HTMLButtonElement).click());
		await expect(header).toBeFocused();
		await expect(body).toHaveAttribute('inert', '');
		await expect(body).toHaveAttribute('aria-hidden', 'true');
		await header.press('ArrowRight');
		await header.press('ArrowLeft');
		await header.press('ArrowRight');
		await expect(header).toHaveAttribute('aria-expanded', 'true');
		await expect(body).toHaveAttribute('aria-hidden', 'false');
		await expect.poll(() => body.evaluate(element => (element as HTMLElement).inert)).toBe(false);
		await expect(graph).not.toHaveClass(/closing/u);
		await expect.poll(() => graph.evaluate(element => element.getBoundingClientRect().height)).toBeCloseTo(opening.target, 0);
		const sash = graph.locator('..').locator('..').locator('.ash-sash').last();
		await sash.focus();
		await sash.press('ArrowUp');
		await expect(sash).toBeFocused();
		await expect.poll(() => graph.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(opening.target);
	});

	test('reduced motion switches pane geometry and content visibility immediately', async ({ workbench }) => {
		const page = workbench.page;
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await expect(page.locator('.ash-workbench')).toHaveClass(/ash-reduce-motion/u);
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const graph = page.locator('[data-view-id="ash.gitGraph"]');
		const state = await graph.evaluate(element => {
			const wrapper = element.parentElement!;
			const header = element.querySelector<HTMLButtonElement>('.ash-pane-view-header-button')!;
			const body = element.querySelector<HTMLElement>('.ash-pane-view-content')!;
			wrapper.getBoundingClientRect();
			header.click();
			const expanded = wrapper.getBoundingClientRect().height;
			const target = Number.parseFloat(wrapper.style.height);
			header.click();
			return { expanded, target, collapsed: wrapper.getBoundingClientRect().height, hidden: body.hidden, inert: body.inert, animations: wrapper.getAnimations().length };
		});
		expect(state).toEqual({ expanded: state.target, target: state.target, collapsed: 28, hidden: true, inert: true, animations: 0 });
	});
});


test('sidebar overflow registers view visibility and layout commands', async ({ workbench, application }) => {
	const page = workbench.page;
	const sidebar = page.locator('[data-part="sidebar"]');
	const activitybar = page.locator('[data-part="activitybar"]');
	await page.getByRole('tab', { name: 'Explorer', exact: true }).first().click();
	const open = () => sidebar.locator('.ash-pane-composite-title-part-actions').getByRole('button', { name: 'More Actions', exact: true }).click();
	const items = () => workbench.menus.inspect(application, open);
	const initial = await items();
	expect(initial).toEqual(expect.arrayContaining([
		expect.objectContaining({ label: 'Open Editors', checked: false, enabled: true }),
		expect.objectContaining({ label: 'Move Primary Side Bar Right', enabled: true }),
		expect.objectContaining({ label: 'Activity Bar Position', enabled: true }),
		expect.objectContaining({ label: 'Activity Bar Size', enabled: true }),
		expect.objectContaining({ label: 'Hide Primary Side Bar', enabled: true }),
	]));
	await workbench.menus.select(application, open, ['Open Editors']);
	const editors = sidebar.locator('[data-view-id="workbench.explorer.openEditorsView"]');
	await expect(editors).toBeVisible();
	expect(await items()).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Open Editors', checked: true })]));
	await workbench.menus.select(application, open, ['Open Editors']);
	await expect(editors).toBeHidden();
	await workbench.menus.select(application, open, ['Move Primary Side Bar Right']);
	await expect(sidebar).toHaveClass(/sidebar-right/u);
	expect(await items()).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Move Primary Side Bar Left' })]));
	await workbench.quickaccess.runCommand('workbench.action.toggleSidebarPosition');
	await expect(sidebar).not.toHaveClass(/sidebar-right/u);
	await workbench.menus.select(application, open, ['Activity Bar Size', 'Compact']);
	await expect(activitybar).toHaveClass(/compact/u);
	await workbench.quickaccess.runCommand('workbench.action.activityBar.size.default');
	await expect(activitybar).not.toHaveClass(/compact/u);
	await workbench.menus.select(application, open, ['Activity Bar Position', 'Top']);
	await expect(activitybar).toBeHidden();
	await expect(sidebar.locator('.ash-sidebar-composite-bar-top .ash-composite-bar')).toBeVisible();
	expect((await items()).some(item => item.label === 'Activity Bar Size')).toBe(false);
	expect(await workbench.menus.inspect(application, open, ['Activity Bar Position'])).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Top', checked: true })]));
	await workbench.quickaccess.runCommand('workbench.action.activityBarLocation.bottom');
	await expect(sidebar.locator('.ash-sidebar-composite-bar-bottom .ash-composite-bar')).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.activityBarLocation.hide');
	await expect(sidebar.locator('.ash-composite-bar')).toBeHidden();
	await workbench.quickaccess.runCommand('workbench.action.activityBarLocation.default');
	await expect(activitybar).toBeVisible();
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	const gitItems = await items();
	expect(gitItems.some(item => item.label === 'Open Editors')).toBe(false);
	expect(gitItems).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Changes', checked: true, enabled: false })]));
	await workbench.menus.select(application, open, ['Hide Primary Side Bar']);
	await expect(sidebar).toBeHidden();
	await workbench.quickaccess.runCommand('workbench.action.toggleSideBar');
	await expect(sidebar).toBeVisible();
});


test.describe('Git sidebar visibility menus', () => {
	test.use({ openWorkspace: true, gitRepository: true });
	test('Git sidebar overflow toggles panes and protects the last visible view', async ({ target, workbench, application }) => {
		test.skip(target.appServerMode !== 'required', 'Git panes require the connected App Server');
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const sidebar = page.locator('[data-part="sidebar"]');
		const open = () => sidebar.locator('.ash-pane-composite-title-part-actions').getByRole('button', { name: 'More Actions', exact: true }).click();
		for (const [label, id] of [['Graph', 'ash.gitGraph'], ['Agent Review', 'ash.gitAgentReview']] as const) {
			const pane = sidebar.locator(`[data-view-id="${id}"]`);
			await expect(pane).toBeVisible();
			await workbench.menus.select(application, open, [label]);
			await expect(pane).toBeHidden();
		}
		expect(await workbench.menus.inspect(application, open)).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Changes', checked: true, enabled: false })]));
		await workbench.menus.select(application, open, ['Graph']);
		await expect(sidebar.locator('[data-view-id="ash.gitGraph"]')).toBeVisible();
		await workbench.menus.select(application, open, ['Changes']);
		await expect(sidebar.locator('[data-view-id="ash.gitView"]')).toBeHidden();
		expect(await workbench.menus.inspect(application, open)).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Graph', checked: true, enabled: false })]));
		await workbench.menus.select(application, open, ['Changes']);
		await expect(sidebar.locator('[data-view-id="ash.gitView"]')).toBeVisible();
	});
});
