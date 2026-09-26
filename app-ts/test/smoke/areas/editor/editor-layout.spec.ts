import type { Locator } from "@playwright/test";
import { expect, test } from "../../../automation/test.js";

test.describe('startup layout defaults', () => {
	test.use({ openWorkspace: false });

	test('empty window keeps Explorer and Panel hidden and shows first-launch desktop Chat', async ({ target, workbench }) => {
		const page = workbench.page;
		await expect(page.locator("[data-part='sidebar']")).toBeHidden();
		await expect(page.locator("[data-part='panel']")).toBeHidden();
		await expect(page.locator("[data-part='auxiliarybar']")).toBeVisible({ visible: target.kind === 'electron' });
	});
});

test('new desktop workspace shows Explorer and Chat with Panel hidden', async ({ target, workbench }) => {
	test.skip(target.kind !== 'electron');
	const page = workbench.page;
	await expect(page.locator("[data-part='sidebar']")).toBeVisible();
	await expect(page.locator("[data-part='auxiliarybar']")).toBeVisible();
	await expect(page.locator("[data-part='panel']")).toBeHidden();
});

test("empty editor distinguishes an empty window from an open workspace", async ({ target, workbench }) => {
	const editors = workbench.editors;
	const group = editors.groupAt(0);
	const welcomeVisible = target.kind === 'browser' && target.appServerMode === 'disabled';

	await expect(editors.element).toBeVisible();
	await expect(group.element).toBeVisible();
	await expect(group.title).toBeVisible();
	await expect(group.content).toBeVisible();
	await expect(group.welcome).toBeVisible({ visible: welcomeVisible });
	await expect(group.tabs).toHaveCount(welcomeVisible ? 1 : 0);

	await expect.poll(async () => editorGeometry(editors.element, group.element, group.title, group.content, group.welcome)).toEqual({
		groupFillsEditorClient: true,
		titleAboveContent: true,
		titleHasHeight: true,
		contentHasArea: true,
		welcomeInsideContent: welcomeVisible ? true : null,
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
		await workbench.page.keyboard.press('F1');
		await workbench.page.locator('.ash-quick-pick').getByRole('combobox').fill('Welcome');
		await workbench.page.keyboard.press('Enter');
		await expect(group.tabs).toHaveCount(1);
		await expect(group.welcome).toBeVisible();
		await expect(group.title.getByRole('button', { name: 'Reveal in File Explorer' })).toHaveCount(0);
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
		const expanded = await geometry();
		await toggle.click();
		await expect(auxiliaryBar).toBeHidden();
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
				labelOverflow: Math.max(0, ...cards.map(card => {
					const label = card.querySelector<HTMLElement>('.ash-getting-started-card-label')!;
					return label.scrollWidth - label.clientWidth;
				})),
			};
		});

		await welcome.evaluate(element => { element.style.width = '364px'; });
		expect(await cardGeometry()).toEqual({ cardWidth: 160, secondCardOnFirstRow: true, labelOverflow: 0 });
		await welcome.evaluate(element => { element.style.width = '350px'; });
		expect(await cardGeometry()).toEqual({ cardWidth: 180, secondCardOnFirstRow: false, labelOverflow: 0 });
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

test("editor layout remains valid across workbench window sizes", async ({ target, driver, workbench }) => {
	const editors = workbench.editors;
	const group = editors.groupAt(0);
	const observedSizes = new Set<string>();
	const welcomeVisible = target.kind === 'browser' && target.appServerMode === 'disabled';

	for (const size of [{ width: 900, height: 700 }, { width: 1200, height: 800 }, { width: 1494, height: 1104 }]) {
		const actualSize = await driver.setWindowSize(size);
		observedSizes.add(`${actualSize.width}x${actualSize.height}`);
		await expect.poll(async () => editorGeometry(editors.element, group.element, group.title, group.content, group.welcome), { message: `editor geometry at ${size.width}x${size.height}` }).toEqual({
			groupFillsEditorClient: true,
			titleAboveContent: true,
			titleHasHeight: true,
			contentHasArea: true,
			welcomeInsideContent: welcomeVisible ? true : null,
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
	// The Welcome editor exists only in empty windows; open workspaces render no welcome content.
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
