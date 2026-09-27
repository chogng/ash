import { expect, test } from '../../../automation/test.js';

test('detached editor window inherits workbench theme and accessibility state', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	await expect(workbench.editors.groupAt(0).tabs.last()).toContainText('Untitled');

	await page.keyboard.press('F1');
	const command = page.locator('.ash-quick-pick').getByRole('combobox');
	await command.fill('Move Editor into New Window');
	await expect(page.locator('.ash-quick-pick-row-label', { hasText: 'Move Editor into New Window' })).toBeVisible();
	const popupPromise = page.context().waitForEvent('page');
	await command.press('Enter');
	const popup = await popupPromise;
	try {
		const root = popup.locator('.ash-auxiliary-window-container');
		await expect(root.locator('.ash-workbench-editor')).toBeVisible();
		const sameElementRealm = await root.evaluate(element => element.firstElementChild?.constructor === element.constructor);
		expect(sameElementRealm).toBe(true);
		const mainAppearance = await page.locator('.ash-workbench').first().evaluate(element => ({
			scheme: element.getAttribute('data-color-scheme'),
			os: element.getAttribute('data-os'),
			reducedMotion: element.classList.contains('ash-reduce-motion'),
			background: getComputedStyle(element).backgroundColor,
			foreground: getComputedStyle(element).color,
		}));
		await expect.poll(() => root.evaluate(element => ({
			scheme: element.getAttribute('data-color-scheme'),
			os: element.getAttribute('data-os'),
			reducedMotion: element.classList.contains('ash-reduce-motion'),
			background: getComputedStyle(element).backgroundColor,
			foreground: getComputedStyle(element).color,
		}))).toEqual(mainAppearance);
		await popup.keyboard.press('F1');
		await expect(page.locator('.ash-quick-pick')).toBeVisible();
		await page.keyboard.press('Escape');
		await popup.keyboard.press('ControlOrMeta+f');
		await expect(popup.locator('.stanza-editor-find-widget')).toBeVisible();
		await popup.keyboard.press('Escape');
		await popup.evaluate(() => { window.resizeTo(700, 530); window.moveTo(120, 90); });
		const previousBounds = await popup.evaluate(() => ({ width: window.outerWidth, height: window.outerHeight, left: window.screenX, top: window.screenY }));
		await popup.evaluate(() => window.close());
		await expect.poll(() => popup.isClosed()).toBe(true);
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'Untitled' })).toHaveCount(1);
		await page.keyboard.press('F1');
		const reopenCommand = page.locator('.ash-quick-pick').getByRole('combobox');
		await reopenCommand.fill('Move Editor into New Window');
		const reopenedPromise = page.context().waitForEvent('page');
		await reopenCommand.press('Enter');
		const reopened = await reopenedPromise;
		try {
			await expect(reopened.locator('.ash-auxiliary-window-container .ash-workbench-editor')).toBeVisible();
			await expect.poll(() => reopened.evaluate(() => ({ width: window.outerWidth, height: window.outerHeight, left: window.screenX, top: window.screenY }))).toEqual(previousBounds);
		} finally {
			if (!reopened.isClosed()) await reopened.close();
		}
	} finally {
		if (!popup.isClosed()) await popup.close();
	}
});
