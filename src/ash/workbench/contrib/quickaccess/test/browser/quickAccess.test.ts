import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('quickAccess browser component', () => {
	const browserTests = useBrowserTests();
	test('Quick Access virtualizes single-line results while retaining keyboard and ARIA positions', async function () {
		const { page } = browserTests;
		await page.goto('/quickAccess.html?singleLineRows');
		await page.getByRole('button', { name: 'Open files', exact: true }).click();
		const picker = page.getByRole('dialog');
		const input = picker.getByRole('combobox');
		await input.fill('file-');
		const active = picker.locator('.ash-list-row.is-active');
		await expect(active).toHaveAttribute('aria-setsize', '60');
		await expect(active).toHaveAttribute('aria-posinset', '1');
		await expect(input).toHaveAttribute('aria-activedescendant', await active.getAttribute('id') ?? '');
		expect(await picker.getByRole('option').count()).toBeLessThan(40);
		await input.press('ArrowUp');
		await expect(active.locator('.ash-quick-pick-row-label')).toHaveText('file-59.ts');
		await expect(active).toHaveAttribute('aria-posinset', '60');
		await expect(input).toHaveAttribute('aria-activedescendant', await active.getAttribute('id') ?? '');
		expect(await picker.getByRole('option').count()).toBeLessThan(40);
		await input.press('Enter');
		await expect(picker).toHaveCount(0);
		await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('file-59.ts');
	});

	for (const variant of [{ locale: 'en', theme: 'light' }, { locale: 'zh-CN', theme: 'dark' }, { locale: 'en', theme: 'hc' }]) {
		test(`Quick Pick clears input through its toolbar and retains focus (${variant.locale}, ${variant.theme})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.goto(`/quickAccess.html?${new URLSearchParams(variant)}`);
			const trigger = page.getByRole('button', { name: 'Open files' });
			await trigger.click();
			const picker = page.getByRole('dialog');
			const input = picker.getByRole('combobox');
			const clearLabel = variant.locale === 'zh-CN' ? '清空输入' : 'Clear input';
			const actions = picker.getByRole('toolbar', { name: clearLabel, includeHidden: true });
			const clear = actions.getByRole('button', { name: clearLabel });
			await expect(input).toHaveAttribute('type', 'text');
			const borderColor = await picker.evaluate(element => getComputedStyle(element).borderColor);
			await expect(actions).toBeHidden();
			await input.fill('file-1');
			await expect(picker).toHaveCSS('border-color', borderColor);
			await expect(clear).toBeVisible();
			await expect(picker.getByText('file-0.ts', { exact: true })).toHaveCount(0);
			const fieldBounds = (await input.boundingBox())!;
			const actionBounds = (await clear.boundingBox())!;
			expect(actionBounds.x).toBeGreaterThan(fieldBounds.x);
			expect(actionBounds.x + actionBounds.width).toBeLessThanOrEqual(fieldBounds.x + fieldBounds.width);
			expect(actionBounds.y).toBeGreaterThanOrEqual(fieldBounds.y);
			expect(actionBounds.y + actionBounds.height).toBeLessThanOrEqual(fieldBounds.y + fieldBounds.height);
			await picker.screenshot({ path: testInfo.outputPath('quick-pick-clear-input.png') });
			await clear.click();
			await expect(input).toHaveValue('');
			await expect(input).toBeFocused();
			await expect(actions).toBeHidden();
			await expect(picker.getByText('file-0.ts', { exact: true })).toBeVisible();
			for (const key of ['Enter', 'Space']) {
				await input.fill('file-2');
				await input.press('Tab');
				await expect(clear).toBeFocused();
				await expect(clear).toHaveCSS('outline-style', 'solid');
				await expect(picker).toHaveCSS('border-color', borderColor);
				await clear.press(key);
				await expect(input).toHaveValue('');
				await expect(input).toBeFocused();
				await expect(actions).toBeHidden();
			}
			await input.press('Escape');
			await expect(picker).toHaveCount(0);
			await expect(trigger).toBeFocused();
		});

		test(`Command Palette configures shortcuts without executing commands or changing history (${variant.locale}, ${variant.theme})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.goto(`/quickAccess.html?${new URLSearchParams(variant)}`);
			const open = page.getByRole('button', { name: 'Open commands' });
			const picker = page.getByRole('dialog');
			const input = picker.getByRole('combobox');
			const configureLabel = variant.locale === 'zh-CN' ? '配置快捷键' : 'Configure Keybinding';
			const removeLabel = variant.locale === 'zh-CN' ? '从命令历史记录中移除' : 'Remove from Command History';
			await open.click();
			await input.fill('>Format');
			const alpha = picker.getByRole('option').filter({ has: page.locator('.ash-quick-pick-row-label', { hasText: /^Alpha Format$/ }) });
			const gear = alpha.getByRole('button', { name: configureLabel });
			await expect(gear).toHaveCSS('opacity', '0');
			await alpha.hover();
			await expect(gear).toHaveCSS('opacity', '1');
			await expect(alpha.getByRole('toolbar')).toHaveCount(1);
			await expect(gear.locator('.ash-icon')).toHaveAttribute('aria-hidden', 'true');
			await picker.screenshot({ path: testInfo.outputPath('configure-keybinding.png') });
			await expect(gear).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			const rowBackground = await alpha.evaluate(element => getComputedStyle(element).backgroundColor);
			await gear.hover();
			await expect(gear).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(alpha).toHaveCSS('background-color', rowBackground);
			await picker.screenshot({ path: testInfo.outputPath('configure-keybinding-hover.png') });
			await alpha.hover();
			await expect(gear).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await gear.click();
			await expect(picker).toHaveCount(0);
			await expect.poll(() => page.evaluate(() => window.ashQuickAccessIntegration.keybindingRequests)).toEqual([
				{ textual: false, query: '@command:test.quickAccess.AlphaFormat', pickerVisible: false },
			]);
			await open.click();
			await input.fill('>Unbound command');
			await expect(picker.getByRole('button', { name: removeLabel })).toHaveCount(0);
			await input.press('Tab');
			await page.keyboard.press('Tab');
			await expect(picker.getByRole('tab').first()).toBeFocused();
			await page.keyboard.press('Tab');
			const unboundGear = picker.getByRole('button', { name: configureLabel });
			await expect(unboundGear).toBeFocused();
			await expect(unboundGear).toHaveCSS('opacity', '1');
			await unboundGear.press('Enter');
			await expect(picker).toHaveCount(0);
			await expect.poll(() => page.evaluate(() => window.ashQuickAccessIntegration.keybindingRequests.at(-1))).toEqual({
				textual: false, query: '@command:test.quickAccess.Unboundcommand', pickerVisible: false,
			});
			expect(await page.evaluate(() => window.ashQuickAccessIntegration.executions)).toEqual([]);
			await open.click();
			const recentLabel = variant.locale === 'zh-CN' ? '最近使用' : 'recently used';
			await expect(picker.getByRole('separator', { name: recentLabel })).toHaveCount(0);
			await input.fill('>Format');
			await input.press('Enter');
			await expect(picker).toHaveCount(0);
			await open.click();
			await input.fill('>Format');
			const recent = picker.getByRole('option').filter({ has: page.locator('.ash-quick-pick-row-label', { hasText: /^Format$/ }) });
			await expect(recent.getByRole('button', { name: removeLabel })).toHaveCount(1);
			await recent.getByRole('button', { name: configureLabel }).click();
			await expect(picker).toHaveCount(0);
			await expect.poll(() => page.evaluate(() => window.ashQuickAccessIntegration.keybindingRequests.at(-1))).toEqual({
				textual: false, query: '@command:test.quickAccess.Format', pickerVisible: false,
			});
			expect(await page.evaluate(() => window.ashQuickAccessIntegration.executions)).toEqual(['Format']);
			await open.click();
			await expect(picker.getByRole('separator', { name: recentLabel })).toHaveCount(1);
			await expect(recent.getByRole('button', { name: removeLabel })).toHaveCount(1);
		});

		test(`Command Palette opens the real shortcut editor in a modal and restores focus (${variant.locale}, ${variant.theme})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.goto(`/quickAccess.html?${new URLSearchParams(variant)}&shortcuts=1`);
			const open = page.getByRole('button', { name: 'Open commands' });
			await expect(open).toBeEnabled();
			const picker = page.locator('.ash-quick-pick');
			const configureLabel = variant.locale === 'zh-CN' ? '配置快捷键' : 'Configure Keybinding';
			const title = variant.locale === 'zh-CN' ? '键盘快捷方式' : 'Keyboard Shortcuts';
			const modal = page.getByRole('dialog', { name: title, exact: true });
			for (const [label, command, close] of [['Alpha Format', 'AlphaFormat', 'Escape'], ['Unbound command', 'Unboundcommand', 'button']] as const) {
				await open.click();
				await picker.getByRole('combobox').fill(`>${label}`);
				await picker.getByRole('button', { name: configureLabel }).click();
				await expect(picker).toHaveCount(0);
				await expect(modal).toBeVisible();
				await expect(modal).toHaveAttribute('aria-modal', 'true');
				const search = modal.locator('.ash-keybindings-search input');
				await expect(search).toHaveValue(`@command:test.quickAccess.${command}`);
				await expect(search).toBeFocused();
				await expect(modal.locator('.ash-keybindings-row')).toHaveCount(1);
				await expect(modal.locator('.ash-keybindings-command-id')).toHaveText(`test.quickAccess.${command}`);
				await expect(modal.locator('.ash-keybindings-source')).toHaveText(command === 'AlphaFormat'
					? variant.locale === 'zh-CN' ? '系统' : 'System'
					: variant.locale === 'zh-CN' ? '未分配' : 'Unassigned');
				const closeButton = modal.getByRole('button', { name: variant.locale === 'zh-CN' ? `关闭${title}` : `Close ${title}`, exact: true });
				await expect(closeButton.locator('.ash-icon')).toBeVisible();
				expect((await closeButton.locator('.ash-button-content').boundingBox())!.width).toBeGreaterThanOrEqual(16);
				await closeButton.focus();
				await page.keyboard.press('Shift+Tab');
				expect(await modal.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
				await search.focus();
				if (close === 'Escape') {
					await modal.screenshot({ path: testInfo.outputPath('keyboard-shortcuts-modal.png') });
					await search.press('Escape');
					await expect(search).toHaveValue('');
					await expect(modal).toBeVisible();
					await search.press('Escape');
				} else {
					await closeButton.click();
				}
				await expect(modal).toBeHidden();
				await expect(open).toBeFocused();
			}
			expect(await page.evaluate(() => window.ashQuickAccessIntegration.executions)).toEqual([]);
		});

		test(`Keyboard Shortcuts search actions record exact chords and sort by real precedence (${variant.locale}, ${variant.theme})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.goto(`/quickAccess.html?${new URLSearchParams({ ...variant, shortcuts: '1', shortcutToolbar: '1' })}`);
			await page.getByRole('button', { name: 'Open commands' }).click();
			const picker = page.locator('.ash-quick-pick');
			await picker.getByRole('combobox').fill('>Alpha Format');
			await picker.getByRole('button', { name: variant.locale === 'zh-CN' ? '配置快捷键' : 'Configure Keybinding' }).click();
			const modal = page.locator('.ash-modal-editor');
			const search = modal.locator('.ash-keybindings-search input');
			const actions = modal.locator('.ash-keybindings-search-actions');
			const record = actions.getByRole('button', { name: variant.locale === 'zh-CN' ? '录制按键' : 'Record Keys', exact: false });
			const sort = actions.getByRole('button', { name: variant.locale === 'zh-CN' ? '按优先级排序（从高到低）' : 'Sort by Precedence (Highest first)', exact: false });
			const clear = actions.getByRole('button', { name: variant.locale === 'zh-CN' ? '清空快捷键搜索输入' : 'Clear Keybindings Search Input', exact: false });
			expect(await actions.locator('.ash-icon').evaluateAll(icons => icons.map(icon => icon.getAttribute('data-ash-icon-id')))).toEqual(['record-keys', 'sort-precedence', 'clear-all']);
			await expect(record).toHaveAttribute('aria-pressed', 'false');
			await expect(sort).toHaveAttribute('aria-pressed', 'false');
			await clear.click();
			await expect(clear).toBeDisabled();
			await record.focus();
			await page.keyboard.press('Enter');
			await expect(record).toHaveAttribute('aria-pressed', 'true');
			await expect(search).toBeFocused();
			await expect(search).toHaveAttribute('readonly', '');
			const badge = modal.locator('.ash-keybindings-recording-badge');
			await expect(badge).toHaveText(variant.locale === 'zh-CN' ? '正在录制按键' : 'Recording Keys');
			await expect(badge).toBeVisible();
			await search.press('Control+Alt+9');
			await expect(search).toHaveValue(/^"ctrl\+alt\+.*9.*"$/);
			await expect(modal.locator('.ash-keybindings-row')).toHaveCount(3);
			expect(await page.evaluate(() => window.ashQuickAccessIntegration.executions)).toEqual([]);
			await search.press('Control+x');
			await expect(modal.locator('.ash-keybindings-empty')).toBeVisible();
			const chordQuery = await search.inputValue();
			await search.press('Escape');
			await expect(record).toHaveAttribute('aria-pressed', 'false');
			await expect(badge).toBeHidden();
			await expect(search).toHaveValue(chordQuery);
			await expect(modal).toBeVisible();
			await search.press('Control+Alt+9');
			await expect.poll(() => page.evaluate(() => window.ashQuickAccessIntegration.executions)).toEqual(['YankeeLatest']);
			await clear.click();
			await search.fill('test.shortcutToolbar');
			const commands = () => modal.locator('.ash-keybindings-command-id').allTextContents();
			await expect.poll(commands).toEqual(['test.shortcutToolbar.AlphaLate', 'test.shortcutToolbar.YankeeLatest', 'test.shortcutToolbar.ZuluEarly']);
			await sort.click();
			await expect(sort).toHaveAttribute('aria-pressed', 'true');
			await expect(search).toHaveValue('test.shortcutToolbar');
			await expect.poll(commands).toEqual(['test.shortcutToolbar.YankeeLatest', 'test.shortcutToolbar.ZuluEarly', 'test.shortcutToolbar.AlphaLate']);
			await expect(modal.locator('.ash-keybindings-count')).toContainText(variant.locale === 'zh-CN' ? '按优先级' : 'precedence');
			await record.click();
			await clear.click();
			await search.press('Control+Alt+9');
			await expect.poll(commands).toEqual(['test.shortcutToolbar.YankeeLatest', 'test.shortcutToolbar.ZuluEarly', 'test.shortcutToolbar.AlphaLate']);
			expect(await page.evaluate(() => window.ashQuickAccessIntegration.executions)).toEqual(['YankeeLatest']);
			await modal.screenshot({ path: testInfo.outputPath('keybindings-search-actions-recording.png') });
			await search.press('Tab');
			await expect(record).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(sort).toBeFocused();
			await page.keyboard.press('Space');
			await expect(sort).toHaveAttribute('aria-pressed', 'false');
			await expect(search).toBeFocused();
			await expect.poll(commands).toEqual(['test.shortcutToolbar.AlphaLate', 'test.shortcutToolbar.YankeeLatest', 'test.shortcutToolbar.ZuluEarly']);
			await page.setViewportSize({ width: 700, height: 720 });
			const bounds = (await modal.locator('.ash-keybindings-search').boundingBox())!;
			for (const button of [record, sort, clear]) {
				const box = (await button.boundingBox())!;
				expect(box.height).toBe(22);
				expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
				expect((await button.locator('.ash-button-content').boundingBox())!.width).toBeGreaterThanOrEqual(16);
			}
			await modal.screenshot({ path: testInfo.outputPath('keybindings-search-actions-narrow.png') });
			await search.press('Escape');
			await search.press('Escape');
			await expect(search).toHaveValue('');
			await expect(clear).toBeDisabled();
		});

		test(`Keyboard Shortcuts keeps the compact layout and reveals actions on intent (${variant.locale}, ${variant.theme})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.goto(`/quickAccess.html?${new URLSearchParams({ ...variant, shortcuts: '1', shortcutRows: '1' })}`);
			await page.getByRole('button', { name: 'Open commands' }).click();
			const picker = page.locator('.ash-quick-pick');
			await picker.getByRole('combobox').fill('>Alpha Format');
			await picker.getByRole('button', { name: variant.locale === 'zh-CN' ? '配置快捷键' : 'Configure Keybinding' }).click();
			const modal = page.locator('.ash-modal-editor');
			const editor = modal.locator('.ash-keybindings-editor');
			const search = editor.locator('.ash-keybindings-search input');
			const grid = editor.getByRole('grid');
			const row = grid.locator('.ash-table-row').first();
			await page.mouse.move(2, 2);
			await expect(editor.locator('h1')).toHaveCount(0);
			await expect(row.locator('.ash-keybindings-command-id')).toBeHidden();
			await expect(row).toHaveCSS('height', '24px');
			await expect(row.locator('.ash-keybinding-label kbd').first()).toHaveCSS('height', '20px');
			await expect(editor.locator('.ash-keybindings-list')).toHaveCSS('border-top-width', '0px');
			await expect(editor.locator('.ash-keybindings-list')).toHaveCSS('border-radius', '0px');
			const editorBounds = (await editor.boundingBox())!;
			const searchBounds = (await search.boundingBox())!;
			const tableBounds = (await grid.boundingBox())!;
			expect(searchBounds.y - editorBounds.y).toBeLessThanOrEqual(16);
			expect(tableBounds.y - searchBounds.y - searchBounds.height).toBeLessThanOrEqual(16);
			const edit = row.locator('.ash-keybindings-row-action').first();
			await expect(edit).toHaveCSS('opacity', '0');
			await row.hover();
			await expect(edit).toHaveCSS('opacity', '1');
			await edit.focus();
			await page.mouse.move(2, 2);
			await expect(edit).toHaveCSS('opacity', '1');
			await search.fill('test.shortcutTable.row000');
			await expect(row.locator('.ash-keybindings-command-id')).toBeVisible();
			await expect(row).toHaveCSS('height', '40px');
			await search.fill('row000');
			await expect(row.locator('.ash-keybindings-command-id')).toBeHidden();
			await expect(row).toHaveCSS('height', '24px');
			const clear = editor.getByRole('button', { name: variant.locale === 'zh-CN' ? '清空快捷键搜索输入' : 'Clear Keybindings Search Input', exact: false });
			await clear.click();
			await expect(search).toHaveValue('');
			await expect(search).toBeFocused();
			await expect(clear).toBeDisabled();
			await expect.poll(() => grid.locator('.ash-table-row').count()).toBeGreaterThan(10);
			const striped = grid.locator('.ash-keybindings-row.is-odd').first();
			await expect(striped).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await page.mouse.move(2, 2);
			await modal.screenshot({ path: testInfo.outputPath('keybindings-compact-table.png') });
			await page.setViewportSize({ width: 700, height: 720 });
			await expect.poll(() => grid.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
			const narrowEditor = (await editor.boundingBox())!;
			const narrowSearch = (await search.boundingBox())!;
			expect(narrowSearch.x + narrowSearch.width).toBeLessThanOrEqual(narrowEditor.x + narrowEditor.width);
			await expect.poll(() => grid.locator('.ash-keybinding-label-chord').evaluateAll(chords => chords.length > 0 && chords.every(chord => {
				const cell = chord.closest('.ash-keybindings-key')!.getBoundingClientRect();
				return chord.getBoundingClientRect().width <= cell.width - 20;
			}))).toBe(true);
			await modal.screenshot({ path: testInfo.outputPath('keybindings-compact-narrow.png') });
		});

		test(`Keyboard Shortcuts title menu and icon editing (${variant.locale}, ${variant.theme})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.goto(`/quickAccess.html?${new URLSearchParams({ ...variant, shortcuts: '1' })}`);
			await page.getByRole('button', { name: 'Open commands' }).click();
			const picker = page.locator('.ash-quick-pick');
			await picker.getByRole('combobox').fill('>Alpha Format');
			await picker.getByRole('button', { name: variant.locale === 'zh-CN' ? '配置快捷键' : 'Configure Keybinding' }).click();
			const modal = page.locator('.ash-modal-editor');
			const toolbar = modal.locator('.ash-modal-editor-actions');
			await expect(toolbar.getByRole('button', { name: variant.locale === 'zh-CN' ? '打开键盘快捷方式 (JSON)' : 'Open Keyboard Shortcuts (JSON)', exact: true }).locator('.ash-icon')).toBeVisible();
			const more = toolbar.locator('.ash-toolbar-more-actions button');
			const search = modal.locator('.ash-keybindings-search input');
			for (const [source, label] of [
				['system', variant.locale === 'zh-CN' ? '显示系统快捷键' : 'Show System Keybindings'],
				['user', variant.locale === 'zh-CN' ? '显示用户快捷键' : 'Show User Keybindings'],
				['extension', variant.locale === 'zh-CN' ? '显示扩展快捷键' : 'Show Extension Keybindings'],
				['unassigned', variant.locale === 'zh-CN' ? '显示未分配快捷键的命令' : 'Show Unassigned Commands'],
			]) {
				await more.click();
				await expect(page.locator('.ash-menu-leading-check > .ash-icon:visible')).toHaveCount(1);
				await expect(page.locator('.ash-menu')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				if (source === 'system') await page.screenshot({ path: testInfo.outputPath('keybindings-source-menu.png') });
				await page.getByRole('menuitemcheckbox', { name: label, exact: true }).click();
				await expect(search).toHaveValue(`@source:${source}`);
				await expect(search).toBeFocused();
				if (source === 'user' || source === 'extension') await expect(modal.locator('.ash-keybindings-empty')).toBeVisible();
			}
			await search.fill('@source:system @command:test.quickAccess.AlphaFormat');
			const row = modal.locator('.ash-keybindings-row');
			const edit = row.locator('.ash-keybindings-row-action:visible');
			await expect(edit).toHaveCount(1);
			await expect(edit.locator('.ash-icon')).toBeVisible();
			const previousWhen = await row.locator('.ash-keybindings-when').innerText();
			await edit.focus();
			await page.keyboard.press('Enter');
			const recorder = modal.locator('.ash-keybindings-record-input input');
			await expect(recorder).toBeFocused();
			await recorder.press('Control+j');
			await page.keyboard.press('Tab');
			await expect(recorder).toBeFocused();
			await recorder.press('Enter');
			await expect(modal.locator('.ash-keybindings-status')).toHaveText(variant.locale === 'zh-CN' ? '快捷键已保存。' : 'Keybinding saved.');
			await expect(modal.locator('.ash-keybindings-recorder')).toBeHidden();
			await search.fill('@source:user @command:test.quickAccess.AlphaFormat');
			await expect(row).toHaveCount(1);
			await expect(row.locator('.ash-keybindings-source')).toHaveText(variant.locale === 'zh-CN' ? '用户' : 'User');
			await expect(row.locator('.ash-keybindings-when')).toHaveText(previousWhen);
			await expect(row.locator('.ash-keybindings-row-action .ash-icon')).toHaveCount(2);
			await modal.screenshot({ path: testInfo.outputPath('keybindings-icons-and-toolbar.png') });
			await page.setViewportSize({ width: 700, height: 720 });
			await expect(edit.first()).toBeVisible();
			await row.getByRole('button', { name: variant.locale === 'zh-CN' ? '移除“Alpha Format”的快捷键' : 'Remove keybinding for Alpha Format' }).click();
			await expect(row).toHaveCount(0);
		});

		test(`Keyboard Shortcuts uses resizable table columns and virtual keyboard navigation (${variant.locale}, ${variant.theme})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.goto(`/quickAccess.html?${new URLSearchParams({ ...variant, shortcuts: '1', shortcutRows: '1' })}`);
			await page.getByRole('button', { name: 'Open commands' }).click();
			const picker = page.locator('.ash-quick-pick');
			await picker.getByRole('combobox').fill('>Alpha Format');
			await picker.getByRole('button', { name: variant.locale === 'zh-CN' ? '配置快捷键' : 'Configure Keybinding' }).click();
			const modal = page.locator('.ash-modal-editor');
			const search = modal.locator('.ash-keybindings-search input');
			await search.fill('test.shortcutTable');
			const grid = modal.getByRole('grid');
			await expect(grid).toHaveAttribute('aria-rowcount', '161');
			await expect(grid).toHaveAttribute('aria-colcount', '5');
			await expect.poll(() => grid.locator('.ash-table-row').count()).toBeGreaterThan(0);
			expect(await grid.locator('.ash-table-row').count()).toBeLessThan(160);
			const headers = grid.getByRole('columnheader');
			const commandHeader = headers.nth(1);
			const separator = grid.getByRole('separator').first();
			const originalWidth = (await commandHeader.boundingBox())!.width;
			const sash = (await separator.boundingBox())!;
			await page.mouse.move(sash.x + sash.width / 2, sash.y + sash.height / 2);
			await page.mouse.down();
			await page.mouse.move(sash.x + sash.width / 2 + 72, sash.y + sash.height / 2);
			await page.mouse.up();
			await expect.poll(async () => (await commandHeader.boundingBox())!.width).toBeGreaterThan(originalWidth + 40);
			const widths = () => headers.evaluateAll(elements => elements.map(element => Math.round(element.getBoundingClientRect().width)));
			const draggedWidths = await widths();
			await search.fill('test.shortcutTable row000');
			await expect(grid.locator('.ash-table-row')).toHaveCount(1);
			expect(await widths()).toEqual(draggedWidths);
			await separator.focus();
			await page.keyboard.press('ArrowRight');
			await expect.poll(widths).not.toEqual(draggedWidths);
			await separator.dblclick();
			await expect.poll(async () => (await commandHeader.boundingBox())!.width).toBeLessThan(draggedWidths[1]);
			await search.fill('test.shortcutTable');
			const headerTop = (await commandHeader.boundingBox())!.y;
			await grid.locator('.ash-table-row').first().focus();
			await page.keyboard.press('End');
			const last = grid.locator('.ash-table-row').filter({ has: page.locator('.ash-keybindings-command-id', { hasText: 'test.shortcutTable.row159' }) });
			await expect(last).toBeFocused();
			expect((await commandHeader.boundingBox())!.y).toBe(headerTop);
			await page.keyboard.press('ArrowUp');
			await page.keyboard.press('ArrowRight');
			const focusedCell = grid.locator('.ash-table-cell:focus');
			await expect(focusedCell).toHaveAttribute('aria-colindex', '1');
			await page.keyboard.press('Enter');
			await expect(modal.locator('.ash-keybindings-record-input input')).toBeFocused();
			await modal.locator('.ash-keybindings-record-input input').press('Escape');
			await expect(focusedCell).toBeFocused();
			const aligned = await grid.evaluate(element => {
				const headerWidths = [...element.querySelectorAll('[role="columnheader"]')].map(cell => Math.round(cell.getBoundingClientRect().width));
				const cellWidths = [...element.querySelector('.ash-table-row')!.querySelectorAll('[role="gridcell"]')].map(cell => Math.round(cell.getBoundingClientRect().width));
				return { headerWidths, cellWidths };
			});
			expect(aligned.cellWidths).toEqual(aligned.headerWidths);
			await modal.screenshot({ path: testInfo.outputPath('keybindings-resizable-table.png') });
			await page.setViewportSize({ width: 700, height: 720 });
			await expect.poll(() => grid.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
		});
	}

	for (const variant of [
		{ os: 'mac', locale: 'zh-CN', theme: 'dark', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
		{ os: 'windows', locale: 'en', theme: 'light', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
		{ os: 'linux', locale: 'en', theme: 'hc', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' },
	]) {
		test(`Keyboard Shortcuts tooltips and command shortcuts follow platform defaults and user overrides (${variant.os})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.addInitScript(userAgent => Object.defineProperty(navigator, 'userAgent', { get: () => userAgent }), variant.userAgent);
			await page.goto(`/quickAccess.html?${new URLSearchParams({ os: variant.os, locale: variant.locale, theme: variant.theme, shortcuts: '1', shortcutToolbar: '1' })}`);
			const trigger = page.getByRole('button', { name: 'Open commands' });
			await trigger.click();
			const picker = page.locator('.ash-quick-pick');
			await picker.getByRole('combobox').fill('>Alpha Format');
			await picker.getByRole('button', { name: variant.locale === 'zh-CN' ? '配置快捷键' : 'Configure Keybinding' }).click();
			const modal = page.locator('.ash-modal-editor');
			const search = modal.locator('.ash-keybindings-search input');
			const buttons = modal.locator('.ash-keybindings-search-action');
			const record = buttons.nth(0), sort = buttons.nth(1), clear = buttons.nth(2);
			const recordLabel = variant.locale === 'zh-CN' ? '录制按键' : 'Record Keys';
			const sortLabel = variant.locale === 'zh-CN' ? '按优先级排序（从高到低）' : 'Sort by Precedence (Highest first)';
			const clearLabel = variant.locale === 'zh-CN' ? '清空快捷键搜索输入' : 'Clear Keybindings Search Input';
			const recordKey = variant.os === 'mac' ? 'Alt+Meta+k' : 'Alt+k';
			const sortKey = variant.os === 'mac' ? 'Alt+Meta+p' : 'Alt+p';
			await expect(record).toHaveAttribute('title', `${recordLabel} (${variant.os === 'mac' ? '⌥⌘K' : 'Alt+K'})`);
			await expect(sort).toHaveAttribute('title', `${sortLabel} (${variant.os === 'mac' ? '⌥⌘P' : 'Alt+P'})`);
			await expect(clear).toHaveAttribute('title', `${clearLabel} (Escape)`);
			await search.press(recordKey);
			await expect(record).toHaveAttribute('aria-pressed', 'true');
			await search.press('Escape');
			await expect(record).toHaveAttribute('aria-pressed', 'false');
			await expect(search).not.toHaveValue('');
			await search.press('Escape');
			await expect(search).toHaveValue('');
			await expect(clear).toBeDisabled();
			await search.fill('test.shortcutToolbar');
			const row = modal.locator('.ash-table-row').first();
			await row.focus();
			await page.keyboard.press(recordKey);
			await expect(record).toHaveAttribute('aria-pressed', 'false');
			await page.keyboard.press(sortKey);
			await expect(sort).toHaveAttribute('aria-pressed', 'true');
			await expect(search).toBeFocused();
			await expect(modal.locator('.ash-keybindings-command-id').first()).toHaveText('test.shortcutToolbar.YankeeLatest');
			await modal.screenshot({ path: testInfo.outputPath('keybindings-default-command-shortcuts.png') });
			await page.evaluate(async () => window.ashQuickAccessIntegration.writeShortcutBindings([
				{ key: 'f6', command: 'keybindings.editor.recordSearchKeys', when: 'inKeybindings && inKeybindingsSearch' },
				{ key: 'f7', command: 'keybindings.editor.toggleSortByPrecedence', when: 'inKeybindings' },
				{ key: 'f8', command: 'keybindings.editor.clearSearchResults', when: 'inKeybindings && inKeybindingsSearch && keybindingsSearchHasValue' },
				{ key: 'escape', command: null },
			]));
			await expect(record).toHaveAttribute('title', `${recordLabel} (F6)`);
			await expect(sort).toHaveAttribute('title', `${sortLabel} (F7)`);
			await expect(clear).toHaveAttribute('title', `${clearLabel} (F8)`);
			await expect(record).toHaveAttribute('aria-label', `${recordLabel} (F6)`);
			await search.press('F6');
			await expect(record).toHaveAttribute('aria-pressed', 'true');
			await search.press('Escape');
			await expect(record).toHaveAttribute('aria-pressed', 'false');
			const query = await search.inputValue();
			await search.press('Escape');
			await expect(search).toHaveValue(query);
			await expect(modal).toBeVisible();
			await search.press('F7');
			await expect(sort).toHaveAttribute('aria-pressed', 'false');
			await expect(modal.locator('.ash-keybindings-command-id').first()).toHaveText('test.shortcutToolbar.AlphaLate');
			await search.press('F8');
			await expect(search).toHaveValue('');
			await expect(search).toBeFocused();
			await expect(clear).toBeDisabled();
			await page.evaluate(async ({ recordKey, sortKey }) => window.ashQuickAccessIntegration.writeShortcutBindings([
				{ key: recordKey, command: null }, { key: sortKey, command: null }, { key: 'escape', command: null },
			]), { recordKey: variant.os === 'mac' ? 'alt+cmd+k' : 'alt+k', sortKey: variant.os === 'mac' ? 'alt+cmd+p' : 'alt+p' });
			await expect(record).toHaveAttribute('title', recordLabel);
			await expect(sort).toHaveAttribute('title', sortLabel);
			await expect(clear).toHaveAttribute('title', clearLabel);
			await modal.locator('.ash-modal-editor-close').click();
			await trigger.press(sortKey);
			await expect(modal).toBeHidden();
			expect(await page.evaluate(() => window.ashQuickAccessIntegration.executions)).toEqual([]);
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`Reopen With selects an editor, supports background acceptance and restores focus on cancel (${locale})`, async function () {
			const { page } = browserTests;

			await page.goto(`/quickAccess.html?locale=${locale}&reopen=1`);
			const trigger = page.getByRole('button', { name: 'Reopen editor' });
			await trigger.click();
			const label = locale === 'zh-CN' ? '选择编辑器' : 'Select an editor';
			const picker = page.getByRole('dialog');
			const input = picker.getByRole('combobox', { name: label, exact: true });
			await expect(input).toHaveAttribute('placeholder', label);
			await expect(input).toBeFocused();
			await input.fill('Other');
			await input.press('Enter');
			await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText(JSON.stringify({ preferredEditorId: 'test.other', preserveFocus: false, pinned: true }));
			await expect(picker).toHaveCount(0);

			await trigger.click();
			await input.fill('Other');
			await input.press('Control+Enter');
			await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText(JSON.stringify({ preferredEditorId: 'test.other', preserveFocus: true, pinned: true }));
			await expect(trigger).toBeFocused();

			await trigger.click();
			await input.press('Escape');
			await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('cancelled');
			await expect(picker).toHaveCount(0);
			await expect(trigger).toBeFocused();
		});
	}

	for (const variant of [
		{ locale: 'en', theme: 'light', os: 'mac' },
		{ locale: 'zh-CN', theme: 'dark', os: 'windows' },
		{ locale: 'en', theme: 'hc', os: 'mac' },
	]) {
		test(`command palette renders individual keycaps and preserves chord groups (${variant.locale}, ${variant.theme})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.goto(`/quickAccess.html?${new URLSearchParams(variant)}`);
			await page.getByRole('button', { name: 'Open commands' }).click();
			const picker = page.locator('.ash-quick-pick');
			const input = picker.getByRole('combobox');
			await input.fill('>Format');
			const row = picker.locator('.ash-list-row').filter({ has: page.locator('.ash-quick-pick-row-label', { hasText: /^Format$/ }) });
			const shortcut = row.locator('.ash-keybinding-label');
			const modifier = variant.os === 'windows' ? 'Ctrl' : '⌘';
			await expect(shortcut.locator('kbd')).toHaveText([modifier, 'K', modifier, 'Enter']);
			await expect(shortcut.locator('.ash-keybinding-label-chord')).toHaveCount(2);
			await expect(shortcut).toHaveAttribute('aria-label', variant.os === 'windows' ? 'Control+K, Control+Enter' : 'Command+K, Command+Enter');
			for (const cap of await shortcut.locator('kbd').all()) {
				await expect(cap).toHaveCSS('height', '20px');
				await expect(cap).toHaveCSS('border-radius', '4px');
			}
			await expect(shortcut.locator('kbd').last()).toHaveCSS('white-space', 'nowrap');
			await page.setViewportSize({ width: 600, height: 600 });
			const bounds = await shortcut.boundingBox();
			const rowBounds = await row.boundingBox();
			expect(rowBounds!.height).toBe(22);
			expect((await row.locator('.ash-quick-pick-row-content').boundingBox())!.height).toBe(22);
			expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(rowBounds!.x + rowBounds!.width);
			await picker.screenshot({ path: testInfo.outputPath('command-keycaps.png') });
			await input.fill('>Zulu Format');
			await expect(picker.locator('.ash-keybinding-label kbd')).toHaveText(['F1']);
			await input.press('Enter');
			await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('Zulu Format');
		});
	}

	for (const variant of [{ locale: 'en', theme: 'light' }, { locale: 'zh-CN', theme: 'dark' }, { locale: 'en', theme: 'hc' }]) {
		test(`Quick Access switches Commands, Files, Issues and PR through one picker (${variant.locale}, ${variant.theme})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.goto(`/quickAccess.html?locale=${variant.locale}&theme=${variant.theme}`);
			await page.getByRole('button', { name: 'Open commands' }).click();
			const input = page.getByRole('combobox');
			const picker = page.getByRole('dialog');
			const tabs = picker.getByRole('tab');
			const labels = variant.locale === 'zh-CN' ? ['命令', '文件', '议题', 'PR'] : ['Commands', 'Files', 'Issues', 'PR'];
			await expect(tabs).toHaveText(labels);
			for (const tab of await tabs.all()) {
				const offset = await tab.evaluate(element => {
					const button = element.getBoundingClientRect();
					const text = element.querySelector('.ash-icon-label-text')!.getBoundingClientRect();
					return {
						x: Math.abs(text.x + text.width / 2 - button.x - button.width / 2),
						y: Math.abs(text.y + text.height / 2 - button.y - button.height / 2),
					};
				});
				expect(offset.x).toBeLessThanOrEqual(1);
				expect(offset.y).toBeLessThanOrEqual(1);
			}
			await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
			await input.fill('>Fix');
			await page.keyboard.press('Tab');
			await expect(picker.getByRole('button', { name: variant.locale === 'zh-CN' ? '清空输入' : 'Clear input' })).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(tabs.nth(0)).toBeFocused();
			await page.keyboard.press('ArrowRight');
			await page.keyboard.press('ArrowRight');
			await expect(tabs.nth(2)).toBeFocused();
			await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
			await page.keyboard.press('Enter');
			await expect(input).toBeFocused();
			await expect(input).toHaveValue('issue Fix');
			await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
			await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText('#9 Fix issue');
			await expect(picker).toHaveCount(1);
			await page.screenshot({ path: testInfo.outputPath('quick-access-tabs.png') });
			await tabs.nth(1).click();
			await expect(input).toHaveValue('Fix');
			await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
			await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText('Fix.ts');
			await tabs.nth(3).click();
			await expect(input).toHaveValue('pr Fix');
			await expect(picker.locator('.ash-quick-pick-row-label').first()).toHaveText('#7 Fix rendering');
			await input.fill('pr navigation');
			const more = variant.locale === 'zh-CN' ? '加载更多结果' : 'Load more results';
			await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText(more);
			await page.keyboard.press('Enter');
			await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText('#8 Add navigation');
			await expect(input).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(picker).toHaveCount(0);
			await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('ash-github://github.com/team/repo/pull/8?account=alice');
		});

		test(`Quick Access keeps long file results readable and keyboard reachable (${variant.locale}, ${variant.theme})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.setViewportSize({ width: 1_200, height: 700 });
			await page.goto(`/quickAccess.html?locale=${variant.locale}&theme=${variant.theme}`);
			const open = page.getByRole('button', { name: 'Open files' });
			await open.click();
			const input = page.getByRole('combobox');
			const picker = page.getByRole('dialog');
			await expect(input).toBeFocused();
			await expect(picker).toHaveCSS('border-radius', '8px');
			await expect(input).toHaveCSS('border-radius', '4px');
			const borderColor = variant.theme === 'hc' ? 'rgb(255, 255, 255)' : variant.theme === 'dark' ? 'rgb(69, 69, 69)' : 'rgb(212, 212, 212)';
			await expect(picker).toHaveCSS('border-color', borderColor);
			await expect(input).toHaveCSS('border-color', variant.theme === 'hc' ? 'rgb(255, 255, 255)' : 'rgba(0, 0, 0, 0)');
			await expect(input).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			const placeholder = await input.evaluate(element => {
				const style = getComputedStyle(element, '::placeholder');
				return { color: style.color, opacity: style.opacity };
			});
			expect(placeholder.opacity).toBe('1');
			expect(placeholder.color).toBe(variant.theme === 'hc' ? 'rgb(255, 255, 255)' : variant.theme === 'dark' ? 'rgb(143, 143, 143)' : 'rgb(118, 118, 118)');
			const first = picker.getByRole('option').first();
			const detail = first.locator('.ash-quick-pick-row-detail');
			const label = first.locator('.ash-quick-pick-row-label');
			const description = first.locator('.ash-quick-pick-row-description');
			const labelBounds = (await label.boundingBox())!;
			const detailBounds = (await detail.boundingBox())!;
			expect(detailBounds.y).toBeGreaterThanOrEqual(labelBounds.y + labelBounds.height);
			await expect(description).toHaveCSS('text-overflow', 'ellipsis');
			await expect(description).toHaveAttribute('title', await description.textContent() ?? '');
			const results = picker.locator('.ash-quick-pick-list-scrollable');
			expect((await results.boundingBox())!.height).toBeLessThanOrEqual(700 * 0.4);
			expect((await picker.boundingBox())!.width).toBeLessThanOrEqual(600);
			await page.screenshot({ path: testInfo.outputPath('quick-access.png') });
			const hoverColor = variant.theme === 'hc' ? 'rgb(51, 51, 51)' : variant.theme === 'dark' ? 'rgb(42, 45, 46)' : 'rgb(232, 232, 232)';
			const foreground = variant.theme === 'hc' ? 'rgb(255, 255, 255)' : variant.theme === 'dark' ? 'rgb(204, 204, 204)' : 'rgb(59, 59, 59)';
			await first.hover();
			await expect(first).toHaveCSS('background-color', hoverColor);
			await expect(first).toHaveCSS('color', foreground);
			const second = picker.getByRole('option').nth(1);
			await second.hover();
			await expect(second).toHaveClass(/is-active/);
			await expect(second).toHaveCSS('background-color', hoverColor);
			await expect(input).toHaveAttribute('aria-activedescendant', await second.getAttribute('id') ?? '');
			await picker.screenshot({ path: testInfo.outputPath('quick-access-hover.png') });
			await page.keyboard.press('ArrowUp');
			// Returning to the row under a stationary pointer must restore keyboard selection styling.
			await page.keyboard.press('ArrowDown');
			const active = picker.locator('.ash-list-row.is-active');
			await expect(active.locator('.ash-quick-pick-row-label')).toHaveText('file-1.ts');
			await expect(active).toHaveCSS('background-color', variant.theme === 'hc' ? 'rgb(255, 255, 255)' : variant.theme === 'dark' ? 'rgb(4, 57, 94)' : 'rgb(0, 96, 192)');
			await expect(input).toHaveAttribute('aria-activedescendant', await active.getAttribute('id') ?? '');
			await page.keyboard.press('PageDown');
			await page.keyboard.press('PageDown');
			await expect.poll(() => results.locator('.ash-scrollbar-viewport').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
			await page.setViewportSize({ width: 360, height: 240 });
			await expect.poll(async () => (await results.boundingBox())!.height).toBeLessThanOrEqual(240 * 0.4);
			await expect.poll(() => description.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
			const bounds = (await picker.boundingBox())!;
			expect(bounds.x).toBeGreaterThanOrEqual(0);
			expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
			await page.keyboard.press('Escape');
			await expect(picker).toHaveCount(0);
			await expect(open).toBeFocused();
			await open.click();
			await input.fill('file-59');
			await page.keyboard.press('Enter');
			await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('file-59.ts');
			await expect(open).toBeFocused();
		});

		test(`Command Palette preserves recent history through search and reload (${variant.locale}, ${variant.theme})`, async function () {
			const { page } = browserTests;

			await page.goto(`/quickAccess.html?locale=${variant.locale}&theme=${variant.theme}`);
			const open = page.getByRole('button', { name: 'Open commands' });
			const input = page.getByRole('combobox');
			const labels = page.locator('.ash-quick-pick-row-label');
			for (const label of ['Zulu Format', 'Alpha Format', 'Zulu Format']) {
				await open.click();
				await input.fill(`>${label}`);
				await page.keyboard.press('Enter');
				await expect(input).toHaveCount(0);
				await expect(open).toBeFocused();
			}
			await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('Zulu Format, Alpha Format, Zulu Format');
			await open.click();
			await expect(labels.nth(0)).toHaveText('Zulu Format');
			await expect(labels.nth(1)).toHaveText('Alpha Format');
			const recent = variant.locale === 'zh-CN' ? '最近使用' : 'recently used';
			const other = variant.locale === 'zh-CN' ? '其他命令' : 'other commands';
			await expect(page.getByRole('separator', { name: recent })).toHaveCount(1);
			await expect(page.getByRole('separator', { name: other })).toHaveCount(1);
			await input.fill('>for');
			await expect(labels).toHaveText(variant.locale === 'en' ? ['Zulu Format', 'Alpha Format', 'Focus Status Bar', 'Format', 'Go to File'] : ['Zulu Format', 'Alpha Format', 'Format', '聚焦状态栏']);
			await expect(input).toBeFocused();
			await input.fill('>Format');
			await expect(labels.nth(0)).toHaveText('Format');
			await input.fill('>Zulu');
			await expect(labels).toHaveText(['Zulu Format']);
			const removeName = variant.locale === 'zh-CN' ? '从命令历史记录中移除' : 'Remove from Command History';
			const remove = page.getByRole('button', { name: removeName });
			await expect(remove.locator('.ash-icon')).toHaveAttribute('aria-hidden', 'true');
			await page.keyboard.press('Tab');
			await expect(page.getByRole('button', { name: variant.locale === 'zh-CN' ? '清空输入' : 'Clear input' })).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(page.getByRole('tab').first()).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(page.getByRole('button', { name: variant.locale === 'zh-CN' ? '配置快捷键' : 'Configure Keybinding' })).toBeFocused();
			await page.keyboard.press('ArrowRight');
			await expect(remove).toBeFocused();
			await expect(remove).toHaveCSS('opacity', '1');
			await page.keyboard.press('Enter');
			await expect(input).toBeFocused();
			await expect(remove).toHaveCount(0);
			await expect(labels).toHaveText(['Zulu Format']);
			await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('Zulu Format, Alpha Format, Zulu Format');
			await page.keyboard.press('Escape');
			await page.reload();
			await open.click();
			await expect(labels.nth(0)).toHaveText('Alpha Format');
			await input.fill('>for');
			await expect(labels).toHaveText(variant.locale === 'en' ? ['Alpha Format', 'Focus Status Bar', 'Format', 'Go to File', 'Zulu Format'] : ['Alpha Format', 'Format', 'Zulu Format', '聚焦状态栏']);
			await page.evaluate(() => window.ashQuickAccessIntegration.setHistoryLength(0));
			await expect(page.getByRole('separator', { name: recent })).toHaveCount(0);
			await expect(labels).toHaveText(variant.locale === 'en' ? ['Alpha Format', 'Focus Status Bar', 'Format', 'Go to File', 'Zulu Format'] : ['Alpha Format', 'Format', 'Zulu Format', '聚焦状态栏']);
			await input.fill('>Zulu');
			await page.keyboard.press('Enter');
			await page.evaluate(() => window.ashQuickAccessIntegration.setHistoryLength(50));
			await open.click();
			await expect(page.getByRole('separator', { name: recent })).toHaveCount(0);
		});
	}

	test('switching providers cancels late GitHub results and scoped pickers omit navigation', async function () {
		const { page } = browserTests;

		await page.goto('/quickAccess.html');
		await expect(page.getByRole('button', { name: 'Open commands' })).toBeEnabled();
		await page.evaluate(() => {
			window.ashQuickAccessIntegration.holdNextRequest();
			window.ashQuickAccessIntegration.show('pr ');
		});
		await expect.poll(() => page.evaluate(() => window.ashQuickAccessIntegration.requests.some(request => request.kind === 'prs'))).toBe(true);
		const input = page.getByRole('combobox');
		await page.getByRole('tab', { name: 'Commands', exact: true }).click();
		await expect(input).toHaveValue('>');
		await input.fill('>for');
		await expect(page.locator('.ash-quick-pick-row-label')).toHaveText(['Alpha Format', 'Focus Status Bar', 'Format', 'Go to File', 'Zulu Format']);
		await page.evaluate(() => window.ashQuickAccessIntegration.releaseRequest());
		await expect(page.locator('.ash-quick-pick-row-label')).toHaveText(['Alpha Format', 'Focus Status Bar', 'Format', 'Go to File', 'Zulu Format']);
		await page.keyboard.press('Escape');
		await page.evaluate(() => window.ashQuickAccessIntegration.show('>', true));
		await expect(page.getByRole('tab')).toHaveCount(0);
		await expect(input).toBeFocused();
	});

	test('GitHub navigation offers repository setup when no account is connected', async function () {
		const { page } = browserTests;

		await page.goto('/quickAccess.html');
		await expect(page.getByRole('button', { name: 'Open commands' })).toBeEnabled();
		await page.evaluate(() => {
			window.ashQuickAccessIntegration.setSignedIn(false);
			window.ashQuickAccessIntegration.show('issue ');
		});
		await expect(page.locator('.ash-quick-pick-row-label')).toHaveText('Open GitHub to sign in or choose a repository');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('ash-github:/');
	});


	test('Quick Input navigation uses live user bindings and blockers', async function () {
		const { page } = browserTests;

		await page.goto('/quickAccess.html');
		await page.getByRole('button', { name: 'Open files' }).click();
		const input = page.getByRole('combobox');
		const active = page.locator('.ash-quick-pick .ash-list-row.is-active .ash-quick-pick-row-label');
		await expect(active).toHaveText('file-0.ts');
		await page.evaluate(() => window.ashQuickAccessIntegration.setNavigationBinding('blocked'));
		await page.keyboard.press('ArrowDown');
		await expect(active).toHaveText('file-0.ts');
		await page.evaluate(() => window.ashQuickAccessIntegration.setNavigationBinding('rebound'));
		await page.keyboard.press('F8');
		await expect(active).toHaveText('file-1.ts');
		await expect(input).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(active).toHaveText('file-1.ts');
		await page.evaluate(() => window.ashQuickAccessIntegration.setNavigationBinding('default'));
		await page.keyboard.press('ArrowDown');
		await expect(active).toHaveText('file-2.ts');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Open files' })).toBeFocused();
	});


	test('Quick Access Files background acceptance preserves the picker for both keyboard and pointer modifiers', async function () {
		const { page } = browserTests;

		await page.goto('/quickAccess.html');
		await page.getByRole('button', { name: 'Open commands' }).click();
		await page.getByRole('tab', { name: 'Files', exact: true }).click();
		const input = page.getByRole('combobox');
		const result = page.locator('.ash-quick-pick-row-label');
		await input.fill('Fix');
		await expect(result).toHaveText('Fix.ts');
		await page.keyboard.press('ControlOrMeta+Enter');
		await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('file:///workspace/Fix.ts');
		await expect(input).toBeFocused();
		await result.click({ modifiers: ['ControlOrMeta'] });
		await expect(page.getByRole('dialog')).toHaveCount(1);
		await result.click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
	});


	test('Quick Access workspace symbols cancel stale queries and accept through the shared service', async function () {
		const { page } = browserTests;

		await page.goto('/quickAccess.html');
		await page.getByRole('button', { name: 'Open commands' }).click();
		await page.evaluate(() => {
			window.ashQuickAccessIntegration.holdNextRequest();
			window.ashQuickAccessIntegration.show('@old');
		});
		await expect.poll(() => page.evaluate(() => window.ashQuickAccessIntegration.requests.some(request => request.kind === 'symbols' && request.query === 'old'))).toBe(true);
		const input = page.getByRole('combobox');
		await input.fill('@new');
		await expect(page.locator('.ash-quick-pick-row-label')).toHaveText('newSymbol');
		await page.evaluate(() => window.ashQuickAccessIntegration.releaseRequest());
		await expect(page.locator('.ash-quick-pick-row-label')).toHaveText('newSymbol');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('file:///workspace/symbol.ts');
	});

	test('Quick Open applies configured path filters before filename results are limited', async function () {
		const { page } = browserTests;

		await page.goto('/quickAccess.html?fileSearch');
		await expect(page.getByRole('button', { name: 'Open files' })).toBeEnabled();
		await page.evaluate(async () => {
			await window.ashQuickAccessIntegration.setSearchPatterns('src/**', '**/*skip*, **/*.md');
			window.ashQuickAccessIntegration.show('needle');
		});
		const picker = page.getByRole('dialog');
		await expect(picker.getByRole('option').filter({ hasText: 'long_needle.ts' })).toHaveCount(1);
		await expect(picker.getByRole('option')).toHaveCount(1);
		await picker.getByRole('combobox').press('Escape');
		await page.evaluate(() => window.ashQuickAccessIntegration.show('**/*needle*'));
		await expect(picker.getByRole('option').filter({ hasText: 'long_needle.ts' })).toHaveCount(1);
		await expect(picker.getByRole('option')).toHaveCount(1);
		await picker.getByRole('combobox').press('Enter');
		await expect(page.locator('output')).toHaveText('file:///workspace/src/long_needle.ts');
	});

	test('Quick Access scrolls its results within the list', async function () {
		const { page } = browserTests;

		await page.goto('/quickAccess.html?scrollRows');
		await page.getByRole('button', { name: 'Open commands' }).click();
		const picker = page.locator('.ash-quick-pick');
		const colors = await picker.evaluate(element => {
			const initial = getComputedStyle(element).backgroundColor;
			(element as HTMLElement).style.setProperty('--ash-quickInput-background', '#123456');
			const overridden = getComputedStyle(element).backgroundColor;
			(element as HTMLElement).style.removeProperty('--ash-quickInput-background');
			return { initial, overridden, restored: getComputedStyle(element).backgroundColor };
		});
		expect(colors.initial).not.toBe('rgba(0, 0, 0, 0)');
		expect(colors.overridden).toBe('rgb(18, 52, 86)');
		expect(colors.restored).toBe(colors.initial);

		const listContainer = picker.locator('.ash-quick-pick-list');
		const scrollable = picker.locator('.ash-quick-pick-list-scrollable');
		const viewport = scrollable.locator('.ash-scrollbar-viewport');
		const scrollbar = scrollable.locator('.ash-scrollbar-track-vertical');
		await picker.getByRole('combobox').fill('>');
		await expect(picker.locator('.ash-list-row').nth(20)).toBeVisible();
		const initial = await listContainer.evaluate(container => {
			const viewport = container.querySelector<HTMLElement>('.ash-scrollbar-viewport')!;
			const scrollbar = container.querySelector<HTMLElement>('.ash-scrollbar-track-vertical')!;
			const thumb = scrollbar.querySelector<HTMLElement>('.ash-scrollbar-thumb')!;
			const picker = container.closest('.ash-quick-pick')!;
			return {
				containerOverflow: getComputedStyle(container).overflowY,
				containerScrollHeight: container.scrollHeight,
				containerHeight: container.clientHeight,
				listScrollHeight: viewport.scrollHeight,
				listHeight: viewport.clientHeight,
				rowHeight: container.querySelector<HTMLElement>('.ash-list-row')!.getBoundingClientRect().height,
				scrollbarRightInset: picker.getBoundingClientRect().right - scrollbar.getBoundingClientRect().right,
				thumbBorder: getComputedStyle(thumb).borderRightWidth,
				thumbWidth: thumb.getBoundingClientRect().width,
				trackWidth: scrollbar.getBoundingClientRect().width,
			};
		});
		expect(initial.containerOverflow).toBe('hidden');
		expect(initial.containerScrollHeight).toBeLessThanOrEqual(initial.containerHeight + 1);
		expect(initial.listScrollHeight).toBeGreaterThan(initial.listHeight);
		expect(Math.abs(initial.listHeight / initial.rowHeight - Math.round(initial.listHeight / initial.rowHeight))).toBeLessThan(0.03);
		expect(initial.scrollbarRightInset).toBeLessThanOrEqual(2);
		expect(initial.thumbBorder).toBe('0px');
		expect(initial.thumbWidth).toBe(initial.trackWidth);
		const [rowBounds, trackBounds] = await Promise.all([
			picker.locator('.ash-list-row.is-active').boundingBox(),
			scrollbar.boundingBox(),
		]);
		expect(rowBounds).not.toBeNull();
		expect(trackBounds).not.toBeNull();
		// Rows keep the component's six-pixel inset before the edge scrollbar.
		expect(trackBounds!.x - rowBounds!.x - rowBounds!.width).toBe(6);
		const [bindingBounds, scrollbarBounds] = await Promise.all([
			picker.locator('.ash-quick-pick-row-keybinding').first().boundingBox(),
			scrollbar.boundingBox(),
		]);
		expect(bindingBounds).not.toBeNull();
		expect(scrollbarBounds).not.toBeNull();
		expect(bindingBounds!.x + bindingBounds!.width).toBeLessThanOrEqual(scrollbarBounds!.x - 4);
		const combobox = picker.getByRole('combobox');
		const firstId = await combobox.getAttribute('aria-activedescendant');
		await combobox.press('PageDown');
		await expect.poll(() => picker.locator('.ash-list-row.is-active').evaluate(row => Number((row as HTMLElement).dataset.index))).toBeGreaterThan(1);
		await expect(picker.locator('.ash-list-row.is-active')).toBeInViewport();
		await expect(combobox).toBeFocused();
		await expect(combobox).toHaveValue('>');
		await combobox.press('PageUp');
		await expect(combobox).toHaveAttribute('aria-activedescendant', firstId!);
		for (let index = 0; index < 20; index++) {
			await picker.getByRole('combobox').press('ArrowDown');
		}
		const scrolled = await viewport.evaluate(element => element.scrollTop);
		expect(scrolled).toBeGreaterThan(0);
		expect(await listContainer.evaluate(element => element.scrollTop)).toBe(0);
		const active = picker.locator('.ash-list-row.is-active');
		await expect(active).toBeInViewport();
		await expect(scrollbar).toHaveAttribute('aria-orientation', 'vertical');
		await picker.getByRole('combobox').fill('>Narrow scroll result');
		await expect(picker.locator('.ash-list-row')).toHaveCount(2);
		await expect.poll(() => scrollable.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(initial.listHeight);
		await picker.getByRole('combobox').fill('>no-such-command-quick-access-scroll');
		await expect(scrollable).toBeHidden();
		await expect(picker.locator('.ash-quick-pick-empty')).toBeVisible();
		await picker.getByRole('combobox').fill('>');
		await expect(picker.locator('.ash-list-row').nth(20)).toBeVisible();
		await expect.poll(() => viewport.evaluate(element => element.clientHeight)).toBe(initial.listHeight);
		await page.setViewportSize({ width: 900, height: 400 });
		await expect(async () => {
			const compactListHeight = await viewport.evaluate(element => element.clientHeight);
			expect(compactListHeight).toBeGreaterThan(0);
			expect(compactListHeight).toBeLessThan(initial.listHeight);
			expect(Math.abs(compactListHeight / initial.rowHeight - Math.round(compactListHeight / initial.rowHeight))).toBeLessThan(0.03);
			const resized = await picker.evaluate(element => ({
				bottom: element.getBoundingClientRect().bottom,
				viewportHeight: window.innerHeight,
			}));
			expect(resized.bottom).toBeLessThanOrEqual(resized.viewportHeight);
		}).toPass({ timeout: 10_000 });
	});
});
