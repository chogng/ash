import { expect, test } from '@playwright/test';

test('Sessions model picker selects with keys, restores focus and dismisses on outside click and disposal', async ({ page }) => {
	await page.goto('/modelPicker.html');
	const picker = page.locator('.ash-sessions-model-picker');
	await picker.focus();
	await picker.press('ArrowDown');
	await expect(page.getByRole('menuitemradio', { name: 'First model' })).toBeFocused();
	await expect(page.getByRole('menuitemradio', { name: 'First model' })).toHaveAttribute('aria-checked', 'true');
	await page.keyboard.press('End');
	await expect(page.getByRole('menuitemradio', { name: 'Second model' })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('status', { name: 'Selection' })).toHaveText('two');
	await expect(picker).toHaveText('Second model');
	await expect(picker).toBeFocused();
	await picker.click();
	await page.keyboard.press('Escape');
	await expect(picker).toBeFocused();
	await expect(picker).toHaveAttribute('aria-expanded', 'false');
	await picker.click();
	await page.getByRole('button', { name: 'Outside', exact: true }).click();
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Outside', exact: true })).toBeFocused();
	await picker.click();
	await page.evaluate(() => window.ashModelPickerIntegration.dispose());
	await expect(page.getByRole('menu')).toHaveCount(0);
});

test('Sessions thinking slider uses only supplied levels and its heading opens the model list', async ({ page }, testInfo) => {
	await page.goto('/modelPicker.html');
	await page.evaluate(() => window.ashModelPickerIntegration.configure({ thinking: true }));
	const picker = page.locator('.ash-sessions-model-picker');
	await picker.click();
	const slider = page.getByRole('slider', { name: 'Thinking level', exact: true });
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeFocused();
	await expect(slider).not.toBeFocused();
	await expect(slider).toHaveAttribute('aria-valuetext', 'Extra High');
	await expect(picker).toHaveAttribute('aria-haspopup', 'dialog');
	await testInfo.attach('thinking-level', { body: await page.getByRole('dialog').screenshot(), contentType: 'image/png' });
	await page.keyboard.press('ArrowDown');
	await expect(page.getByRole('button', { name: 'Choose model', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(slider).toBeFocused();
	await slider.press('ArrowRight');
	await expect(slider).toHaveAttribute('aria-valuetext', 'Max');
	await expect(picker).toHaveText('Max');
	await expect(page.getByRole('status', { name: 'Selection' })).toHaveText('max');
	await slider.press('Home');
	await expect(slider).toHaveAttribute('aria-valuetext', 'Low');
	await slider.press('End');
	await expect(slider).toHaveAttribute('aria-valuetext', 'Max');
	await page.getByRole('button', { name: 'Choose model', exact: true }).click();
	await expect(picker).toHaveAttribute('aria-haspopup', 'menu');
	await testInfo.attach('model-list', { body: await page.getByRole('menu').screenshot(), contentType: 'image/png' });
	await expect(page.getByRole('menu')).toBeFocused();
	const popupId = await page.getByRole('menu').getAttribute('id');
	await page.getByRole('menuitemradio', { name: 'Second model' }).click();
	await expect(picker).toHaveText('Max');
	await expect(dialog).toHaveAttribute('id', popupId!);
	await expect(slider).toHaveAttribute('aria-valuetext', 'Max');
	await expect(page.getByRole('menuitemradio')).toHaveCount(0);
	await page.getByRole('button', { name: 'Choose model', exact: true }).click();
	await expect(page.getByRole('menuitemradio', { name: 'Second model' })).toHaveAttribute('aria-checked', 'true');
	await page.getByRole('menuitemradio', { name: 'Second model' }).click();
	await expect(dialog).toBeVisible();
	await picker.click();
	await expect(dialog).toHaveCount(0);
});

test('Sessions model picker trigger toggles closed from either page and reopens on the slider', async ({ page }) => {
	await page.goto('/modelPicker.html');
	await page.evaluate(() => window.ashModelPickerIntegration.configure({ thinking: true }));
	const picker = page.locator('.ash-sessions-model-picker');
	await picker.click();
	await expect(page.getByRole('dialog')).toBeVisible();
	await picker.click();
	await expect(picker).toHaveAttribute('aria-expanded', 'false');
	await picker.click();
	await page.getByRole('button', { name: 'Choose model', exact: true }).click();
	await picker.click();
	await expect(page.getByRole('menu')).toHaveCount(0);
	await picker.click();
	await expect(page.getByRole('dialog')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(picker).toBeFocused();
	await page.evaluate(() => window.ashModelPickerIntegration.configure({ thinking: true, secondWithoutThinking: true }));
	await picker.press('ArrowDown');
	await expect(page.getByRole('button', { name: 'Choose model', exact: true })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('menuitemradio', { name: 'First model' })).toBeFocused();
	await page.keyboard.press('End');
	await page.keyboard.press('Enter');
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(picker).toHaveText('Second model');
	await expect(picker).toBeFocused();
});

test('Sessions thinking slider follows the pointer continuously, snaps on release and clamps outside its rail', async ({ page }) => {
	await page.goto('/modelPicker.html');
	await page.evaluate(() => window.ashModelPickerIntegration.configure({ thinking: true }));
	await page.locator('.ash-sessions-model-picker').click();
	const rail = page.locator('.ash-sessions-model-picker-thumb-rail');
	const thumb = page.locator('.ash-sessions-model-picker-thumb');
	const surface = page.locator('.ash-sessions-model-picker-surface');
	await expect.poll(() => surface.evaluate(element => element.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0);
	const bounds = (await rail.boundingBox())!;
	const y = bounds.y + bounds.height / 2;
	await page.mouse.move(bounds.x + bounds.width * 0.63, y);
	await page.mouse.down();
	await expect(page.getByRole('slider')).toHaveAttribute('aria-valuetext', 'Extra High');
	await expect.poll(async () => {
		const box = (await thumb.boundingBox())!;
		return Math.abs(box.x + box.width / 2 - (bounds.x + bounds.width * 0.63));
	}).toBeLessThan(1);
	await page.mouse.up();
	await expect.poll(async () => {
		const box = (await thumb.boundingBox())!;
		return Math.abs(box.x + box.width / 2 - (bounds.x + bounds.width * 0.75));
	}).toBeLessThan(1);
	await page.mouse.move(bounds.x + bounds.width * 0.5, y);
	await page.mouse.down();
	await page.mouse.move(bounds.x - 80, y);
	await expect(page.getByRole('slider')).toHaveAttribute('aria-valuetext', 'Low');
	await page.mouse.move(bounds.x + bounds.width + 80, y);
	await expect(page.getByRole('slider')).toHaveAttribute('aria-valuetext', 'Max');
	await page.mouse.up();
	await expect(page.getByRole('dialog')).toBeVisible();
});

test('Sessions thinking slider moves visually without changing the thumb layout position', async ({ page }) => {
	await page.goto('/modelPicker.html');
	await page.evaluate(() => window.ashModelPickerIntegration.configure({ thinking: true }));
	await page.locator('.ash-sessions-model-picker').click();
	const slider = page.getByRole('slider');
	await slider.press('Home');
	const thumb = page.locator('.ash-sessions-model-picker-thumb');
	const rail = page.locator('.ash-sessions-model-picker-thumb-rail');
	await expect.poll(async () => {
		const box = (await thumb.boundingBox())!;
		return Math.abs(box.x + box.width / 2 - (await rail.boundingBox())!.x);
	}).toBeLessThan(1);
	const positions = await page.evaluate(() => {
		const popup = document.querySelector<HTMLElement>('.ash-sessions-model-picker-popup')!;
		const slider = popup.querySelector('input')!;
		slider.value = slider.max;
		slider.dispatchEvent(new Event('input', { bubbles: true }));
		// Resolve styles, then sample the real transitions at deterministic points.
		const thumb = popup.querySelector<HTMLElement>('.ash-sessions-model-picker-thumb')!;
		thumb.getBoundingClientRect();
		const animations = popup.getAnimations({ subtree: true }).filter(animation => animation instanceof CSSTransition);
		for (const animation of animations) { animation.pause(); }
		return [0, 0.25, 0.5, 0.75, 1].map(progress => {
			for (const animation of animations) { animation.currentTime = Number(animation.effect!.getTiming().duration) * progress; }
			const bounds = thumb.getBoundingClientRect();
			return { x: bounds.x + bounds.width / 2, layoutX: thumb.offsetLeft };
		});
	});
	const bounds = (await rail.boundingBox())!;
	expect(Math.abs(positions[0]!.x - bounds.x)).toBeLessThan(1);
	expect(Math.abs(positions.at(-1)!.x - bounds.x - bounds.width)).toBeLessThan(1);
	expect(positions[1]!.x).toBeGreaterThan(positions[0]!.x);
	expect(positions[1]!.x).toBeLessThan(positions.at(-1)!.x);
	expect(new Set(positions.map(position => position.layoutX)).size).toBe(1);
});

test('Sessions model picker keeps one popup through view transitions and honors reduced motion', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/modelPicker.html');
	await page.evaluate(() => window.ashModelPickerIntegration.configure({ thinking: true, emphasizedLevel: 'extraHigh' }));
	await page.locator('.ash-sessions-model-picker').click();
	const id = await page.getByRole('dialog').getAttribute('id');
	await expect(page.locator('.ash-sessions-model-picker-surface')).toHaveCSS('animation-name', 'none');
	await expect(page.locator('.ash-sessions-model-picker-pages')).toHaveCSS('transition-duration', '0s');
	await expect(page.locator('.ash-sessions-model-picker-maximum-effects')).toHaveCSS('opacity', '1');
	expect(await page.locator('.ash-sessions-model-picker-maximum-effects').evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
	for (let index = 0; index < 3; index++) {
		await page.getByRole('button', { name: 'Choose model', exact: true }).click();
		await expect(page.getByRole('menu')).toHaveAttribute('id', id!);
		await page.getByRole('menuitemradio', { name: index % 2 ? 'First model' : 'Second model' }).click();
		await expect(page.getByRole('dialog')).toHaveAttribute('id', id!);
	}
	await page.keyboard.press('Escape');
	await expect(page.locator('.ash-sessions-model-picker-page')).toHaveCount(0);
});

test('Sessions model picker runs emphasized effects only for the provider-marked level on the visible page', async ({ page }) => {
	await page.goto('/modelPicker.html');
	await page.evaluate(() => window.ashModelPickerIntegration.configure({ thinking: true, emphasizedLevel: 'high' }));
	const picker = page.locator('.ash-sessions-model-picker');
	await picker.click();
	const slider = page.getByRole('slider');
	await slider.press('Home');
	await slider.press('ArrowRight');
	await slider.press('ArrowRight');
	const effects = page.locator('.ash-sessions-model-picker-maximum-effects');
	const running = () => effects.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length);
	await expect(picker).toHaveText('High');
	await expect(effects).toHaveCSS('opacity', '1');
	await expect.poll(running).toBeGreaterThan(1);
	await slider.press('End');
	await expect(picker).toHaveText('Max');
	await expect(effects).toHaveCSS('opacity', '0');
	await expect.poll(running).toBe(0);
	await slider.press('ArrowLeft');
	await slider.press('ArrowLeft');
	await expect.poll(running).toBeGreaterThan(1);
	await page.getByRole('button', { name: 'Choose model', exact: true }).click();
	await expect.poll(running).toBe(0);
	await page.getByRole('menuitemradio', { name: 'Second model', exact: true }).click();
	await expect.poll(running).toBeGreaterThan(1);
	await page.keyboard.press('Escape');
	await expect(effects).toHaveCount(0);
});

test('Sessions model picker animates page height and lets a new selection interrupt its transition', async ({ page }) => {
	await page.goto('/modelPicker.html');
	await page.addStyleTag({ content: '.ash-sessions-model-picker-surface { animation: none; } .ash-sessions-model-picker-pages { transition-duration: 2s; }' });
	await page.evaluate(() => window.ashModelPickerIntegration.configure({ thinking: true }));
	await page.locator('.ash-sessions-model-picker').click();
	const pages = page.locator('.ash-sessions-model-picker-pages');
	const before = (await pages.boundingBox())!.height;
	await page.getByRole('button', { name: 'Choose model', exact: true }).click();
	const intermediate = await pages.evaluate(element => {
		const animation = element.getAnimations().find(animation => animation instanceof CSSTransition && animation.transitionProperty === 'height');
		if (!animation) { throw new Error('The panel height must transition between its two measured sizes'); }
		animation.pause();
		animation.currentTime = Number(animation.effect!.getTiming().duration) * 0.15;
		return {
			height: element.getBoundingClientRect().height,
			target: element.querySelector<HTMLElement>('[data-active="true"]')!.offsetHeight,
		};
	});
	expect(intermediate.height).toBeGreaterThan(Math.min(before, intermediate.target));
	expect(intermediate.height).toBeLessThan(Math.max(before, intermediate.target));
	// Interrupt the paused, unfinished transition with a real model choice.
	await page.getByRole('menuitemradio', { name: 'Second model' }).click();
	await expect(page.getByRole('dialog')).toBeVisible();
	await expect(page.locator('.ash-sessions-model-picker-page[data-active="true"]')).toHaveCount(1);
	await expect.poll(async () => Math.abs((await pages.boundingBox())!.height - before)).toBeLessThan(1);
});

for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
	test(`Sessions model picker fits narrow windows and retains focus and surface contrast in ${theme}`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 320, height: 400 });
		await page.goto(`/modelPicker.html?theme=${theme}`);
		await page.evaluate(() => window.ashModelPickerIntegration.configure({ longTitle: true }));
		const picker = page.locator('.ash-sessions-model-picker');
		await picker.focus();
		await picker.press('Enter');
		const menu = page.getByRole('menu');
		const bounds = await menu.boundingBox();
		expect(bounds!.x).toBeGreaterThanOrEqual(0);
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
		const surface = page.locator('.ash-sessions-model-picker-surface');
		await expect(surface).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(menu.getByRole('menuitemradio').first()).toHaveCSS('outline-style', 'solid');
		expect(await menu.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		if (theme.startsWith('hc')) {
			await expect(surface).toHaveCSS('box-shadow', 'none');
			await expect(surface).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
		}
		await testInfo.attach('model-menu', { body: await page.screenshot(), contentType: 'image/png' });
		await page.keyboard.press('Escape');
		await page.evaluate(() => window.ashModelPickerIntegration.configure({ thinking: true, singleLevel: true }));
		await picker.click();
		await expect(page.getByRole('slider')).toBeDisabled();
		await expect(page.getByRole('dialog')).toBeFocused();
		await page.evaluate(() => window.ashModelPickerIntegration.configure({ disabled: true }));
		await expect(picker).toBeDisabled();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await page.evaluate(() => window.ashModelPickerIntegration.configure({ thinking: true, emphasizedLevel: 'extraHigh' }));
		await picker.click();
		const effects = page.locator('.ash-sessions-model-picker-maximum-effects');
		await expect(effects).toHaveCSS('opacity', '1');
		if (theme.startsWith('hc')) {
			await expect(effects).toHaveCSS('background-image', 'none');
			await expect(effects.locator('span').first()).toHaveCSS('display', 'none');
			expect(await effects.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
		} else {
			await expect(effects).not.toHaveCSS('background-image', 'none');
		}
		await testInfo.attach('emphasized-level', { body: await page.getByRole('dialog').screenshot(), contentType: 'image/png' });
	});
}
