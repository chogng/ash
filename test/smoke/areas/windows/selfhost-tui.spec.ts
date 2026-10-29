import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isProcessRunning, registerRunResource } from '../../../../build/processes.ts';
import { expect, test } from '../../../automation/test.js';

const repository = resolve(import.meta.dirname, '../../../..');
const execute = promisify(execFile);

test('Ash debugs its real Code TUI in the integrated terminal', { tag: ['@electron-app-server'] }, async ({ workbench, testWorkspace, runningApplication }, info) => {
	test.skip(process.env.ASH_SELFHOST_ACCEPTANCE !== '1', 'Requires the Prepare Ash Code Debug task in this checkout.');
	test.setTimeout(180_000);
	const root = testWorkspace.directory;
	const launch = JSON.parse(await readFile(join(repository, '.vscode/launch.json'), 'utf8')) as { configurations: Array<Record<string, unknown>>; };
	const template = launch.configurations.find(candidate => candidate.name === 'Ash Code (TUI)');
	if (!template) throw new Error('Missing Ash Code self-host launch configuration');
	const configuration = JSON.parse(JSON.stringify(template).replaceAll('${workspaceFolder}', repository.replaceAll('\\', '/'))) as Record<string, unknown>;
	delete configuration.preLaunchTask; // The exact task is built before this opt-in acceptance run.
	configuration.cwd = root;
	configuration.stopOnEntry = false;
	const mainSource = await readFile(join(repository, 'cli/src/main.rs'), 'utf8');
	const entryLine = mainSource.split('\n').findIndex(line => line.includes('std::process::exit(ash_cli::run(')) + 1;
	if (!entryLine) throw new Error('Missing CLI entrypoint');
	// Workbench file URIs canonicalize the Windows drive to lowercase. LLDB's
	// reverse source-map lookup must use the same prefix for this copied source.
	const sourceRoot = root.replaceAll('\\', '/').replace(/^[A-Z]:/u, drive => drive.toLowerCase());
	configuration.sourceMap = { [repository.replaceAll('\\', '/')]: sourceRoot };
	const platform = configuration[process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'] as Record<string, unknown> | undefined;
	// Windows AF_UNIX limits include the daemon's run/ directory and socket ID.
	const profile = await mkdtemp(join(tmpdir(), 'ash-tui-'));
	const suffix = process.platform === 'win32' ? '.exe' : '';
	const daemon = join(repository, '.build/cargo/ci-test', `ash-app-server-daemon${suffix}`);
	const registration = await registerRunResource({ executable: daemon, profile });
	const environment = { ...(configuration.env as object), ...(platform?.env as object), ASH_HOME: profile, CODEX_HOME: join(root, 'codex'), ASH_ANNOUNCEMENT_URL: '' };
	await mkdir(environment.CODEX_HOME);
	configuration.env = environment;
	if (platform) platform.env = environment;
	await mkdir(join(root, '.vscode'), { recursive: true });
	await mkdir(join(root, 'cli/src'), { recursive: true });
	await writeFile(join(root, 'cli/src/main.rs'), mainSource);
	await writeFile(join(root, 'rust-toolchain.toml'), await readFile(join(repository, 'rust-toolchain.toml'), 'utf8'));
	await writeFile(join(root, '.vscode/launch.json'), JSON.stringify({ version: '0.2.0', configurations: [configuration] }));
	const page = workbench.page;
	const debug = page.locator('[data-view-container-id="ash.debug"]');
	try {
		await workbench.quickaccess.open('cli/src/main.rs');
		await workbench.quickaccess.select('main.rs');
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorContents(value => value.includes('ash_cli::run('));
		await editor.waitForEditorFocus();
		await editor.input.press('ControlOrMeta+Home');
		for (let line = 1; line < entryLine; line++) await editor.input.press('ArrowDown');
		await workbench.quickaccess.runCommand('editor.debug.action.toggleBreakpoint');
		await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
		const sidebar = page.locator('[data-part="sidebar"]');
		await expect(sidebar.getByRole('button', { name: /^Debug configuration:/ })).toContainText('Ash Code (TUI)');
		await sidebar.getByRole('button', { name: 'Start Debugging', exact: true }).click();
		await expect(debug.getByRole('status')).toContainText('stopped', { timeout: 60_000 });
		await expect(debug.locator('.ash-debug-stack')).toContainText('main');
		await expect(debug.locator('.ash-debug-variables')).toContainText('_package_lease', { timeout: 20_000 });
		await expect(editor.element.locator('.ash-debug-breakpoint-gutter.verified')).toHaveCount(1);
		await workbench.quickaccess.runCommand('workbench.debug.action.focusRepl');
		const output = await page.locator('.ash-debug-console-output').innerText();
		expect(output).not.toContain('RecursionError');
		expect(output).not.toContain('KeyboardInterrupt');
		const nativePid = Number(/Launched process (\d+)/u.exec(output)?.[1]);
		expect(nativePid).toBeGreaterThan(0);
		expect(isProcessRunning(nativePid)).toBe(true);
		await writeFile(info.outputPath('native-launch.log'), output);
		await info.attach('native-launch-output', { path: info.outputPath('native-launch.log'), contentType: 'text/plain' });
		await debug.getByRole('button', { name: 'Remove breakpoint', exact: true }).click();
		await debug.getByRole('button', { name: 'Continue', exact: true }).click();
		await expect(debug.getByRole('status')).toContainText('running');
		await page.getByRole('tab', { name: 'Terminal', exact: true }).first().click();
		const terminal = workbench.terminal.activeInstance;
		await expect(terminal).toContainText('Ash Code v', { timeout: 60_000 });
		const input = terminal.locator('.xterm-helper-textarea');
		await input.focus();
		await input.pressSequentially('/help');
		await input.press('Enter');
		await expect(terminal).toContainText('Search help');
		await page.screenshot({ path: info.outputPath('tui-native-debug.png') });
		if (!await debug.isVisible()) await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
		await debug.getByRole('button', { name: 'Stop', exact: true }).click();
		await expect(debug.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
		await expect.poll(() => isProcessRunning(nativePid)).toBe(false);
	} finally {
		const logs = await readdir(join(profile, 'run')).catch(() => [] as string[]);
		for (const log of logs.filter(log => log.endsWith('.log'))) {
			await writeFile(info.outputPath(`native-${log}`), await readFile(join(profile, 'run', log)));
		}
		const terminalTab = page.getByRole('tab', { name: 'Terminal', exact: true }).first();
		if (await terminalTab.isVisible().catch(() => false)) await terminalTab.click({ timeout: 2_000 }).catch(() => { });
		await writeFile(info.outputPath('native-terminal.log'), await workbench.terminal.activeInstance.innerText({ timeout: 2_000 }).catch(() => ''));
		await workbench.quickaccess.runCommand('workbench.debug.action.focusRepl').catch(() => { });
		await writeFile(info.outputPath('native-completion.log'), await page.locator('.ash-debug-console-output').textContent().catch(() => '') ?? '');
		const stop = debug.getByRole('button', { name: 'Stop', exact: true });
		if (await stop.isVisible().catch(() => false)) await stop.click({ timeout: 5_000 }).catch(() => { });
		// The integrated terminal owns the launch shell and its descendants. End
		// those clients before stopping their daemon, otherwise they can reconnect
		// while Windows is still releasing the profile's SQLite mappings.
		if (await workbench.terminal.instances.count()) {
			await terminalTab.click();
			await workbench.quickaccess.runCommand('workbench.action.terminal.kill');
			await expect(workbench.terminal.instances).toHaveCount(0);
		}
		await runningApplication.close();
		await execute(daemon, ['stop'], { env: { ...process.env, ASH_HOME: profile, ASH_APP_SERVER_PATH: join(repository, '.build/cargo/ci-test', `ash-app-server${suffix}`) }, windowsHide: true, timeout: 30_000 });
		await registration.dispose();
		const owned = relative(tmpdir(), profile);
		if (isAbsolute(owned) || !owned.startsWith('ash-tui-') || owned.includes('..')) throw new Error('Unsafe TUI profile cleanup path');
		await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
