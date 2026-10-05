import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

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
