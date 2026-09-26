import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('titlebar navigation moves through editor history beside Quick Access', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const navigation = page.locator('.ash-titlebar-command-center-navigation');
	const back = navigation.getByRole('button', { name: 'Go Back' });
	const forward = navigation.getByRole('button', { name: 'Go Forward' });
	const search = page.getByRole('button', { name: 'Search commands' });
	await expect(back).toBeDisabled();
	await expect(forward).toBeDisabled();
	const originalViewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
	for (const width of [1200, 700]) {
		await page.setViewportSize({ width, height: 800 });
		const [leftBounds, navigationBounds, searchBounds] = await Promise.all([
			page.locator('.ash-workbench-titlebar > .ash-workbench-part-title').boundingBox(),
			navigation.boundingBox(),
			search.boundingBox(),
		]);
		expect(leftBounds).not.toBeNull();
		expect(navigationBounds).not.toBeNull();
		expect(searchBounds).not.toBeNull();
		expect(navigationBounds!.x - leftBounds!.x - leftBounds!.width).toBeGreaterThanOrEqual(0);
		expect(searchBounds!.x - navigationBounds!.x - navigationBounds!.width).toBeGreaterThanOrEqual(6);
	}
	await page.setViewportSize(originalViewport);

	const openUntitled = async () => {
		await page.getByRole('button', { name: 'Application menu' }).click();
		await page.getByRole('menu').first().getByRole('menuitem', { name: 'File' }).hover();
		await page.getByRole('menu').last().getByRole('menuitem', { name: 'New Untitled Text Editor' }).click();
	};
	await openUntitled();
	await openUntitled();
	await openUntitled();
	await expect(back).toBeEnabled();
	await expect(forward).toBeDisabled();
	await back.click();
	await expect(page.locator('.ash-tab.checked')).toContainText('Untitled-2');
	await expect(forward).toBeEnabled();
	await back.focus();
	await back.press('ArrowRight');
	await expect(forward).toBeFocused();
	await forward.click();
	await expect(page.locator('.ash-tab.checked')).toContainText('Untitled-3');
	const backShortcut = process.platform === 'darwin' ? 'Control+-' : process.platform === 'linux' ? 'Control+Alt+-' : 'Alt+ArrowLeft';
	await page.keyboard.press(backShortcut);
	await expect(page.locator('.ash-tab.checked')).toContainText('Untitled-2');
	await openUntitled();
	await expect(forward).toBeDisabled();
});

test('titlebar navigation restores a cursor location in the same editor', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.getByRole('button', { name: 'Application menu' }).click();
	await page.getByRole('menu').first().getByRole('menuitem', { name: 'File' }).hover();
	await page.getByRole('menu').last().getByRole('menuitem', { name: 'New Untitled Text Editor' }).click();
	const input = workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.insertText(Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n'));
	const cursor = page.locator('[data-statusbar-item-id="ash.status.editor.cursor"]');
	const start = process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home';
	const end = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';
	await page.keyboard.press(start);
	await expect(cursor).toContainText('Ln 1, Col 1');
	await page.keyboard.press(end);
	await expect(cursor).toContainText('Ln 40, Col 8');
	await page.locator('.ash-titlebar-command-center-navigation').getByRole('button', { name: 'Go Back' }).click();
	await expect(cursor).toContainText('Ln 1, Col 1');
	await page.locator('.ash-titlebar-command-center-navigation').getByRole('button', { name: 'Go Forward' }).click();
	await expect(cursor).toContainText('Ln 40, Col 8');
});

test('Sessions entry sits beside Quick Access and animates its Ash mark on intent', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const commandCenter = page.locator('.ash-titlebar-command-center-button');
	const actionId = target.kind === 'electron' ? 'workbench.action.openAgentsWindow' : 'ash.code.open-sessions';
	const entry = page.locator(`.ash-titlebar-center-adjacent-actions [data-action-id="${actionId}"] button`);
	await expect(page.locator(`.ash-titlebar-left-actions [data-action-id="${actionId}"]`)).toHaveCount(0);
	await expect(entry).toBeVisible();
	await expect(entry).toHaveAttribute('aria-label', target.kind === 'electron' ? 'Open Agents Window' : 'Open Code Sessions');
	const mark = entry.locator('svg.ash-sessions-titlebar-mark');
	await expect(mark.locator('path')).toHaveCount(9);

	for (const width of [1200, 700]) {
		await page.setViewportSize({ width, height: 800 });
		await expect.poll(async () => {
			const searchBounds = await commandCenter.boundingBox();
			const entryBounds = await entry.boundingBox();
			return searchBounds && entryBounds ? entryBounds.x - searchBounds.x - searchBounds.width : -1;
		}).toBeGreaterThanOrEqual(6);
		const searchBounds = await commandCenter.boundingBox();
		const entryBounds = await entry.boundingBox();
		expect(searchBounds).not.toBeNull();
		expect(entryBounds).not.toBeNull();
		expect(Math.abs(entryBounds!.y + entryBounds!.height / 2 - searchBounds!.y - searchBounds!.height / 2)).toBeLessThan(1);
	}

	const petal = mark.locator('#petal-north');
	await entry.hover();
	await expect(petal).toHaveCSS('animation-name', 'ash-sessions-mark-bloom');
	await page.mouse.move(400, 180);
	await commandCenter.focus();
	await page.keyboard.press('Tab');
	await expect(entry).toBeFocused();
	await expect(petal).toHaveCSS('animation-name', 'ash-sessions-mark-bloom');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(petal).toHaveCSS('animation-name', 'none');

	if (target.kind === 'browser') {
		await entry.click();
		await expect(page).toHaveURL(/sessions-code\.html/u);
	}
});

test('titlebar toolbar icons fit inside their buttons', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const buttons = workbench.page.locator('.ash-workbench-titlebar .ash-toolbar .ash-action-view-item.icon > .ash-button');
	await expect(buttons.first()).toBeVisible();
	const iconBounds = await buttons.evaluateAll(elements => elements.map(button => {
		const label = button.querySelector('.ash-icon-label');
		const icon = label?.querySelector('svg.ash-icon');
		if (!label || !icon) throw new Error('Toolbar icon button is missing its icon');
		const labelRect = label.getBoundingClientRect();
		const iconRect = icon.getBoundingClientRect();
		const buttonRect = button.getBoundingClientRect();
		return {
			buttonWidth: buttonRect.width,
			labelWidth: labelRect.width,
			iconWidth: iconRect.width,
			leftInset: iconRect.left - labelRect.left,
			rightInset: labelRect.right - iconRect.right,
			buttonLeftInset: iconRect.left - buttonRect.left,
			buttonRightInset: buttonRect.right - iconRect.right,
		};
	}));
	for (const bounds of iconBounds) {
		expect(bounds.buttonWidth).toBe(22);
		expect(bounds.iconWidth).toBe(16);
		expect(bounds.labelWidth).toBeGreaterThanOrEqual(bounds.iconWidth);
		expect(bounds.leftInset).toBeGreaterThanOrEqual(0);
		expect(bounds.rightInset).toBeGreaterThanOrEqual(0);
		expect(bounds.buttonLeftInset).toBeCloseTo(3, 1);
		expect(bounds.buttonRightInset).toBeCloseTo(3, 1);
	}
});

test('Quick Access has no backdrop and lets workbench controls receive clicks', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.keyboard.press('F1');
	const host = page.locator('.ash-quick-input-host');
	const picker = page.locator('.ash-quick-pick');
	await expect(picker.getByRole('combobox')).toBeFocused();
	await expect(host).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	await expect(host).toHaveCSS('pointer-events', 'none');
	await expect(picker).toHaveCSS('pointer-events', 'auto');
	await page.getByRole('button', { name: 'Application menu' }).click();
	await expect(picker).toHaveCount(0);
	await expect(page.getByRole('menu').first()).toBeVisible();
});

test('titlebar command center opens command search and restores focus', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const commandCenter = page.getByRole('button', { name: 'Search commands' });
	await expect(commandCenter).toBeVisible();

	const titlebar = page.locator('.ash-workbench-titlebar');
	const appIcon = titlebar.locator('.ash-titlebar-app-icon');
	await expect(appIcon).toHaveCSS('mask-image', /ash-mark.*\.svg/u);
	await expect(appIcon).toHaveCSS('background-image', 'none');
	await expect(appIcon).toHaveCSS('background-color', await appIcon.evaluate(element => getComputedStyle(element).color));
	const markSize = await appIcon.evaluate(async element => {
		const mask = getComputedStyle(element).maskImage;
		const image = new Image();
		image.src = mask.slice(5, -2);
		await image.decode();
		const canvas = document.createElement('canvas');
		canvas.width = element.clientWidth;
		canvas.height = element.clientHeight;
		const context = canvas.getContext('2d')!;
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
		let left = canvas.width;
		let top = canvas.height;
		let right = -1;
		let bottom = -1;
		for (let y = 0; y < canvas.height; y++) {
			for (let x = 0; x < canvas.width; x++) {
				if (pixels[(y * canvas.width + x) * 4 + 3] === 0) continue;
				left = Math.min(left, x);
				top = Math.min(top, y);
				right = Math.max(right, x);
				bottom = Math.max(bottom, y);
			}
		}
		return { width: right - left + 1, height: bottom - top + 1 };
	});
	expect(markSize.width).toBeGreaterThanOrEqual(13);
	expect(markSize.height).toBeGreaterThanOrEqual(13);
	const [titlebarBounds, controlBounds] = await Promise.all([titlebar.boundingBox(), commandCenter.boundingBox()]);
	expect(titlebarBounds).not.toBeNull();
	expect(controlBounds).not.toBeNull();
	expect(controlBounds!.width).toBeGreaterThan(300);
	expect(titlebarBounds!.height).toBe(35);
	expect(controlBounds!.height).toBe(24);
	expect(Math.abs(controlBounds!.x + controlBounds!.width / 2 - titlebarBounds!.x - titlebarBounds!.width / 2)).toBeLessThan(2);
	expect(Math.abs(controlBounds!.y + controlBounds!.height / 2 - titlebarBounds!.y - titlebarBounds!.height / 2)).toBeLessThan(0.6);
	const contentBounds = await commandCenter.locator('.ash-button-content').boundingBox();
	expect(contentBounds).not.toBeNull();
	expect(Math.abs(contentBounds!.x + contentBounds!.width / 2 - controlBounds!.x - controlBounds!.width / 2)).toBeLessThan(1);
	await expect(commandCenter).toHaveCSS('background-color', 'rgb(246, 246, 246)');
	await expect(commandCenter).toHaveCSS('border-color', 'rgb(208, 208, 208)');
	await commandCenter.hover();
	await expect(commandCenter).toHaveCSS('background-color', 'rgb(235, 235, 235)');

	await commandCenter.click();
	await expect(commandCenter).toHaveAttribute('aria-expanded', 'true');
	await expect(commandCenter).toHaveClass(/active/);
	const picker = page.locator('.ash-quick-pick');
	const query = picker.getByRole('combobox');
	await expect(query).toBeFocused();
	await expect(query).toHaveAttribute('placeholder', 'Search commands (type >, @, or ? for modes)');
	const initialPicker = await picker.elementHandle();
	await query.fill('?');
	await expect(query).toHaveAttribute('placeholder', 'Select a search mode');
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: '> Commands' })).toBeVisible();
	await query.fill('@');
	await expect(query).toHaveAttribute('placeholder', 'Type the name of a symbol in the workspace');
	await query.fill('?');
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: '? Show Search Modes' })).toHaveCount(0);
	await query.press('Enter');
	await expect(query).toHaveValue('>');
	await expect(query).toHaveAttribute('placeholder', 'Type the name of a command to run');
	expect(await query.evaluate(input => (input as HTMLInputElement).selectionStart)).toBe(1);
	expect(await page.evaluate(element => element === document.querySelector('.ash-quick-pick'), initialPicker)).toBe(true);
	await query.pressSequentially('Toggle Minimap');
	await expect(query).toHaveValue('>Toggle Minimap');
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: 'Toggle Minimap' })).toBeVisible();
	await query.press('Escape');
	await expect(picker).toHaveCount(0);
	await expect(commandCenter).toHaveAttribute('aria-expanded', 'false');
	await expect(commandCenter).toBeFocused();

	await commandCenter.press('Enter');
	await expect(picker.getByRole('combobox')).toBeFocused();
	await picker.getByRole('combobox').press('Escape');

	for (const width of [801, 700]) {
		await page.setViewportSize({ width, height: 800 });
		await expect(commandCenter).toBeVisible();
		const [left, control, right] = await Promise.all([
			titlebar.locator('.ash-workbench-part-title').boundingBox(),
			commandCenter.boundingBox(),
			titlebar.locator('.ash-workbench-part-content').boundingBox(),
		]);
		expect(left!.x + left!.width).toBeLessThanOrEqual(control!.x);
		expect(control!.x + control!.width).toBeLessThanOrEqual(right!.x);
		if (width === 700) expect(control!.width).toBe(32);
	}
	await commandCenter.click();
	await expect(picker.getByRole('combobox')).toBeFocused();
});
