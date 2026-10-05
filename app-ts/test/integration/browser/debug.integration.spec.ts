import { expect, test } from '@playwright/test';

test('disassembly navigates instruction pages, follows frame focus, toggles breakpoints and steps by instruction', async ({ page }) => {
	await page.goto('/debug.html');
	await page.getByRole('button', { name: 'Open Disassembly View', exact: true }).click();
	const view = page.locator('.ash-disassembly');
	const grid = view.getByRole('grid', { name: 'Disassembly', exact: true });
	await expect(view.locator('[data-instruction-address="0x1000"]')).toHaveAttribute('aria-current', 'step');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.disassemblyRequests().at(-1))).toEqual({ reference: '0x1000', offset: 0, instructionOffset: 0, instructionCount: 50 });
	await grid.focus();
	await grid.press('F9');
	await expect(view.getByRole('button', { name: 'Toggle instruction breakpoint at 0x1000', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await grid.press('F9');
	await expect(view.getByRole('button', { name: 'Toggle instruction breakpoint at 0x1000', exact: true })).toHaveAttribute('aria-pressed', 'false');
	await page.getByRole('button', { name: 'Add Instruction Breakpoint', exact: true }).click();
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
	await page.getByRole('button', { name: 'Open Disassembly View', exact: true }).click();
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
	await page.getByRole('button', { name: 'Open Disassembly View', exact: true }).click();
	const grid = page.locator('.ash-disassembly').getByRole('grid');
	await expect(page.locator('.ash-disassembly [data-instruction-address="0x1000"]')).toBeVisible();
	await grid.focus();
	await grid.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.openedSources().at(-1))).toEqual({ resource: 'debug-source://session/session-one/33/generated.ts', initialText: 'const generated = true;', readOnly: true, line: 2 });
});

test('a frame without an instruction reference can inspect an explicit address', async ({ page }) => {
	await page.goto('/debug.html?no-address');
	await page.getByRole('button', { name: 'Open Disassembly View', exact: true }).click();
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
	await page.getByRole('button', { name: 'Open Disassembly View', exact: true }).click();
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
	await page.getByRole('button', { name: '打开反汇编视图', exact: true }).click();
	const view = page.locator('.ash-disassembly');
	await expect(view.getByRole('grid', { name: '反汇编', exact: true })).toBeVisible();
	await expect(view.getByRole('columnheader')).toHaveText(['断点', '地址', '机器码', '指令']);
	await expect(view.getByRole('button', { name: '前面的指令', exact: true })).toBeEnabled();
	await expect(view.getByRole('textbox', { name: '指令地址', exact: true })).toHaveValue('0x1000');
	await expect(view.getByRole('status')).toHaveText('50 条指令');
});

test('all breakpoint families expose localized creation and access labels', async ({ page }) => {
	await page.goto('/debug.html?locale=zh-cn');
	await page.getByRole('button', { name: '添加函数断点', exact: true }).click();
	const name = page.getByRole('textbox', { name: '函数名称', exact: true });
	await name.fill('worker');
	await name.press('Enter');
	await expect(page.locator('[data-breakpoint-kind="function"]')).toContainText('函数：worker');
	await page.getByRole('button', { name: '在访问 parent 的数据时中断', exact: true }).click();
	const access = page.getByRole('combobox', { name: '访问时中断', exact: true });
	await expect(access.locator('option')).toHaveText(['读取', '写入', '读取和写入']);
	await page.getByRole('button', { name: '保存断点', exact: true }).click();
	await expect(page.locator('[data-breakpoint-kind="data"]')).toContainText('数据：parent（写入）');
	await page.getByRole('button', { name: '添加指令断点', exact: true }).click();
	const offset = page.getByRole('textbox', { name: '指令字节偏移', exact: true });
	await offset.fill('-4');
	await offset.press('Enter');
	await expect(page.locator('[data-breakpoint-kind="instruction"]')).toContainText('指令：0x1000（偏移 -4）');
});

test('function breakpoints add and edit by keyboard and participate in bulk controls', async ({ page }) => {
	await page.goto('/debug.html');
	await page.getByRole('button', { name: 'Add Function Breakpoint', exact: true }).click();
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
	await page.getByRole('button', { name: 'Add Instruction Breakpoint', exact: true }).click();
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
	await page.getByRole('button', { name: 'Add Instruction Breakpoint', exact: true }).click();
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
