import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Workbench } from '../../../automation/workbench.js';
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
				const request = JSON.parse(new TextDecoder().decode(raw)) as { id: number; method?: string; };
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
							else if (frame.method?.startsWith('debug/')) append(frame);
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
	await info.attach('debug-workflow-boundary', { body: JSON.stringify(frames, null, 2), contentType: 'application/json' });
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };

async function disableProvider(workbench: Workbench): Promise<void> {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
	const search = page.getByRole('searchbox', { name: 'Search extensions', exact: true });
	await search.fill('@installed ash.debug-javascript');
	await search.press('Enter');
	const plugins = page.getByRole('listbox', { name: 'Plugins', exact: true });
	await plugins.getByRole('option').filter({ has: page.getByText('ash.debug-javascript', { exact: true }) }).click();
	await plugins.press('Enter');
	const editor = page.locator('.ash-extension-editor').filter({ has: page.getByRole('heading', { name: 'ash.debug-javascript', exact: true }) });
	await editor.getByRole('button', { name: 'Disable', exact: true }).click();
	await expect(editor.getByRole('button', { name: 'Enable', exact: true })).toBeEnabled();
}

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
		await workbench.terminal.runCommand(`'${process.execPath.replaceAll("'", "'\\''")}' '${join(root, 'auto.cjs').replaceAll("'", "'\\''")}'`);
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
		await writeFile(join(root, 'revoked.cjs'), "require('node:fs').writeFileSync('revoked.pid', String(process.pid)); debugger; setInterval(() => {}, 1000);\n");
		await page.getByRole('tab', { name: 'Terminal', exact: true }).first().click();
		await workbench.terminal.runCommand(`'${process.execPath.replaceAll("'", "'\\''")}' '${join(root, 'revoked.cjs').replaceAll("'", "'\\''")}'`);
		await expect.poll(async () => readFile(join(root, 'revoked.pid'), 'utf8').catch(() => '')).toMatch(/^\d+$/);
		const unbound = Number(await readFile(join(root, 'revoked.pid'), 'utf8'));
		await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
		await expect(pane.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
		await page.getByRole('tab', { name: 'Terminal', exact: true }).first().click();
		await workbench.terminal.activeInstance.locator('.xterm-helper-textarea').press('Control+C');
		await expect.poll(() => alive(unbound)).toBe(false);
	});
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
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ workbench } = await restartWorkbench());
	const root = testWorkspace.directory;
	await mkdir(join(root, '.vscode'), { recursive: true });
	await writeFile(join(root, 'locale.cjs'), 'setInterval(() => {}, 1000);\n');
	await writeFile(join(root, '.vscode/launch.json'), JSON.stringify({ version: '0.2.0', configurations: [{ name: '中文工作流', type: 'node', request: 'launch', runtimeExecutable: process.execPath, program: '${workspaceFolder}/locale.cjs', cwd: '${workspaceFolder}', console: 'internalConsole', serverReadyAction: { action: 'openExternally', pattern: '(unsupported)\\1' } }] }));
	await workbench.quickaccess.runCommand('workbench.action.debug.start');
	await expect(workbench.page.getByRole('article').filter({ hasText: '服务就绪配置无效或正则表达式不受支持' })).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.debug.stopAll');
	const pane = workbench.page.locator('[data-view-container-id="ash.debug"]');
	if (!await pane.isVisible()) await workbench.page.getByRole('tab', { name: '运行和调试', exact: true }).first().click();
	const heading = pane.getByRole('button', { name: '变量', exact: true });
	await heading.focus();
	await workbench.page.keyboard.press('Alt+F1');
	const help = workbench.page.getByRole('dialog', { name: '无障碍帮助', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/新建集成终端以自动附加[\s\S]*停止调试会分离已附加的终端程序/u);
	await workbench.page.keyboard.press('Escape');
	await expect(heading).toBeFocused();
});
