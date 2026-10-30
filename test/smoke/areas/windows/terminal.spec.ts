import { readFile, writeFile, mkdir, unlink, rmdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import type { Locator } from '@playwright/test';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { readUserSettings, writeUserSettings } from '../../../automation/settings.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { appServerDaemonExecutablePath, appServerExecutablePath } from '../../../../src/ash/platform/app-server-daemon/node/appServerDaemonPackage.js';

const windowsPowerShellSettings = process.platform === 'win32' ? {
	'terminal.integrated.profiles.windows': {
		'Smoke PowerShell': {
			path: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
			args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'RemoteSigned'],
		},
	},
	// A runner launched from PowerShell 7 can otherwise inject incompatible core
	// modules into Windows PowerShell 5.1. Let the child build its own module path.
	'terminal.integrated.env.windows': { PSModulePath: null },
	'terminal.integrated.defaultProfile.windows': 'Smoke PowerShell',
} : {};
test.use({ electronUserSettings: windowsPowerShellSettings });

for (const locale of ['en', 'zh-CN'] as const) test.describe(`terminal profile dropdown (${locale})`, () => {
	const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
	const shell = process.platform === 'win32' ? {
		path: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
		args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'RemoteSigned'],
	} : {
		path: '/bin/bash',
		// Skip user startup files while allowing Ash's injected shell integration.
		args: ['--login', '--noprofile'],
	};
	test.use({
		electronUserSettings: {
			...windowsPowerShellSettings,
			'workbench.locale': locale,
			'window.menuStyle': 'custom',
			[`terminal.integrated.profiles.${platform}`]: { 'Smoke Shell': shell, 'Copilot Test CLI': shell, 'Claude Test CLI': shell },
			[`terminal.integrated.defaultProfile.${platform}`]: 'Smoke Shell',
			[`terminal.integrated.agentHostProfile.${platform}`]: { ...shell, env: { ASH_AGENT_PROFILE: 'agent-shell' } },
		}
	});

	test('keeps configured profiles together and launches the agent host shell from the keyboard menu', { tag: ['@electron-app-server'] }, async ({ workbench, testWorkspace, driver }, testInfo) => {
		const page = workbench.page;
		const zh = locale === 'zh-CN';
		await workbench.quickaccess.runCommand('workbench.action.terminal.focus');
		await expect(workbench.terminal.activeInstance.locator('.ash-terminal-command-status.pending')).toBeVisible();
		const trigger = page.locator('.ash-terminal-title-toolbar .ash-dropdown-with-primary-dropdown button');
		await trigger.focus();
		await trigger.press('ArrowDown');
		const menu = page.getByRole('menu');
		await expect(menu.getByRole('menuitem', { name: 'Copilot Test CLI', exact: true })).toBeVisible();
		const entries = await menu.locator('[role="menuitem"], [role="separator"]').evaluateAll(rows => rows.map(row => ({
			role: row.getAttribute('role'), label: row.getAttribute('aria-label') ?? row.textContent?.trim(),
		})));
		const shellIndex = entries.findIndex(entry => entry.label?.startsWith('Smoke Shell'));
		expect(shellIndex).toBeGreaterThanOrEqual(0);
		expect(entries.slice(shellIndex + 1, shellIndex + 3)).toEqual([
			{ role: 'menuitem', label: 'Copilot Test CLI' },
			{ role: 'menuitem', label: 'Claude Test CLI' },
		]);
		await page.keyboard.press('Escape');
		await expect(trigger).toBeFocused();
		await trigger.press('ArrowDown');
		const agent = menu.getByRole('menuitem', { name: zh ? '智能体主机（本地）' : 'Agent Host (Local)', exact: true });
		await agent.focus();
		await page.screenshot({ path: testInfo.outputPath(`terminal-profiles-${locale}.png`) });
		await agent.press('Enter');
		await expect(menu).toHaveCount(0);
		await expect(workbench.terminal.instances).toHaveCount(2);
		await expect(workbench.terminal.activeInstance.locator('.xterm-helper-textarea')).toBeFocused();
		await workbench.terminal.runCommand("node -e \"require('fs').writeFileSync('agent-profile.txt', process.env.ASH_AGENT_PROFILE)\"");
		await expect.poll(() => readFile(join(testWorkspace.directory, 'agent-profile.txt'), 'utf8').catch(() => '')).toBe('agent-shell');
		expect(driver.diagnostics.errors).toEqual([]);
	});
});

test('installed WSL distributions appear as distinct profiles and launch their own shell', { tag: ['@electron-app-server'] }, async ({ workbench }) => {
	test.skip(process.platform !== 'win32', 'WSL discovery is Windows-only');
	const launcher = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
	const distributions = execFileSync(launcher, ['--list', '--quiet'], {
		encoding: 'utf16le', windowsHide: true, timeout: 5000, env: { ...process.env, WSL_UTF8: '0' },
	}).split(/\r?\n/).map(name => name.trim()).filter(Boolean);
	test.skip(distributions.length === 0, 'No WSL distributions installed');
	await workbench.terminal.show();
	const trigger = workbench.page.locator('.ash-terminal-title-toolbar .ash-dropdown-with-primary-dropdown button');
	await trigger.click();
	const menu = workbench.page.getByRole('menu');
	for (const distribution of distributions) {
		await expect(menu.getByRole('menuitem', { name: `${distribution} (WSL)`, exact: true })).toBeVisible();
	}
	await menu.getByRole('menuitem', { name: `${distributions[0]} (WSL)`, exact: true }).click();
	await expect(workbench.terminal.instances).toHaveCount(2);
	// A newly installed distribution may provision its user before accepting input.
	await expect(workbench.terminal.activeInstance.locator('.xterm-rows')).toContainText(/[$#%>❯]\s*$/u, { timeout: 30000 });
	await workbench.terminal.runCommand('printf "ASH_WSL_PROFILE:%s\\n" "$WSL_DISTRO_NAME"');
	await expect(workbench.terminal.activeInstance.locator('.xterm-rows > div').filter({ hasText: `ASH_WSL_PROFILE:${distributions[0]}` })).toBeVisible();
});

for (const locale of ['en', 'zh-CN'] as const) test.describe(`independent terminal host (${locale})`, () => {

	test.use({ electronUserSettings: { ...windowsPowerShellSettings, 'workbench.locale': locale, 'terminal.integrated.confirmOnKill': 'never', 'terminal.integrated.confirmOnExit': 'never' } });

	test('a failed PTY host retains the screen and explicit relaunch starts a fresh shell without restarting App Server', { tag: ['@electron-app-server'] }, async ({ application, workbench, testWorkspace }, testInfo) => {
		if (!('windows' in application)) throw new Error('Expected Electron');
		const zh = locale === 'zh-CN';
		const exec = promisify(execFile);
		const location = { appPath: resolve(import.meta.dirname, '../../../..'), isPackaged: false, platform: process.platform, resourcesPath: '' };
		const profile = await application.evaluate(() => process.env.ASH_HOME!);
		const env = { ...process.env, ASH_HOME: profile, ASH_APP_SERVER_PATH: appServerExecutablePath(location), ASH_ELECTRON_RUN_AS_NODE_PATH: await application.evaluate(() => process.execPath) };
		const backend = async () => JSON.parse((await exec(appServerDaemonExecutablePath(location), ['version'], { env, timeout: 15_000 })).stdout) as { pid: number; };
		await writeFile(join(testWorkspace.directory, 'owner-once.cjs'), `const fs=require('fs');fs.appendFileSync('owner-executions.txt','once');fs.writeFileSync('owner-process.json',JSON.stringify({pid:process.pid,shell:process.ppid}));console.log('OWNER_COMMAND_RUNNING');setInterval(()=>{},1000);`);
		await workbench.page.getByRole('button', { name: zh ? '切换面板显示' : 'Toggle Panel Visibility', exact: true }).click();
		const pane = workbench.page.locator('.ash-terminal-group-pane:visible');
		const input = pane.locator('.xterm-helper-textarea');
		await input.focus();
		await input.pressSequentially('node owner-once.cjs');
		await input.press('Enter');
		await expect(pane.locator('.xterm-rows')).toContainText('OWNER_COMMAND_RUNNING');
		const child = JSON.parse(await readFile(join(testWorkspace.directory, 'owner-process.json'), 'utf8')) as { pid: number; shell: number; };
		const owner = (await terminalProcessInfo(child.shell)).parent;
		expect(owner).toBeGreaterThan(0);
		expect((await terminalProcessInfo(owner)).command).toContain(' --terminal-host ');
		const original = await backend();
		expect(owner).not.toBe(original.pid);
		const instanceId = await pane.getAttribute('data-instance-id');
		process.kill(owner, 'SIGKILL');
		await expect(pane.locator('.ash-terminal-instance')).toHaveAttribute('data-state', 'error');
		await expect(pane.locator('.xterm-rows')).toContainText('OWNER_COMMAND_RUNNING');
		await expect.poll(() => { try { process.kill(child.pid, 0); return true; } catch { return false; } }).toBe(false);
		await workbench.menus.select(application, () => workbench.page.locator('.ash-terminal-active-action button').click(), [zh ? '重新启动终端' : 'Relaunch Terminal']);
		await expect(pane.locator('.ash-terminal-instance')).toHaveAttribute('data-state', 'running');
		await expect(pane).toHaveAttribute('data-instance-id', instanceId!);
		await input.focus();
		await input.pressSequentially('echo HOST_OWNER_RELAUNCH_OK');
		await input.press('Enter');
		await expect(pane.locator('.xterm-rows > div').filter({ hasText: /^HOST_OWNER_RELAUNCH_OK\s*$/u })).toBeVisible();
		expect(await readFile(join(testWorkspace.directory, 'owner-executions.txt'), 'utf8')).toBe('once');
		expect((await backend()).pid).toBe(original.pid);
		await workbench.page.screenshot({ path: testInfo.outputPath(`terminal-host-relaunched-${locale}.png`) });
		await workbench.page.locator('.ash-terminal-title-toolbar').getByRole('button', { name: zh ? '终止终端' : 'Kill Terminal', exact: true }).click();
		await expect(pane).toHaveCount(0);
	});

	test('running commands survive an App Server crash, prolonged outage and graceful restart without replay', { tag: ['@electron-app-server'] }, async ({ application, workbench, testWorkspace }, testInfo) => {
		test.setTimeout(150_000);
		if (!('windows' in application)) throw new Error('Expected Electron');
		const location = { appPath: resolve(import.meta.dirname, '../../../..'), isPackaged: false, platform: process.platform, resourcesPath: '' };
		const profile = await application.evaluate(() => process.env.ASH_HOME!);
		const env = { ...process.env, ASH_HOME: profile, ASH_APP_SERVER_PATH: appServerExecutablePath(location), ASH_ELECTRON_RUN_AS_NODE_PATH: await application.evaluate(() => process.execPath) };
		const daemon = appServerDaemonExecutablePath(location);
		const control = async (command: string) => JSON.parse((await promisify(execFile)(daemon, [command], { env, timeout: 30_000, windowsHide: true })).stdout) as { pid: number; instanceId: string; endpointPath: string; };
		const state = (index: number): Promise<{ pid: number; shell: number; count: number; }> => readTerminalHeartbeat(join(testWorkspace.directory, `host-live-${index}.jsonl`));
		await writeFile(join(testWorkspace.directory, 'host-live.cjs'), `const fs = require('fs'); const id = process.argv[2]; let count = 0; fs.appendFileSync('host-executions.txt', id + String.fromCharCode(10)); setInterval(() => { fs.appendFileSync('host-live-' + id + '.jsonl', JSON.stringify({pid:process.pid,shell:process.ppid,count:++count})+String.fromCharCode(10)); console.log('HOST-LIVE:' + id + ':' + count); if(fs.existsSync('host-flood-'+id)) { fs.unlinkSync('host-flood-'+id); process.stdout.write('x'.repeat(2*1024*1024)+String.fromCharCode(10),()=>fs.writeFileSync('host-flood-drained-'+id,'done')); } }, 100);`);
		await workbench.page.getByRole('button', { name: locale === 'zh-CN' ? '切换面板显示' : 'Toggle Panel Visibility', exact: true }).click();
		const panes = workbench.page.locator('.ash-terminal-group-pane:visible');
		for (let index = 0; index < 2; index++) {
			if (index) await workbench.quickaccess.runCommand('workbench.action.terminal.split');
			await expect(panes).toHaveCount(index + 1);
			const input = panes.nth(index).locator('.xterm-helper-textarea');
			await input.focus();
			await input.pressSequentially(`node host-live.cjs ${index}`);
			await input.press('Enter');
			await expect(panes.nth(index).locator('.xterm-rows')).toContainText(`HOST-LIVE:${index}:`);
		}
		const before = await Promise.all([state(0), state(1)]);
		const ids = await panes.evaluateAll(elements => elements.map(element => element.getAttribute('data-instance-id')));
		await workbench.page.locator('body').evaluate(element => element.dataset.terminalHostRetention = 'same-renderer');
		const generations: unknown[] = [];
		for (const mode of ['crash', 'prolonged-outage', 'restart'] as const) {
			const old = await control('version');
			expect(old.pid).toBeGreaterThan(0);
			const counts = await Promise.all([state(0), state(1)]);
			let duringOutage: typeof before | undefined;
			let outageMillis: number | undefined;
			if (mode === 'prolonged-outage') {
				// Hold the real profile lifecycle gate with a live heartbeat. All
				// carriers must wait here, including replacement acquisition attempts.
				expect(old.endpointPath).toMatch(/\.sock$/u);
				const operationLock = old.endpointPath.replace(/\.sock$/u, '.operation');
				await mkdir(operationLock, { mode: 0o700 });
				const heartbeatFile = join(operationLock, 'heartbeat');
				await writeFile(heartbeatFile, 'terminal outage fixture');
				let heartbeat = Promise.resolve();
				const timer = setInterval(() => { heartbeat = heartbeat.then(() => writeFile(heartbeatFile, 'terminal outage fixture')); }, 1_000);
				try {
					process.kill(old.pid, 'SIGKILL');
					const disconnectedAt = performance.now();
					await expect(panes.first().locator('.ash-terminal-instance')).toHaveAttribute('data-state', 'reconnecting');
					await Promise.all([0, 1].map(index => writeFile(join(testWorkspace.directory, `host-flood-${index}`), 'go')));
					for (const index of [0, 1]) await expect.poll(() => readFile(join(testWorkspace.directory, `host-flood-drained-${index}`), 'utf8').catch(() => ''), { timeout: 10_000 }).toBe('done');
					await expect.poll(async () => {
						const current = await Promise.all([state(0), state(1)]);
						for (const [index, process] of current.entries()) expect([process.pid, process.shell]).toEqual([before[index]!.pid, before[index]!.shell]);
						return performance.now() - disconnectedAt >= 35_000 && current.every((process, index) => process.count > counts[index]!.count + 300);
					}, { timeout: 45_000, intervals: [1_000] }).toBe(true);
					duringOutage = await Promise.all([state(0), state(1)]);
					outageMillis = performance.now() - disconnectedAt;
				} finally {
					clearInterval(timer);
					await heartbeat;
					await unlink(heartbeatFile);
					await rmdir(operationLock);
				}
			} else if (mode === 'crash') {
				if (process.platform !== 'win32') {
					// Prove progress while the business backend cannot service any IO.
					process.kill(old.pid, 'SIGSTOP');
					try {
						for (let index = 0; index < 2; index++) await expect.poll(async () => (await state(index)).count).toBeGreaterThan(counts[index]!.count + 3);
						duringOutage = await Promise.all([state(0), state(1)]);
					} finally { process.kill(old.pid, 'SIGKILL'); }
				} else process.kill(old.pid, 'SIGKILL');
				await expect(panes.first().locator('.ash-terminal-instance')).toHaveAttribute('data-state', 'reconnecting');
			} else {
				await Promise.all([
					control('restart'),
					expect(panes.first().locator('.ash-terminal-instance')).toHaveAttribute('data-state', 'reconnecting'),
				]);
			}
			await expect.poll(async () => { try { const pid = (await control('version')).pid; return pid > 0 ? pid : old.pid; } catch { return old.pid; } }, { timeout: 30_000 }).not.toBe(old.pid);
			for (let index = 0; index < 2; index++) {
				await expect(panes.nth(index).locator('.ash-terminal-instance')).toHaveAttribute('data-state', 'running');
				await expect.poll(async () => { try { return (await state(index)).count; } catch { return 0; } }).toBeGreaterThan(counts[index]!.count + 3);
				const after = await state(index);
				expect([after.pid, after.shell]).toEqual([before[index]!.pid, before[index]!.shell]);
				process.kill(after.pid, 0);
				// Recovery can replay more output than fits in the visible screen.
				// Assert a live counter beyond the outage, not one already scrolled away.
				await expect.poll(async () => {
					const output = await panes.nth(index).locator('.xterm-rows').textContent();
					return Math.max(0, ...[...(output ?? '').matchAll(new RegExp(`HOST-LIVE:${index}:(\\d+)`, 'gu'))].map(match => Number(match[1])));
				}).toBeGreaterThan(counts[index]!.count + 3);
			}
			generations.push({ mode, duringOutage, outageMillis, backend: await control('version'), processes: await Promise.all([state(0), state(1)]) });
		}
		expect(await panes.evaluateAll(elements => elements.map(element => element.getAttribute('data-instance-id')))).toEqual(ids);
		await expect(workbench.page.locator('body')).toHaveAttribute('data-terminal-host-retention', 'same-renderer');
		expect(await readFile(join(testWorkspace.directory, 'host-executions.txt'), 'utf8')).toBe('0\n1\n');
		for (let index = 0; index < 2; index++) {
			const pane = panes.nth(index);
			const input = pane.locator('.xterm-helper-textarea');
			await input.focus();
			await input.press('Control+c');
			await expect.poll(() => { try { process.kill(before[index]!.pid, 0); return true; } catch { return false; } }).toBe(false);
			await expect(pane.locator('.ash-terminal-command-status.pending')).toBeVisible();
			await input.pressSequentially(`echo HOST_INPUT_OK_${index}`);
			await input.press('Enter');
			await expect(pane.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^HOST_INPUT_OK_${index}\\s*$`, 'u') })).toBeVisible();
		}
		await testInfo.attach('backend-and-process-identities', { body: JSON.stringify({ before, generations }, null, 2), contentType: 'application/json' });
		await workbench.page.screenshot({ path: testInfo.outputPath(`terminal-host-retained-${locale}.png`) });
		for (const count of [1, 0]) {
			await workbench.page.locator('.ash-terminal-title-toolbar').getByRole('button', { name: locale === 'zh-CN' ? '终止终端' : 'Kill Terminal', exact: true }).click();
			await expect(panes).toHaveCount(count);
		}
		for (const child of before) await expect.poll(() => { try { process.kill(child.shell, 0); return true; } catch { return false; } }).toBe(false);
	});
});

async function revealSavedHistory(pane: Locator, text: string): Promise<void> {
	const input = pane.locator('.xterm-helper-textarea');
	await input.focus();
	await input.press('ControlOrMeta+f');
	const find = pane.getByRole('region', { name: 'Find in terminal', exact: true });
	const query = find.getByRole('textbox', { name: 'Find', exact: true });
	await query.fill(text);
	await expect(find.getByRole('status')).toHaveText('1 of 1');
	await query.press('Escape');
	await expect(pane.locator('.xterm-rows')).toContainText(text);
}

test('terminal path commands run a literal file and reopen a recent directory in the real shell', { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ workbench, testWorkspace }) => {
	const windows = process.platform === 'win32';
	const filename = windows ? "run 'literal' file.cmd" : "run 'literal' file.sh";
	const source = windows ? '@echo off\r\n<nul set /p "=executed literal file">path-command-result.txt\r\n' : "#!/bin/sh\nprintf '%s' 'executed literal file' > path-command-result.txt\n";
	await writeFile(join(testWorkspace.directory, filename), source, { mode: 0o755 });
	const directory = join(testWorkspace.directory, "recent 'literal' directory");
	await mkdir(directory);
	const row = workbench.page.locator('.ash-explorer').getByRole('treeitem', { name: filename, exact: true });
	await expect(row).toBeVisible();
	await row.dblclick();
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await workbench.quickaccess.runCommand('workbench.action.terminal.runActiveFile');
	await expect.poll(() => readFile(join(testWorkspace.directory, 'path-command-result.txt'), 'utf8').catch(() => '')).toBe('executed literal file');
	await expect(editor.input).toBeFocused();
	await expect(workbench.terminal.instances).toHaveCount(1);
	const quote = (path: string): string => "'" + path.replaceAll("'", windows ? "''" : "'\"'\"'") + "'";
	const changeDirectory = windows ? 'Set-Location -LiteralPath' : 'cd --';
	await workbench.terminal.runCommand(`${changeDirectory} ${quote(directory)}`);
	await workbench.terminal.runCommand(`${changeDirectory} ${quote(testWorkspace.directory)}`);
	await workbench.quickaccess.runCommand('workbench.action.terminal.goToRecentDirectory');
	await expect(workbench.page.getByText(directory, { exact: true })).toBeVisible();
	await workbench.page.getByText(directory, { exact: true }).click();
	await workbench.terminal.runCommand(`node -e "require('fs').writeFileSync('path-directory-result.txt', process.cwd() + '\\n')"`);
	await expect.poll(() => readFile(join(directory, 'path-directory-result.txt'), 'utf8').catch(() => '')).toBe(directory + '\n');
	expect(await readFile(join(testWorkspace.directory, filename), 'utf8')).toBe(source);
});

for (const locale of ['en', 'zh-CN'] as const) test.describe(`terminal run selected text (${locale})`, () => {
	test.use({ electronUserSettings: { ...windowsPowerShellSettings, 'workbench.locale': locale } });

	test('runs selected text and the current line in a real shell while retaining editor focus', { tag: ['@electron-app-server'] }, async ({ workbench, testWorkspace, driver }, testInfo) => {
		const page = workbench.page;
		const zh = locale === 'zh-CN';
		const commandId = 'workbench.action.terminal.runSelectedText';
		const title = zh ? '终端：在活动终端中运行选中文本' : 'Terminal: Run Selected Text in Active Terminal';
		const output = join(testWorkspace.directory, 'selection-result.txt');
		const contents = ['selected', 'current-line'].map(value =>
			`node -e "require('fs').appendFileSync('selection-result.txt', '${value}\\n')"`
		).join('\n');
		await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorFocus();
		await editor.input.evaluate((element, text) => {
			const clipboardData = new DataTransfer();
			clipboardData.setData('text/plain', text);
			element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
		}, contents);
		await editor.waitForEditorContents(text => text === contents);
		await editor.input.press('ControlOrMeta+Home');
		await editor.input.press('Shift+End');
		await expect(workbench.terminal.instances).toHaveCount(0);
		await workbench.quickaccess.open(`>${commandId}`);
		const option = workbench.quickaccess.items.filter({ has: page.locator('.ash-quick-pick-row-description').getByText(commandId, { exact: true }) });
		await expect(option.locator('.ash-quick-pick-row-label')).toHaveText(title);
		await option.click();
		await expect.poll(() => readFile(output, 'utf8').catch(() => '')).toBe('selected\n');
		await expect(editor.input).toBeFocused();
		await expect(workbench.terminal.instances).toHaveCount(1);
		const pane = page.locator('.ash-terminal-group-pane:visible');
		const terminalId = await pane.getAttribute('data-instance-id');
		expect(terminalId).not.toBeNull();

		await editor.input.press('ArrowRight');
		await editor.input.press('ArrowDown');
		await workbench.quickaccess.runCommand(commandId);
		await expect.poll(() => readFile(output, 'utf8')).toBe('selected\ncurrent-line\n');
		await expect(editor.input).toBeFocused();
		await editor.input.press('ControlOrMeta+a');
		await workbench.quickaccess.runCommand(commandId);
		await expect.poll(() => readFile(output, 'utf8')).toBe('selected\ncurrent-line\nselected\ncurrent-line\n');
		await expect(editor.input).toBeFocused();
		await expect(workbench.terminal.instances).toHaveCount(1);
		await expect(pane).toHaveAttribute('data-instance-id', terminalId!);

		const terminalInput = workbench.terminal.instances.first().locator('.xterm-helper-textarea');
		await terminalInput.focus();
		await terminalInput.press('Alt+F1');
		const help = page.locator('.ash-accessible-view-content');
		await expect(help).toHaveValue(zh ? /没有选区时运行当前行/u : /the current line when nothing is selected/u);
		await help.press('Escape');
		await expect(terminalInput).toBeFocused();
		await testInfo.attach(`selection-output-${locale}`, { body: await readFile(output), contentType: 'text/plain' });
		await page.screenshot({ path: testInfo.outputPath(`terminal-run-selection-${locale}.png`) });
		expect(driver.diagnostics.errors).toEqual([]);
	});
});

test('terminal file links open compiler locations and directory links reveal Explorer by mouse and keyboard', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, testWorkspace }) => {
	const page = workbench.page;
	const terminal = workbench.terminal;
	const relative = 'terminal-link-fixture.ts';
	const spaced = 'terminal link fixture.ts';
	const pointerDirectory = 'terminal-link-folder';
	const keyboardDirectory = 'terminal link keyboard folder';
	const contents = Array.from({ length: 60 }, (_, index) => `// synthetic terminal link row ${index + 1}`).join('\n');
	await writeFile(join(testWorkspace.directory, relative), contents);
	await writeFile(join(testWorkspace.directory, spaced), contents);
	await mkdir(join(testWorkspace.directory, pointerDirectory));
	await mkdir(join(testWorkspace.directory, keyboardDirectory));
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
	await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Select a terminal file, folder or URL to open');
	await picker.getByRole('combobox').press('Escape');
	await expect(terminal.activeInstance.locator('.xterm-helper-textarea')).toBeFocused();
	await terminal.activeInstance.locator('.xterm-helper-textarea').press('ControlOrMeta+Shift+o');
	await workbench.quickaccess.select(`${join(testWorkspace.directory, spaced)}:18:7`);
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: spaced })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Ln 18, Col 7', exact: true })).toBeVisible();
	await expect(workbench.editors.groupAt(0).editor.input).toBeFocused();
	await expect(pane).toHaveAttribute('data-instance-id', instanceId!);
	const tabsBeforeDirectories = await workbench.editors.groupAt(0).tabs.count();
	const explorer = page.locator('.ash-explorer');
	await print(`${pointerDirectory}/`);
	const directoryRow = terminal.activeInstance.locator('.xterm-rows > div').filter({ hasText: `${pointerDirectory}/` }).last();
	await expect(directoryRow).toBeVisible();
	const directoryBounds = await directoryRow.boundingBox();
	if (!directoryBounds) throw new Error('The terminal directory link is not visible');
	await page.mouse.move(directoryBounds.x + 12, directoryBounds.y + directoryBounds.height / 2);
	await expect(terminal.activeInstance.locator('.ash-terminal-link-hover-target')).toHaveCount(1);
	await page.mouse.click(directoryBounds.x + 12, directoryBounds.y + directoryBounds.height / 2);
	await expect(explorer.getByRole('treeitem', { name: pointerDirectory, exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(explorer.locator('.ash-tree')).toBeFocused();
	await print(`"${keyboardDirectory}/"`);
	await expect.poll(async () => (await terminal.activeInstance.locator('.xterm-rows').textContent())?.replace(/\s/gu, '')).toContain(keyboardDirectory.replace(/\s/gu, '') + '/');
	await terminal.activeInstance.locator('.xterm-helper-textarea').press('ControlOrMeta+Shift+o');
	await workbench.quickaccess.select(`${keyboardDirectory}/`);
	await expect(explorer.getByRole('treeitem', { name: keyboardDirectory, exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(explorer.locator('.ash-tree')).toBeFocused();
	await expect(workbench.editors.groupAt(0).tabs).toHaveCount(tabsBeforeDirectories);
	await expect(pane).toHaveAttribute('data-instance-id', instanceId!);
	await print('terminal-link-shell-alive');
	await expect(terminal.activeInstance.locator('.xterm-rows')).toContainText('terminal-link-shell-alive');
});

test('terminal preserves every output line when the screen temporarily stops consuming', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, testWorkspace, driver }, testInfo) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	const editor = workbench.editors.groupAt(0);
	await editor.editor.input.press('ControlOrMeta+A');
	await editor.editor.input.evaluate((element, settings) => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', JSON.stringify({ ...settings, 'terminal.integrated.scrollback': 60000 }));
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	}, windowsPowerShellSettings);
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
	await expect(terminal.activeInstance.locator('.xterm-rows')).toContainText('The terminal process terminated with exit code: 17.');
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
	await expect(pending.locator('.ash-icon')).toHaveCSS('width', '16px');
	await expect(pending.locator('.ash-icon')).toHaveCSS('font-size', '16px');
	await terminal.runCommand(`node -e "console.log(['ash','command-success'].join('-'))"`);
	await expect(instance.locator('.ash-terminal-command-status.succeeded')).toBeVisible();
	await terminal.runCommand('node -e "process.exit(7)"');
	// PowerShell reports pipeline success through $?; POSIX preserves the child's exit code.
	const failedExitCode = process.platform === 'win32' ? 1 : 7;
	await expect(instance.getByRole('button', { name: `Command failed with exit code ${failedExitCode}`, exact: true })).toBeVisible();
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

test('terminal split row icons create panes whose keyboard focus and input stay independent', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, driver, testWorkspace }) => {
	const page = workbench.page;
	await workbench.terminal.show();
	await page.locator('.ash-terminal-title-toolbar').getByRole('button', { name: 'Split Terminal', exact: true }).click();
	const panes = page.locator('.ash-terminal-group-pane:visible');
	await expect(panes).toHaveCount(2);
	await expect(panes.nth(1).locator('.xterm-helper-textarea')).toBeFocused();
	const firstRow = workbench.terminal.tabs.nth(0).locator('..');
	await firstRow.hover();
	const split = firstRow.getByRole('button', { name: 'Split Terminal', exact: true });
	await expect(split.locator('.ash-icon')).toBeVisible();
	await split.click();
	await expect(panes).toHaveCount(3);
	await expect(workbench.terminal.tabs.locator('.ash-terminal-group-branch')).toHaveText(['┌', '├', '└']);
	await expect(workbench.terminal.tabs.nth(1)).toHaveAttribute('aria-description', 'Split 2 of 3 in terminal group 1');
	await expect(panes.nth(2).locator('.xterm-helper-textarea')).toBeFocused();
	await panes.nth(0).locator('.xterm-screen').click({ position: { x: 20, y: 20 } });
	await expect(panes.nth(0).locator('.xterm-helper-textarea')).toBeFocused();
	const shellPids = new Map<number, string>();
	for (const index of [1, 2, 0]) {
		await page.keyboard.press('ControlOrMeta+Alt+ArrowRight');
		await expect(panes.nth(index).locator('.xterm-helper-textarea')).toBeFocused();
		await page.keyboard.type(`node -e "require('fs').writeFileSync('pane-${index}.pid',String(process.ppid));console.log(['P',${index},'_OK'].join(''))"`);
		await page.keyboard.press('Enter');
		await expect.poll(() => readFile(join(testWorkspace.directory, `pane-${index}.pid`), 'utf8').catch(() => '')).toMatch(/^\d+$/u);
		await expect(panes.nth(index).locator('.xterm-rows > div').filter({ hasText: new RegExp(`^P${index}_OK\\s*$`) })).toBeVisible();
		shellPids.set(index, await readFile(join(testWorkspace.directory, `pane-${index}.pid`), 'utf8'));
		for (const other of [0, 1, 2].filter(other => other !== index)) {
			await expect(panes.nth(other).locator('.xterm-rows')).not.toContainText(`P${index}_OK`);
		}
	}
	expect(new Set(shellPids.values()).size).toBe(3);
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
	// Narrow ConPTY panes can scroll output behind a long prompt. Verify execution
	// and its original shell identity independently of the current viewport.
	await page.keyboard.type(`node -e "require('fs').writeFileSync('resize-result.pid',String(process.ppid))"`);
	await page.keyboard.press('Enter');
	await expect.poll(() => readFile(join(testWorkspace.directory, 'resize-result.pid'), 'utf8').catch(() => '')).toBe(shellPids.get(2));
	await expect(panes.nth(2).locator('.xterm-helper-textarea')).toBeFocused();
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
		await page.keyboard.type(`node -e "console.log(['retained',${index}].join('-'))"`);
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
	expect(shellName).toBe(process.platform === 'win32' ? 'Smoke PowerShell' : shellName.toLowerCase());
	await workbench.menus.select(application, () => title.click(), ['Rename Terminal']);
	const input = page.getByPlaceholder('Enter a terminal name; leave empty to restore the shell name', { exact: true });
	await expect(input).toBeFocused();
	await input.fill('Build Shell');
	await input.press('Enter');
	await expect(title).toHaveText('Build Shell');
	await expect(workbench.terminal.activeInstance.locator('.xterm-helper-textarea')).toBeFocused();
	await page.screenshot({ path: testInfo.outputPath('terminal-title-toolbar.png') });
	await expect(workbench.terminal.activeInstance).toHaveAttribute('data-state', 'running');
	await toolbar.getByRole('button', { name: 'New Terminal', exact: true }).click({ modifiers: ['Alt'] });
	await expect(page.locator('.ash-terminal-group-pane:visible')).toHaveCount(2);
	await expect(title).toBeVisible();
	await expect(toolbar.getByRole('button', { name: 'Split Terminal', exact: true })).toBeVisible();
	await toolbar.getByRole('button', { name: 'Kill Terminal', exact: true }).click();
	await expect(workbench.terminal.instances).toHaveCount(1);
	await expect(title).toHaveText('Build Shell');
});

for (const locale of ['en', 'zh-CN'] as const) test.describe(`terminal close protection and reload (${locale})`, () => {
	test.use({ electronUserSettings: { ...windowsPowerShellSettings, 'terminal.integrated.confirmOnKill': 'always', 'terminal.integrated.confirmOnExit': 'always', 'workbench.locale': locale } });

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
		await expect.poll(() => {
			try { process.kill(before.pid, 0); return true; } catch { return false; }
		}).toBe(false);
		await expect(pane.locator('.ash-terminal-command-status.pending')).toBeVisible();
		await input.pressSequentially('echo CLOSE_RESUMED');
		await input.press('Enter');
		await expect(pane.locator('.xterm-rows > div').filter({ hasText: /^CLOSE_RESUMED\s*$/u })).toBeVisible();
		await page.locator('.ash-terminal-title-toolbar').getByRole('button', { name: zh ? '终止终端' : 'Kill Terminal', exact: true }).click();
		await expect(pane).toHaveCount(0);
	});

	test('runtime replacement stops reconnecting and allows explicit shell relaunch without replaying commands', { tag: ['@electron-app-server'] }, async ({ application, workbench, testWorkspace }, testInfo) => {
		if (!('windows' in application)) throw new Error('Expected Electron');
		const page = workbench.page;
		const zh = locale === 'zh-CN';
		await page.getByRole('button', { name: zh ? '切换面板显示' : 'Toggle Panel Visibility', exact: true }).click();
		const pane = page.locator('.ash-terminal-group-pane:visible');
		await expect(pane).toHaveCount(1);
		const instanceId = await pane.getAttribute('data-instance-id');
		const input = pane.locator('.xterm-helper-textarea');
		await writeFile(join(testWorkspace.directory, 'before-replacement.cjs'), `const fs = require('fs'); let count = 0; setInterval(() => { fs.writeFileSync('before-replacement.json', JSON.stringify({ pid: process.pid, count: ++count })); console.log('BEFORE_REPLACEMENT:' + count); }, 100);`);
		await input.focus();
		await input.pressSequentially('node before-replacement.cjs');
		await input.press('Enter');
		await expect(pane.locator('.xterm-rows')).toContainText('BEFORE_REPLACEMENT:');
		const old = JSON.parse(await readFile(join(testWorkspace.directory, 'before-replacement.json'), 'utf8')) as { pid: number; count: number; };
		const window = await application.browserWindow(page);
		await window.evaluate(window => window.webContents.send('ash:terminal:prepareReplacement'));
		await expect(pane.locator('.ash-terminal-instance')).toHaveAttribute('data-state', 'error');
		const title = page.locator('.ash-terminal-active-action button');
		await title.focus();
		await title.press('Alt+ArrowDown');
		const hover = page.locator('.ash-terminal-instance-hover');
		await expect(hover.locator('[data-severity="error"]')).toContainText(zh ? '与进程的连接已断开' : 'Lost connection to process');
		await title.press('Escape');
		await expect(hover).toHaveCount(0);
		await expect(pane.locator('.xterm-rows')).not.toContainText(zh ? '[终端操作失败]' : '[terminal operation failed]');
		await expect(pane.locator('.xterm-rows')).toContainText('BEFORE_REPLACEMENT:');
		await expect(page.locator('.ash-terminal-active-action')).toHaveAttribute('data-state', 'error');
		await expect(page.locator('.ash-terminal-title-toolbar').getByRole('button', { name: zh ? '拆分终端' : 'Split Terminal', exact: true })).toBeDisabled();
		await expect.poll(() => application.evaluate((_electron, pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }, old.pid)).toBe(false);
		const stopped = await readFile(join(testWorkspace.directory, 'before-replacement.json'), 'utf8');
		await workbench.menus.select(application, () => page.locator('.ash-terminal-active-action button').click(), [zh ? '重新启动终端' : 'Relaunch Terminal']);
		await expect(page.locator('.ash-terminal-active-action')).toHaveAttribute('data-state', 'running');
		await expect(pane).toHaveAttribute('data-instance-id', instanceId!);
		await expect(pane.locator('.xterm-rows')).toContainText(testWorkspace.directory.split(/[/\\]/u).at(-1)!);
		await input.focus();
		await input.pressSequentially('echo RELAUNCH_OK');
		await input.press('Enter');
		await expect(pane.locator('.xterm-rows > div').filter({ hasText: /^RELAUNCH_OK\s*$/u })).toBeVisible();
		expect(await readFile(join(testWorkspace.directory, 'before-replacement.json'), 'utf8')).toBe(stopped);
		await page.screenshot({ path: testInfo.outputPath(`explicit-terminal-relaunch-${locale}.png`) });
	});

	test('reload omits terminals retired by runtime replacement and preserves a healthy terminal', { tag: ['@electron-app-server'] }, async ({ application, workbench, testWorkspace, runningApplication }, testInfo) => {
		if (!('windows' in application)) throw new Error('Expected Electron');
		const page = workbench.page;
		const zh = locale === 'zh-CN';
		await page.getByRole('button', { name: zh ? '切换面板显示' : 'Toggle Panel Visibility', exact: true }).click();
		const panes = page.locator('.ash-terminal-group-pane:visible');
		await expect(panes).toHaveCount(1);
		const retiredId = await panes.first().getAttribute('data-instance-id');
		await writeFile(join(testWorkspace.directory, 'retired-terminal.cjs'), `const fs = require('fs'); const id = process.argv[2]; let count = 0; setInterval(() => { fs.writeFileSync(id + '.json', JSON.stringify({ pid: process.pid, shell: process.ppid, count: ++count })); console.log('ALIVE:' + id + ':' + count); }, 200);`);
		const oldInput = panes.first().locator('.xterm-helper-textarea');
		await oldInput.focus();
		await oldInput.pressSequentially('node retired-terminal.cjs retired');
		await oldInput.press('Enter');
		await expect(panes.first().locator('.xterm-rows')).toContainText('ALIVE:retired');
		const old = JSON.parse(await readFile(join(testWorkspace.directory, 'retired.json'), 'utf8')) as { pid: number; };
		// This is the production notification sent before replacing the App Server.
		const window = await application.browserWindow(page);
		await window.evaluate(window => window.webContents.send('ash:terminal:prepareReplacement'));
		await expect.poll(async () => application.evaluate((_electron, pid) => {
			try { process.kill(pid, 0); return true; } catch { return false; }
		}, old.pid)).toBe(false);
		await workbench.quickaccess.runCommand('workbench.action.terminal.new');
		await expect(panes).toHaveCount(1);
		const healthy = panes.first();
		await expect(healthy).not.toHaveAttribute('data-instance-id', retiredId!);
		await expect(healthy.locator('.xterm-rows')).toContainText(testWorkspace.directory.split(/[/\\]/u).at(-1)!);
		const healthyId = await healthy.getAttribute('data-instance-id');
		const input = healthy.locator('.xterm-helper-textarea');
		await input.focus();
		await input.pressSequentially('node retired-terminal.cjs healthy');
		await input.press('Enter');
		await expect(healthy.locator('.xterm-rows')).toContainText('ALIVE:healthy');
		const before = JSON.parse(await readFile(join(testWorkspace.directory, 'healthy.json'), 'utf8'));
		const loaded = page.waitForEvent('domcontentloaded');
		await workbench.quickaccess.runCommand('workbench.action.reloadWindow');
		await loaded;
		await workbench.waitForReady();
		await expect(panes).toHaveCount(1);
		await expect(panes.first()).toHaveAttribute('data-instance-id', healthyId!);
		await expect(panes.first().locator('.xterm-rows')).toContainText('ALIVE:healthy');
		const after = JSON.parse(await readFile(join(testWorkspace.directory, 'healthy.json'), 'utf8'));
		expect([after.pid, after.shell]).toEqual([before.pid, before.shell]);
		await expect.poll(async () => JSON.parse(await readFile(join(testWorkspace.directory, 'healthy.json'), 'utf8')).count).toBeGreaterThan(after.count);
		expect(runningApplication.diagnostics.consoleErrors.filter(message => /Failed to save window state before closing|no longer recoverable|cannot be reattached after reload/u.test(message))).toEqual([]);
		await page.screenshot({ path: testInfo.outputPath(`retired-terminal-reload-${locale}.png`) });
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
		await third.pressSequentially('echo PENDING_');
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
			await expect.poll(() => {
				try { process.kill(before[index].pid, 0); return true; } catch { return false; }
			}).toBe(false);
			await expect(panes.nth(index).locator('.ash-terminal-command-status.pending')).toBeVisible();
			await input.pressSequentially(`echo AFTER_${index}`);
			await input.press('Enter');
			await expect(panes.nth(index).locator('.xterm-rows > div').filter({ hasText: new RegExp(`^AFTER_${index}\\s*$`, 'u') })).toBeVisible();
			await input.press('Alt+F2');
			const accessible = page.locator('.ash-accessible-view-content');
			await expect(accessible).toBeFocused();
			const history = await accessible.inputValue();
			await writeFile(testInfo.outputPath(`terminal-history-${index}.txt`), history);
			expect(history).toContain(`HISTORY:${index}`);
			// ConPTY can pad resized rows; the numbered stream must still be exact.
			const sequences = [...history.matchAll(new RegExp(`^LIVE:${index}:(\\d+)[ \\t]*$`, 'gmu'))].map(match => Number(match[1]));
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

test('terminal Panel position commands rotate real splits while preserving sizes, focus and shell processes', { tag: ['@electron-app-server'] }, async ({ workbench, driver, testWorkspace }, testInfo) => {
	const page = workbench.page;
	await driver.setWindowSize({ width: 1600, height: 1000 });
	await workbench.terminal.show();
	await page.locator('.ash-terminal-title-toolbar').getByRole('button', { name: 'Split Terminal', exact: true }).click();
	const panes = page.locator('.ash-terminal-group-pane:visible');
	await expect(panes).toHaveCount(2);
	const ids = await panes.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.instanceId));
	const shellPids: string[] = [];
	const recordShell = async (index: number, phase: string): Promise<string> => {
		const file = `panel-process-${index}-${phase}.txt`;
		const input = panes.nth(index).locator('.xterm-helper-textarea');
		await input.focus();
		await input.pressSequentially(`node -e "require('fs').writeFileSync('${file}',String(process.ppid))"`);
		await input.press('Enter');
		await expect.poll(() => readFile(join(testWorkspace.directory, file), 'utf8').catch(() => '')).toMatch(/^\d+$/u);
		return readFile(join(testWorkspace.directory, file), 'utf8');
	};
	for (const index of [0, 1]) shellPids.push(await recordShell(index, 'before'));
	const input = panes.nth(1).locator('.xterm-helper-textarea');
	await input.focus();
	await input.pressSequentially("node -e \"console.log(['PANEL',");
	const sash = page.locator('.ash-terminal-group:visible > .ash-sash').first();
	await expect(sash).toBeVisible();
	const sashBounds = (await sash.boundingBox())!;
	await page.mouse.move(sashBounds.x + sashBounds.width / 2, sashBounds.y + sashBounds.height / 2);
	await page.mouse.down();
	await page.mouse.move(sashBounds.x + 55, sashBounds.y + sashBounds.height / 2, { steps: 6 });
	await page.mouse.up();
	await expect(input).toBeFocused();
	const ratios = async (axis: 'width' | 'height'): Promise<number[]> => panes.evaluateAll((nodes, axis) => {
		const sizes = nodes.map(node => node.getBoundingClientRect()[axis]);
		const total = sizes.reduce((sum, size) => sum + size, 0);
		return sizes.map(size => size / total);
	}, axis);
	const beforeRatios = await ratios('width');
	for (const [position, axis] of [['Left', 'height'], ['Right', 'height'], ['Top', 'width'], ['Bottom', 'width']] as const) {
		await workbench.quickaccess.runCommand(`workbench.action.positionPanel${position}`);
		await expect(panes).toHaveCount(2);
		await expect(page.locator(`.ash-terminal-group:visible.ash-split-view-${axis === 'width' ? 'horizontal' : 'vertical'}`)).toHaveCount(1);
		await expect(input).toBeFocused();
		await expect.poll(() => panes.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.instanceId))).toEqual(ids);
		await expect.poll(async () => Math.max(...(await ratios(axis)).map((ratio, index) => Math.abs(ratio - beforeRatios[index]!))), { message: `Panel ${position} must retain pane ratios ${JSON.stringify(beforeRatios)}` }).toBeLessThan(0.02);
		await expect.poll(async () => {
			const panel = (await page.locator('[data-part="panel"]').boundingBox())!;
			const editor = (await page.locator('[data-part="editor"]').boundingBox())!;
			switch (position) {
				case 'Left': return Math.abs(panel.x + panel.width - editor.x) <= 8 && Math.abs(panel.y - editor.y) <= 4;
				case 'Right': return Math.abs(editor.x + editor.width - panel.x) <= 8 && Math.abs(panel.y - editor.y) <= 4;
				case 'Top': return Math.abs(panel.y + panel.height - editor.y) <= 8 && Math.abs(panel.x - editor.x) <= 4;
				case 'Bottom': return Math.abs(editor.y + editor.height - panel.y) <= 8 && Math.abs(panel.x - editor.x) <= 4;
			}
		}).toBe(true);
	}
	await input.pressSequentially("'READY'].join('_'))\"");
	await input.press('Enter');
	await expect(panes.nth(1).locator('.xterm-rows > div').filter({ hasText: /^PANEL_READY\s*$/u })).toBeVisible();
	for (const index of [0, 1]) expect(await recordShell(index, 'after')).toBe(shellPids[index]);
	await page.screenshot({ path: testInfo.outputPath('terminal-panel-positions.png') });
	expect(driver.diagnostics.errors).toEqual([]);
});

test('moving a terminal to a real desktop window retains its shell PID, cwd, output and pending input', { tag: ['@electron-app-server'] }, async ({ application, workbench, testWorkspace, driver }, testInfo) => {
	test.setTimeout(90000);
	if (!('windows' in application)) throw new Error('The terminal window transfer requires Electron');
	const { Workbench } = await import('../../../automation/workbench.js');
	const source = workbench.page;
	const directory = join(testWorkspace.directory, 'transfer working directory');
	await mkdir(directory);
	const windows = process.platform === 'win32';
	const quote = (value: string): string => "'" + value.replaceAll("'", windows ? "''" : "'\"'\"'") + "'";
	await workbench.terminal.show();
	await workbench.terminal.runCommand(`${windows ? 'Set-Location -LiteralPath' : 'cd --'} ${quote(directory)}`);
	const beforeFile = join(directory, 'before.json');
	await workbench.terminal.runCommand("node -e \"require('fs').writeFileSync('before.json',JSON.stringify({shell:process.ppid,cwd:process.cwd()}))\"");
	await expect.poll(() => readFile(beforeFile, 'utf8').catch(() => '')).toMatch(/"shell":\d+/u);
	const before = JSON.parse(await readFile(beforeFile, 'utf8')) as { shell: number; cwd: string; };
	await workbench.terminal.runCommand('echo WINDOW_HISTORY');
	await expect(workbench.terminal.activeInstance.locator('.xterm-rows > div').filter({ hasText: /^WINDOW_HISTORY\s*$/u })).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.terminal.moveToEditor');
	const sourceInput = source.locator('.ash-terminal-editor .xterm-helper-textarea');
	await expect(sourceInput).toBeFocused();
	await sourceInput.pressSequentially('echo PENDING_');
	const opening = application.waitForEvent('window');
	await workbench.quickaccess.runCommand('workbench.action.terminal.moveIntoNewWindow');
	const target = await opening;
	const peer = new Workbench(target);
	try {
		await peer.waitForReady();
		await expect(peer.terminal.instances).toHaveCount(1);
		await expect(source.locator('.ash-terminal-editor .xterm')).toHaveCount(0);
		await expect(workbench.terminal.instances).toHaveCount(0);
		const screen = peer.terminal.activeInstance;
		await expect(screen.locator('.xterm-rows')).toContainText('WINDOW_HISTORY');
		await expect(screen.locator('.xterm-rows')).toContainText('PENDING_');
		const input = screen.locator('.xterm-helper-textarea');
		await expect(input).toBeFocused();
		process.kill(before.shell, 0);
		await input.pressSequentially('RESUMED');
		await input.press('Enter');
		await expect(screen.locator('.xterm-rows > div').filter({ hasText: /^PENDING_RESUMED\s*$/u })).toBeVisible();
		await peer.terminal.runCommand("node -e \"require('fs').writeFileSync('after.json',JSON.stringify({shell:process.ppid,cwd:process.cwd()}))\"");
		const afterFile = join(directory, 'after.json');
		await expect.poll(() => readFile(afterFile, 'utf8').catch(() => '')).toMatch(/"shell":\d+/u);
		expect(JSON.parse(await readFile(afterFile, 'utf8'))).toEqual(before);
		await target.screenshot({ path: testInfo.outputPath('terminal-window-transfer.png') });
		await testInfo.attach('terminal-window-process-identity', { body: JSON.stringify(before), contentType: 'application/json' });
		await target.locator('.ash-terminal-title-toolbar').getByRole('button', { name: 'Kill Terminal', exact: true }).click();
		await expect(peer.terminal.instances).toHaveCount(0);
		expect(driver.diagnostics.errors).toEqual([]);
	} finally {
		if (!target.isClosed()) await target.close();
	}
});

for (const reason of ['quit', 'windowClose'] as const) test.describe(`terminal process revival after ${reason}`, () => {
	test.use({ electronUserSettings: { ...windowsPowerShellSettings, 'terminal.integrated.persistentSessionReviveProcess': reason === 'quit' ? 'onExit' : 'onExitAndWindowClose' } });
	test('restores output, cwd and split layout with fresh shells without replaying commands', { tag: ['@electron-app-server'] }, async ({ workbench, runningApplication, testWorkspace }, testInfo) => {
		test.setTimeout(90_000);
		const directory = join(testWorkspace.directory, 'revived-cwd');
		await mkdir(directory);
		await writeFile(join(testWorkspace.directory, 'revive-fixture.cjs'), `const fs = require('fs'); const path = require('path'); const root = ${JSON.stringify(testWorkspace.directory)}; const id = process.argv[2]; const phase = process.argv[3]; fs.writeFileSync(path.join(root, id + '-' + phase + '.json'), JSON.stringify({ shell: process.ppid, pid: process.pid, cwd: process.cwd() })); if (phase === 'before') { fs.appendFileSync(path.join(root, 'executions.txt'), id + '\\n'); console.log('REVIVE_HISTORY:' + id); setInterval(() => {}, 1000); } else console.log('REVIVE_READY:' + id);`);
		await workbench.terminal.show();
		await workbench.page.locator('.ash-terminal-title-toolbar').getByRole('button', { name: 'Split Terminal', exact: true }).click();
		const panes = workbench.page.locator('.ash-terminal-group-pane:visible');
		await expect(panes).toHaveCount(2);
		for (const index of [0, 1]) {
			const input = panes.nth(index).locator('.xterm-helper-textarea');
			await input.focus();
			await input.pressSequentially('cd revived-cwd');
			await input.press('Enter');
			await input.pressSequentially(`node ../revive-fixture.cjs ${index} before`);
			await input.press('Enter');
			await expect(panes.nth(index).locator('.xterm-rows')).toContainText(`REVIVE_HISTORY:${index}`);
		}
		const sash = workbench.page.locator('.ash-terminal-group:visible > .ash-sash').first();
		const bounds = (await sash.boundingBox())!;
		await workbench.page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
		await workbench.page.mouse.down();
		await workbench.page.mouse.move(bounds.x + 55, bounds.y + bounds.height / 2, { steps: 6 });
		await workbench.page.mouse.up();
		const ratio = await panes.evaluateAll(nodes => nodes[0]!.getBoundingClientRect().width / nodes.reduce((sum, node) => sum + node.getBoundingClientRect().width, 0));
		const identities = await Promise.all([0, 1].map(async index => JSON.parse(await readFile(join(testWorkspace.directory, `${index}-before.json`), 'utf8')) as { shell: number; pid: number; cwd: string; }));
		const executions = await readFile(join(testWorkspace.directory, 'executions.txt'), 'utf8');
		const restored = (await runningApplication.reload(reason)).workbench;
		const restoredPanes = restored.page.locator('.ash-terminal-group-pane:visible');
		await expect(restoredPanes).toHaveCount(2);
		await expect.poll(() => restoredPanes.evaluateAll(nodes => nodes[0]!.getBoundingClientRect().width / nodes.reduce((sum, node) => sum + node.getBoundingClientRect().width, 0))).toBeCloseTo(ratio, 2);
		for (const index of [0, 1]) {
			const pane = restoredPanes.nth(index);
			if (process.platform === 'win32') await revealSavedHistory(pane, `REVIVE_HISTORY:${index}`);
			await expect(pane.locator('.xterm-rows')).toContainText(`REVIVE_HISTORY:${index}`);
			const input = pane.locator('.xterm-helper-textarea');
			await input.focus();
			await input.pressSequentially(`node ../revive-fixture.cjs ${index} after`);
			await input.press('Enter');
			await expect(pane.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^REVIVE_READY:${index}\\s*$`, 'u') })).toBeVisible();
			const after = JSON.parse(await readFile(join(testWorkspace.directory, `${index}-after.json`), 'utf8')) as { shell: number; cwd: string; };
			expect(after.shell).not.toBe(identities[index]!.shell);
			expect(after.cwd).toBe(directory);
			await expect.poll(() => { try { process.kill(identities[index]!.pid, 0); return true; } catch { return false; } }).toBe(false);
		}
		expect(await readFile(join(testWorkspace.directory, 'executions.txt'), 'utf8')).toBe(executions);
		await restored.page.screenshot({ path: testInfo.outputPath(`terminal-revive-${reason}.png`) });
		expect(runningApplication.diagnostics.errors).toEqual([]);
	});
});

test.describe('terminal revival keeps independent windows of the same workspace isolated', () => {
	test.use({ electronUserSettings: { ...windowsPowerShellSettings, 'window.restoreWindows': 'preserve', 'terminal.integrated.persistentSessionReviveProcess': 'onExit' } });

	test('quit restores both window histories, directories and split layouts with separate fresh shells', { tag: ['@electron-app-server'] }, async ({ application, workbench, runningApplication, testWorkspace }, testInfo) => {
		test.setTimeout(120_000);
		if (!('windows' in application)) throw new Error('Multi-window revival requires Electron');
		const { Workbench } = await import('../../../automation/workbench.js');
		const directoryA = join(testWorkspace.directory, 'window-a-cwd');
		const directoryB = join(testWorkspace.directory, 'window-b-cwd');
		await mkdir(directoryA);
		await mkdir(directoryB);
		await writeFile(join(testWorkspace.directory, 'multiwindow-revive.cjs'), `const fs = require('fs'); const path = require('path'); const root = ${JSON.stringify(testWorkspace.directory)}; const id = process.argv[2]; const phase = process.argv[3]; fs.writeFileSync(path.join(root,id+'-'+phase+'.json'),JSON.stringify({shell:process.ppid,cwd:process.cwd()})); if(phase==='before') fs.appendFileSync(path.join(root,'window-executions.txt'),id+'\\n'); console.log((phase==='before'?'MW_HISTORY:':'MW_READY:')+id);`);
		await workbench.terminal.show();
		const opening = application.waitForEvent('window');
		await workbench.quickaccess.runCommand('workbench.action.terminal.moveIntoNewWindow');
		const peer = new Workbench(await opening);
		await peer.waitForReady();
		await expect(workbench.terminal.instances).toHaveCount(0);
		await expect(peer.terminal.instances).toHaveCount(1);
		await workbench.quickaccess.runCommand('workbench.action.terminal.new');
		await workbench.page.locator('.ash-terminal-title-toolbar').getByRole('button', { name: 'Split Terminal', exact: true }).click();
		const panesA = workbench.page.locator('.ash-terminal-group-pane:visible');
		const panesB = peer.page.locator('.ash-terminal-group-pane:visible');
		await expect(panesA).toHaveCount(2);
		await expect(panesB).toHaveCount(1);
		const windowsHost = process.platform === 'win32';
		const quote = (value: string): string => "'" + value.replaceAll("'", windowsHost ? "''" : "'\"'\"'") + "'";
		for (const { pane, id, cwd } of [{ pane: panesA.nth(0), id: 'A0', cwd: directoryA }, { pane: panesA.nth(1), id: 'A1', cwd: directoryA }, { pane: panesB.nth(0), id: 'B0', cwd: directoryB }]) {
			const input = pane.locator('.xterm-helper-textarea');
			await input.focus();
			await input.pressSequentially(`${windowsHost ? 'Set-Location -LiteralPath' : 'cd --'} ${quote(cwd)}`);
			await input.press('Enter');
			await input.pressSequentially(`node ../multiwindow-revive.cjs ${id} before`);
			await input.press('Enter');
			await expect(pane.locator('.xterm-rows')).toContainText(`MW_HISTORY:${id}`);
		}
		const sash = workbench.page.locator('.ash-terminal-group:visible > .ash-sash').first();
		const bounds = (await sash.boundingBox())!;
		await workbench.page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
		await workbench.page.mouse.down();
		await workbench.page.mouse.move(bounds.x + 55, bounds.y + bounds.height / 2, { steps: 6 });
		await workbench.page.mouse.up();
		const ratio = await panesA.evaluateAll(nodes => nodes[0]!.getBoundingClientRect().width / nodes.reduce((sum, node) => sum + node.getBoundingClientRect().width, 0));
		const identities = new Map(await Promise.all(['A0', 'A1', 'B0'].map(async id => [id, JSON.parse(await readFile(join(testWorkspace.directory, `${id}-before.json`), 'utf8')) as { shell: number; cwd: string; }] as const)));
		const executions = await readFile(join(testWorkspace.directory, 'window-executions.txt'), 'utf8');
		const restored = await runningApplication.reload('quit');
		if (!('windows' in restored.application)) throw new Error('Desktop revival returned a browser application');
		const desktop = restored.application;
		await expect.poll(() => desktop.windows().length).toBe(2);
		const windows = desktop.windows().map(page => new Workbench(page));
		await Promise.all(windows.map(window => window.waitForReady()));
		if (process.platform === 'win32') {
			for (const window of windows) await revealSavedHistory(window.page.locator('.ash-terminal-group-pane:visible').first(), 'MW_HISTORY:');
		}
		await expect.poll(async () => (await Promise.all(windows.map(async window => {
			const text = (await window.page.locator('.ash-terminal-instance .xterm-rows').allTextContents()).join('\n');
			return text.includes('MW_HISTORY:A0') ? 'A' : text.includes('MW_HISTORY:B0') ? 'B' : 'loading';
		}))).sort()).toEqual(['A', 'B']);
		const contents = await Promise.all(windows.map(async window => (await window.page.locator('.ash-terminal-instance .xterm-rows').allTextContents()).join('\n')));
		const a = windows[contents.findIndex(text => text.includes('MW_HISTORY:A0'))]!;
		const b = windows[contents.findIndex(text => text.includes('MW_HISTORY:B0'))]!;
		expect(a).toBeDefined();
		expect(b).toBeDefined();
		expect(a).not.toBe(b);
		await expect(a.terminal.instances).toHaveCount(2);
		await expect(b.terminal.instances).toHaveCount(1);
		await expect(a.page.locator('.ash-terminal-group-pane:visible')).toHaveCount(2);
		await expect(b.page.locator('.ash-terminal-group-pane:visible')).toHaveCount(1);
		await expect(a.page.locator('.ash-terminal-group:visible')).toHaveCount(1);
		await expect(b.page.locator('.ash-terminal-group:visible')).toHaveCount(1);
		expect((await a.page.locator('.xterm-rows').allTextContents()).join('\n')).not.toContain('MW_HISTORY:B0');
		expect((await b.page.locator('.xterm-rows').allTextContents()).join('\n')).not.toContain('MW_HISTORY:A');
		const restoredPanesA = a.page.locator('.ash-terminal-group-pane:visible');
		await expect.poll(() => restoredPanesA.evaluateAll(nodes => nodes[0]!.getBoundingClientRect().width / nodes.reduce((sum, node) => sum + node.getBoundingClientRect().width, 0))).toBeCloseTo(ratio, 1);
		for (const { pane, id, cwd } of [{ pane: restoredPanesA.nth(0), id: 'A0', cwd: directoryA }, { pane: restoredPanesA.nth(1), id: 'A1', cwd: directoryA }, { pane: b.page.locator('.ash-terminal-group-pane:visible').nth(0), id: 'B0', cwd: directoryB }]) {
			if (process.platform === 'win32') await revealSavedHistory(pane, `MW_HISTORY:${id}`);
			const input = pane.locator('.xterm-helper-textarea');
			await input.focus();
			await input.pressSequentially(`node ../multiwindow-revive.cjs ${id} after`);
			await input.press('Enter');
			await expect(pane.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^MW_READY:${id}\\s*$`, 'u') })).toBeVisible();
			const after = JSON.parse(await readFile(join(testWorkspace.directory, `${id}-after.json`), 'utf8')) as { shell: number; cwd: string; };
			expect(after.shell).not.toBe(identities.get(id)!.shell);
			expect(after.cwd).toBe(cwd);
		}
		expect(await readFile(join(testWorkspace.directory, 'window-executions.txt'), 'utf8')).toBe(executions);
		await a.page.screenshot({ path: testInfo.outputPath('terminal-revive-window-a.png') });
		await b.page.screenshot({ path: testInfo.outputPath('terminal-revive-window-b.png') });
		expect(runningApplication.diagnostics.errors).toEqual([]);
	});
});

for (const locale of ['en', 'zh-CN'] as const) for (const host of ['workbench', 'sessions'] as const) test.describe(`terminal panel positions (${host}, ${locale})`, () => {
	test.use({ electronUserSettings: { ...windowsPowerShellSettings, 'workbench.locale': locale } });

	test('moving a real panel preserves split proportions, shell input and focus through hiding and reload', { tag: ['@electron-app-server'] }, async ({ target, workbench, testWorkspace, driver }) => {
		test.setTimeout(90000);
		const zh = locale === 'zh-CN';
		const page = host === 'sessions' ? await workbench.openAgentsWindow(target.kind) : workbench.page;
		if (host === 'sessions') await page.locator('.ash-sessions-activity-content').getByRole('button', { name: zh ? '代码' : 'Code', exact: true }).click();
		const commands = new QuickAccess(page);
		await commands.runCommand('workbench.action.terminal.focus');
		await commands.runCommand('workbench.action.terminal.split');
		const panes = page.locator('.ash-terminal-group-pane:visible');
		await expect(panes).toHaveCount(2);
		const ids = await panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-instance-id')));
		const input = () => panes.nth(1).locator('.xterm-helper-textarea');
		const sash = () => page.getByRole('separator', { name: zh ? '调整终端窗格大小' : 'Resize terminal panes', exact: true });
		const share = async (horizontal: boolean): Promise<number> => panes.evaluateAll((nodes, horizontal) => {
			const sizes = nodes.map(node => horizontal ? node.getBoundingClientRect().width : node.getBoundingClientRect().height);
			return sizes[0]! / sizes.reduce((sum, value) => sum + value, 0);
		}, horizontal);
		const beforeResize = await share(true);
		await sash().focus();
		await sash().press('ArrowRight');
		await expect.poll(() => share(true)).toBeGreaterThan(beforeResize);
		const ratio = await share(true);
		const execution = join(testWorkspace.directory, `panel-executed-${host}.txt`);
		const shellIdentity = join(testWorkspace.directory, `panel-shell-${host}.txt`);
		const encodedPath = Buffer.from(execution).toString('base64');
		const encodedIdentity = Buffer.from(shellIdentity).toString('base64');
		await input().focus();
		await input().pressSequentially(`node -e "require('fs').writeFileSync(Buffer.from('${encodedIdentity}','base64').toString(),String(process.ppid));console.log(['panel','retained-buffer'].join('-'))"`);
		await input().press('Enter');
		await expect(panes.nth(1).locator('.xterm-rows')).toContainText('panel-retained-buffer');
		const shellPid = await readFile(shellIdentity, 'utf8');
		await input().pressSequentially(`node -e "require('fs').writeFileSync(Buffer.from('${encodedPath}','base64').toString(),'once:'+process.ppid)"`);
		for (const [position, suffix, horizontal] of [['left', 'Left', false], ['top', 'Top', true], ['right', 'Right', false], ['bottom', 'Bottom', true], ['right', 'Right', false]] as const) {
			const commandId = `workbench.action.positionPanel${suffix}`;
			await commands.open(`>${commandId}`);
			const option = commands.items.filter({ has: page.locator('.ash-quick-pick-row-description').getByText(commandId, { exact: true }) });
			const titles = zh
				? { left: '将面板移到左侧', right: '将面板移到右侧', top: '将面板移到顶部', bottom: '将面板移到底部' }
				: { left: 'Move Panel Left', right: 'Move Panel Right', top: 'Move Panel to Top', bottom: 'Move Panel to Bottom' };
			await expect(option.locator('.ash-quick-pick-row-label')).toHaveText(titles[position]);
			await option.click();
			await expect(page.locator('[data-panel-position]')).toHaveAttribute('data-panel-position', position);
			await expect(sash()).toHaveAttribute('aria-orientation', horizontal ? 'vertical' : 'horizontal');
			const panel = (await page.locator('[data-part="panel"]').boundingBox())!;
			const borders = await page.locator('[data-part="panel"]').evaluate(element => {
				const style = getComputedStyle(element);
				return { top: parseFloat(style.borderTopWidth), bottom: parseFloat(style.borderBottomWidth), left: parseFloat(style.borderLeftWidth), right: parseFloat(style.borderRightWidth) };
			});
			expect(borders[position === 'top' ? 'bottom' : position === 'bottom' ? 'top' : position === 'left' ? 'right' : 'left']).toBeGreaterThan(0);
			const centers = await page.locator('[data-part="editor"]:visible, [data-part="sessions"]:visible').evaluateAll(nodes => nodes.map(node => {
				const rect = node.getBoundingClientRect();
				return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
			}));
			expect(centers.length).toBeGreaterThan(0);
			for (const center of centers) {
				if (position === 'left') expect(panel.x + panel.width).toBeLessThanOrEqual(center.x + 1);
				if (position === 'right') expect(center.x + center.width).toBeLessThanOrEqual(panel.x + 1);
				if (position === 'top') expect(panel.y + panel.height).toBeLessThanOrEqual(center.y + 1);
				if (position === 'bottom') expect(center.y + center.height).toBeLessThanOrEqual(panel.y + 1);
			}
			await expect(input()).toBeFocused();
			await expect.poll(async () => Math.abs(await share(horizontal) - ratio)).toBeLessThan(0.03);
			await expect.poll(() => panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-instance-id')))).toEqual(ids);
			const first = (await panes.nth(0).boundingBox())!;
			const second = (await panes.nth(1).boundingBox())!;
			if (horizontal) expect(second.x).toBeGreaterThanOrEqual(first.x + first.width - 1);
			else expect(second.y).toBeGreaterThanOrEqual(first.y + first.height - 1);
			expect(await readFile(execution, 'utf8').catch(() => undefined)).toBeUndefined();
		}
		await input().press('Alt+F1');
		const help = page.locator('.ash-accessible-view-content');
		await expect(help).toHaveValue(zh ? /窗格左右并排/u : /Panes are side by side/u);
		await help.press('Escape');
		await expect(input()).toBeFocused();
		const restoredPanel = (await page.locator('[data-part="panel"]').boundingBox())!;
		await commands.runCommand('workbench.action.toggleMaximizedPanel');
		await expect(panes).toHaveCount(2);
		await expect.poll(async () => (await page.locator('[data-part="panel"]').boundingBox())!.width).toBeGreaterThan(restoredPanel.width + 20);
		await expect.poll(async () => Math.abs(await share(false) - ratio)).toBeLessThan(0.03);
		await commands.runCommand('workbench.action.toggleMaximizedPanel');
		await expect.poll(async () => Math.abs((await page.locator('[data-part="panel"]').boundingBox())!.width - restoredPanel.width)).toBeLessThan(2);
		await expect.poll(async () => Math.abs(await share(false) - ratio)).toBeLessThan(0.03);
		await commands.runCommand('workbench.action.closePanel');
		await expect(panes).toHaveCount(0);
		await commands.runCommand('workbench.action.terminal.focus');
		await expect(panes).toHaveCount(2);
		await expect(input()).toBeFocused();
		await expect.poll(async () => Math.abs(await share(false) - ratio)).toBeLessThan(0.03);
		const loaded = page.waitForEvent('domcontentloaded');
		await commands.runCommand('workbench.action.reloadWindow');
		await loaded;
		if (host === 'workbench') await workbench.waitForReady();
		await expect(page.locator('[data-panel-position]')).toHaveAttribute('data-panel-position', 'right');
		await expect(panes).toHaveCount(2);
		await expect.poll(() => panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-instance-id')))).toEqual(ids);
		await expect(sash()).toHaveAttribute('aria-orientation', 'horizontal');
		await expect.poll(async () => Math.abs(await share(false) - ratio)).toBeLessThan(0.03);
		await expect(input()).toBeFocused();
		expect(await readFile(execution, 'utf8').catch(() => undefined)).toBeUndefined();
		await input().press('Alt+F2');
		const buffer = page.locator('.ash-accessible-view-content');
		await expect(buffer).toHaveValue(/panel-retained-buffer/u);
		await buffer.press('Escape');
		await expect(input()).toBeFocused();
		await input().press('Enter');
		await expect.poll(() => readFile(execution, 'utf8').catch(() => '')).toBe(`once:${shellPid}`);
		expect(driver.diagnostics.errors).toEqual([]);
	});
});

test.describe('terminal contributions execution chain', () => {
	test.use({
		electronUserSettings: {
			...windowsPowerShellSettings,
			'terminal.integrated.autoReplies': { 'ASH-AUTO-REPLY>': 'accepted\r' },
		}
	});

	test('replies on the execution host and keeps the existing terminal through Quick Access', { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ workbench, testWorkspace, driver }) => {
		if (await workbench.page.evaluate(() => document.querySelector<HTMLElement>('#app')?.dataset.runtime !== 'electron')) {
			const settings = await readUserSettings(workbench.page);
			await writeUserSettings(workbench.page, JSON.stringify({ ...JSON.parse(settings.content), 'terminal.integrated.autoReplies': { 'ASH-AUTO-REPLY>': 'accepted\r' } }), settings.revision);
			await workbench.reloadWindow();
			await workbench.waitForReady();
		}
		await workbench.quickaccess.runCommand('workbench.action.terminal.new');
		await expect(workbench.terminal.activeInstance).toBeVisible();
		const instance = workbench.terminal.activeInstance;
		const pane = workbench.page.locator('.ash-terminal-group-pane:visible');
		const identity = await pane.getAttribute('data-instance-id');
		expect(identity).not.toBeNull();
		await workbench.terminal.runCommand(process.platform === 'win32'
			? "$answer=Read-Host ('ASH-'+'AUTO-REPLY>'); [IO.File]::WriteAllText((Join-Path (Get-Location) 'auto-reply-result.txt'),$answer)"
			: "printf 'ASH-%s>' AUTO-REPLY; read answer; printf '%s' \"$answer\" > auto-reply-result.txt");
		await expect.poll(() => readFile(join(testWorkspace.directory, 'auto-reply-result.txt'), 'utf8').catch(() => '')).toBe('accepted');
		await workbench.quickaccess.runCommand('workbench.action.quickOpenTerm');
		await workbench.page.getByRole('combobox', { name: 'Type the name of a terminal to open', exact: true }).press('Enter');
		await expect(instance.locator('.xterm-helper-textarea')).toBeFocused();
		await expect(workbench.terminal.instances).toHaveCount(1);
		await expect(pane).toHaveAttribute('data-instance-id', identity!);
		expect(driver.diagnostics.errors).toEqual([]);
	});

	test('sends a foreground signal through the real terminal process chain', { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ workbench, testWorkspace, driver }) => {
		test.skip(process.platform === 'win32', 'The ConPTY backend explicitly reports process signals as unsupported.');
		await workbench.quickaccess.runCommand('workbench.action.terminal.new');
		await expect(workbench.terminal.activeInstance).toBeVisible();
		await workbench.terminal.runCommand("node -e \"require('fs').writeFileSync('signal-ready.txt','ready');process.on('SIGTERM',()=>{require('fs').writeFileSync('signal-result.txt','terminated');process.exit(0)});setInterval(()=>{},1000)\"");
		await expect.poll(() => readFile(join(testWorkspace.directory, 'signal-ready.txt'), 'utf8').catch(() => '')).toBe('ready');
		await workbench.quickaccess.runCommand('workbench.action.terminal.sendSignal');
		await workbench.page.getByRole('option', { name: /SIGTERM/ }).click();
		await expect.poll(() => readFile(join(testWorkspace.directory, 'signal-result.txt'), 'utf8').catch(() => '')).toBe('terminated');
		await expect(workbench.terminal.instances).toHaveCount(1);
		expect(driver.diagnostics.errors).toEqual([]);
	});
});

interface LifetimeIdentity { pid: number; shell: number; child: number; count: number; }
const lifetimePidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function readTerminalHeartbeat<T>(path: string): Promise<T> {
	// Append complete records instead of replacing a file while Windows readers
	// and workspace watchers hold it open. Ignore an in-flight trailing record.
	const records = (await readFile(path, 'utf8')).split('\n');
	return JSON.parse(records.at(-2) ?? '') as T;
}

async function writeLifetimeFixture(directory: string): Promise<string> {
	const file = join(directory, 'window-lifetime.cjs');
	await writeFile(file, `const fs=require('fs'),path=require('path'),cp=require('child_process');const root=${JSON.stringify(directory)},id=process.argv[2];process.on('SIGHUP',()=>{});const child=cp.spawn(process.execPath,['-e',"process.on('SIGHUP',()=>{});require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",path.join(root,id+'.child')],{stdio:'ignore'});let count=0;setInterval(()=>{const state={pid:process.pid,shell:process.ppid,child:child.pid,count:++count};fs.appendFileSync(path.join(root,id+'.jsonl'),JSON.stringify(state)+String.fromCharCode(10));console.log('WINDOW-LIFETIME:'+id+':'+count)},100);`);
	return file;
}

async function startLifetimeCommand(workbench: import('../../../automation/workbench.js').Workbench, file: string, id: string): Promise<LifetimeIdentity> {
	const input = workbench.page.locator('.ash-terminal-group-pane:visible .xterm-helper-textarea').first();
	await input.focus();
	const quote = (value: string): string => "'" + value.replaceAll("'", process.platform === 'win32' ? "''" : "'\"'\"'") + "'";
	await input.pressSequentially(`node ${quote(file)} ${id}`);
	await input.press('Enter');
	const directory = resolve(file, '..');
	await expect.poll(() => readFile(join(directory, `${id}.child`), 'utf8').catch(() => '')).toMatch(/^\d+$/u);
	await expect.poll(() => readFile(join(directory, `${id}.jsonl`), 'utf8').catch(() => '')).toContain('"child":');
	return readTerminalHeartbeat<LifetimeIdentity>(join(directory, `${id}.jsonl`));
}

async function lifetimeHostPids(application: import('@playwright/test').ElectronApplication, identities: readonly LifetimeIdentity[], profile: string): Promise<number[]> {
	// The Windows development launcher can leave cmd.exe as Playwright's child.
	// Read Main's own identity before inspecting or force-terminating its owners.
	const mainPid = await application.evaluate(() => process.pid);
	const rows = process.platform === 'win32'
		? await windowsTerminalProcesses([`ParentProcessId = ${mainPid}`, ...identities.map(identity => `ProcessId = ${identity.shell}`)].join(' OR '))
		: (await promisify(execFile)('ps', ['-Ao', 'pid=,ppid=,command='])).stdout.split('\n').flatMap(line => {
			const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
			return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3]! }] : [];
		});
	const pids = new Set<number>();
	for (const row of rows) {
		if (row.parent === mainPid && row.command.includes(' --terminal-owner ') && row.command.includes(profile)) pids.add(row.pid);
		if (identities.some(identity => identity.shell === row.pid)) pids.add(row.parent);
	}
	return [...pids];
}

interface TerminalProcessInfo { pid: number; parent: number; command: string; }

async function windowsTerminalProcesses(filter: string): Promise<TerminalProcessInfo[]> {
	const env = { ...process.env };
	delete env.PSModulePath;
	const command = `Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object @{Name='pid';Expression={$_.ProcessId}},@{Name='parent';Expression={$_.ParentProcessId}},@{Name='command';Expression={$_.CommandLine}} | ConvertTo-Json -Compress`;
	const output = (await promisify(execFile)(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { env, windowsHide: true, timeout: 10_000 })).stdout.trim();
	return output ? [JSON.parse(output)].flat() : [];
}

async function terminalProcessInfo(pid: number): Promise<TerminalProcessInfo> {
	if (process.platform === 'win32') {
		const rows = await windowsTerminalProcesses(`ProcessId = ${pid}`);
		expect(rows).toHaveLength(1);
		return rows[0]!;
	}
	const output = (await promisify(execFile)('ps', ['-o', 'ppid=,command=', '-p', String(pid)])).stdout;
	const match = /^\s*(\d+)\s+(.*)$/u.exec(output.trim());
	expect(match).not.toBeNull();
	return { pid, parent: Number(match![1]), command: match![2]! };
}

async function blockLifetimeBackend(application: import('@playwright/test').ElectronApplication): Promise<{ profile: string; release(): Promise<void>; }> {
	const profile = await application.evaluate(() => process.env.ASH_HOME!);
	const location = { appPath: resolve(import.meta.dirname, '../../../..'), isPackaged: false, platform: process.platform, resourcesPath: '' };
	const env = { ...process.env, ASH_HOME: profile, ASH_APP_SERVER_PATH: appServerExecutablePath(location), ASH_ELECTRON_RUN_AS_NODE_PATH: await application.evaluate(() => process.execPath) };
	const state = JSON.parse((await promisify(execFile)(appServerDaemonExecutablePath(location), ['version'], { env, timeout: 30_000, windowsHide: true })).stdout) as { pid: number; endpointPath: string; };
	expect(state.endpointPath).toMatch(/\.sock$/u);
	const gate = state.endpointPath.replace(/\.sock$/u, '.operation');
	await mkdir(gate, { mode: 0o700 });
	const path = join(gate, 'heartbeat');
	await writeFile(path, 'window lifetime cleanup');
	let heartbeat = Promise.resolve();
	const timer = setInterval(() => { heartbeat = heartbeat.then(() => writeFile(path, 'window lifetime cleanup')); }, 1_000);
	process.kill(state.pid, 'SIGKILL');
	return { profile, release: async () => { clearInterval(timer); await heartbeat; await unlink(path); await rmdir(gate); } };
}

for (const locale of ['en', 'zh-CN'] as const) test.describe(`terminal window lifetime cleanup (${locale})`, () => {
	test.use({ electronUserSettings: { ...windowsPowerShellSettings, 'workbench.locale': locale, 'terminal.integrated.confirmOnKill': 'never', 'terminal.integrated.confirmOnExit': 'never', 'terminal.integrated.persistentSessionReviveProcess': 'never' } });

	test('window destruction during backend loss cleans its jobs and preserves a transferred peer until normal close', { tag: ['@electron-app-server'] }, async ({ application, workbench, testWorkspace }, testInfo) => {
		test.setTimeout(90_000);
		if (!('windows' in application)) throw new Error('Expected Electron');
		const { Workbench } = await import('../../../automation/workbench.js');
		const file = await writeLifetimeFixture(testWorkspace.directory);
		await workbench.page.getByRole('button', { name: locale === 'zh-CN' ? '切换面板显示' : 'Toggle Panel Visibility', exact: true }).click();
		await expect(workbench.terminal.activeInstance).toHaveAttribute('data-state', 'running');
		const opening = application.waitForEvent('window');
		await workbench.quickaccess.runCommand('workbench.action.terminal.moveIntoNewWindow');
		const target = await opening;
		const peer = new Workbench(target);
		await peer.waitForReady();
		await workbench.quickaccess.runCommand('workbench.action.terminal.new');
		const first = await startLifetimeCommand(workbench, file, 'first');
		const second = await startLifetimeCommand(peer, file, 'second');
		const profile = await application.evaluate(() => process.env.ASH_HOME!);
		const hosts = await lifetimeHostPids(application, [first, second], profile);
		expect(hosts).toHaveLength(3);
		const sourceWindow = await application.browserWindow(workbench.page);
		const gate = await blockLifetimeBackend(application);
		try {
			await expect(workbench.terminal.activeInstance).toHaveAttribute('data-state', 'reconnecting');
			await sourceWindow.evaluate(window => window.destroy());
			await expect.poll(() => [first.pid, first.child, first.shell].filter(lifetimePidAlive)).toEqual([]);
			for (const pid of [second.pid, second.child, second.shell]) expect(lifetimePidAlive(pid)).toBe(true);
			await expect.poll(async () => (await readTerminalHeartbeat<LifetimeIdentity>(join(testWorkspace.directory, 'second.jsonl'))).count).toBeGreaterThan(second.count + 3);
		} finally { await gate.release(); }
		await expect(peer.terminal.activeInstance).toHaveAttribute('data-state', 'running', { timeout: 30_000 });
		await peer.page.screenshot({ path: testInfo.outputPath(`terminal-window-peer-${locale}.png`) });
		const targetWindow = await application.browserWindow(target);
		await targetWindow.evaluate(window => window.close());
		await expect.poll(() => [second.pid, second.child, second.shell, ...hosts].filter(lifetimePidAlive)).toEqual([]);
		await testInfo.attach('terminal-window-cleanup-identities', { body: JSON.stringify({ first, second, hosts, survivingPids: [] }), contentType: 'application/json' });
	});

	for (const mode of ['quit', 'force-kill'] as const) test(`application ${mode} during backend loss cleans the shell, hangup-resistant jobs and lifetime helpers`, { tag: ['@electron-app-server'] }, async ({ application, workbench, testWorkspace }, testInfo) => {
		test.setTimeout(75_000);
		if (!('windows' in application)) throw new Error('Expected Electron');
		const file = await writeLifetimeFixture(testWorkspace.directory);
		await workbench.page.getByRole('button', { name: locale === 'zh-CN' ? '切换面板显示' : 'Toggle Panel Visibility', exact: true }).click();
		const command = await startLifetimeCommand(workbench, file, 'exit');
		const profile = await application.evaluate(() => process.env.ASH_HOME!);
		const hosts = await lifetimeHostPids(application, [command], profile);
		expect(hosts).toHaveLength(2);
		const mainPid = await application.evaluate(() => process.pid);
		const gate = await blockLifetimeBackend(application);
		try {
			await expect(workbench.terminal.activeInstance).toHaveAttribute('data-state', 'reconnecting');
			if (mode === 'force-kill') process.kill(mainPid, 'SIGKILL');
			else await application.evaluate(({ app }) => { app.quit(); }).catch(error => {
				if (!(error instanceof Error) || !error.message.includes('has been closed')) throw error;
			});
			await expect.poll(() => [mainPid, command.pid, command.child, command.shell, ...hosts].filter(lifetimePidAlive), { timeout: 20_000 }).toEqual([]);
		} finally { await gate.release(); }
		await testInfo.attach('terminal-application-cleanup-identities', { body: JSON.stringify({ mode, command, hosts, survivingPids: [] }), contentType: 'application/json' });
	});
});
