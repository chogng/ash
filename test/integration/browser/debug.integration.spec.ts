import { expect, test, type Page, type Locator } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

async function clickDebugHeaderAction(page: Page, section: 'stack' | 'breakpoints', name: string): Promise<void> {
	const header = page.locator(`[data-pane-view-id="ash-debug-${section}"] > .ash-pane-view-header`);
	await header.hover();
	await header.getByRole('button', { name, exact: true }).click();
}

test('disassembly launch waits for header intent and opens through keyboard focus and pointer hover', async ({ page }) => {
	await page.goto('/debug.html');
	const stack = page.locator('[data-pane-view-id="ash-debug-stack"]');
	const open = stack.locator('[data-action-id="debug.action.openDisassemblyView"] button');
	await expect(open).toBeAttached();
	await expect(open).toBeEnabled();
	await expect(open).toHaveCSS('visibility', 'hidden');
	await expect(page.getByRole('button', { name: 'Open Disassembly View', exact: true })).toHaveCount(0);
	expect(await page.evaluate(() => window.ashDebugIntegration.disassemblyRequests())).toEqual([]);
	await stack.getByRole('button', { name: 'Call Stack', exact: true }).focus();
	await expect(open).toBeVisible();
	await open.focus();
	await open.press('Enter');
	await expect(page.locator('.ash-disassembly [data-instruction-address="0x1000"]')).toBeVisible();
	await page.reload();
	await expect(open).toHaveCSS('visibility', 'hidden');
	await clickDebugHeaderAction(page, 'stack', 'Open Disassembly View');
	await expect(page.locator('.ash-disassembly [data-instruction-address="0x1000"]')).toBeVisible();
});

test('debug breakpoints pane follows content and fills space only when its peers are collapsed', async ({ page }, testInfo) => {
	await page.goto('/debug.html?launch-controls');
	const section = page.locator('[data-pane-view-id="ash-debug-breakpoints"]');
	const body = section.locator(':scope > .ash-pane-view-content');
	const header = section.getByRole('button', { name: 'Breakpoints', exact: true });
	const contentHeight = () => body.evaluate(element => Math.ceil([...element.children].reduce((height, child) => height + child.getBoundingClientRect().height, 0)));
	const bodyHeight = () => body.evaluate(element => element.getBoundingClientRect().height);
	await expect(page.locator('.ash-debug-exceptions > li')).toHaveCount(2);
	await expect.poll(bodyHeight).toBe(await contentHeight());
	await page.evaluate(() => window.ashDebugIntegration.stop());
	await expect(body).toHaveCSS('height', '0px');
	await expect(header).toHaveAttribute('aria-expanded', 'true');
	await page.screenshot({ path: testInfo.outputPath('debug-breakpoints-empty.png'), clip: { x: 0, y: 0, width: 280, height: 640 } });

	await page.evaluate(() => window.ashDebugIntegration.setBreakpointCount(3));
	await expect(page.locator('.ash-debug-breakpoints > li')).toHaveCount(3);
	await expect.poll(bodyHeight).toBe(await contentHeight());
	const populatedHeight = await bodyHeight();
	await page.evaluate(() => window.ashDebugIntegration.setBreakpointCount(1));
	await expect.poll(bodyHeight).toBeLessThan(populatedHeight);
	await expect.poll(bodyHeight).toBe(await contentHeight());
	await page.evaluate(() => window.ashDebugIntegration.setBreakpointCount(0));
	await expect(body).toHaveCSS('height', '0px');

	const peerHeaders = ['Variables', 'Watch', 'Call Stack'].map(name => page.getByRole('button', { name, exact: true }));
	for (const peer of peerHeaders) {
		await peer.focus();
		await peer.press('ArrowLeft');
	}
	await expect.poll(bodyHeight).toBeGreaterThan(300);
	await expect(page.locator('.ash-debug-section.closing')).toHaveCount(0);
	await expect.poll(() => section.evaluate(element => Math.round(element.getBoundingClientRect().bottom - element.closest('.ash-pane-view-container')!.getBoundingClientRect().bottom))).toBe(0);
	await page.screenshot({ path: testInfo.outputPath('debug-breakpoints-fill.png'), clip: { x: 0, y: 0, width: 280, height: 640 } });
	await peerHeaders[0]!.press('ArrowRight');
	await expect(body).toHaveCSS('height', '0px');
	await expect(header).toHaveAttribute('aria-expanded', 'true');

	await page.evaluate(() => window.ashDebugIntegration.setBreakpointCount(12));
	await expect.poll(bodyHeight).toBeGreaterThanOrEqual(9 * 22);
	await expect.poll(async () => await bodyHeight() <= await contentHeight()).toBe(true);
	await header.focus();
	await header.press('ArrowLeft');
	await page.evaluate(() => window.ashDebugIntegration.setBreakpointCount(0));
	await header.press('ArrowRight');
	await expect(body).toHaveCSS('height', '0px');
	await expect(header).toBeFocused();
});

test('debug launch title navigates its compound controls and dismisses its popup when hidden', async ({ page }) => {
	await page.goto('/debug.html?launch-controls');
	const start = page.getByRole('button', { name: 'Start Debugging', exact: true });
	const dropdown = page.locator('.ash-debug-configuration');
	const gear = page.getByRole('button', { name: 'Open launch.json', exact: true });
	await start.focus();
	await start.press('ArrowRight');
	await expect(dropdown).toBeFocused();
	await dropdown.press('ArrowLeft');
	await expect(start).toBeFocused();
	await start.press('ArrowRight');
	await dropdown.press('ArrowRight');
	await expect(gear).toBeFocused();
	await page.evaluate(() => window.ashDebugIntegration.starting());
	await expect(start).toBeDisabled();
	await gear.press('ArrowLeft');
	await expect(dropdown).toBeFocused();
	await dropdown.press('ArrowDown');
	await expect(page.getByRole('searchbox')).toBeFocused();
	await page.evaluate(() => window.ashDebugIntegration.reopenContainer());
	await expect(dropdown).toHaveAttribute('aria-expanded', 'false');
	await expect(page.locator('.ash-action-widget')).toHaveCount(0);
});

test('debug launch dropdown searches configurations, retains selection, starts compounds and configures the selected folder', async ({ page }) => {
	await page.goto('/debug.html?launch-controls');
	const dropdown = page.locator('.ash-debug-configuration');
	await expect(page.locator('.ash-debug .ash-debug-launch-start')).toHaveCount(0);
	await expect(page.locator('.ash-workbench-part-title .ash-debug-launch-start')).toHaveCount(1);
	await expect(dropdown).toHaveText('Run — First');
	await expect(page.getByRole('button', { name: 'Open launch.json', exact: true }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'debug-configure');
	await dropdown.focus();
	await dropdown.press('ArrowDown');
	const search = page.getByRole('searchbox', { name: 'Debug configuration', exact: true });
	await expect(search).toBeFocused();
	await expect(page.getByRole('menuitemradio', { name: 'Run — First', exact: true })).toHaveAttribute('aria-checked', 'true');
	await search.fill('Run — Second');
	await expect(page.getByRole('menuitemradio')).toHaveCount(1);
	await search.press('ArrowDown');
	await page.keyboard.press('Enter');
	await expect(dropdown).toHaveText('Run — Second');
	await expect(dropdown).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.selectedConfiguration())).toBe('second');
	await page.evaluate(() => window.ashDebugIntegration.reopenContainer());
	await expect(dropdown).toHaveText('Run — Second');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.launches())).toEqual([]);
	await page.evaluate(() => window.ashDebugIntegration.refreshConfigurations());
	await expect(dropdown).toHaveText('Run — Second');
	await page.getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.launches())).toEqual(['second']);
	await page.evaluate(() => window.ashDebugIntegration.stop());
	await page.evaluate(() => window.ashDebugIntegration.startCommand());
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.launches())).toEqual(['second', 'second']);
	await page.getByRole('button', { name: 'Open launch.json', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.openedSources().at(-1))).toMatchObject({ resource: 'file:///second/.vscode/launch.json' });
	await dropdown.click();
	await page.getByRole('menuitemradio', { name: 'All (compound)', exact: true }).click();
	await page.getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.launches())).toEqual(['second', 'second', 'all']);
	await dropdown.click();
	await search.press('Escape');
	await expect(dropdown).toBeFocused();
	await expect(dropdown).toHaveAttribute('aria-expanded', 'false');
	await dropdown.click();
	await page.evaluate(() => window.ashDebugIntegration.dispose());
	await expect(page.locator('.ash-action-widget')).toHaveCount(0);
});

test('debug launch dropdown uses Chinese labels and stays inside a narrow sidebar across themes', async ({ page }, testInfo) => {
	await page.goto('/debug.html?launch-controls&locale=zh-cn');
	const dropdown = page.locator('.ash-debug-configuration');
	await expect(dropdown).toHaveAttribute('aria-label', '调试配置：Run — First');
	await page.evaluate(() => window.ashDebugIntegration.resize(180));
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(theme => window.ashDebugIntegration.theme(theme), theme);
		const geometry = await page.locator('.ash-workbench-part-title .ash-pane-composite-title-menu-actions').evaluate(element => {
			const controls = element.getBoundingClientRect();
			const dropdown = element.querySelector('.ash-debug-configuration')!.getBoundingClientRect();
			const gear = element.querySelector('[data-action-id="workbench.action.debug.configure"] button')!.getBoundingClientRect();
			const label = element.querySelector('.ash-debug-configuration-label')!;
			return { fits: gear.right <= controls.right && dropdown.right <= gear.left, overflow: element.scrollWidth > element.clientWidth, ellipsis: getComputedStyle(label).textOverflow };
		});
		expect(geometry).toEqual({ fits: true, overflow: false, ellipsis: 'ellipsis' });
		await dropdown.click();
		await expect(page.getByPlaceholder('搜索配置', { exact: true })).toBeFocused();
		await expect(page.getByRole('menuitemradio', { name: 'All（复合配置）', exact: true })).toBeVisible();
		await page.getByPlaceholder('搜索配置', { exact: true }).press('Escape');
		await expect(dropdown).toBeFocused();
	}
	await page.evaluate(() => window.ashDebugIntegration.theme('light'));
	await dropdown.click();
	await page.screenshot({ path: testInfo.outputPath('debug-launch-dropdown.png'), clip: { x: 0, y: 0, width: 300, height: 200 } });
});

test('debug console coalesces an output flood and preserves keyboard evaluation and clearing', async ({ page }, testInfo) => {
	await page.goto('/debug.html?console');
	const output = page.getByRole('log', { name: 'Debug Console output', exact: true });
	const input = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	await fillRepl(page, input, 'answer');
	await input.focus();
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Performance.enable');
	try {
		const before = await cdp.send('Performance.getMetrics');
		const measurement = await output.evaluate(element => {
			let updates = 0;
			const observer = new MutationObserver(records => { updates += records.length; });
			observer.observe(element, { childList: true, characterData: true, subtree: true });
			const burst = window.ashDebugIntegration.burstOutput(2000);
			return new Promise<typeof burst & { updates: number; }>(resolve => {
				const settled = () => {
					if (!element.textContent?.endsWith('burst-1999\n')) { requestAnimationFrame(settled); return; }
					observer.disconnect();
					resolve({ ...burst, updates });
				};
				requestAnimationFrame(settled);
			});
		});
		const after = await cdp.send('Performance.getMetrics');
		const samplesPath = testInfo.outputPath('debug-console-output-flood.json');
		await writeFile(samplesPath, JSON.stringify({ measurement, before, after }, null, 2));
		await testInfo.attach('debug-console-output-flood.json', { path: samplesPath, contentType: 'application/json' });
		expect(measurement.output).toBe(Array.from({ length: 2000 }, (_, index) => `burst-${index}\n`).join(''));
		expect(measurement.updates).toBeLessThan(5);
		await expect(input).toBeFocused();
		await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('answer');
		await input.press('Enter');
		await expect(output).toContainText('42');
		const clear = page.locator('[data-view-id="debug.console.integration"] [data-action-id="workbench.debug.panel.action.clearReplAction"] button');
		await clear.focus();
		await clear.press('Enter');
		await expect(output).toHaveText('');
	} finally { await cdp.detach(); }
});

test('disassembly navigates instruction pages, follows frame focus, toggles breakpoints and steps by instruction', async ({ page }) => {
	await page.goto('/debug.html');
	await clickDebugHeaderAction(page, 'stack', 'Open Disassembly View');
	const view = page.locator('.ash-disassembly');
	const grid = view.getByRole('grid', { name: 'Disassembly', exact: true });
	await expect(view.locator('[data-instruction-address="0x1000"]')).toHaveAttribute('aria-current', 'step');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.disassemblyRequests().at(-1))).toEqual({ reference: '0x1000', offset: 0, instructionOffset: 0, instructionCount: 50 });
	await grid.focus();
	await grid.press('F9');
	await expect(view.getByRole('button', { name: 'Toggle instruction breakpoint at 0x1000', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await grid.press('F9');
	await expect(view.getByRole('button', { name: 'Toggle instruction breakpoint at 0x1000', exact: true })).toHaveAttribute('aria-pressed', 'false');
	await clickDebugHeaderAction(page, 'stack', 'Add Instruction Breakpoint');
	const byteOffset = page.getByRole('textbox', { name: 'Instruction byte offset', exact: true });
	await byteOffset.fill('4');
	await byteOffset.press('Enter');
	await expect(view.getByRole('button', { name: 'Toggle instruction breakpoint at 0x1004', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await view.getByRole('button', { name: 'Toggle instruction breakpoint at 0x1004', exact: true }).click();
	expect(await page.evaluate(() => window.ashDebugIntegration.additionalBreakpoints())).toEqual([]);
	await grid.focus();
	await grid.press('Enter');
	expect(await page.evaluate(() => window.ashDebugIntegration.position())).toBe(2);
	await view.getByRole('button', { name: 'Next instructions', exact: true }).click();
	await expect(view.locator('[data-instruction-address="0x10c8"]')).toBeVisible();
	await view.getByRole('button', { name: 'Previous instructions', exact: true }).click();
	await expect(view.locator('[data-instruction-address="0x1000"]')).toBeVisible();
	const address = view.getByRole('textbox', { name: 'Instruction address', exact: true });
	await address.fill('0x2000');
	await address.press('Enter');
	await expect(view.locator('[data-instruction-address="0x2000"]')).toBeVisible();
	await page.evaluate(() => window.ashDebugIntegration.focusInstruction('0x3000'));
	await expect(view.locator('[data-instruction-address="0x3000"]')).toHaveAttribute('aria-current', 'step');
	await view.getByRole('button', { name: 'Step over instruction', exact: true }).click();
	expect(await page.evaluate(() => window.ashDebugIntegration.stepRequests())).toContain('stepOver:instruction');
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(name => window.ashDebugIntegration.theme(name), theme);
		const colors = await view.locator('[aria-current="step"]').evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
		expect(colors.color).not.toBe(colors.background);
		expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
	}
});

test('disassembly discards held replies after another frame and after resume', async ({ page }) => {
	await page.goto('/debug.html');
	await clickDebugHeaderAction(page, 'stack', 'Open Disassembly View');
	const view = page.locator('.ash-disassembly');
	await expect(view.locator('[data-instruction-address="0x1000"]')).toBeVisible();
	await page.evaluate(() => window.ashDebugIntegration.holdDisassembly());
	await view.getByRole('button', { name: 'Next instructions', exact: true }).click();
	await expect(view.getByRole('grid')).toHaveAttribute('aria-busy', 'true');
	await page.evaluate(() => window.ashDebugIntegration.focusInstruction('0x3000'));
	await expect(view.locator('[data-instruction-address="0x3000"]')).toBeVisible();
	await page.evaluate(() => window.ashDebugIntegration.releaseDisassembly());
	await expect(view.locator('[data-instruction-address="0xdead"]')).toHaveCount(0);
	await page.evaluate(() => window.ashDebugIntegration.holdDisassembly());
	await view.getByRole('button', { name: 'Next instructions', exact: true }).click();
	await expect(view.getByRole('grid')).toHaveAttribute('aria-busy', 'true');
	await page.evaluate(() => window.ashDebugIntegration.resume());
	await page.evaluate(() => window.ashDebugIntegration.releaseDisassembly());
	await expect(view.getByRole('status')).toHaveText('Pause debugging to view disassembly.');
	await expect(view.locator('[data-instruction-address]')).toHaveCount(0);
	await expect(view.getByRole('button', { name: 'Go to address', exact: true })).toBeDisabled();
});

test('disassembly opens adapter-owned source as a read-only editor', async ({ page }) => {
	await page.goto('/debug.html?virtual');
	await clickDebugHeaderAction(page, 'stack', 'Open Disassembly View');
	const grid = page.locator('.ash-disassembly').getByRole('grid');
	await expect(page.locator('.ash-disassembly [data-instruction-address="0x1000"]')).toBeVisible();
	await grid.focus();
	await grid.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.openedSources().at(-1))).toEqual({ resource: 'debug:/generated.ts?session=session-one&ref=33', initialText: undefined, readOnly: true, line: 2 });
});

test('a frame without an instruction reference can inspect an explicit address', async ({ page }) => {
	await page.goto('/debug.html?no-address');
	await clickDebugHeaderAction(page, 'stack', 'Open Disassembly View');
	const view = page.locator('.ash-disassembly');
	await expect(view.getByRole('status')).toHaveText('This stack frame has no instruction address. Enter an address to inspect.');
	const address = view.getByRole('textbox', { name: 'Instruction address', exact: true });
	await address.fill('');
	await address.press('Enter');
	await expect(address).toHaveAttribute('aria-invalid', 'true');
	await address.fill('0x2000');
	await expect(address).not.toHaveAttribute('aria-invalid');
	await address.press('Enter');
	await expect(view.locator('[data-instruction-address="0x2000"]')).toBeVisible();
});

test('disposing disassembly retires its pending adapter reply and DOM listeners', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/debug.html');
	await clickDebugHeaderAction(page, 'stack', 'Open Disassembly View');
	const view = page.locator('.ash-disassembly');
	await expect(view.locator('[data-instruction-address="0x1000"]')).toBeVisible();
	await page.evaluate(() => window.ashDebugIntegration.holdDisassembly());
	await view.getByRole('button', { name: 'Next instructions', exact: true }).click();
	await expect(view.getByRole('grid')).toHaveAttribute('aria-busy', 'true');
	await page.evaluate(() => window.ashDebugIntegration.dispose());
	await page.evaluate(() => window.ashDebugIntegration.releaseDisassembly());
	await expect(view).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('disassembly controls and headings use the selected language', async ({ page }) => {
	await page.goto('/debug.html?locale=zh-cn');
	await clickDebugHeaderAction(page, 'stack', '打开反汇编视图');
	const view = page.locator('.ash-disassembly');
	await expect(view.getByRole('grid', { name: '反汇编', exact: true })).toBeVisible();
	await expect(view.getByRole('columnheader')).toHaveText(['断点', '地址', '机器码', '指令']);
	await expect(view.getByRole('button', { name: '前面的指令', exact: true })).toBeEnabled();
	await expect(view.getByRole('textbox', { name: '指令地址', exact: true })).toHaveValue('0x1000');
	await expect(view.getByRole('status')).toHaveText('50 条指令');
});

test('all breakpoint families expose localized creation and access labels', async ({ page }) => {
	await page.goto('/debug.html?locale=zh-cn');
	await clickDebugHeaderAction(page, 'breakpoints', '添加函数断点');
	const name = page.getByRole('textbox', { name: '函数名称', exact: true });
	await name.fill('worker');
	await name.press('Enter');
	await expect(page.locator('[data-breakpoint-kind="function"]')).toContainText('函数：worker');
	await page.getByRole('button', { name: '在访问 parent 的数据时中断', exact: true }).click();
	const access = page.getByRole('combobox', { name: '访问时中断', exact: true });
	await expect(access.locator('option')).toHaveText(['读取', '写入', '读取和写入']);
	await page.getByRole('button', { name: '保存断点', exact: true }).click();
	await expect(page.locator('[data-breakpoint-kind="data"]')).toContainText('数据：parent（写入）');
	await clickDebugHeaderAction(page, 'stack', '添加指令断点');
	const offset = page.getByRole('textbox', { name: '指令字节偏移', exact: true });
	await offset.fill('-4');
	await offset.press('Enter');
	await expect(page.locator('[data-breakpoint-kind="instruction"]')).toContainText('指令：0x1000（偏移 -4）');
});

test('function breakpoints add and edit by keyboard and participate in bulk controls', async ({ page }) => {
	await page.goto('/debug.html');
	await clickDebugHeaderAction(page, 'breakpoints', 'Add Function Breakpoint');
	const name = page.getByRole('textbox', { name: 'Function name', exact: true });
	await expect(name).toBeFocused();
	await name.press('Enter');
	await expect(name).toHaveAttribute('aria-invalid', 'true');
	await name.fill('app::process');
	await name.press('Enter');
	const row = page.locator('[data-breakpoint-kind="function"]');
	await expect(row).toContainText('Function: app::process');
	await row.locator('.ash-debug-breakpoint').focus();
	await row.locator('.ash-debug-breakpoint').press('F2');
	await name.fill('app::worker');
	await page.getByRole('textbox', { name: 'Expression condition', exact: true }).fill('counter > 0');
	await name.press('Enter');
	await expect(row).toContainText('app::worker');
	await expect(row).toContainText('counter > 0');
	await page.getByRole('button', { name: 'Disable All Breakpoints', exact: true }).click();
	await expect(row.getByRole('checkbox')).not.toBeChecked();
	await row.getByRole('button', { name: 'Remove breakpoint', exact: true }).click();
	await expect(row).toHaveCount(0);
});

test('data breakpoints query the variable container, offer supported access and reject unavailable locations', async ({ page }) => {
	await page.goto('/debug.html');
	await page.getByRole('button', { name: 'Break on data access for parent', exact: true }).click();
	const access = page.getByRole('combobox', { name: 'Break on access', exact: true });
	await expect(access).toBeFocused();
	await expect(access.locator('option')).toHaveText(['Read', 'Write', 'Read and write']);
	await access.selectOption('readWrite');
	const condition = page.getByRole('textbox', { name: 'Expression condition', exact: true });
	await condition.fill('counter > 0');
	await condition.press('Enter');
	const row = page.locator('[data-breakpoint-kind="data"]');
	await expect(row).toContainText('Data: parent (Read and write)');
	expect(await page.evaluate(() => window.ashDebugIntegration.dataInfoRequests())).toEqual([{ name: 'parent', variablesReference: 20, frameId: 10 }]);
	await row.getByRole('button', { name: 'Edit breakpoint', exact: true }).click();
	await access.selectOption('read');
	await page.getByRole('button', { name: 'Save breakpoint', exact: true }).click();
	await expect(row).toContainText('Data: parent (Read)');
	await page.evaluate(() => window.ashDebugIntegration.denyDataBreakpoint());
	await page.getByRole('button', { name: 'Break on data access for parent', exact: true }).click();
	await expect(page.getByRole('status')).toContainText('The variable has no stable memory location.');
	await expect(page.getByRole('form', { name: 'Edit breakpoint', exact: true })).toHaveCount(0);
});

test('a data breakpoint query cannot open a stale draft after execution resumes', async ({ page }) => {
	await page.goto('/debug.html');
	await page.evaluate(() => window.ashDebugIntegration.holdDataInfo());
	await page.getByRole('button', { name: 'Break on data access for parent', exact: true }).click();
	await page.evaluate(() => window.ashDebugIntegration.resume());
	await page.evaluate(() => window.ashDebugIntegration.releaseDataInfo());
	await expect(page.getByRole('form', { name: 'Edit breakpoint', exact: true })).toHaveCount(0);
	expect(await page.evaluate(() => window.ashDebugIntegration.additionalBreakpoints())).toEqual([]);
});

test('instruction breakpoints use the selected instruction reference, validate byte offsets and retire their draft on resume', async ({ page }) => {
	await page.goto('/debug.html');
	await clickDebugHeaderAction(page, 'stack', 'Add Instruction Breakpoint');
	const address = page.getByRole('textbox', { name: 'Instruction address', exact: true });
	await expect(address).toBeFocused();
	await expect(address).toHaveValue('0x1000');
	const offset = page.getByRole('textbox', { name: 'Instruction byte offset', exact: true });
	await offset.fill('1.5');
	await offset.press('Enter');
	await expect(offset).toHaveAttribute('aria-invalid', 'true');
	await expect(page.getByRole('alert').filter({ hasText: 'Instruction byte offset must be an integer.' })).toHaveText('Instruction byte offset must be an integer.');
	await offset.fill('-4');
	await offset.press('Enter');
	const row = page.locator('[data-breakpoint-kind="instruction"]');
	await expect(row).toContainText('Instruction: 0x1000 (offset -4)');
	await row.getByRole('button', { name: 'Edit breakpoint', exact: true }).click();
	await address.fill('0x2000');
	await address.press('Escape');
	await expect(row).toContainText('0x1000');
	await clickDebugHeaderAction(page, 'stack', 'Add Instruction Breakpoint');
	await page.evaluate(() => window.ashDebugIntegration.resume());
	await expect(address).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Add Instruction Breakpoint', exact: true })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Break on data access for parent', exact: true })).toHaveCount(0);
});

test('breakpoints edit expressions by keyboard, update gutter state and support bulk controls', async ({ page }) => {
	await page.goto('/debug.html?breakpoints');
	const first = page.locator('.ash-debug-breakpoints > li').filter({ hasText: 'main.ts:2' });
	const checkbox = first.getByRole('checkbox');
	await expect(checkbox).toBeChecked();
	await checkbox.focus();
	await checkbox.press('Space');
	await expect(checkbox).not.toBeChecked();
	await expect(checkbox).toBeFocused();
	await expect(page.locator('.ash-debug-breakpoint-gutter.disabled')).toHaveCount(1);
	const action = first.locator('.ash-debug-breakpoint');
	await expect(action).toHaveCSS('height', '22px');
	await action.focus();
	await action.press('F2');
	const condition = page.getByRole('textbox', { name: 'Expression condition', exact: true });
	await expect(condition).toBeFocused();
	await condition.fill('discarded');
	await condition.press('Escape');
	await expect(first.getByRole('button', { name: 'Edit breakpoint', exact: true })).toBeFocused();
	await first.getByRole('button', { name: 'Edit breakpoint', exact: true }).click();
	await condition.fill('answer > 10');
	await page.evaluate(() => window.ashDebugIntegration.resize(180));
	await expect.poll(() => condition.evaluate(element => {
		const bounds = element.getBoundingClientRect();
		const pane = element.closest('.ash-debug')!.getBoundingClientRect();
		return bounds.left >= pane.left && bounds.right <= pane.right;
	})).toBe(true);
	await page.getByRole('textbox', { name: 'Hit count condition', exact: true }).fill('>= 3');
	const log = page.getByRole('textbox', { name: 'Log message', exact: true });
	await log.fill(' answer={answer} ');
	await log.press('Enter');
	await expect(page.getByRole('form', { name: 'Edit breakpoint', exact: true })).toHaveCount(0);
	await expect(first.getByRole('button', { name: 'Edit breakpoint', exact: true })).toBeFocused();
	expect(await page.evaluate(() => window.ashDebugIntegration.breakpoints())).toEqual([
		{ lineNumber: 2, enabled: false, condition: 'answer > 10', hitCondition: '>= 3', logMessage: ' answer={answer} ' },
		{ lineNumber: 3, enabled: true },
	]);
	await expect(page.locator('.ash-debug-breakpoint-gutter.logpoint')).toHaveCount(1);
	await page.getByRole('button', { name: 'Enable All Breakpoints', exact: true }).click();
	await expect(checkbox).toBeChecked();
	await expect(page.locator('.ash-debug-breakpoint-gutter.disabled')).toHaveCount(0);
	await page.getByRole('button', { name: 'Disable All Breakpoints', exact: true }).click();
	await expect(page.locator('.ash-debug-breakpoint-gutter.disabled')).toHaveCount(2);
	await page.getByRole('button', { name: 'Remove All Breakpoints', exact: true }).click();
	await expect(page.locator('.ash-debug-breakpoints > li')).toHaveCount(0);
	await expect(page.locator('.ash-debug-breakpoint-gutter')).toHaveCount(0);
});

test('unconfigured debugging shows a localized welcome and retains inspection after a session ends', async ({ page }) => {
	await page.goto('/debug.html?locale=zh-cn&welcome&empty');
	await expect(page.getByRole('button', { name: '打开文件夹', exact: true })).toBeVisible();
	await expect(page.locator('.ash-debug-section .ash-pane-view-header-title')).toHaveText(['运行']);
	await expect(page.getByRole('combobox', { name: '调试配置', exact: true })).toBeHidden();
	await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
	expect(await page.evaluate(() => window.ashDebugIntegration.folderOpens())).toBe(1);
	await page.evaluate(() => window.ashDebugIntegration.start());
	await expect(page.locator('.ash-debug-section .ash-pane-view-header-title')).toHaveText(['变量', '监视', '调用堆栈', '断点']);
	await page.evaluate(() => window.ashDebugIntegration.stop());
	await expect(page.locator('.ash-debug-section .ash-pane-view-header-title')).toHaveText(['变量', '监视', '调用堆栈', '断点']);
	await expect(page.locator('.ash-debug-empty')).toHaveCount(0);
});

test('debug sections resize and collapse by keyboard and only show watch input while adding', async ({ page }) => {
	await page.goto('/debug.html');
	const variables = page.getByRole('button', { name: 'Variables', exact: true });
	const watch = page.getByRole('button', { name: 'Watch', exact: true });
	await variables.focus();
	await variables.press('ArrowDown');
	await expect(watch).toBeFocused();
	await watch.press('ArrowLeft');
	await expect(watch).toHaveAttribute('aria-expanded', 'false');
	await watch.press('ArrowRight');
	await expect(watch).toHaveAttribute('aria-expanded', 'true');
	const separator = page.getByRole('separator', { name: 'Resize panes', exact: true }).first();
	await separator.focus();
	const before = await watch.boundingBox();
	await separator.press('ArrowDown');
	await expect.poll(async () => (await watch.boundingBox())!.y).toBeGreaterThan(before!.y);
	const input = page.getByRole('textbox', { name: 'Add watch expression', exact: true });
	await expect(input).toBeHidden();
	await watch.hover();
	const add = page.getByRole('button', { name: 'Add watch expression', exact: true });
	await add.click();
	await expect(input).toBeFocused();
	await input.fill('cancelled');
	await input.press('Escape');
	await expect(input).toBeHidden();
	await expect(add).toBeFocused();
	await add.click();
	await input.fill('counter');
	await input.press('Enter');
	await expect(input).toBeHidden();
	await expect(page.locator('.ash-debug-watch-value')).toHaveText(['answer = 42', 'counter = 42']);
	await page.getByRole('button', { name: 'Remove All Expressions', exact: true }).click();
	await expect(page.locator('.ash-debug-watch-value')).toHaveCount(0);
	await expect(page.getByRole('list', { name: 'Exception Breakpoints' })).toBeVisible();
	expect(await page.getByRole('list', { name: 'Exception Breakpoints' }).evaluate(element => element.closest('.ash-debug-section')!.querySelector('.ash-pane-view-header-title')!.textContent)).toBe('Breakpoints');
	await page.evaluate(() => window.ashDebugIntegration.resize(180));
	expect(await page.locator('.ash-debug').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test('stopped debugging locates source and edits a nested variable with keyboard focus and theme support', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/debug.html');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.position())).toBe(2);
	const parent = page.locator('.ash-debug-variable').filter({ hasText: 'parent = Object' });
	await parent.dblclick();
	const parentValue = page.getByRole('textbox', { name: 'Value of parent', exact: true });
	await expect(parentValue).toBeFocused();
	await parentValue.press('Escape');
	await expect(parent).toHaveAttribute('aria-expanded', 'true');
	const child = page.locator('.ash-debug-variable').filter({ hasText: 'child = value' });
	await child.focus();
	await child.press('F2');
	const value = page.getByRole('textbox', { name: 'Value of child', exact: true });
	await expect(value).toBeFocused();
	await value.fill('cancelled');
	await value.press('Escape');
	await expect(child).toBeFocused();
	expect(await page.evaluate(() => window.ashDebugIntegration.assignments())).toEqual([]);
	await child.dblclick();
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(theme => window.ashDebugIntegration.theme(theme), theme);
		await value.focus();
		const colors = await value.evaluate(element => {
			const style = getComputedStyle(element.closest('.ash-input-box')!);
			return { background: style.backgroundColor, border: style.borderColor, borderStyle: style.borderStyle };
		});
		expect(colors.borderStyle).toBe('solid');
		expect(colors.border).not.toBe(colors.background);
	}
	await page.evaluate(() => window.ashDebugIntegration.resize(220));
	// PaneView receives the new container dimensions through ResizeObserver.
	await expect.poll(() => value.evaluate(element => {
		const input = element.getBoundingClientRect();
		const pane = element.closest('.ash-debug')!.getBoundingClientRect();
		return input.left >= pane.left && input.right <= pane.right;
	})).toBe(true);
	const geometry = await value.evaluate(element => {
		const input = element.getBoundingClientRect();
		const pane = element.closest('.ash-debug')!.getBoundingClientRect();
		return { width: input.width, fits: input.left >= pane.left && input.right <= pane.right };
	});
	expect(geometry.width).toBeGreaterThan(0);
	expect(geometry.fits).toBe(true);
	await value.fill('43');
	await value.press('Enter');
	const updated = page.locator('.ash-debug-variable').filter({ hasText: 'child = 43' });
	await expect(updated).toBeFocused();
	await expect(page.locator('.ash-debug-watch-value')).toHaveText('answer = 43');
	expect(await page.evaluate(() => window.ashDebugIntegration.assignments())).toEqual([{ reference: 21, name: 'child', value: '43' }]);
	expect(errors).toEqual([]);
});

test('variable edits expose validation, discard replies after resume, and localize input instructions', async ({ page }) => {
	await page.goto('/debug.html?locale=zh-cn');
	const parent = page.locator('.ash-debug-variable').filter({ hasText: 'parent = Object' });
	await parent.focus();
	await parent.press('F2');
	const value = page.getByRole('textbox', { name: 'parent 的值', exact: true });
	await expect(value).toHaveAttribute('aria-description', '按 Enter 应用新值，按 Escape 取消。');
	await page.evaluate(() => window.ashDebugIntegration.failAssignment());
	await value.fill('invalid');
	await value.press('Enter');
	await expect(value).toHaveAttribute('aria-invalid', 'true');
	await expect(value).toBeFocused();
	await expect(page.getByRole('alert').filter({ hasText: 'Invalid value' })).toHaveText('Invalid value');
	await page.evaluate(() => window.ashDebugIntegration.holdAssignment());
	await value.fill('pending');
	await value.press('Enter');
	await expect(value).toHaveAttribute('readonly');
	await page.evaluate(() => window.ashDebugIntegration.resume());
	await expect(page.locator('.ash-debug-variable-edit')).toHaveCount(0);
	await page.evaluate(() => window.ashDebugIntegration.releaseAssignment());
	await expect(page.locator('.ash-debug-frame, .ash-debug-variable')).toHaveCount(0);
	await expect(page.getByRole('status')).toContainText('正在运行');
});


test('structured debug console groups expand objects and open source by keyboard without losing output focus', async ({ page }, testInfo) => {
	await page.goto('/debug.html?console');
	const output = page.getByRole('log', { name: 'Debug Console output', exact: true });
	const input = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	await fillRepl(page, input, 'draft');
	await input.focus();
	await page.evaluate(() => window.ashDebugIntegration.structuredOutput());
	await expect(input).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('draft');
	const tree = output.getByRole('tree');
	const group = tree.getByRole('treeitem').filter({ hasText: 'Structured group' });
	await expect(group).toBeVisible();
	await expect(group).toHaveAttribute('aria-expanded', 'false');
	await tree.focus();
	await tree.press('Home');
	await tree.press('ArrowRight');
	const object = tree.getByRole('treeitem').filter({ hasText: 'Object output' });
	await expect(object).toBeVisible();
	await tree.press('ArrowRight');
	await tree.press('ArrowRight');
	const parent = tree.getByRole('treeitem').filter({ hasText: 'parent: Object' });
	await expect(parent).toBeVisible();
	await tree.press('ArrowRight');
	await tree.press('ArrowRight');
	await expect(output).toContainText('child: value');
	const source = output.getByRole('button', { name: 'main.ts:2', exact: true });
	await source.focus();
	await source.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.openedSources())).toContainEqual({ resource: 'file:///workspace/main.ts', readOnly: false, line: 2 });
	await page.evaluate(() => window.ashDebugIntegration.theme('hcDark'));
	await source.focus();
	await expect(source).toHaveCSS('outline-style', 'solid');
	await expect(source).toHaveCSS('outline-width', '1px');
	await page.evaluate(() => window.ashDebugIntegration.burstOutput(100));
	await expect(output).toContainText('burst-99');
	await expect(source).toBeFocused();
	await expect(group).toHaveAttribute('aria-expanded', 'true');
	await page.evaluate(() => window.ashDebugIntegration.resize(240));
	expect(await output.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
	await page.screenshot({ path: testInfo.outputPath('structured-console.png') });
	await source.focus();
	await page.evaluate(() => window.ashDebugIntegration.selectConsoleSession('session-two'));
	await expect(tree).toBeFocused();
});

test('structured console labels use the selected display language', async ({ page }) => {
	await page.goto('/debug.html?console&locale=zh-cn');
	await expect(page.getByRole('log', { name: '调试控制台输出', exact: true })).toBeVisible();
	await expect(page.locator('.ash-repl-input .stanza-editor-placeholder-text')).toHaveText('计算表达式');
});

test('debug console tools filter alternatives and exclusions by keyboard while retaining group context', async ({ page }) => {
	await page.goto('/debug.html?console');
	const output = page.getByRole('log', { name: 'Debug Console output', exact: true });
	const input = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	const filter = page.getByRole('textbox', { name: 'Filter Debug Console', exact: true });
	await page.evaluate(() => window.ashDebugIntegration.consoleOutput());
	const tree = output.getByRole('tree');
	const group = tree.getByRole('treeitem').filter({ hasText: 'Build group' });
	const alpha = output.locator('[data-entry-id="2"]');
	const beta = output.locator('[data-entry-id="3"]');
	const gamma = output.locator('[data-entry-id="4"]');
	await expect(group).toBeVisible();
	await expect(group).toHaveAttribute('aria-expanded', 'false');
	await expect(alpha).toBeHidden();
	await input.focus();
	await input.press('Control+f');
	await expect(filter).toBeFocused();
	await filter.fill('alpha, gamma, !beta');
	await expect(alpha).toBeVisible();
	await expect(beta).toBeHidden();
	await expect(gamma).toBeVisible();
	await expect(group).toHaveAttribute('aria-expanded', 'true');
	await expect(page.locator('.ash-view-filter-badge')).toHaveText('3 of 4');
	expect(await page.evaluate(() => window.ashDebugIntegration.consoleStats())).toEqual({ total: 4, filtered: 3 });
	expect((await page.evaluate(() => window.ashDebugIntegration.consoleAccessibility())).view).toBe('Build group\nAlpha success\nGamma outside\n');
	await filter.fill('alpha, !Build');
	await expect(group).toBeHidden();
	await expect(alpha).toBeHidden();
	expect(await page.evaluate(() => window.ashDebugIntegration.consoleStats())).toEqual({ total: 4, filtered: 0 });
	await filter.fill('!beta');
	await expect(alpha).toBeVisible();
	await expect(beta).toBeHidden();
	await filter.press('Escape');
	await expect(filter).toHaveValue('');
	await expect(group).toHaveAttribute('aria-expanded', 'false');
	await expect(alpha).toBeHidden();
	await expect(gamma).toBeVisible();
	expect((await page.evaluate(() => window.ashDebugIntegration.consoleAccessibility())).view).toBe('Build group\nGamma outside\n');
	await filter.press('Escape');
	await expect(output.getByRole('tree')).toBeFocused();
});

test('debug console tools restore input drafts and persist independent input and filter histories by workspace', async ({ page }) => {
	await page.goto('/debug.html?console');
	const input = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	const filter = page.getByRole('textbox', { name: 'Filter Debug Console', exact: true });
	for (const expression of ['first', 'second']) { await fillRepl(page, input, expression); await input.press('Enter'); }
	await fillRepl(page, input, 'unsent draft');
	await input.press('ArrowUp');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('second');
	await input.press('ArrowUp');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('first');
	await input.press('ArrowDown');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('second');
	await input.press('ArrowDown');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('unsent draft');
	await filter.fill('Alpha');
	await filter.press('Enter');
	await page.evaluate(() => window.ashDebugIntegration.recreateConsole());
	await input.focus();
	await input.press('ArrowUp');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('second');
	await filter.focus();
	await filter.press('ArrowUp');
	await expect(filter).toHaveValue('Alpha');
	await page.reload();
	await input.focus();
	await input.press('ArrowUp');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('second');
	await filter.focus();
	await filter.press('ArrowUp');
	await expect(filter).toHaveValue('Alpha');
	await page.evaluate(() => window.ashDebugIntegration.consoleWorkspace('other-debug-workspace'));
	await fillRepl(page, input, '');
	await input.press('ArrowUp');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('');
	await filter.fill('');
	await filter.press('ArrowUp');
	await expect(filter).toHaveValue('');
	await fillRepl(page, input, 'other');
	await input.press('Enter');
	await page.evaluate(() => window.ashDebugIntegration.consoleWorkspace('debug-console-integration'));
	await input.focus();
	await input.press('ArrowUp');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('second');
	await filter.focus();
	await filter.press('ArrowUp');
	await expect(filter).toHaveValue('Alpha');
});

test('debug console tools complete in frame zero and preserve adapter replacement ranges and selections', async ({ page }) => {
	await page.goto('/debug.html?console&console-tools');
	const input = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	const suggestions = page.getByRole('listbox', { name: 'Debug Console suggestions', exact: true });
	const output = page.getByRole('log', { name: 'Debug Console output', exact: true });
	await page.evaluate(() => window.ashDebugIntegration.focusConsoleFrame(0));
	await fillRepl(page, input, 'value');
	await input.press('Control+Space');
	await expect(suggestions.getByRole('option')).toHaveText(['alpha', 'beta']);
	expect(await page.evaluate(() => window.ashDebugIntegration.completionRequests().at(-1))).toMatchObject({ sessionId: 'session-one', frameId: 0, threadId: 2, text: 'value', lineNumber: 1, column: 6 });
	await input.press('ArrowDown');
	await expect(suggestions.getByRole('option', { selected: true })).toHaveText('beta');
	await input.press('ArrowUp');
	await expect(suggestions.getByRole('option', { selected: true })).toHaveText('alpha');
	await input.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('alpha');
	await expect(input).toBeFocused();
	await expect(output).toHaveText('');
	await expect(suggestions).toBeHidden();
	await fillRepl(page, input, 'value');
	await input.press('Control+Space');
	await expect(suggestions).toBeVisible();
	await input.press('ArrowDown');
	await input.press('Tab');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('beta');
	await expect(input).toBeFocused();
	await expect(output).toHaveText('');
	await fillRepl(page, input, 'pre obj.pa tail');
	await input.press('Home');
	for (let index = 0; index < 10; index++) await input.press('ArrowRight');
	await input.press('Control+Space');
	await expect(suggestions.getByRole('option')).toHaveCount(3);
	await input.press('ArrowDown');
	await input.press('ArrowDown');
	await input.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('pre obj.pair(value) tail');
	expect(await page.evaluate(() => { const { start, end, selection } = window.ashDebugIntegration.consoleInput(); return { start, end, selection }; })).toEqual({ start: 13, end: 18, selection: 'value' });
	await fillRepl(page, input, 'dismiss');
	await input.press('Control+Space');
	await expect(suggestions).toBeVisible();
	await input.press('Escape');
	await expect(suggestions).toBeHidden();
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('dismiss');
	await expect(output).toHaveText('');
	await fillRepl(page, input, 'obj.');
	await expect(suggestions).toBeVisible();
	expect(await page.evaluate(() => window.ashDebugIntegration.completionRequests().at(-1)?.text)).toBe('obj.');
});

test('debug console tools discard late completions after input, caret, frame, session and focus changes', async ({ page }) => {
	await page.goto('/debug.html?console&console-tools');
	const input = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	const suggestions = page.getByRole('listbox', { name: 'Debug Console suggestions', exact: true });
	for (const change of ['input', 'caret', 'frame', 'session', 'focus'] as const) {
		await fillRepl(page, input, `held-${change}`);
		await page.evaluate(() => window.ashDebugIntegration.holdCompletion());
		await input.press('Control+Space');
		await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.completionRequests().at(-1)?.held)).toBe(true);
		if (change === 'input') await fillRepl(page, input, 'changed!');
		else if (change === 'caret') await input.press('ArrowLeft');
		else if (change === 'frame') await page.evaluate(() => window.ashDebugIntegration.focusConsoleFrame(99));
		else if (change === 'session') await page.evaluate(() => window.ashDebugIntegration.selectConsoleSession('session-two'));
		else await page.getByRole('log', { name: 'Debug Console output', exact: true }).getByRole('tree').focus();
		await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.completionRequests().at(-1)?.cancelled)).toBe(true);
		await page.evaluate(() => window.ashDebugIntegration.releaseCompletion());
		await expect(suggestions.getByRole('option', { name: 'obsolete-result', exact: true })).toHaveCount(0);
		await expect(suggestions).toBeHidden();
		await expect(input).toHaveAttribute('aria-expanded', 'false');
	}
});

test('debug console tools localize filter, history help and completion labels', async ({ page }) => {
	await page.goto('/debug.html?console&console-tools&locale=zh-cn');
	const input = page.getByRole('textbox', { name: '调试控制台表达式', exact: true });
	const filter = page.getByRole('textbox', { name: '筛选调试控制台', exact: true });
	await expect(filter).toHaveAttribute('placeholder', '筛选（文本、!排除）');
	await input.focus();
	await input.press('Control+f');
	await expect(filter).toBeFocused();
	const help = (await page.evaluate(() => window.ashDebugIntegration.consoleAccessibility())).help;
	expect(help).toContain('按 Control+Space 请求建议');
	expect(help).toContain('用逗号分隔替代条件');
	await fillRepl(page, input, 'value');
	await input.press('Control+Space');
	const suggestions = page.getByRole('listbox', { name: '调试控制台建议', exact: true });
	await expect(suggestions).toBeVisible();
	await expect(input).toHaveAttribute('aria-expanded', 'true');
	await input.press('Escape');
	await expect(suggestions).toBeHidden();
});

test('debug console tools fit high contrast narrow panes without clipping focused inputs and suggestions', async ({ page }, testInfo) => {
	await page.goto('/debug.html?console&console-tools');
	await page.evaluate(() => window.ashDebugIntegration.resizeConsole(240));
	const input = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	const filter = page.getByRole('textbox', { name: 'Filter Debug Console', exact: true });
	await page.evaluate(() => window.ashDebugIntegration.consoleOutput());
	await filter.fill('alpha');
	const filterGeometry = await filter.evaluate(element => {
		const bounds = element.getBoundingClientRect();
		const pane = element.closest('.ash-view-pane')!.getBoundingClientRect();
		return { left: bounds.left, right: bounds.right, paneLeft: pane.left, paneRight: pane.right };
	});
	expect(filterGeometry.left).toBeGreaterThanOrEqual(filterGeometry.paneLeft);
	expect(filterGeometry.right).toBeLessThanOrEqual(filterGeometry.paneRight);
	await fillRepl(page, input, 'value');
	await input.press('Control+Space');
	const suggestions = page.getByRole('listbox', { name: 'Debug Console suggestions', exact: true });
	await expect(suggestions).toBeVisible();
	for (const theme of ['hcDark', 'hcLight'] as const) {
		await page.evaluate(name => window.ashDebugIntegration.theme(name), theme);
		await expect(suggestions).toHaveCSS('box-shadow', 'none');
		await expect(page.locator('.ash-repl-input')).toHaveCSS('outline-style', 'solid');
		const geometry = await suggestions.evaluate(element => {
			const pane = element.closest('.ash-view-pane')!;
			const bounds = element.getBoundingClientRect();
			const outer = pane.getBoundingClientRect();
			const selected = element.querySelector('[aria-selected="true"]')!;
			const style = getComputedStyle(selected);
			return { left: bounds.left, right: bounds.right, outerLeft: outer.left, outerRight: outer.right, color: style.color, background: style.backgroundColor, border: getComputedStyle(element).borderColor, fits: pane.scrollWidth <= pane.clientWidth };
		});
		expect(geometry.left).toBeGreaterThanOrEqual(geometry.outerLeft);
		expect(geometry.right).toBeLessThanOrEqual(geometry.outerRight);
		expect(geometry.fits).toBe(true);
		expect(geometry.color).not.toBe(geometry.background);
		expect(geometry.border).not.toBe('rgba(0, 0, 0, 0)');
	}
	await page.screenshot({ path: testInfo.outputPath('debug-console-tools-hc.png') });
});

async function fillRepl(page: Page, input: Locator, text: string): Promise<void> {
	await input.focus();
	await input.press('ControlOrMeta+a');
	await input.press('Backspace');
	if (text) await page.keyboard.insertText(text);
}

test('debug console editor supports multiline editing, undo, UTF-16 completion coordinates and bounded layout', async ({ page }) => {
	await page.goto('/debug.html?console&console-tools');
	const input = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	await fillRepl(page, input, 'first');
	const initial = await page.evaluate(() => window.ashDebugIntegration.consoleInput());
	await input.press('Shift+Enter');
	await page.keyboard.insertText('😀obj.');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('first\n😀obj.');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().height)).toBeGreaterThan(initial.height);
	await input.press('Control+Space');
	await expect(page.getByRole('listbox', { name: 'Debug Console suggestions', exact: true })).toBeVisible();
	const requests = await page.evaluate(() => window.ashDebugIntegration.completionRequests());
	expect(requests.at(-1)).toMatchObject({ text: 'first\n😀obj.', lineNumber: 2, column: 7 });
	await input.press('Escape');
	await input.press('ControlOrMeta+z');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('first');
	await fillRepl(page, input, Array.from({ length: 20 }, (_, index) => `line-${index}`).join('\n'));
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().lineCount)).toBe(20);
	expect((await page.evaluate(() => window.ashDebugIntegration.consoleInput())).height).toBeLessThanOrEqual(204);
	await page.evaluate(() => window.ashDebugIntegration.resizeConsole(240, 180));
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().height)).toBeLessThanOrEqual(44);
	await input.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().height)).toBe(initial.height);
});
