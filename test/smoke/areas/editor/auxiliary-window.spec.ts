import { expect, test } from '../../../automation/test.js';
import { waitForElectronWindowState } from '../../../automation/electronDriver.js';

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

test('detached editor windows participate in desktop window switching and close-other-windows', async ({ workbench, target, application }) => {
	test.skip(target.kind !== 'electron', 'Requires desktop window operations.');
	if (!('windows' in application)) {
		throw new Error('Expected an Electron application');
	}
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	await expect(workbench.editors.groupAt(0).tabs.last()).toContainText('Untitled');
	await page.keyboard.press('F1');
	const command = page.locator('.ash-quick-pick').getByRole('combobox');
	await command.fill('Move Editor into New Window');
	const opened = page.context().waitForEvent('page');
	await command.press('Enter');
	const popup = await opened;
	try {
		await expect(popup.locator('.ash-auxiliary-window-container .ash-workbench-editor')).toBeVisible();
		const title = await popup.title();
		await page.bringToFront();
		await page.keyboard.press('F1');
		await command.fill('Switch Window...');
		await command.press('Enter');
		await expect(command).toHaveAttribute('placeholder', 'Select a window');
		await expect(page.locator('.ash-quick-pick-row-label')).toHaveCount(2);
		await page.locator('.ash-quick-pick-row-label').filter({ hasText: title }).click();
		await waitForElectronWindowState(application, popup, { focused: true });

		await page.bringToFront();
		await page.keyboard.press('F1');
		await command.fill('Close Other Windows');
		await command.press('Enter');
		await expect.poll(() => popup.isClosed()).toBe(true);
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'Untitled' })).toHaveCount(1);
		await page.keyboard.press('F1');
		await command.fill('Switch Window...');
		await command.press('Enter');
		await expect(command).toHaveAttribute('placeholder', 'Select a window');
		await expect(page.locator('.ash-quick-pick-row-label')).toHaveCount(1);
		await command.press('Escape');
	} finally {
		if (!popup.isClosed()) {
			await popup.close();
		}
	}
});

test('detached window titlebar follows its own editor and reserves layout space', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
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

		const titlebar = root.locator('.ash-auxiliary-titlebar');
		await expect(titlebar).toBeVisible();
		await expect(popup).toHaveTitle(/Untitled/);
		await expect(titlebar.locator('.ash-titlebar-command-center-button')).toHaveAttribute('aria-description', await popup.title());
		const mainTitle = await page.title();
		await popup.locator('.stanza-editor-input').first().focus();
		await expect(page).toHaveTitle(mainTitle);
		const bounds = await root.evaluate(element => {
			const title = element.querySelector('.ash-auxiliary-titlebar')!.getBoundingClientRect();
			const editor = element.querySelector('.ash-workbench-editor')!.getBoundingClientRect();
			const status = element.querySelector('.ash-workbench-statusbar')!.getBoundingClientRect();
			return { titleHeight: title.height, titleBottom: title.bottom, editorTop: editor.top, editorBottom: editor.bottom, statusTop: status.top, statusBottom: status.bottom, windowHeight: element.ownerDocument.defaultView!.innerHeight };
		});
		expect(bounds.titleHeight).toBeGreaterThan(0);
		expect(Math.abs(bounds.titleBottom - bounds.editorTop)).toBeLessThanOrEqual(1);
		expect(Math.abs(bounds.editorBottom - bounds.statusTop)).toBeLessThanOrEqual(1);
		expect(Math.abs(bounds.statusBottom - bounds.windowHeight)).toBeLessThanOrEqual(1);

		await popup.close();
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'Untitled' })).toHaveCount(1);
	} finally {
		if (!popup.isClosed()) await popup.close();
	}
});
