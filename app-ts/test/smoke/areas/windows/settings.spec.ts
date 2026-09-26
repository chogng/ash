import { expect, test } from '../../../automation/test.js';

test('Settings opens with editor display controls', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Ash Settings');
	await page.keyboard.press('Enter');
	await expect(page.locator('.ash-modal-editor')).toBeVisible();
	await page.locator('[data-settings-category-id="editor"]').click();
	await expect(page.locator('[data-configuration-key="editor.renderWhitespace"]')).toBeVisible();
	await expect(page.locator('[data-configuration-key="editor.renderControlCharacters"]')).toBeVisible();
});

test.describe('without an open workspace', () => {
	test.use({ openWorkspace: false });

	test('Manage menu runs its other workbench commands', async ({ target, workbench }) => {
		test.skip(target.workbenchMode !== 'code');
		const page = workbench.page;
		const manageButton = page.getByRole('button', { name: 'Manage' });
		const layoutButton = page.locator('[data-action-id="workbench.action.toggleAuxiliaryBar"] button');
		const [manageBounds, layoutBounds] = await Promise.all([manageButton.boundingBox(), layoutButton.boundingBox()]);
		expect(manageBounds).not.toBeNull();
		expect(layoutBounds).not.toBeNull();
		expect(manageBounds!.x).toBeLessThan(layoutBounds!.x);
		expect(manageBounds!.y).toBeGreaterThan(layoutBounds!.y);
		await expect(manageButton.locator('.ash-dropdown-menu-indicator')).toBeHidden();
		const select = async (name: string) => {
			await manageButton.click();
			await page.getByRole('menu').last().getByRole('menuitem', { name }).click();
		};

		await select('Command Palette...');
		await expect(page.getByPlaceholder('Type the name of a command to run')).toBeVisible();
		await page.keyboard.press('Escape');

		await select('Keyboard Shortcuts');
		await expect(page.locator('.ash-keybindings-editor')).toBeVisible();

		await select('Extensions');
		await expect(page.locator('.ash-marketplace')).toBeVisible();

		await select('Run Task...');
		await expect(page.locator('.ash-tasks')).toBeVisible();
		await manageButton.focus();
		await manageButton.press('ArrowDown');
		await expect(manageButton).toHaveAttribute('aria-expanded', 'true');
		await page.keyboard.press('Escape');
		await expect(manageButton).toHaveAttribute('aria-expanded', 'false');
		await expect(manageButton).toBeFocused();
	});

	test('Manage Themes menu changes the color theme', async ({ target, workbench }) => {
		test.skip(target.workbenchMode !== 'code');
		const page = workbench.page;
		await page.getByRole('button', { name: 'Manage' }).click();
		await page.getByRole('menu').last().getByRole('menuitem', { name: 'Themes' }).hover();
		const themes = page.getByRole('menu').last();
		await expect(themes.getByRole('menuitem')).toHaveText(['Color Theme', 'File Icon Theme', 'Product Icon Theme']);
		await themes.getByRole('menuitem', { name: 'Color Theme' }).click();
		const picker = page.locator('.ash-quick-pick-input input');
		await expect(picker).toBeVisible();
		await picker.fill('Ash Dark');
		await picker.press('Enter');
		await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-dark');
		for (const name of ['File Icon Theme', 'Product Icon Theme']) {
			await page.getByRole('button', { name: 'Manage' }).click();
			await page.getByRole('menu').last().getByRole('menuitem', { name: 'Themes' }).hover();
			await page.getByRole('menu').last().getByRole('menuitem', { name }).click();
			await expect(picker).toBeVisible();
			await picker.press('Escape');
		}
	});

	test('Activity Bar Manage menu opens Settings from the welcome page', async ({ target, workbench }) => {
		const page = workbench.page;
		const manageButton = page.getByRole('button', { name: 'Manage' });
		await manageButton.focus();
		const tooltip = page.locator('.ash-hover', { hasText: 'Manage' });
		await expect(tooltip).toBeVisible();
		const buttonBounds = await manageButton.boundingBox();
		const tooltipBounds = await page.locator('.ash-context-view-hover', { has: tooltip }).boundingBox();
		expect(buttonBounds).not.toBeNull();
		expect(tooltipBounds).not.toBeNull();
		const viewportWidth = await page.evaluate(() => window.innerWidth);
		expect(tooltipBounds!.x).toBeGreaterThanOrEqual(0);
		expect(tooltipBounds!.x + tooltipBounds!.width).toBeLessThanOrEqual(viewportWidth);
		expect(tooltipBounds!.x).toBeLessThan(buttonBounds!.x + buttonBounds!.width);
		await manageButton.click();
		await expect(manageButton).toHaveAttribute('aria-expanded', 'true');
		const menu = page.getByRole('menu').last();
		await expect(menu.getByRole('menuitem')).toHaveText([
			/^Command Palette/, /^Settings/, 'Extensions', 'Keyboard Shortcuts', /^Run Task/, 'Themes',
			...(target.kind === 'electron' ? ['Check for Updates...'] : []),
		]);
		await menu.getByRole('menuitem', { name: 'Settings' }).click();
		await expect(page.getByRole('dialog', { name: 'Ash Settings' })).toBeVisible();
		await expect(page.locator('.ash-settings-editor')).toBeVisible();
		await page.locator('[data-settings-category-id="general"]').click();
		if (target.kind === 'electron') {
			const updatePolicy = page.locator('[data-configuration-key="update.policy"]').getByRole('combobox');
			await expect(updatePolicy).toBeVisible();
			await updatePolicy.click();
			await page.getByRole('option', { name: 'Never' }).click();
			await expect(updatePolicy).toHaveText('Never');
			await updatePolicy.click();
			await page.getByRole('option', { name: 'Latest' }).click();
			await expect(updatePolicy).toHaveText('Latest');
		} else {
			await expect(page.locator('[data-configuration-key="update.policy"]')).toHaveCount(0);
		}
		await page.locator('[data-settings-category-id="appearance"]').click();
		await expect(page.locator('[data-configuration-key="workbench.layoutStyle"]')).toBeVisible();
		if (target.kind === 'electron') {
			await expect(page.locator('[data-configuration-key="window.zoomLevel"]')).toBeVisible();
		} else {
			await expect(page.locator('[data-configuration-key="window.zoomLevel"]')).toHaveCount(0);
		}
	});

	test('Manage menu starts a desktop update check', async ({ target, workbench }) => {
		test.skip(target.kind !== 'electron', 'The web host does not install desktop updates');
		const page = workbench.page;
		await page.getByRole('button', { name: 'Manage' }).click();
		await page.getByRole('menu').last().getByRole('menuitem', { name: 'Check for Updates...' }).click();
		await expect(page.getByText(/Could not check for updates\.|Ash .* is up to date\.|Ash .* is available\./)).toBeVisible({ timeout: 45_000 });
		await expect(page.getByText('Checking for updates...')).toHaveCount(0);
	});

	test('editor More Actions tooltip clears the window controls', async ({ workbench }) => {
		const page = workbench.page;
		const moreActions = page.locator('.ash-editor-title-actions').getByRole('button', { name: 'More Actions' });
		await moreActions.focus();
		const tooltip = page.locator('.ash-hover', { hasText: 'More Actions' });
		await expect(tooltip).toBeVisible();
		const buttonBounds = await moreActions.boundingBox();
		const tooltipBounds = await tooltip.boundingBox();
		expect(buttonBounds).not.toBeNull();
		expect(tooltipBounds).not.toBeNull();
		expect(tooltipBounds!.y).toBeGreaterThanOrEqual(buttonBounds!.y + buttonBounds!.height);
	});
});
