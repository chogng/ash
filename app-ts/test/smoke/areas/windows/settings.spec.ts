import { expect, test } from '../../../automation/test.js';

test('Settings opens with editor display controls', async ({ target, workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Ash Settings');
	await page.keyboard.press('Enter');
	await expect(page.locator('.ash-modal-editor')).toBeVisible();
	await page.locator('[data-settings-category-id="editor"]').click();
	await expect(page.locator('.ash-settings-content-tree > .is-settings-root > .ash-settings-tree-group-title')).toHaveCount(0);
	await expect(page.locator('.ash-settings-card').first()).toHaveCSS('border-radius', '8px');
	await expect(page.locator('[data-configuration-key="editor.renderWhitespace"]')).toBeVisible();
	await expect(page.locator('[data-configuration-key="editor.renderControlCharacters"]')).toBeVisible();
	const rootTitle = page.locator('.ash-settings-page .is-settings-root > .ash-settings-tree-group-title');
	const rootDescription = page.locator('.ash-settings-page .is-settings-root > .ash-settings-tree-group-description');
	await expect(rootTitle).toHaveCount(1);
	await expect(rootDescription).toHaveCount(1);
	await expect(rootTitle).toBeHidden();
	await expect(rootDescription).toBeHidden();
	await page.locator('[data-settings-target-id="editor.group.selection"]').click();
	await expect(page.locator('.ash-settings-page h3')).toHaveText('Editor selection');
	await expect(rootTitle).toBeHidden();
	await expect(rootDescription).toBeHidden();
	for (const key of ['workbench.editor.showTabs', 'workbench.editor.defaultBinaryEditor']) {
		const row = page.locator(`[data-settings-item-id="${key}"]`);
		const control = row.getByRole('combobox');
		const [rowBounds, controlBounds] = await Promise.all([row.boundingBox(), control.boundingBox()]);
		expect(rowBounds).not.toBeNull();
		expect(controlBounds).not.toBeNull();
		expect(Math.abs(rowBounds!.x + rowBounds!.width - 16 - controlBounds!.x - controlBounds!.width)).toBeLessThanOrEqual(1);
	}
	await page.locator('[data-settings-target-id="editor.group.minimap"]').click();
	await expect(page.locator('.ash-settings-page h3')).toHaveText('Minimap');
	await expect(rootTitle).toBeHidden();
	await expect(rootDescription).toBeHidden();
	await expect(page.locator('[data-configuration-key="editor.minimap.enabled"]')).toBeVisible();
	if (target.kind === 'electron') {
		await page.locator('[data-settings-category-id="general"]').click();
		await expect(rootTitle).toBeHidden();
		await expect(rootDescription).toBeHidden();
		await page.locator('[data-settings-target-id="general.group.dictation"]').click();
		await expect(page.locator('.ash-settings-page h3')).toHaveText('Voice input');
		await expect(page.locator('.ash-settings-content-tree > .is-settings-root > .ash-settings-tree-group-title')).toHaveCount(0);
		await expect(page.locator('.ash-settings-content-tree > .is-settings-root > .ash-settings-tree-group-description')).toHaveCount(0);
		await expect(page.locator('[data-configuration-key="dictation.backend"]')).toBeVisible();
		await expect(page.locator('[data-configuration-key="dictation.localModel"]')).toBeVisible();
	}
	if (target.workbenchMode === 'code') {
		await page.locator('[data-settings-group-id="workbench"]').click();
		await page.locator('[data-settings-category-id="startup"]').click();
		await expect(rootTitle).toBeHidden();
		await expect(rootDescription).toBeHidden();
		const startupEditor = page.locator('[data-configuration-key="workbench.startupEditor"]').getByRole('combobox');
		await expect(startupEditor).toBeVisible();
		const startupRow = page.locator('[data-settings-item-id="workbench.startupEditor"]');
		const [startupRowBounds, startupControlBounds] = await Promise.all([startupRow.boundingBox(), startupEditor.boundingBox()]);
		expect(startupRowBounds).not.toBeNull();
		expect(startupControlBounds).not.toBeNull();
		expect(Math.abs(startupRowBounds!.x + startupRowBounds!.width - 16 - startupControlBounds!.x - startupControlBounds!.width)).toBeLessThanOrEqual(1);
		await startupEditor.click();
		await expect(page.getByRole('option', { name: 'Welcome in empty workbench' })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.locator('.ash-notification')).toHaveCount(0);
		await expect(page.locator('[data-settings-category-id="sessions"]')).toHaveCount(0);
	}
});

test('Changing the color theme does not add a modified marker', async ({ target, workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Ash Settings');
	await page.keyboard.press('Enter');
	await page.locator('[data-settings-group-id="workbench"]').click();
	await page.locator('[data-settings-category-id="appearance"]').click();
	const setting = page.locator('[data-settings-item-id="workbench.colorTheme"]');
	const control = setting.getByRole('combobox');
	const initialHeight = (await setting.boundingBox())?.height;
	expect(initialHeight).toBeDefined();
	await control.click();
	await page.getByRole('option', { name: 'Ash Dark', exact: true }).click();
	await expect(control).toHaveText('Ash Dark');
	await expect(setting.locator('.ash-settings-indicators')).toHaveCSS('display', 'none');
	expect((await setting.boundingBox())?.height).toBeCloseTo(initialHeight!, 0);
	if (target.kind === 'browser') {
		await page.locator('.ash-settings-search-filter').click();
		await expect(page.getByRole('menuitem', { name: 'Setting ID…' })).toBeVisible();
		await expect(page.getByRole('menuitem', { name: 'Modified' })).toHaveCount(0);
	}
});

test('Workbench boolean settings use keyboard-operable switches', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Ash Settings');
	await page.keyboard.press('Enter');
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await expect(settings).toBeVisible();
	await settings.locator('[data-settings-group-id="workbench"]').click();
	await settings.locator('[data-settings-category-id="layout"]').click();
	const compactActivityBar = settings.getByRole('switch', { name: 'Compact Activity Bar' });
	await expect(compactActivityBar).toBeVisible();
	const initialState = await compactActivityBar.isChecked();
	await expect(compactActivityBar).toHaveAttribute('aria-checked', String(initialState));
	await compactActivityBar.focus();
	await compactActivityBar.press('Space');
	await expect(compactActivityBar).toHaveAttribute('aria-checked', String(!initialState));
	await compactActivityBar.press('Space');
	await expect(compactActivityBar).toHaveAttribute('aria-checked', String(initialState));
});

test('Saving a boolean setting does not move neighboring settings', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Ash Settings');
	await page.keyboard.press('Enter');
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await settings.locator('[data-settings-category-id="general"]').click();
	await settings.locator('[data-settings-target-id="general.group.accessibility"]').click();
	const row = settings.locator('[data-settings-item-id="accessibility.verbosity.memories"]');
	const control = row.getByRole('switch', { name: 'Memories accessibility help' });
	await expect(control).toBeVisible();
	await expect(row.locator('.ash-settings-indicators')).toHaveAttribute('aria-live', 'polite');
	await expect(row.locator('.ash-settings-indicators')).toHaveCSS('clip-path', 'inset(50%)');
	const initialChecked = await control.isChecked();
	await page.evaluate(() => {
		const row = document.querySelector<HTMLElement>('[data-settings-item-id="accessibility.verbosity.memories"]')!;
		const indicator = row.querySelector<HTMLElement>('.ash-settings-indicators')!;
		const measurements: { pending: boolean; height: number }[] = [];
		const sample = () => measurements.push({ pending: !indicator.hidden, height: row.getBoundingClientRect().height });
		const observer = new MutationObserver(sample);
		observer.observe(indicator, { attributes: true, childList: true, subtree: true });
		sample();
		(window as Window & { settingRowMeasurements?: typeof measurements; settingRowObserver?: MutationObserver }).settingRowMeasurements = measurements;
		(window as Window & { settingRowObserver?: MutationObserver }).settingRowObserver = observer;
	});
	for (let index = 0; index < 4; index++) {
		await row.locator('.ash-switch-track').click();
		await expect(control).toHaveAttribute('aria-checked', String(index % 2 === 0 ? !initialChecked : initialChecked));
		await expect(row.locator('.ash-settings-indicators')).toBeHidden();
	}
	const measurements = await page.evaluate(() => {
		const state = window as Window & { settingRowMeasurements?: { pending: boolean; height: number }[]; settingRowObserver?: MutationObserver };
		state.settingRowObserver!.disconnect();
		return state.settingRowMeasurements!;
	});
	expect(measurements.some(measurement => measurement.pending)).toBe(true);
	expect(measurements.every(measurement => Math.abs(measurement.height - measurements[0].height) <= 1)).toBe(true);
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
		const quickDiffWhitespace = page.locator('[data-configuration-key="scm.diffDecorationsIgnoreTrimWhitespace"]').getByRole('combobox');
		await expect(quickDiffWhitespace).toHaveCSS('height', '24px');
		const autoFetchPeriod = page.locator('[data-configuration-key="git.autofetchPeriod"]');
		await expect(autoFetchPeriod).toHaveCSS('height', '24px');
		await expect(autoFetchPeriod).toHaveCSS('width', '96px');
		await expect(autoFetchPeriod).toHaveCSS('justify-self', 'end');
		await expect(autoFetchPeriod).toHaveCSS('appearance', 'textfield');
		const autoFetch = page.locator('[data-configuration-key="git.autofetch"]').getByRole('combobox');
		await autoFetch.click();
		const autoFetchPopup = page.locator('.ash-context-view-default', { has: page.locator('.ash-select-box-list') });
		const [autoFetchBounds, popupBounds] = await Promise.all([autoFetch.boundingBox(), autoFetchPopup.boundingBox()]);
		expect(autoFetchBounds).not.toBeNull();
		expect(popupBounds).not.toBeNull();
		expect(popupBounds!.width).toBeGreaterThan(autoFetchBounds!.width);
		expect(Math.abs(popupBounds!.x + popupBounds!.width - autoFetchBounds!.x - autoFetchBounds!.width)).toBeLessThanOrEqual(1);
		await page.keyboard.press('Escape');
		await page.locator('[data-settings-group-id="workbench"]').click();
		const appearanceRow = page.locator('.ash-tree-row', { has: page.locator('[data-settings-category-id="appearance"]') });
		expect(await appearanceRow.getAttribute('aria-expanded')).toBeNull();
		await expect(page.locator('[data-settings-target-id="appearance.group.theme"]')).toHaveCount(0);
		await page.locator('[data-settings-category-id="appearance"]').click();
		const appearanceGroup = page.locator('.ash-settings-content-group:not(.is-settings-root)');
		await expect(appearanceGroup.locator('.ash-settings-tree-group-title')).toBeHidden();
		await expect(appearanceGroup.locator('.ash-settings-tree-group-description')).toBeHidden();
		await expect(appearanceGroup.locator('.ash-settings-card')).toHaveCSS('border-radius', '8px');
		await expect(page.locator('[data-configuration-key="workbench.colorTheme"]')).toBeVisible();
		await expect(page.locator('[data-configuration-key="workbench.colorTheme"]').getByRole('combobox')).toBeVisible();
		const appearanceSettings = appearanceGroup.locator('.ash-configuration-setting');
		await expect(appearanceSettings).toHaveCount(3);
		for (const setting of await appearanceSettings.all()) {
			await expect(setting.locator('.ash-settings-indicators')).toHaveCSS('display', 'none');
			await expect(setting).toHaveCSS('height', '68px');
		}
		await expect(page.locator('[data-configuration-key="workbench.layoutStyle"]')).toHaveCount(0);
		await page.locator('[data-settings-category-id="layout"]').click();
		const layoutStyle = page.locator('[data-configuration-key="workbench.layoutStyle"]');
		await expect(layoutStyle).toBeVisible();
		for (const key of ['window.titleBarStyle', 'window.menuStyle']) {
			if (target.kind === 'electron') await expect(page.locator(`[data-configuration-key="${key}"]`)).toBeVisible();
			else await expect(page.locator(`[data-configuration-key="${key}"]`)).toHaveCount(0);
		}
		await expect(page.locator('[data-configuration-key="sessions.activityBar.location"]')).toHaveCount(0);
		const modernWidth = (await layoutStyle.getByRole('combobox').boundingBox())?.width;
		expect(modernWidth).toBeDefined();
		expect(modernWidth!).toBeLessThan(120);
		const layoutIndicator = layoutStyle.locator('.ash-dropdown-indicator [data-ash-icon-id="chevron-down"]');
		await expect(layoutIndicator).toBeVisible();
		await expect(layoutStyle.getByRole('combobox')).toHaveCSS('gap', '4px');
		await expect(layoutIndicator).toHaveCSS('width', '16px');
		await expect(layoutIndicator).toHaveCSS('height', '16px');
		await layoutStyle.getByRole('combobox').click();
		const selectedCheck = page.locator('.ash-select-box-option-selected .ash-select-box-option-check [data-ash-icon-id="check"]');
		await expect(selectedCheck).toHaveCSS('width', '16px');
		await expect(selectedCheck).toHaveCSS('height', '16px');
		const clippedOptions = await page.locator('.ash-select-box-option-label').evaluateAll(labels => labels.some(label => label.scrollWidth > label.clientWidth));
		expect(clippedOptions).toBe(false);
		await expect(page.locator('.ash-context-view-default', { has: page.locator('.ash-select-box-list') })).toHaveCSS('border-radius', '6px');
		const fontSizes = await page.evaluate(() => {
			const trigger = document.querySelector('[data-configuration-key="workbench.layoutStyle"] .ash-dropdown-label');
			const option = document.querySelector('.ash-select-box-option-label');
			return { trigger: getComputedStyle(trigger!).fontSize, option: getComputedStyle(option!).fontSize };
		});
		expect(fontSizes.option).toBe(fontSizes.trigger);
		await page.getByRole('option', { name: 'Flat' }).click();
		const flatWidth = (await layoutStyle.getByRole('combobox').boundingBox())?.width;
		expect(flatWidth).toBeDefined();
		expect(flatWidth!).toBeLessThan(modernWidth!);
		await layoutStyle.getByRole('combobox').click();
		await page.getByRole('option', { name: 'Modern' }).click();
		if (target.kind === 'electron') {
			await expect(page.locator('[data-configuration-key="window.zoomLevel"]')).toBeVisible();
		} else {
			await expect(page.locator('[data-configuration-key="window.zoomLevel"]')).toHaveCount(0);
		}
		await page.locator('[data-settings-category-id="editor"]').click();
		const fontSizeControl = page.locator('[data-configuration-key="editor.fontSize"]').locator('..');
		await expect(fontSizeControl).toHaveCSS('height', '24px');
		await expect(fontSizeControl).toHaveCSS('width', '96px');
		await expect(fontSizeControl).toHaveCSS('justify-self', 'end');
		await expect(page.locator('[data-configuration-key="editor.fontFamily"]')).toHaveCSS('height', '24px');
		await expect(page.locator('[data-configuration-key="editor.wordWrap"]').getByRole('combobox')).toHaveCSS('height', '24px');
		await expect(page.locator('[data-configuration-key="explorer.fileNesting.patterns"] .ash-string-map-row input').first()).toHaveCSS('height', '24px');
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
