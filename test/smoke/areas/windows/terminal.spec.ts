import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test('terminal file links open compiler locations by click and keyboard without losing the shell', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, testWorkspace }) => {
	const page = workbench.page;
	const terminal = workbench.terminal;
	const relative = 'terminal-link-fixture.ts';
	const spaced = 'terminal link fixture.ts';
	const contents = Array.from({ length: 60 }, (_, index) => `// synthetic terminal link row ${index + 1}`).join('\n');
	await writeFile(join(testWorkspace.directory, relative), contents);
	await writeFile(join(testWorkspace.directory, spaced), contents);
	await terminal.show();
	const pane = page.locator('.ash-terminal-group-pane:visible');
	const instanceId = await pane.getAttribute('data-instance-id');
	const print = async (text: string): Promise<void> => {
		const encoded = Buffer.from(text).toString('base64');
		await terminal.runCommand(`node -e "console.log(Buffer.from('${encoded}','base64').toString())"`);
	};
	await print(`${relative}:42:3`);
	const row = terminal.activeInstance.locator('.xterm-rows > div').filter({ hasText: `${relative}:42:3` }).last();
	await expect(row).toBeVisible();
	const bounds = await row.boundingBox();
	if (!bounds) throw new Error('The terminal file link is not visible');
	await page.mouse.move(bounds.x + 12, bounds.y + bounds.height / 2);
	await expect(terminal.activeInstance.locator('.ash-terminal-link-hover-target')).toHaveCount(1);
	await page.mouse.click(bounds.x + 12, bounds.y + bounds.height / 2);
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: relative })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Ln 42, Col 3', exact: true })).toBeVisible();
	await expect(workbench.editors.groupAt(0).editor.input).toBeFocused();

	const spacedLocation = `"${join(testWorkspace.directory, spaced)}":18:7`;
	await print(spacedLocation);
	// The picker snapshots parsed output. Enter acknowledges input before the
	// asynchronous PTY read has necessarily delivered the resulting path.
	await expect.poll(async () => (await terminal.activeInstance.locator('.xterm-rows').textContent())?.replace(/\s/gu, '')).toContain(spacedLocation.replace(/\s/gu, ''));
	await terminal.activeInstance.locator('.xterm-helper-textarea').press('ControlOrMeta+Shift+o');
	const picker = page.getByRole('dialog', { name: 'Open a terminal link', exact: true });
	await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Select a terminal file or URL to open');
	await picker.getByRole('combobox').press('Escape');
	await expect(terminal.activeInstance.locator('.xterm-helper-textarea')).toBeFocused();
	await terminal.activeInstance.locator('.xterm-helper-textarea').press('ControlOrMeta+Shift+o');
	await workbench.quickaccess.select(`${join(testWorkspace.directory, spaced)}:18:7`);
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: spaced })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Ln 18, Col 7', exact: true })).toBeVisible();
	await expect(workbench.editors.groupAt(0).editor.input).toBeFocused();
	await expect(pane).toHaveAttribute('data-instance-id', instanceId!);
	await print('terminal-link-shell-alive');
	await expect(terminal.activeInstance.locator('.xterm-rows')).toContainText('terminal-link-shell-alive');
});

test('terminal preserves every output line when the screen temporarily stops consuming', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, testWorkspace, driver }, testInfo) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	const editor = workbench.editors.groupAt(0);
	await editor.editor.input.press('ControlOrMeta+A');
	await editor.editor.input.evaluate(element => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', JSON.stringify({ 'terminal.integrated.scrollback': 60000 }));
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	});
	await editor.editor.waitForEditorContents(source => JSON.parse(source)['terminal.integrated.scrollback'] === 60000);
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	await expect(editor.tabs.filter({ hasText: 'User Settings (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	const payload = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
	await writeFile(join(testWorkspace.directory, 'terminal-output-producer.cjs'), `setTimeout(() => {
    const rows = Array.from({ length: 20000 }, (_, index) => 'PRESSURE:' + String(index).padStart(5, '0') + ' ${payload}');
    process.stdout.write(rows.join('\\n') + '\\nPRESSURE-DONE\\n');
}, 200);`);
	await workbench.terminal.show();
	await workbench.terminal.runCommand('node terminal-output-producer.cjs');
	// A bounded main-thread stall emulates a screen falling behind the producer.
	// The App Server and real PTY continue on their own processes during this pause.
	await page.evaluate(() => {
		const end = performance.now() + 800;
		while (performance.now() < end) { /* Deliberately defer screen commits. */ }
	});
	await expect(workbench.terminal.activeInstance.locator('.xterm-rows')).toContainText('PRESSURE-DONE', { timeout: 30000 });
	await workbench.terminal.activeInstance.locator('.xterm-helper-textarea').press('Alt+F2');
	const output = page.locator('.ash-accessible-view-content');
	await expect(output).toBeFocused();
	const rows = [...(await output.inputValue()).matchAll(/^PRESSURE:(\d{5}) (.*)$/gmu)];
	expect(rows).toHaveLength(20000);
	const firstInvalidRow = rows.findIndex((row, index) => row[1] !== String(index).padStart(5, '0') || row[2] !== payload);
	expect(firstInvalidRow, 'All numbered rows must retain their exact payload and order').toBe(-1);
	await output.press('Escape');
	await expect(workbench.terminal.activeInstance.locator('.xterm-helper-textarea')).toBeFocused();
	await workbench.terminal.runCommand(`node -e "console.log(['pressure','shell-alive'].join('-'))"`);
	await expect(workbench.terminal.activeInstance.locator('.xterm-rows')).toContainText('pressure-shell-alive');
	expect(driver.diagnostics.errors).toEqual([]);
	await testInfo.attach('terminal-output-check.json', {
		contentType: 'application/json',
		body: JSON.stringify({
			rows: rows.length, firstSequence: rows[0]![1], lastSequence: rows.at(-1)![1], firstInvalidRow,
			normalizedOutputBytes: rows.reduce((bytes, row) => bytes + Buffer.byteLength(row[0]) + 1, 0),
			focusRestored: true, shellAcceptsCommands: true, runtimeErrors: driver.diagnostics.errors,
		}),
	});
});

test('terminal Find searches PTY output, restores focus and isolates each instance', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	const terminal = workbench.terminal;
	await terminal.show();
	await terminal.runCommand(`node -e "console.log(['ash','find-first'].join('-'))"`);
	await expect(terminal.activeInstance.locator('.xterm-rows')).toContainText('ash-find-first');
	await terminal.activeInstance.locator('.xterm-helper-textarea').press('ControlOrMeta+f');
	const find = terminal.activeInstance.getByRole('region', { name: 'Find in terminal' });
	const input = find.getByRole('textbox', { name: 'Find', exact: true });
	await expect(input).toBeFocused();
	await input.fill('ash-find-first');
	await expect(find.getByRole('status')).toHaveText('1 of 1');
	await input.press('Alt+F1');
	const help = page.locator('.ash-accessible-view-content');
	await expect(help).toBeFocused();
	await expect(help).toHaveValue(/Find searches this terminal/u);
	await help.press('Escape');
	await expect(input).toBeFocused();
	await page.getByRole('button', { name: 'New Terminal', exact: true }).click();
	await expect(terminal.instances).toHaveCount(2);
	await terminal.runCommand(`node -e "console.log(['ash','find-second'].join('-'))"`);
	await expect(terminal.activeInstance.locator('.xterm-rows')).toContainText('ash-find-second');
	await terminal.activeInstance.locator('.xterm-helper-textarea').press('ControlOrMeta+f');
	await input.fill('ash-find-first');
	await expect(find.getByRole('status')).toHaveText('No results');
	await input.fill('ash-find-second');
	await expect(find.getByRole('status')).toHaveText('1 of 1');
	await terminal.tabs.nth(0).click();
	await expect(input).toHaveValue('ash-find-first');
	await expect(find.getByRole('status')).toHaveText('1 of 1');
	await input.focus();
	await input.press('Escape');
	await expect(find).toHaveCount(0);
	await expect(terminal.activeInstance.locator('.xterm-helper-textarea')).toBeFocused();
	await terminal.runCommand(`node -e "console.log(['ash','after-find'].join('-'))"`);
	await expect(terminal.activeInstance.locator('.xterm-rows')).toContainText('ash-after-find');
	await terminal.tabs.nth(0).focus();
	await terminal.tabs.nth(0).press('Delete');
	await expect(terminal.instances).toHaveCount(1);
	await expect(input).toHaveValue('ash-find-second');
});

test('terminal panel preserves focus, accepts input and retains instances when reopened', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	await expect(page.locator('.xterm')).toHaveCount(0);
	await workbench.terminal.show();
	const terminal = workbench.terminal.activeInstance;
	await expect(terminal).toHaveAttribute('data-state', 'running');
	await expect(terminal.locator('.xterm-helper-textarea')).toBeFocused();
	// Build the marker in the child so echoed input cannot satisfy the output assertion.
	await workbench.terminal.runCommand(`node -e "console.log(['ash','terminal-ready'].join('-'))"`);
	await expect(terminal.locator('.xterm-rows')).toContainText('ash-terminal-ready');
	await page.getByRole('button', { name: 'Close Panel', exact: true }).click();
	await expect(terminal).toHaveCount(0);
	await workbench.terminal.show();
	await expect(page.locator('.xterm')).toHaveCount(1);
	await expect(terminal.locator('.xterm-rows')).toContainText('ash-terminal-ready');
	await page.getByRole('button', { name: 'New Terminal', exact: true }).click();
	await expect(page.locator('.ash-terminal-instance')).toHaveCount(2);
	await expect(terminal.locator('.xterm-helper-textarea')).toBeFocused();
	await workbench.terminal.tabs.nth(1).focus();
	await workbench.terminal.tabs.nth(1).press('Delete');
	await expect(page.locator('.ash-terminal-instance')).toHaveCount(1);
	await expect(page.locator('.xterm')).toHaveCount(1);
	await expect(terminal.locator('.xterm-rows')).toContainText('ash-terminal-ready');
});

test('terminal instances keep output separate and start in the workspace', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, testWorkspace, workbench }) => {
	const terminal = workbench.terminal;
	await terminal.show();
	await expect(terminal.activeInstance).toHaveAttribute('data-state', 'running');
	await terminal.runCommand(`node -e "require('fs').writeFileSync('terminal-cwd.txt','workspace'); console.log(['ash','first-terminal'].join('-'))"`);
	await expect(terminal.activeInstance.locator('.xterm-rows')).toContainText('ash-first-terminal');
	expect(await readFile(join(testWorkspace.directory, 'terminal-cwd.txt'), 'utf8')).toBe('workspace');

	await workbench.page.getByRole('button', { name: 'New Terminal', exact: true }).click();
	await expect(terminal.instances).toHaveCount(2);
	await expect(terminal.tabs).toHaveCount(2);
	await expect(terminal.tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
	await expect(terminal.activeInstance.locator('.xterm-rows')).not.toContainText('ash-first-terminal');
	await terminal.runCommand(`node -e "console.log(['ash','second-terminal'].join('-'))"`);
	await expect(terminal.activeInstance.locator('.xterm-rows')).toContainText('ash-second-terminal');

	await terminal.tabs.nth(0).click();
	await expect(terminal.tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
	await expect(terminal.activeInstance.locator('.xterm-helper-textarea')).toBeFocused();
	await expect(terminal.activeInstance.locator('.xterm-rows')).toContainText('ash-first-terminal');
	await expect(terminal.activeInstance.locator('.xterm-rows')).not.toContainText('ash-second-terminal');
	await terminal.tabs.nth(1).click();
	await expect(terminal.activeInstance.locator('.xterm-rows')).toContainText('ash-second-terminal');
	await expect(terminal.activeInstance.locator('.xterm-rows')).not.toContainText('ash-first-terminal');
});

test('terminal relaunches an exited shell and accepts new commands', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, application, workbench }) => {
	const terminal = workbench.terminal;
	await terminal.show();
	await expect(terminal.activeInstance).toHaveAttribute('data-state', 'running');
	await terminal.runCommand('exit 17');
	await expect(terminal.activeInstance).toHaveAttribute('data-state', 'exited');
	await expect(terminal.activeInstance.locator('.xterm-rows')).toContainText('[process exited with code 17]');
	await workbench.menus.select(application, () => workbench.page.locator('.ash-terminal-title-toolbar').getByRole('button', { name: 'More Actions', exact: true }).click(), ['Relaunch Terminal']);
	await expect(terminal.instances).toHaveCount(1);
	await expect(terminal.activeInstance).toHaveAttribute('data-state', 'running');
	await expect(terminal.activeInstance.locator('.xterm-helper-textarea')).toBeFocused();
	await terminal.runCommand(`node -e "console.log(['ash','relaunched-terminal'].join('-'))"`);
	await expect(terminal.activeInstance.locator('.xterm-rows')).toContainText('ash-relaunched-terminal');
});

test('terminal command markers use VS Code geometry and follow real shell command results', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench }, testInfo) => {
	const terminal = workbench.terminal;
	await terminal.show();
	const instance = terminal.activeInstance;
	await expect(instance.locator('.ash-terminal-command-status.pending')).toBeVisible();
	const panelBackground = await workbench.page.locator('.ash-workbench-panel').evaluate(element => getComputedStyle(element).backgroundColor);
	for (const selector of ['.ash-terminal-content', '.ash-terminal-instance', '.xterm-viewport', '.xterm-scrollable-element']) {
		await expect(workbench.page.locator(selector).first()).toHaveCSS('background-color', panelBackground);
	}
	await expect(instance.locator('.xterm')).toHaveCSS('padding-left', '20px');
	const pending = instance.locator('.ash-terminal-command-status.pending');
	await expect(pending).toHaveCSS('margin-left', '-17px');
	await expect(pending.locator('svg')).toHaveCSS('width', '16px');
	expect(await pending.locator('svg').evaluate(element => (element as SVGGraphicsElement).getBBox().width)).toBe(8);
	await terminal.runCommand(`node -e "console.log(['ash','command-success'].join('-'))"`);
	await expect(instance.locator('.ash-terminal-command-status.succeeded')).toBeVisible();
	await terminal.runCommand('node -e "process.exit(7)"');
	await expect(instance.getByRole('img', { name: 'Command failed with exit code 7', exact: true })).toBeVisible();
	const ruler = instance.locator('canvas.xterm-decoration-overview-ruler');
	await expect(ruler).toBeVisible();
	await expect.poll(() => ruler.evaluate(canvas => {
		const target = canvas as HTMLCanvasElement;
		const failed = target.closest('.ash-terminal-instance')!.querySelector('.ash-terminal-command-status.failed')!;
		const color = getComputedStyle(failed).color.match(/\d+/g)!.slice(0, 3).map(Number);
		const pixels = target.getContext('2d')!.getImageData(0, 0, target.width, target.height).data;
		for (let index = 0; index < pixels.length; index += 4) {
			if (pixels[index] === color[0] && pixels[index + 1] === color[1] && pixels[index + 2] === color[2]
				&& pixels[index + 3]! > 0 && index / 4 % target.width >= target.width / 2) return true;
		}
		return false;
	})).toBe(true);
	await expect(instance.locator('.ash-terminal-command-status.pending')).toBeVisible();
	await workbench.page.getByRole('button', { name: 'New Terminal', exact: true }).click();
	await expect(terminal.tabs).toHaveCount(2);
	await terminal.tabs.nth(0).click();
	await workbench.page.locator('.ash-workbench-panel').screenshot({ path: testInfo.outputPath('terminal-presentation.png') });
});

test('terminal split row icons create panes whose keyboard focus and input stay independent', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, driver }) => {
	const page = workbench.page;
	await workbench.terminal.show();
	await page.locator('.ash-terminal-title-toolbar').getByRole('button', { name: 'Split Terminal', exact: true }).click();
	const panes = page.locator('.ash-terminal-group-pane:visible');
	await expect(panes).toHaveCount(2);
	await expect(panes.nth(1).locator('.xterm-helper-textarea')).toBeFocused();
	const firstRow = workbench.terminal.tabs.nth(0).locator('..');
	await firstRow.hover();
	const split = firstRow.getByRole('button', { name: 'Split Terminal', exact: true });
	await expect(split.locator('svg')).toBeVisible();
	await split.click();
	await expect(panes).toHaveCount(3);
	await expect(workbench.terminal.tabs.locator('.ash-terminal-group-branch')).toHaveText(['┌', '├', '└']);
	await expect(workbench.terminal.tabs.nth(1)).toHaveAttribute('aria-description', 'Split 2 of 3 in terminal group 1');
	await expect(panes.nth(2).locator('.xterm-helper-textarea')).toBeFocused();
	await panes.nth(0).locator('.xterm-screen').click({ position: { x: 20, y: 20 } });
	await expect(panes.nth(0).locator('.xterm-helper-textarea')).toBeFocused();
	for (const index of [1, 2, 0]) {
		await page.keyboard.press('ControlOrMeta+Alt+ArrowRight');
		await expect(panes.nth(index).locator('.xterm-helper-textarea')).toBeFocused();
		await page.keyboard.type(`echo pane-${index}-ready`);
		await page.keyboard.press('Enter');
		await expect(panes.nth(index).locator('.xterm-rows > div').filter({ hasText: new RegExp(`^pane-${index}-ready\\s*$`) })).toBeVisible();
		for (const other of [0, 1, 2].filter(other => other !== index)) {
			await expect(panes.nth(other).locator('.xterm-rows')).not.toContainText(`pane-${index}-ready`);
		}
	}
	await page.keyboard.press('ControlOrMeta+Alt+ArrowLeft');
	await expect(panes.nth(2).locator('.xterm-helper-textarea')).toBeFocused();
	const sash = page.locator('.ash-terminal-group:visible > .ash-sash').first();
	const bounds = await sash.boundingBox();
	expect(bounds).not.toBeNull();
	const x = bounds!.x + bounds!.width / 2;
	const y = bounds!.y + bounds!.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + 30, y, { steps: 10 });
	await page.mouse.up();
	const screensFit = () => panes.evaluateAll(elements => elements.every(element => {
		const pane = element.getBoundingClientRect();
		const screen = element.querySelector('.xterm-screen')!.getBoundingClientRect();
		return screen.width > 0 && screen.height > 0 && screen.right <= pane.right + 1 && screen.bottom <= pane.bottom + 1;
	}));
	await expect.poll(screensFit).toBe(true);
	await expect(panes.nth(2).locator('.xterm-helper-textarea')).toBeFocused();
	await driver.setWindowSize({ width: 1200, height: 700 });
	await expect.poll(screensFit).toBe(true);
	await expect(panes.nth(2).locator('.xterm-helper-textarea')).toBeFocused();
	await page.keyboard.type('echo after-resize');
	await page.keyboard.press('Enter');
	await expect(panes.nth(2).locator('.xterm-rows > div').filter({ hasText: /^after-resize\s*$/ })).toBeVisible();
});

test('terminal panel reopening retains split output, pending input, focus and column widths', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench }) => {
	const page = workbench.page;
	await workbench.terminal.show();
	const split = page.locator('.ash-terminal-title-toolbar').getByRole('button', { name: 'Split Terminal', exact: true });
	await split.click();
	await split.click();
	const panes = page.locator('.ash-terminal-group-pane:visible');
	await expect(panes).toHaveCount(3);
	const paneIds = await panes.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.instanceId!));
	const widths = () => panes.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
	for (const index of [0, 1, 2]) {
		await panes.nth(index).locator('.xterm-screen').click({ position: { x: 12, y: 12 } });
		await page.keyboard.type(`printf 'retained-%s\\n' ${index}`);
		await page.keyboard.press('Enter');
		await expect(panes.nth(index).locator('.xterm-rows > div').filter({ hasText: new RegExp(`^retained-${index}\\s*$`) })).toBeVisible();
	}
	const before = await widths();
	for (const [cycle, index] of [1, 0].entries()) {
		await panes.nth(index).locator('.xterm-screen').click({ position: { x: 12, y: 12 } });
		await page.keyboard.type('echo pending-');
		if (cycle === 0) await page.getByRole('button', { name: 'Close Panel', exact: true }).click();
		else await page.getByRole('button', { name: 'Hide Panel', exact: true }).click();
		await expect(panes).toHaveCount(0);
		await page.getByRole('button', { name: 'Toggle Panel Visibility', exact: true }).click();
		await expect(panes).toHaveCount(3);
		await expect.poll(widths).toEqual(before);
		await expect.poll(() => panes.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.instanceId))).toEqual(paneIds);
		await expect(panes.nth(index).locator('.xterm-helper-textarea')).toBeFocused();
		await page.keyboard.type(String(cycle));
		await page.keyboard.press('Enter');
		await expect(panes.nth(index).locator('.xterm-rows > div').filter({ hasText: new RegExp(`^pending-${cycle}\\s*$`) })).toBeVisible();
		for (const other of [0, 1, 2]) {
			// Long shell prompts can scroll earlier output beyond the rendered rows.
			await panes.nth(other).locator('.xterm-screen').click({ position: { x: 12, y: 12 } });
			await page.keyboard.press('ControlOrMeta+f');
			const find = panes.nth(other).getByRole('region', { name: 'Find in terminal' });
			const input = find.getByRole('textbox', { name: 'Find', exact: true });
			await input.fill(`retained-${other}`);
			await expect(find.getByRole('status')).toHaveText('1 of 1');
			if (other !== index) {
				await input.fill(`pending-${cycle}`);
				await expect(find.getByRole('status')).toHaveText('No results');
			}
			await input.press('Escape');
		}
	}
});

test('closing inactive and active terminal splits restores input to the surviving pane', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench }) => {
	const page = workbench.page;
	await workbench.terminal.show();
	const toolbar = page.locator('.ash-terminal-title-toolbar');
	await toolbar.getByRole('button', { name: 'Split Terminal', exact: true }).click();
	await toolbar.getByRole('button', { name: 'Split Terminal', exact: true }).click();
	const panes = page.locator('.ash-terminal-group-pane:visible');
	await expect(panes).toHaveCount(3);
	const survivorId = await panes.nth(2).getAttribute('data-instance-id');
	const survivor = page.locator(`.ash-terminal-group-pane[data-instance-id="${survivorId}"]`);
	await expect(survivor.locator('.xterm-helper-textarea')).toBeFocused();
	const inactiveRow = workbench.terminal.tabs.nth(0).locator('..');
	await inactiveRow.hover();
	await inactiveRow.locator('.ash-tab-primary-action button').click();
	await expect(panes).toHaveCount(2);
	await expect(survivor.locator('.xterm-helper-textarea')).toBeFocused();
	await expect(workbench.terminal.tabs.locator('.ash-terminal-group-branch')).toHaveText(['┌', '└']);
	await page.keyboard.type('echo inactive-closed');
	await page.keyboard.press('Enter');
	await expect(survivor.locator('.xterm-rows > div').filter({ hasText: /^inactive-closed\s*$/ })).toBeVisible();
	await toolbar.getByRole('button', { name: 'Kill Terminal', exact: true }).click();
	await expect(survivor).toHaveCount(0);
	await expect(panes).toHaveCount(1);
	await expect(workbench.terminal.tabs.locator('.ash-terminal-group-branch:visible')).toHaveCount(0);
	await expect(panes.locator('.xterm-helper-textarea')).toBeFocused();
	await page.keyboard.type('echo active-closed');
	await page.keyboard.press('Enter');
	await expect(panes.locator('.xterm-rows > div').filter({ hasText: /^active-closed\s*$/ })).toBeVisible();
});

test('terminal title toolbar uses shell names, preserves renamed text and splits the current shell', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, workbench }, testInfo) => {
	const page = workbench.page;
	await workbench.terminal.show();
	const toolbar = page.locator('.ash-terminal-title-toolbar');
	await expect(toolbar.locator('.ash-dropdown-with-primary-dropdown .ash-dropdown-menu-indicator')).toBeVisible();
	const title = toolbar.locator('.ash-terminal-active-action button');
	await expect(title).toBeVisible();
	const shellName = (await title.textContent())!.trim();
	expect(shellName).toBe(shellName.toLowerCase());
	await workbench.menus.select(application, () => title.click(), ['Rename Terminal']);
	const input = page.getByPlaceholder('Enter a terminal name; leave empty to restore the shell name', { exact: true });
	await expect(input).toBeFocused();
	await input.fill('Build Shell');
	await input.press('Enter');
	await expect(title).toHaveText('Build Shell');
	await expect(workbench.terminal.activeInstance.locator('.xterm-helper-textarea')).toBeFocused();
	await page.screenshot({ path: testInfo.outputPath('terminal-title-toolbar.png') });
	await toolbar.getByRole('button', { name: 'New Terminal', exact: true }).click({ modifiers: ['Alt'] });
	await expect(page.locator('.ash-terminal-group-pane:visible')).toHaveCount(2);
	await expect(title).toBeVisible();
	await expect(toolbar.getByRole('button', { name: 'Split Terminal', exact: true })).toBeVisible();
	await toolbar.getByRole('button', { name: 'Kill Terminal', exact: true }).click();
	await expect(workbench.terminal.instances).toHaveCount(1);
	await expect(title).toHaveText('Build Shell');
});

for (const locale of ['en', 'zh-CN'] as const) test.describe(`terminal close protection and reload (${locale})`, () => {
	test.use({ electronUserSettings: { 'terminal.integrated.confirmOnKill': 'always', 'terminal.integrated.confirmOnExit': 'always', 'workbench.locale': locale } });

	test('canceling pane and window close preserves the process, output and input focus', { tag: ['@electron-app-server'] }, async ({ workbench, application, testWorkspace }) => {
		const page = workbench.page;
		const zh = locale === 'zh-CN';
		await page.getByRole('button', { name: zh ? '切换面板显示' : 'Toggle Panel Visibility', exact: true }).click();
		const pane = page.locator('.ash-terminal-group-pane:visible');
		const input = pane.locator('.xterm-helper-textarea');
		const statePath = join(testWorkspace.directory, 'close-child.json');
		await writeFile(join(testWorkspace.directory, 'close-child.cjs'), `const fs = require('fs'); let count = 0; setInterval(() => { fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ pid: process.pid, shell: process.ppid, count: ++count })); console.log('CLOSE-LIVE:' + count); }, 100);`);
		await input.focus();
		await input.pressSequentially('node close-child.cjs');
		await input.press('Enter');
		await expect(pane.locator('.xterm-rows')).toContainText('CLOSE-LIVE:');
		const before = JSON.parse(await readFile(statePath, 'utf8'));
		const id = await pane.getAttribute('data-instance-id');
		const message = await workbench.dialogs.confirm(application, zh ? '确认' : 'Confirm', zh ? '取消' : 'Cancel', () => page.locator('.ash-terminal-title-toolbar').getByRole('button', { name: zh ? '终止终端' : 'Kill Terminal', exact: true }).click());
		expect(message.message).toContain(zh ? '正在运行的进程' : 'running processes');
		await expect(input).toBeFocused();
		await expect(pane).toHaveAttribute('data-instance-id', id!);
		await expect.poll(async () => JSON.parse(await readFile(statePath, 'utf8')).count).toBeGreaterThan(before.count);
		if (!('windows' in application)) throw new Error('Desktop application is required');
		const window = await application.browserWindow(page);
		await workbench.dialogs.confirm(application, zh ? '确认' : 'Confirm', zh ? '取消' : 'Cancel', () => window.evaluate(window => window.close()));
		await expect(input).toBeFocused();
		await expect(page.locator('body')).toHaveJSProperty('inert', false);
		const after = JSON.parse(await readFile(statePath, 'utf8'));
		expect([after.pid, after.shell]).toEqual([before.pid, before.shell]);
		process.kill(before.pid, 0);
		await input.press('Control+c');
		await input.pressSequentially("printf 'CLOSE_%s\\n' RESUMED");
		await input.press('Enter');
		await expect(pane.locator('.xterm-rows > div').filter({ hasText: /^CLOSE_RESUMED\s*$/u })).toBeVisible();
		await page.locator('.ash-terminal-title-toolbar').getByRole('button', { name: zh ? '终止终端' : 'Kill Terminal', exact: true }).click();
		await expect(pane).toHaveCount(0);
	});

	test('reload retains original processes, output, split widths, pending input and focused pane', { tag: ['@electron-app-server'] }, async ({ workbench, testWorkspace, driver }, testInfo) => {
		test.setTimeout(90000);
		const page = workbench.page;
		const zh = locale === 'zh-CN';
		await page.getByRole('button', { name: zh ? '切换面板显示' : 'Toggle Panel Visibility', exact: true }).click();
		const split = page.locator('.ash-terminal-title-toolbar').getByRole('button', { name: zh ? '拆分终端' : 'Split Terminal', exact: true });
		await split.click();
		await split.click();
		const panes = page.locator('.ash-terminal-group-pane:visible');
		await expect(panes).toHaveCount(3);
		await writeFile(join(testWorkspace.directory, 'reload-child.cjs'), `const fs = require('fs'); const id = process.argv[2]; let count = 0; console.log('HISTORY:' + id); setInterval(() => { fs.writeFileSync('reload-' + id + '.json', JSON.stringify({ pid: process.pid, shell: process.ppid, count: ++count })); console.log('LIVE:' + id + ':' + count); }, 200);`);
		for (const index of [0, 1]) {
			const input = panes.nth(index).locator('.xterm-helper-textarea');
			await input.focus();
			await input.pressSequentially(`node reload-child.cjs ${index}`);
			await input.press('Enter');
			await expect(panes.nth(index).locator('.xterm-rows')).toContainText(`LIVE:${index}:`);
		}
		const third = panes.nth(2).locator('.xterm-helper-textarea');
		await third.focus();
		await third.pressSequentially("printf 'PENDING_%s\\n' ");
		const sash = page.locator('.ash-terminal-group:visible > .ash-sash').first();
		const bounds = (await sash.boundingBox())!;
		await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
		await page.mouse.down();
		await page.mouse.move(bounds.x + 55, bounds.y + bounds.height / 2, { steps: 6 });
		await page.mouse.up();
		await expect(third).toBeFocused();
		const widths = () => panes.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
		const beforeWidths = await widths();
		const ids = await panes.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.instanceId));
		const before = await Promise.all([0, 1].map(async index => JSON.parse(await readFile(join(testWorkspace.directory, `reload-${index}.json`), 'utf8'))));
		for (const method of ['command', 'refresh'] as const) {
			const loaded = page.waitForEvent('domcontentloaded');
			if (method === 'command') await workbench.quickaccess.runCommand('workbench.action.reloadWindow');
			else await page.evaluate(() => { window.location.reload(); });
			await loaded;
			await workbench.waitForReady();
			await expect(panes).toHaveCount(3);
			await expect.poll(() => panes.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.instanceId))).toEqual(ids);
			await expect.poll(async () => (await widths()).map((width, index) => Math.abs(width - beforeWidths[index]!)).every(delta => delta <= 2)).toBe(true);
			await expect(third).toBeFocused();
			for (const index of [0, 1]) {
				const state = JSON.parse(await readFile(join(testWorkspace.directory, `reload-${index}.json`), 'utf8'));
				expect([state.pid, state.shell]).toEqual([before[index].pid, before[index].shell]);
				await expect.poll(async () => JSON.parse(await readFile(join(testWorkspace.directory, `reload-${index}.json`), 'utf8')).count).toBeGreaterThan(state.count);
				await expect(panes.nth(index).locator('.xterm-rows')).toContainText(`LIVE:${index}:`);
			}
			await expect(panes.nth(2).locator('.xterm-rows')).toContainText('PENDING_');
			const screenshotPath = testInfo.outputPath(`reload-${method}-${locale}.png`);
			await page.screenshot({ path: screenshotPath });
			await testInfo.attach(`reload-${method}-${locale}`, { path: screenshotPath, contentType: 'image/png' });
		}
		await third.pressSequentially('OK');
		await third.press('Enter');
		await expect(panes.nth(2).locator('.xterm-rows > div').filter({ hasText: /^PENDING_OK\s*$/u })).toBeVisible();
		for (const index of [0, 1]) {
			const input = panes.nth(index).locator('.xterm-helper-textarea');
			await input.focus();
			await input.press('Control+c');
			await input.pressSequentially(`printf 'AFTER_%s\\n' ${index}`);
			await input.press('Enter');
			await expect(panes.nth(index).locator('.xterm-rows > div').filter({ hasText: new RegExp(`^AFTER_${index}\\s*$`, 'u') })).toBeVisible();
			await input.press('Alt+F2');
			const accessible = page.locator('.ash-accessible-view-content');
			await expect(accessible).toBeFocused();
			const history = await accessible.inputValue();
			await writeFile(testInfo.outputPath(`terminal-history-${index}.txt`), history);
			expect(history).toContain(`HISTORY:${index}`);
			const sequences = [...history.matchAll(new RegExp(`^LIVE:${index}:(\\d+)$`, 'gmu'))].map(match => Number(match[1]));
			expect(sequences.length).toBeGreaterThan(before[index].count);
			expect(sequences.findIndex((sequence, offset) => sequence !== offset + 1), 'Reload must retain the complete numbered stream without gaps or duplicates').toBe(-1);
			await accessible.press('Escape');
			await expect(input).toBeFocused();
		}
		expect(driver.diagnostics.errors).toEqual([]);
		for (const remaining of [2, 1, 0]) {
			await page.locator('.ash-terminal-title-toolbar').getByRole('button', { name: zh ? '终止终端' : 'Kill Terminal', exact: true }).click();
			await expect(panes).toHaveCount(remaining);
		}
	});
});
