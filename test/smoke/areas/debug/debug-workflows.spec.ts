import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Workbench } from '../../../automation/workbench.js';
import { readUserSettings } from '../../../automation/settings.js';
import { expect, test } from '../../../automation/test.js';

const tags = { tag: ['@electron-app-server'] };
// Retain the actual Debug boundary on failure; this observer never alters frames.
test.beforeEach(async ({ workbench }) => {
	await workbench.page.evaluate(() => {
		const saved = MessagePort.prototype.postMessage;
		const pending = new Map<number, string>();
		const listeners = new Map<MessagePort, EventListener>();
		const frames: unknown[] = [];
		const bytes = (value: unknown) => value && typeof value === 'object' && 'data' in value && value.data instanceof Uint8Array ? value.data : undefined;
		const redact = (value: unknown): unknown => {
			if (Array.isArray(value)) return value.map(redact);
			if (!value || typeof value !== 'object') return value;
			return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /token|secret|password|credential|authorization|api.?key|VSCODE_INSPECTOR_OPTIONS|ASH_JS_DEBUG/i.test(key) ? '<redacted>' : redact(entry)]));
		};
		const append = (value: unknown) => { frames.push(redact(value)); if (frames.length > 512) frames.shift(); };
		MessagePort.prototype.postMessage = function (message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
			const raw = bytes(message);
			if (raw) {
				const request = JSON.parse(new TextDecoder().decode(raw)) as { id: number; method?: string; error?: unknown; };
				if (request.error !== undefined) append({ clientResponse: request });
				if (request.method?.startsWith('debug/') && request.method !== 'debug/workspace/read') { pending.set(request.id, request.method); if (!['debug/adapter/read', 'debug/session/breakpoints/read', 'debug/session/console/read', 'debug/session/lifecycle', 'debug/session/response', 'debug/session/inspection/read'].includes(request.method)) append(request); }
				if (!listeners.has(this)) {
					let buffer = '';
					const observer: EventListener = event => {
						if (!(event instanceof MessageEvent)) return;
						const raw = bytes(event.data); if (!raw) return;
						buffer += new TextDecoder().decode(raw);
						let end: number;
						while ((end = buffer.indexOf('\n')) >= 0) {
							const frame = JSON.parse(buffer.slice(0, end)) as { id?: number; method?: string; }; buffer = buffer.slice(end + 1);
							if (frame.id !== undefined && pending.has(frame.id)) { const method = pending.get(frame.id)!; const result = (frame as { result?: { messages?: unknown[]; }; }).result; if (method === 'debug/adapter/read') { if (result?.messages?.length) append({ method, messages: result.messages.filter(entry => { const message = (entry as { message: { command?: string; type?: string; }; }).message; return message.type !== 'response' || !['variables', 'scopes', 'stackTrace', 'threads'].includes(message.command ?? ''); }) }); } else if (!['debug/session/breakpoints/read', 'debug/session/console/read', 'debug/session/lifecycle', 'debug/session/response', 'debug/session/inspection/read'].includes(method)) append({ method, response: frame }); pending.delete(frame.id); }
							else if (frame.method?.startsWith('debug/') || frame.method === 'extensionClient/request' && (frame as { params?: { operation?: { operation?: string; }; }; }).params?.operation?.operation !== 'readTerminal') append(frame);
						}
					};
					listeners.set(this, observer); this.addEventListener('message', observer);
				}
			}
			Reflect.apply(saved, this, options === undefined ? [message] : [message, options]);
		};
		Object.assign(globalThis, { debugWorkflowTrace: { frames, dispose: () => { MessagePort.prototype.postMessage = saved; for (const [port, listener] of listeners) port.removeEventListener('message', listener); } } });
	});
});
test.afterEach(async ({ workbench }, info) => {
	const frames = workbench.page.isClosed() ? [] : await workbench.page.evaluate(() => { const trace = (globalThis as typeof globalThis & { debugWorkflowTrace?: { frames: unknown[]; dispose(): void; }; }).debugWorkflowTrace; trace?.dispose(); return trace?.frames ?? []; });
	const path = info.outputPath('debug-workflow-boundary.json');
	await writeFile(path, JSON.stringify(frames, null, 2));
	await info.attach('debug-workflow-boundary', { path, contentType: 'application/json' });
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };

function terminalNodeCommand(script: string): string {
	const args = [process.execPath, script];
	return process.platform === 'win32'
		? args.map(argument => `"${argument}"`).join(' ')
		: args.map(argument => `'${argument.replaceAll("'", "'\\''")}'`).join(' ');
}

async function disableProvider(workbench: Workbench): Promise<void> {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
	const search = page.getByRole('searchbox', { name: 'Search extensions', exact: true });
	await search.fill('@installed ash.debug-javascript');
	await search.press('Enter');
	const plugins = page.getByRole('listbox', { name: 'Plugins', exact: true });
	await plugins.locator('[data-package-id="ash.debug-javascript"]').click();
	await plugins.press('Enter');
	const editor = page.locator('.ash-extension-editor:visible').filter({ hasText: 'ash.debug-javascript' });
	const enabled = editor.getByRole('switch');
	await expect(enabled).toBeChecked();
	await enabled.press('Space');
	await expect(enabled).not.toBeChecked();
}

for (const configurationName of ['Ash', 'Ash Agents', 'Ash (Hot Reload)']) test(`node-terminal ${configurationName} retains child debugging after preparation and releases it on stop`, tags, async ({ workbench, testWorkspace }) => {
	test.setTimeout(90_000);
	const root = testWorkspace.directory;
	const launch = JSON.parse(await readFile(join(import.meta.dirname, '../../../../.vscode/launch.json'), 'utf8')) as { configurations: Array<{ name: string; }>; };
	const configuration = launch.configurations.find(candidate => candidate.name === configurationName);
	if (!configuration) throw new Error('Missing Ash self-host launch configuration');
	await mkdir(join(root, '.vscode'), { recursive: true });
	await writeFile(join(root, '.vscode/launch.json'), JSON.stringify({ version: '0.2.0', configurations: [configuration] }));
	// Leave no inspected child alive between lifecycle scripts. The parent
	// terminal session must retain the connection while native pnpm runs its shell delay.
	const delay = process.platform === 'win32' ? 'ping -n 2 127.0.0.1 >NUL' : 'sleep 1';
	await writeFile(join(root, 'package.json'), JSON.stringify({
		private: true, scripts: {
			predev: `${JSON.stringify(process.execPath)} prepare.cjs`,
			dev: `${delay} && ${JSON.stringify(process.execPath)} main.cjs`,
			'dev:agents': 'pnpm run dev',
			'dev:ui:connected': 'pnpm run dev',
		}
	}));
	await writeFile(join(root, 'prepare.cjs'), "require('node:fs').writeFileSync('prepare.pid', String(process.pid));\n");
	await writeFile(join(root, 'main.cjs'), "const answer = 42;\nrequire('node:fs').writeFileSync('child.pid', String(process.pid));\ndebugger;\nconsole.log(answer);\nsetInterval(() => {}, 1000);\n");
	const page = workbench.page;
	const pane = page.locator('[data-view-container-id="ash.debug"]');
	if (!await pane.isVisible()) await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const sidebar = page.locator('[data-part="sidebar"]');
	await expect(sidebar.getByRole('button', { name: /^Debug configuration:/ })).toContainText(configurationName);
	await sidebar.getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await expect(pane.getByRole('status')).toContainText('stopped', { timeout: 30_000 });
	await expect(pane.locator('.ash-debug-variables')).toContainText('answer');
	await expect(pane.locator('.ash-debug-variables')).toContainText('42');
	const preparationPid = Number(await readFile(join(root, 'prepare.pid'), 'utf8'));
	expect(alive(preparationPid)).toBe(false);
	const pid = Number(await readFile(join(root, 'child.pid'), 'utf8'));
	expect(alive(pid)).toBe(true);
	await workbench.quickaccess.runCommand('workbench.action.debug.stopAll');
	await expect.poll(() => alive(pid)).toBe(false);
	await expect(pane.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
});

test.describe('node-terminal with global Auto Attach', () => {
	test.use({ electronUserSettings: { 'debug.javascript.autoAttachFilter': 'always' } });
	test('node-terminal survives completed and failed commands, closes children, relaunches and retires', tags, async ({ workbench, testWorkspace }) => {
		test.setTimeout(120_000);
		const root = testWorkspace.directory;
		await mkdir(join(root, '.vscode'), { recursive: true });
		await writeFile(join(root, '.vscode/launch.json'), JSON.stringify({ version: '0.2.0', configurations: [{ name: 'Terminal lifecycle', type: 'node-terminal', request: 'launch', command: 'pnpm dev', env: { TERMINAL_TEST: 'two words', NODE_OPTIONS: '--no-warnings' } }] }));
		await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, scripts: { predev: `${JSON.stringify(process.execPath)} prepare.cjs`, dev: `${JSON.stringify(process.execPath)} complete.cjs` } }));
		await writeFile(join(root, 'prepare.cjs'), 'process.exit(0);\n');
		await writeFile(join(root, 'fail.cjs'), 'process.exit(7);\n');
		await writeFile(join(root, 'complete.cjs'), "require('node:fs').appendFileSync('starts.jsonl', JSON.stringify({pid:process.pid, inspector:!!require('node:inspector').url(),env:process.env.TERMINAL_TEST})+'\\n');\n");
		await writeFile(join(root, 'hold.cjs'), "require('node:fs').appendFileSync('held.jsonl', JSON.stringify({pid:process.pid,inspector:!!require('node:inspector').url()})+'\\n');setInterval(()=>{},1000);\n");
		const read = async (name: string): Promise<Array<{ pid: number; inspector: boolean; env?: string; }>> => {
			try { return (await readFile(join(root, name), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); } catch { return []; }
		};
		const page = workbench.page;
		await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
		const pane = page.locator('[data-view-container-id="ash.debug"]');
		await expect(page.locator('[data-part="sidebar"]').getByRole('button', { name: /^Debug configuration:/ })).toContainText('Terminal lifecycle');
		await workbench.quickaccess.runCommand('workbench.action.debug.start');
		await expect.poll(async () => (await read('starts.jsonl')).length, { timeout: 30_000 }).toBe(1);
		await page.getByRole('tab', { name: 'Terminal', exact: true }).first().click();
		await workbench.terminal.runCommand('pnpm dev');
		await expect.poll(async () => (await read('starts.jsonl')).length, { timeout: 30_000 }).toBe(2);
		for (const start of await read('starts.jsonl')) { expect(start.inspector).toBe(true); expect(start.env).toBe('two words'); }
		await workbench.terminal.runCommand(terminalNodeCommand(join(root, 'hold.cjs')));
		await expect.poll(async () => (await read('held.jsonl')).length, { timeout: 30_000 }).toBe(1);
		const first = (await read('held.jsonl'))[0]!;
		expect(first.inspector).toBe(true);
		await page.getByRole('button', { name: 'Kill Terminal', exact: true }).click();
		await expect.poll(() => alive(first.pid)).toBe(false);
		await expect(pane.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
		await workbench.quickaccess.runCommand('workbench.action.debug.start');
		await expect.poll(async () => (await read('starts.jsonl')).length, { timeout: 30_000 }).toBe(3);
		await page.getByRole('tab', { name: 'Terminal', exact: true }).first().click();
		await workbench.terminal.runCommand(`${terminalNodeCommand(join(root, 'fail.cjs'))}; echo LIFECYCLE_OK`);
		await expect(workbench.terminal.activeInstance).toContainText('LIFECYCLE_OK');
		await workbench.terminal.runCommand(terminalNodeCommand(join(root, 'hold.cjs')));
		await expect.poll(async () => (await read('held.jsonl')).length, { timeout: 30_000 }).toBe(2);
		const second = (await read('held.jsonl'))[1]!;
		await disableProvider(workbench);
		await expect.poll(() => alive(second.pid)).toBe(false);
		await expect(workbench.terminal.instances).toHaveCount(0);
	});

});

test('Rust JavaScript provider debugs TypeScript source maps, variables and stepping', tags, async ({ workbench, testWorkspace }) => {
	test.setTimeout(90_000);
	const root = testWorkspace.directory;
	await mkdir(join(root, '.vscode'), { recursive: true });
	await mkdir(join(root, 'dist'));
	const source = 'const answer: number = 40;\nconst increment: number = 2;\nconst result: number = answer + increment;\nconsole.log(result);\nconsole.log(result);\nsetInterval(() => {}, 1000);\n';
	await writeFile(join(root, 'main.ts'), source);
	await writeFile(join(root, 'dist/main.js'), source.replaceAll(': number', '') + '\n//# sourceMappingURL=main.js.map\n');
	await writeFile(join(root, 'dist/main.js.map'), JSON.stringify({ version: 3, file: 'main.js', sourceRoot: '', sources: ['../main.ts'], sourcesContent: [source], names: [], mappings: 'AAAA;AACA;AACA;AACA;AACA;AACA' }));
	await writeFile(join(root, '.vscode/launch.json'), JSON.stringify({ version: '0.2.0', configurations: [{ name: 'Rust JS source maps', type: 'node', request: 'launch', runtimeExecutable: process.execPath, program: '${workspaceFolder}/dist/main.js', cwd: '${workspaceFolder}', outFiles: ['${workspaceFolder}/dist/**/*.js'], sourceMaps: true, console: 'internalConsole' }] }));
	const page = workbench.page;
	await workbench.quickaccess.open('main.ts');
	await workbench.quickaccess.select('main.ts');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await editor.input.press('ControlOrMeta+Home');
	for (let line = 1; line < 4; line++) await editor.input.press('ArrowDown');
	await workbench.quickaccess.runCommand('editor.debug.action.toggleBreakpoint');
	await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const pane = page.locator('[data-view-container-id="ash.debug"]');
	await expect(page.locator('[data-part="sidebar"]').getByRole('button', { name: /^Debug configuration:/ })).toContainText('Rust JS source maps');
	await page.locator('[data-part="sidebar"]').getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await expect(pane.getByRole('status')).toContainText('stopped', { timeout: 30_000 });
	await expect(page.getByRole('tab', { name: /main\.ts$/, selected: true })).toBeVisible();
	await expect(pane.locator('.ash-debug-variables')).toContainText('result');
	await expect(pane.locator('.ash-debug-variables')).toContainText('42');
	await expect(pane.locator('.ash-debug-frame.selected')).toContainText('main.ts:4');
	await pane.getByRole('button', { name: 'Step Over', exact: true }).click();
	await expect(pane.locator('.ash-debug-frame.selected')).toContainText('main.ts:5');
	await pane.getByRole('button', { name: 'Stop', exact: true }).click();
	await expect(pane.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
});

for (const consoleMode of ['internalConsole', 'integratedTerminal']) test(`Rust server-ready launches one child from ${consoleMode} and stops it with its server`, tags, async ({ workbench, testWorkspace }) => {
	test.setTimeout(90_000);
	const root = testWorkspace.directory;
	await mkdir(join(root, '.vscode'), { recursive: true });
	await writeFile(join(root, 'server.cjs'), "require('node:fs').writeFileSync('server.pid', String(process.pid));\nprocess.stdout.write('\\x1b[32mASH_SERVER_');\nsetTimeout(() => { console.log('READY 4567\\x1b[0m'); console.log('ASH_SERVER_READY 4567'); }, 100);\nsetInterval(() => {}, 1000);\n");
	await writeFile(join(root, 'client.cjs'), "require('node:fs').appendFileSync('client-starts.jsonl', JSON.stringify({pid:process.pid})+'\\n');\nsetInterval(() => {}, 1000);\n");
	await writeFile(join(root, '.vscode/launch.json'), JSON.stringify({
		version: '0.2.0', configurations: [
			{ name: 'Rust server ready', type: 'node', request: 'launch', runtimeExecutable: process.execPath, program: '${workspaceFolder}/server.cjs', cwd: '${workspaceFolder}', console: consoleMode, serverReadyAction: { action: 'startDebugging', pattern: 'ASH_SERVER_READY (\\d+)', name: 'Rust ready child', killOnServerStop: true } },
			{ name: 'Rust ready child', type: 'node', request: 'launch', runtimeExecutable: process.execPath, program: '${workspaceFolder}/client.cjs', cwd: '${workspaceFolder}', console: 'internalConsole' }
		]
	}));
	const page = workbench.page;
	await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const pane = page.locator('[data-view-container-id="ash.debug"]');
	await expect(page.locator('[data-part="sidebar"]').getByRole('button', { name: /^Debug configuration:/ })).toContainText('Rust server ready');
	await page.locator('[data-part="sidebar"]').getByRole('button', { name: 'Start Debugging', exact: true }).click();
	const starts = async () => { try { return (await readFile(join(root, 'client-starts.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { pid: number; }); } catch { return []; } };
	await expect.poll(async () => (await starts()).length, { timeout: 30_000 }).toBe(1);
	const client = (await starts())[0]!.pid;
	const server = Number(await readFile(join(root, 'server.pid'), 'utf8'));
	expect(alive(client)).toBe(true);
	// The selected child routes Stop through its managed parent relationship.
	await pane.getByRole('button', { name: 'Stop', exact: true }).click();
	await expect.poll(() => alive(client) || alive(server)).toBe(false);
	expect(await starts()).toHaveLength(1);
	await expect(pane.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
});

test.describe('Rust terminal auto attach', () => {
	test.use({ electronUserSettings: { 'debug.javascript.autoAttachFilter': 'always' } });
	test('attaches before Node executes and releases the process on stop', tags, async ({ workbench, testWorkspace }) => {
		test.setTimeout(90_000);
		const root = testWorkspace.directory;
		await writeFile(join(root, 'auto.cjs'), "const answer = 42;\nrequire('node:fs').writeFileSync('auto.pid', String(process.pid));\ndebugger;\nconsole.log(answer);\nsetInterval(() => {}, 1000);\n");
		await workbench.quickaccess.runCommand('workbench.action.terminal.new');
		await workbench.terminal.runCommand(terminalNodeCommand(join(root, 'auto.cjs')));
		const page = workbench.page;
		await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
		const pane = page.locator('[data-view-container-id="ash.debug"]');
		await expect(pane.getByRole('status')).toContainText('stopped', { timeout: 30_000 });
		await expect(pane.locator('.ash-debug-variables')).toContainText('answer');
		await expect(pane.locator('.ash-debug-variables')).toContainText('42');
		const pid = Number(await readFile(join(root, 'auto.pid'), 'utf8'));
		await workbench.quickaccess.runCommand('workbench.action.debug.stopAll');
		// Attach stop disconnects without terminating a process owned by the terminal.
		expect(alive(pid)).toBe(true);
		await page.getByRole('tab', { name: 'Terminal', exact: true }).first().click();
		await workbench.terminal.activeInstance.locator('.xterm-helper-textarea').press('Control+C');
		await expect.poll(() => alive(pid)).toBe(false);
		// The old shell still has its inherited environment. Retiring the provider
		// must reject those credentials and release Inspector instead of hanging it.
		await disableProvider(workbench);
		await expect(page.getByRole('button', { name: /^Auto Attach:/u })).toHaveCount(0);
		await writeFile(join(root, 'revoked.cjs'), "require('node:fs').writeFileSync('revoked.pid', String(process.pid)); debugger; setInterval(() => {}, 1000);\n");
		await page.getByRole('tab', { name: 'Terminal', exact: true }).first().click();
		await workbench.terminal.runCommand(terminalNodeCommand(join(root, 'revoked.cjs')));
		await expect.poll(async () => readFile(join(root, 'revoked.pid'), 'utf8').catch(() => '')).toMatch(/^\d+$/);
		const unbound = Number(await readFile(join(root, 'revoked.pid'), 'utf8'));
		await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
		await expect(pane.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
		await page.getByRole('tab', { name: 'Terminal', exact: true }).first().click();
		await workbench.terminal.activeInstance.locator('.xterm-helper-textarea').press('Control+C');
		await expect.poll(() => alive(unbound)).toBe(false);
	});
});

test('Rust auto attach controls persist modes and pause and resume in existing terminals', tags, async ({ workbench, reloadWorkbench, testWorkspace }) => {
	test.setTimeout(150_000);
	const root = testWorkspace.directory;
	let page = workbench.page;
	const autoAttach = () => page.getByRole('button', { name: /^Auto Attach:/u });
	const userMode = async () => JSON.parse((await readUserSettings(page)).content)['debug.javascript.autoAttachFilter'] as string | undefined;
	const choose = async (label: string, scope = 'User Settings') => {
		const input = page.getByRole('combobox', { name: `Toggle Auto Attach (${scope})`, exact: true });
		await expect(input).toBeFocused();
		await input.fill(label);
		await input.press('Control+Home');
		const active = page.locator(`[id="${await input.getAttribute('aria-activedescendant')}"] .ash-quick-pick-row-label`);
		await expect(active).toHaveText(label);
		await input.press('Enter');
	};
	await expect(autoAttach()).toHaveCount(0);
	await workbench.quickaccess.runCommand('ash.debug-javascript.toggleAutoAttach');
	await expect(page.getByRole('combobox', { name: 'Toggle Auto Attach (User Settings)', exact: true })).toBeFocused();
	await page.keyboard.press('Escape');
	expect(await userMode()).toBeUndefined();
	await workbench.quickaccess.runCommand('ash.debug-javascript.toggleAutoAttach');
	await choose('Always');
	await expect(autoAttach()).toHaveText('Auto Attach: Always');
	await expect.poll(userMode).toBe('always');
	// Status bar uses the same keyboard-operated picker and restores focus on cancellation.
	await autoAttach().focus();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('combobox', { name: 'Toggle Auto Attach (User Settings)', exact: true })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(autoAttach()).toBeFocused();
	await mkdir(join(root, '.vscode'), { recursive: true });
	await autoAttach().click();
	await choose('Use Workspace Settings');
	await choose('Smart', 'Workspace Settings');
	await expect(autoAttach()).toHaveText('Auto Attach: Smart');
	const workspaceMode = async () => JSON.parse(await readFile(join(root, '.vscode/settings.json'), 'utf8'))['debug.javascript.autoAttachFilter'] as string;
	await expect.poll(workspaceMode).toBe('smart');
	expect(await userMode()).toBe('always');
	await autoAttach().click();
	await choose('Only With Flag', 'Workspace Settings');
	await expect.poll(workspaceMode).toBe('onlyWithFlag');
	await expect(autoAttach()).toHaveText('Auto Attach: Only With Flag');
	await autoAttach().click();
	await choose('Always', 'Workspace Settings');
	await expect(autoAttach()).toHaveText('Auto Attach: Always');
	const savedSettings = await readFile(join(root, '.vscode/settings.json'), 'utf8');
	await writeFile(join(root, 'auto.cjs'), "const answer = 42;\nrequire('node:fs').writeFileSync('auto.pid', String(process.pid));\ndebugger;\nsetInterval(() => {}, 1000);\n");
	await writeFile(join(root, 'paused.cjs'), "debugger; require('node:fs').writeFileSync('paused.done', 'ran without attachment');\n");
	await workbench.quickaccess.runCommand('workbench.action.terminal.new');
	const runNode = async (file: string) => workbench.terminal.runCommand(terminalNodeCommand(join(root, file)));
	await runNode('auto.cjs');
	const pane = page.locator('[data-view-container-id="ash.debug"]');
	if (!await pane.isVisible()) await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	await expect(pane.getByRole('status')).toContainText('stopped', { timeout: 30_000 });
	await expect(pane.locator('.ash-debug-variables')).toContainText('42');
	const pid = Number(await readFile(join(root, 'auto.pid'), 'utf8'));
	await autoAttach().click();
	await choose('Temporarily Disable Auto Attach', 'Workspace Settings');
	await expect(autoAttach()).toHaveText('Auto Attach: Temporarily Disabled');
	await expect(pane.getByRole('status')).toContainText('stopped');
	expect(await readFile(join(root, '.vscode/settings.json'), 'utf8')).toBe(savedSettings);
	await workbench.quickaccess.runCommand('workbench.action.debug.stopAll');
	expect(alive(pid)).toBe(true);
	await page.getByRole('tab', { name: 'Terminal', exact: true }).first().click();
	await workbench.terminal.activeInstance.locator('.xterm-helper-textarea').press('Control+C');
	await expect.poll(() => alive(pid)).toBe(false);
	await runNode('paused.cjs');
	await expect.poll(() => readFile(join(root, 'paused.done'), 'utf8').catch(() => '')).toBe('ran without attachment');
	await expect(autoAttach()).toHaveText('Auto Attach: Temporarily Disabled');
	// A terminal created while paused must retain the preload and must not clear the pause.
	await workbench.quickaccess.runCommand('workbench.action.terminal.new');
	await expect(autoAttach()).toHaveText('Auto Attach: Temporarily Disabled');
	await autoAttach().click();
	await choose('Re-enable Auto Attach', 'Workspace Settings');
	await expect(autoAttach()).toHaveText('Auto Attach: Always');
	await runNode('auto.cjs');
	if (!await pane.isVisible()) await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	await expect(pane.getByRole('status')).toContainText('stopped', { timeout: 30_000 });
	const resumedPid = Number(await readFile(join(root, 'auto.pid'), 'utf8'));
	await workbench.quickaccess.runCommand('workbench.action.debug.stopAll');
	await page.getByRole('tab', { name: 'Terminal', exact: true }).first().click();
	await workbench.terminal.activeInstance.locator('.xterm-helper-textarea').press('Control+C');
	await expect.poll(() => alive(resumedPid)).toBe(false);
	await autoAttach().click();
	await choose('Temporarily Disable Auto Attach', 'Workspace Settings');
	await expect(autoAttach()).toHaveText('Auto Attach: Temporarily Disabled');
	({ workbench } = await reloadWorkbench());
	page = workbench.page;
	await expect(autoAttach()).toHaveText('Auto Attach: Always');
	expect(await workspaceMode()).toBe('always');
	await autoAttach().click();
	await choose('Disabled', 'Workspace Settings');
	await expect(autoAttach()).toHaveCount(0);
	await expect.poll(workspaceMode).toBe('disabled');
});

test('Rust JavaScript provider releases launched processes when its authority is disabled', tags, async ({ workbench, testWorkspace }) => {
	const root = testWorkspace.directory;
	await mkdir(join(root, '.vscode'), { recursive: true });
	await writeFile(join(root, 'owned.cjs'), "require('node:fs').writeFileSync('owned.pid', String(process.pid)); setInterval(() => {}, 1000);\n");
	await writeFile(join(root, '.vscode/launch.json'), JSON.stringify({ version: '0.2.0', configurations: [{ name: 'Provider lifetime', type: 'node', request: 'launch', runtimeExecutable: process.execPath, program: '${workspaceFolder}/owned.cjs', cwd: '${workspaceFolder}', console: 'internalConsole' }] }));
	await workbench.quickaccess.runCommand('workbench.action.debug.start');
	await expect.poll(async () => readFile(join(root, 'owned.pid'), 'utf8').catch(() => '')).toMatch(/^\d+$/);
	const pid = Number(await readFile(join(root, 'owned.pid'), 'utf8'));
	await disableProvider(workbench);
	await expect.poll(() => alive(pid)).toBe(false);
	await workbench.page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	await expect(workbench.page.locator('[data-view-container-id="ash.debug"]').getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
});

test('Rust JavaScript provider releases a launched target when its window connection reloads', tags, async ({ workbench, reloadWorkbench, testWorkspace }) => {
	const root = testWorkspace.directory;
	await mkdir(join(root, '.vscode'), { recursive: true });
	await writeFile(join(root, 'connection.cjs'), "require('node:fs').writeFileSync('connection.pid', String(process.pid)); setInterval(() => {}, 1000);\n");
	await writeFile(join(root, '.vscode/launch.json'), JSON.stringify({ version: '0.2.0', configurations: [{ name: 'Connection lifetime', type: 'node', request: 'launch', runtimeExecutable: process.execPath, program: '${workspaceFolder}/connection.cjs', cwd: '${workspaceFolder}', console: 'internalConsole' }] }));
	await workbench.quickaccess.runCommand('workbench.action.debug.start');
	await expect.poll(async () => readFile(join(root, 'connection.pid'), 'utf8').catch(() => '')).toMatch(/^\d+$/);
	const pid = Number(await readFile(join(root, 'connection.pid'), 'utf8'));
	({ workbench } = await reloadWorkbench());
	await expect.poll(() => alive(pid)).toBe(false);
	const pane = workbench.page.locator('[data-view-container-id="ash.debug"]');
	if (!await pane.isVisible()) await workbench.page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	await expect(pane).toBeVisible();
	await expect(pane.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
});

test('Rust server-ready opens its matching URL once through the native opener', tags, async ({ application, workbench, testWorkspace }) => {
	if (!('windows' in application)) throw new Error('Native opener acceptance requires Electron');
	await application.evaluate(({ shell }) => {
		const saved = shell.openExternal;
		const urls: string[] = [];
		Object.assign(globalThis, { debugWorkflowOpener: { urls, restore: () => { shell.openExternal = saved; } } });
		shell.openExternal = async url => { urls.push(url); };
	});
	try {
		const root = testWorkspace.directory;
		await mkdir(join(root, '.vscode'), { recursive: true });
		await writeFile(join(root, 'open.cjs'), "console.log('READY 4567'); console.log('READY 4567'); setInterval(() => {}, 1000);\n");
		await writeFile(join(root, '.vscode/launch.json'), JSON.stringify({ version: '0.2.0', configurations: [{ name: 'Server URL', type: 'node', request: 'launch', runtimeExecutable: process.execPath, program: '${workspaceFolder}/open.cjs', cwd: '${workspaceFolder}', console: 'internalConsole', serverReadyAction: { action: 'openExternally', pattern: 'READY (\\d+)', uriFormat: 'http://localhost:%s/status' } }] }));
		await workbench.quickaccess.runCommand('workbench.action.debug.start');
		await expect.poll(async () => application.evaluate(() => (globalThis as typeof globalThis & { debugWorkflowOpener: { urls: string[]; }; }).debugWorkflowOpener.urls)).toEqual(['http://localhost:4567/status']);
		await workbench.quickaccess.runCommand('workbench.action.debug.stopAll');
	} finally {
		await application.evaluate(() => (globalThis as typeof globalThis & { debugWorkflowOpener: { restore(): void; }; }).debugWorkflowOpener.restore());
	}
});

test('Rust debug workflow errors and accessibility help follow Chinese display language', tags, async ({ workbench, restartWorkbench, testWorkspace }) => {
	test.setTimeout(90_000);
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ workbench } = await restartWorkbench());
	await workbench.quickaccess.runCommand('ash.debug-javascript.toggleAutoAttach');
	const autoAttachPicker = workbench.page.getByRole('combobox', { name: '切换自动附加（用户设置）', exact: true });
	await expect(autoAttachPicker).toBeFocused();
	await autoAttachPicker.fill('始终');
	await autoAttachPicker.press('Control+Home');
	await autoAttachPicker.press('Enter');
	const autoAttach = workbench.page.getByRole('button', { name: /^自动附加:/u });
	await expect(autoAttach).toHaveText('自动附加: 始终');
	await autoAttach.focus();
	await workbench.page.keyboard.press('Enter');
	await expect(autoAttachPicker).toBeFocused();
	await autoAttachPicker.fill('临时禁用自动附加');
	await autoAttachPicker.press('Control+Home');
	await autoAttachPicker.press('Enter');
	await expect(autoAttach).toHaveText('自动附加: 已临时禁用');
	await autoAttach.click();
	await autoAttachPicker.fill('重新启用自动附加');
	await autoAttachPicker.press('Control+Home');
	await autoAttachPicker.press('Enter');
	await expect(autoAttach).toHaveText('自动附加: 始终');
	await autoAttach.click();
	await autoAttachPicker.fill('已禁用');
	await autoAttachPicker.press('Control+Home');
	await autoAttachPicker.press('Enter');
	await expect(autoAttach).toHaveCount(0);
	const root = testWorkspace.directory;
	await mkdir(join(root, '.vscode'), { recursive: true });
	await writeFile(join(root, 'locale.cjs'), 'setInterval(() => {}, 1000);\n');
	await writeFile(join(root, '.vscode/launch.json'), JSON.stringify({ version: '0.2.0', configurations: [{ name: '中文工作流', type: 'node', request: 'launch', runtimeExecutable: process.execPath, program: '${workspaceFolder}/locale.cjs', cwd: '${workspaceFolder}', console: 'internalConsole', serverReadyAction: { action: 'openExternally', pattern: '(unsupported)\\1' } }] }));
	const pane = workbench.page.locator('[data-view-container-id="ash.debug"]');
	if (!await pane.isVisible()) await workbench.page.getByRole('tab', { name: '运行和调试', exact: true }).first().click();
	const sidebar = workbench.page.locator('[data-part="sidebar"]');
	await expect(sidebar.getByRole('button', { name: '调试配置：中文工作流', exact: true })).toBeVisible();
	await sidebar.getByRole('button', { name: '启动调试', exact: true }).click();
	await expect(workbench.page.getByRole('article').filter({ hasText: '服务就绪配置无效或正则表达式不受支持' })).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.debug.stopAll');
	if (!await pane.isVisible()) await workbench.page.getByRole('tab', { name: '运行和调试', exact: true }).first().click();
	const heading = pane.getByRole('button', { name: '变量', exact: true });
	await heading.focus();
	await workbench.page.keyboard.press('Alt+F1');
	const help = workbench.page.getByRole('dialog', { name: '无障碍帮助', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/新建集成终端以自动附加[\s\S]*停止调试会分离已附加的终端程序/u);
	await expect(help.getByRole('textbox')).toHaveValue(/node-terminal[\s\S]*准备脚本退出后仍然有效[\s\S]*父调试会话/u);
	await expect(help.getByRole('textbox')).toHaveValue(/切换自动附加[\s\S]*临时禁用自动附加[\s\S]*同一终端恢复/u);
	await workbench.page.keyboard.press('Escape');
	await expect(heading).toBeFocused();
});
