import type { Locator } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { readStorageEntries, seedStorageOnNextLoad } from '../../../automation/storage.js';
import { StorageScope, StorageTarget } from '../../../../src/ash/platform/storage/common/storage.js';
import type { PlaywrightApplication } from '../../../automation/playwrightDriver.js';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join, resolve, sep } from 'node:path';
import { expect, test, writeEditorExtensionFixture } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import { createSshFixture } from '../../../automation/ssh.js';
import { developmentAshPackagePath } from '../../../../src/ash/platform/environment/node/developmentArtifacts.js';

async function fillReplInput(input: Locator, text: string): Promise<void> {
	await input.focus();
	await input.press('ControlOrMeta+A');
	await input.press('Backspace');
	await input.page().keyboard.insertText(text);
}

async function expectReplInput(input: Locator, text: string): Promise<void> {
	await expect.poll(async () => (await input.page().locator('.ash-debug-console-form .view-lines > .view-line .stanza-editor-line-text').allTextContents()).join('\n').replace(/\u00a0/g, ' ')).toBe(text);
}

// Exercise the production stdio transport with a deterministic DAP peer. The
// peer records requests so UI assertions also prove which container was edited.
const adapter = String.raw`
const fs = require('node:fs');
const source = process.argv[2];
const requests = process.argv[3];
let buffer = Buffer.alloc(0);
let sequence = 1;
let line = 2;
let answer = '42';
let child = '1';
function send(message) {
  const body = Buffer.from(JSON.stringify({ seq: sequence++, ...message }));
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n');
  process.stdout.write(body);
}
function event(event, body) { send({ type: 'event', event, body }); }
function accept(request) {
  fs.appendFileSync(requests, JSON.stringify(request) + '\n');
  const args = request.arguments || {};
  let body = {};
  let success = true;
  if (request.command === 'initialize') body = { supportsConfigurationDoneRequest: true, supportsSetVariable: true, supportsConditionalBreakpoints: true, supportsHitConditionalBreakpoints: true, supportsLogPoints: true, supportsFunctionBreakpoints: true, supportsDataBreakpoints: true, supportsInstructionBreakpoints: true, supportsDisassembleRequest: true, supportsSteppingGranularity: true };
  if (request.command === 'launch') event('initialized', {});
  if (request.command === 'threads') body = { threads: [{ id: 7, name: 'main' }] };
  if (request.command === 'stackTrace') body = { stackFrames: [{ id: 11, name: 'main', source: { name: 'debug-program.js', path: source }, line, column: 1, instructionPointerReference: '0x' + (0x1000 + (line - 2) * 4).toString(16) }] };
  if (request.command === 'disassemble') body = { instructions: Array.from({ length: args.instructionCount }, (_, index) => ({ address: '0x' + (Number(args.memoryReference) + args.offset + (args.instructionOffset + index) * 4).toString(16), instructionBytes: '90', instruction: 'mov r0, r1', location: { name: 'debug-program.js', path: source }, line: 2, column: 1 })) };
  if (request.command === 'scopes') body = { scopes: [{ name: 'Locals', variablesReference: 10, expensive: false }] };
  if (request.command === 'variables') body = { variables: args.variablesReference === 10 ? [
    { name: 'answer', value: answer, variablesReference: 0 },
    { name: 'object', value: 'Object', variablesReference: 20 },
    { name: 'locked', value: '1', variablesReference: 0, presentationHint: { attributes: ['readOnly'] } }
  ] : [{ name: 'child', value: child, variablesReference: 0 }] };
  if (request.command === 'evaluate') body = { result: answer, variablesReference: 0 };
  if (request.command === 'setBreakpoints') body = { breakpoints: args.breakpoints.map(point => ({ line: point.line, verified: true })) };
  if (['setFunctionBreakpoints', 'setDataBreakpoints', 'setInstructionBreakpoints'].includes(request.command)) body = { breakpoints: args.breakpoints.map(() => ({ verified: true })) };
  if (request.command === 'dataBreakpointInfo') body = { dataId: 'memory:' + args.name, description: args.name, accessTypes: ['read', 'write', 'readWrite'], canPersist: false };
  if (request.command === 'setVariable') {
    success = /^\d+$/.test(args.value);
    if (success) {
      if (args.variablesReference === 10 && args.name === 'answer') answer = args.value;
      else if (args.variablesReference === 20 && args.name === 'child') child = args.value;
      else throw new Error('Unexpected setVariable address');
      body = { value: args.value };
    }
  }
  send({ type: 'response', request_seq: request.seq, command: request.command, success, body, ...(success ? {} : { message: 'Value must be numeric.' }) });
  if (request.command === 'configurationDone') {
    event('output', { category: 'console', output: 'ASH_DEBUG_READY\n' });
    event('stopped', { reason: 'breakpoint', threadId: 7, allThreadsStopped: true });
  }
  if (request.command === 'next') {
    line++;
    event('continued', { threadId: 7, allThreadsContinued: true });
    event('stopped', { reason: 'step', threadId: 7, allThreadsStopped: true });
  }
  if (request.command === 'disconnect') {
    event('terminated', {});
    process.stdout.end(() => process.exit(0));
  }
}
process.stdin.on('data', data => {
  buffer = Buffer.concat([buffer, data]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
    const end = headerEnd + 4 + length;
    if (buffer.length < end) return;
    const request = JSON.parse(buffer.subarray(headerEnd + 4, end).toString());
    buffer = buffer.subarray(end);
    accept(request);
  }
});
`;

test.beforeEach(async ({ target, testWorkspace }) => {
	const directory = testWorkspace.directory;
	await mkdir(join(directory, '.vscode'));
	await writeFile(join(directory, 'debug-adapter.cjs'), adapter);
	await writeFile(join(directory, 'debug-program.js'), 'const answer = 42;\nconsole.log(answer);\nconsole.log("finished");\n');
	await writeFile(join(directory, 'debug-requests.jsonl'), '');
	await writeFile(join(directory, '.vscode', 'launch.json'), JSON.stringify({
		version: '0.2.0', configurations: [{
			name: 'Debug smoke', type: 'smoke', request: 'launch',
			environmentIdentity: '${env:TERM_PROGRAM}', missingEnvironment: '${env:ASH_MISSING_VALUE}',
			debugAdapter: { program: process.execPath, args: [join(directory, 'debug-adapter.cjs'), join(directory, 'debug-program.js'), join(directory, 'debug-requests.jsonl')] },
		}]
	}));
});

test('debug launch resolves host paths and scalar settings through the shared variable owner', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, workbench, testWorkspace, webAppServer }) => {
	const directory = testWorkspace.directory;
	const home = webAppServer?.profileDirectory ?? ('windows' in application ? await application.evaluate(() => process.env.HOME!) : undefined);
	expect(home).toBeTruthy();
	const configuration = JSON.parse(await readFile(join(directory, '.vscode', 'launch.json'), 'utf8'));
	Object.assign(configuration.configurations[0], { folder: '${cwd}', home: '${userHome}', separator: '${pathSeparator}${/}', setting: '${config:chat.editor.fontSize}', editor: { file: '${file}', basename: '${fileBasenameNoExtension}', relative: '${relativeFile}', selection: '${selectedText}', line: '${lineNumber}', column: '${columnNumber}' } });
	await writeFile(join(directory, '.vscode', 'launch.json'), JSON.stringify(configuration));
	const selected = 'debug selection ${env:SHOULD_STAY_LITERAL}';
	await writeFile(join(directory, 'editor-variable-debug.ts'), selected + '\n');
	await workbench.quickaccess.open('editor-variable-debug.ts');
	await workbench.quickaccess.select('editor-variable-debug.ts');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorContents(text => text.includes(selected));
	await editor.waitForEditorFocus();
	await workbench.page.keyboard.press('ControlOrMeta+Home');
	await workbench.page.keyboard.press('Shift+End');
	await workbench.page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const pane = workbench.page.locator('[data-view-id="workbench.view.debug"]');
	await expect(workbench.page.locator('[data-part="sidebar"]').getByRole('button', { name: /^Debug configuration:/ })).toContainText('Debug smoke');
	await workbench.page.locator('[data-part="sidebar"]').getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await expect(pane.getByRole('status')).toContainText('stopped');
	await expect.poll(async () => (await readFile(join(directory, 'debug-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; arguments?: unknown; }).find(request => request.command === 'launch')?.arguments).toEqual({ environmentIdentity: 'ash', missingEnvironment: '', folder: directory, home: home, separator: sep + sep, setting: '0', editor: { file: join(directory, 'editor-variable-debug.ts'), basename: 'editor-variable-debug', relative: 'editor-variable-debug.ts', selection: selected, line: '1', column: String(selected.length + 1) } });
	await pane.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('debug startup saves a dirty inactive source before the real adapter reads it', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	const source = join(directory, 'debug-program.js');
	const proof = join(directory, 'saved-before-launch.txt');
	const marker = '// saved before debug';
	await writeFile(join(directory, 'debug-adapter.cjs'), adapter.replace("if (request.command === 'launch') event('initialized', {});", `if (request.command === 'launch') { fs.writeFileSync(${JSON.stringify(proof)}, fs.readFileSync(source)); event('initialized', {}); }`));
	await workbench.quickaccess.open('debug-program.js');
	await workbench.quickaccess.select('debug-program.js');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await workbench.page.keyboard.press('ControlOrMeta+End');
	await editor.waitForTypeInEditor(marker);
	expect(await readFile(source, 'utf8')).not.toContain(marker);
	await writeFile(join(directory, 'other.txt'), 'another editor\n');
	await workbench.quickaccess.open('other.txt');
	await workbench.quickaccess.select('other.txt');
	await editor.waitForEditorContents(text => text.includes('another editor'));
	await workbench.page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const pane = workbench.page.locator('[data-view-id="workbench.view.debug"]');
	await expect(pane.getByRole('combobox', { name: 'Debug configuration', exact: true })).toContainText('Debug smoke');
	await pane.getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await expect(pane.getByRole('status')).toContainText('stopped');
	expect(await readFile(proof, 'utf8')).toContain(marker);
	await editor.waitForEditorContents(text => text.includes(marker));
	await pane.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('debug preLaunchTask waits for background compilation readiness before starting the adapter', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	await writeFile(join(directory, 'debug-watch.cjs'), "const fs = require('node:fs'); fs.writeFileSync('compiler-pid.txt', String(process.pid)); console.log('BUILD'); console.log('ASH_DEBUG_COMPILER_WAITING'); const timer = setInterval(() => { if (fs.existsSync('release-compiler')) { clearInterval(timer); console.log('debug-program.js(1,1): warning TS1000: Debug compiler warning'); console.log('READY'); setInterval(() => {}, 1000); } }, 40);\n");
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Debug compiler', type: 'process', command: process.execPath, args: ['debug-watch.cjs'], isBackground: true, problemMatcher: { base: '$tsc', background: { activeOnStart: true, beginsPattern: '^BUILD$', endsPattern: '^READY$' } } }] }));
	const configuration = JSON.parse(await readFile(join(directory, '.vscode', 'launch.json'), 'utf8'));
	configuration.configurations[0].preLaunchTask = 'Debug compiler';
	await writeFile(join(directory, '.vscode', 'launch.json'), JSON.stringify(configuration));
	const page = workbench.page;
	await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const pane = page.locator('[data-view-id="workbench.view.debug"]');
	await expect(pane.getByRole('combobox', { name: 'Debug configuration', exact: true })).toContainText('Debug smoke');
	await pane.getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await workbench.quickaccess.runCommand('workbench.action.togglePanel');
	await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
	await expect(workbench.terminal.activeInstance).toContainText('ASH_DEBUG_COMPILER_WAITING');
	expect(await readFile(join(directory, 'debug-requests.jsonl'), 'utf8')).toBe('');
	await writeFile(join(directory, 'release-compiler'), 'ready');
	await expect(pane.getByRole('status')).toContainText('stopped');
	await page.getByRole('tab', { name: 'Problems', exact: true }).click();
	await expect(page.locator('.ash-problems-results')).toContainText('Debug compiler warning');
	await pane.getByRole('button', { name: 'Stop', exact: true }).click();
	await workbench.quickaccess.runCommand('workbench.action.tasks.terminate');
	const pid = Number(await readFile(join(directory, 'compiler-pid.txt'), 'utf8'));
	await expect.poll(() => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } }).toBe(false);
});

test('withdrawing an unrelated declarative debugger preserves a launch waiting for its background task', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	const root = join(directory, 'unrelated-debug-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await mkdir(join(root, 'debugger'));
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'acme/unrelated-debug-smoke', version: '1.0.0', displayName: 'Unrelated debug smoke', compatibility: { ash: '>=0.1.0' }, contributions: { declarativeExtensions: [{ id: 'debugger', path: 'debugger' }] }, permissions: [{ type: 'directory', access: 'read' }] }));
	await writeFile(join(root, 'debugger', 'package.json'), JSON.stringify({ name: 'unrelated-debug', publisher: 'acme', version: '1.0.0', contributes: { debuggers: [{ type: 'unrelated', label: 'Unrelated', runtime: process.execPath, program: './adapter.cjs' }] } }));
	await writeFile(join(root, 'debugger', 'adapter.cjs'), "throw Error('Unrelated adapter must never start');");
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('unrelated-debug-extension');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/unrelated-debug-smoke 1.0.0');
	const manage = async (button: string): Promise<void> => {
		await workbench.dialogs.confirm(application, 'Unrelated debug smoke', button, async () => {
			await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
			await page.getByRole('option').filter({ has: page.getByText('Unrelated debug smoke', { exact: true }) }).click();
		});
	};
	await manage('Enable');
	await manage('Grant permissions');
	await writeFile(join(directory, 'retirement-watch.cjs'), "const fs = require('node:fs'); fs.writeFileSync('retirement-pid.txt', String(process.pid)); console.log('BUILD'); console.log('RETIREMENT_COMPILER_WAITING'); const timer = setInterval(() => { if (fs.existsSync('release-retirement')) { clearInterval(timer); console.log('READY'); setInterval(() => {}, 1000); } }, 40);");
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Retirement compiler', type: 'process', command: process.execPath, args: ['${workspaceFolder}/retirement-watch.cjs'], isBackground: true, problemMatcher: { base: '$tsc', background: { activeOnStart: true, beginsPattern: '^BUILD$', endsPattern: '^READY$' } } }] }));
	const configuration = JSON.parse(await readFile(join(directory, '.vscode', 'launch.json'), 'utf8'));
	configuration.configurations[0].preLaunchTask = 'Retirement compiler';
	await writeFile(join(directory, '.vscode', 'launch.json'), JSON.stringify(configuration));
	await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const pane = page.locator('[data-view-id="workbench.view.debug"]');
	await expect(pane.getByRole('combobox', { name: 'Debug configuration', exact: true })).toContainText('Debug smoke');
	await pane.getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await expect(workbench.terminal.activeInstance).toContainText('RETIREMENT_COMPILER_WAITING');
	expect(await readFile(join(directory, 'debug-requests.jsonl'), 'utf8')).toBe('');
	await manage('Disable');
	await writeFile(join(directory, 'release-retirement'), 'ready');
	await expect.poll(async () => (await readFile(join(directory, 'debug-requests.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line).command)).toContain('launch');
	await expect(pane.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
	await pane.getByRole('button', { name: 'Stop', exact: true }).click();
	await workbench.quickaccess.runCommand('workbench.action.tasks.terminate');
	const pid = Number(await readFile(join(directory, 'retirement-pid.txt'), 'utf8'));
	await expect.poll(() => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } }).toBe(false);
	await manage('Revoke permissions');
	await manage('Uninstall');
});

test('debugging routes colliding adapter IDs to their own workspace folders', { tag: ['@electron-app-server'] }, async ({ target, application, testWorkspace }) => {
	if (!('windows' in application)) return;
	const folders = ['first', 'second'].map(name => ({ name, directory: join(testWorkspace.directory, name) }));
	for (const { name, directory } of folders) {
		await mkdir(join(directory, '.vscode'), { recursive: true });
		await writeFile(join(directory, 'debug-adapter.cjs'), adapter);
		await writeFile(join(directory, 'debug-program.js'), `console.log('${name}');\nconsole.log('paused');\nconsole.log('stepped');\n`);
		await writeFile(join(directory, 'debug-requests.jsonl'), '');
		await writeFile(join(directory, '.vscode', 'launch.json'), JSON.stringify({
			version: '0.2.0', configurations: [{
				name: `Debug ${name}`, type: 'smoke', request: 'launch',
				debugAdapter: { program: process.execPath, args: [join(directory, 'debug-adapter.cjs'), join(directory, 'debug-program.js'), join(directory, 'debug-requests.jsonl')] },
			}]
		}));
	}
	const workspaceFile = join(testWorkspace.directory, 'debug.code-workspace');
	await writeFile(workspaceFile, JSON.stringify({ folders: folders.map(({ name }) => ({ name, path: name })) }));
	const opened = application.waitForEvent('window');
	await application.evaluate(({ app }, file) => {
		app.emit('second-instance', {} as never, [process.execPath, app.getAppPath(), '--workspace', file, '--new-window'], process.cwd(), {});
	}, workspaceFile);
	const page = await opened;
	for (const { directory } of folders) {
		const prompt = page.getByRole('dialog', { name: 'Ash', exact: true });
		await expect(prompt.locator('.ash-dialog-detail')).toContainText(directory);
		await prompt.getByRole('button', { name: 'Trust Folder & Enable Features', exact: true }).click();
	}
	const workbench = new Workbench(page);
	await workbench.waitForReady();
	// Observe the real transport without changing requests or backend responses.
	await page.evaluate(() => {
		const owner = globalThis as typeof globalThis & { debugAdapterBoundary?: DebugAdapterBoundary; };
		const post = MessagePort.prototype.postMessage;
		const pending = new Map<number, string>();
		const observers = new Map<MessagePort, EventListener>();
		const bytes = (value: unknown): Uint8Array | undefined => value && typeof value === 'object' && 'data' in value && value.data instanceof Uint8Array ? value.data : undefined;
		const state: DebugAdapterBoundary = {
			starts: [],
			dispose() {
				MessagePort.prototype.postMessage = post;
				for (const [port, observer] of observers) port.removeEventListener('message', observer);
				delete owner.debugAdapterBoundary;
			},
		};
		MessagePort.prototype.postMessage = function (message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
			const data = bytes(message);
			if (data) {
				const request = JSON.parse(new TextDecoder().decode(data)) as { id: number; method?: string; params?: { dirId?: string; }; };
				if (request.method === 'debug/adapter/start' && request.params?.dirId) {
					pending.set(request.id, request.params.dirId);
					if (!observers.has(this)) {
						const decoder = new TextDecoder();
						let buffered = '';
						const observer: EventListener = event => {
							if (!(event instanceof MessageEvent)) return;
							const data = bytes(event.data);
							if (!data) return;
							buffered += decoder.decode(data, { stream: true });
							let end: number;
							while ((end = buffered.indexOf('\n')) >= 0) {
								const response = JSON.parse(buffered.slice(0, end)) as { id: number; result?: { sessionId?: string; }; };
								buffered = buffered.slice(end + 1);
								const dirId = pending.get(response.id);
								if (dirId && response.result?.sessionId) { state.starts.push({ dirId, sessionId: response.result.sessionId }); pending.delete(response.id); }
							}
						};
						observers.set(this, observer);
						this.addEventListener('message', observer);
					}
				}
			}
			Reflect.apply(post, this, options === undefined ? [message] : [message, options]);
		};
		owner.debugAdapterBoundary = state;
	});
	try {
		await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
		const pane = page.locator('[data-view-id="workbench.view.debug"]');
		const configuration = pane.getByRole('combobox', { name: 'Debug configuration', exact: true });
		const sessions = pane.getByRole('combobox', { name: 'Active debug session', exact: true, includeHidden: true });
		for (const { name } of folders) {
			await configuration.selectOption({ label: `Debug ${name} — ${name}` });
			await pane.getByRole('button', { name: 'Start Debugging', exact: true }).click();
			const session = sessions.locator('option').filter({ hasText: `Debug ${name} —` });
			await expect(session).toHaveCount(1);
			await expect(sessions).toHaveValue((await session.getAttribute('value'))!);
			await expect(pane.getByRole('status')).toContainText('stopped');
		}
		const starts = await page.evaluate(() => (globalThis as typeof globalThis & { debugAdapterBoundary: DebugAdapterBoundary; }).debugAdapterBoundary.starts);
		expect(starts).toHaveLength(2);
		expect(new Set(starts.map(start => start.dirId)).size).toBe(2);
		expect(new Set(starts.map(start => start.sessionId)).size).toBe(1);
		await expect(sessions.locator('option')).toHaveCount(2);
		const commands = async (name: string) => (await readFile(join(testWorkspace.directory, name, 'debug-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).command as string);
		for (const { name } of folders) {
			const id = await sessions.locator('option').filter({ hasText: `Debug ${name} —` }).getAttribute('value');
			if (name === 'first') await sessions.selectOption(id!);
			else await expect(sessions).toHaveValue(id!);
			await pane.getByRole('button', { name: 'Step Over', exact: true }).click();
			await expect(pane.locator('.ash-debug-frame')).toContainText('debug-program.js:3');
			await expect.poll(async () => (await commands(name)).filter(command => command === 'next')).toEqual(['next']);
			if (name === 'first') expect(await commands('second')).not.toContain('next');
			await pane.getByRole('button', { name: 'Stop', exact: true }).click();
			await expect.poll(async () => (await commands(name)).filter(command => command === 'disconnect')).toEqual(['disconnect']);
			if (name === 'first') {
				expect(await commands('second')).not.toContain('disconnect');
				await expect(sessions.locator('option')).toHaveCount(1);
			}
		}
		await expect(sessions.locator('option')).toHaveCount(0);
	} finally {
		await page.evaluate(() => (globalThis as typeof globalThis & { debugAdapterBoundary?: DebugAdapterBoundary; }).debugAdapterBoundary?.dispose());
	}
});

interface DebugAdapterBoundary {
	readonly starts: { readonly dirId: string; readonly sessionId: string; }[];
	dispose(): void;
}

test('debug adapter exit retains every line from a 200 message output burst', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, testWorkspace }) => {
	const script = adapter.replace("if (request.command === 'next') {", `if (request.command === 'continue') {
    for (let index = 0; index < 200; index++) event('output', { category: 'console', output: 'ASH_DEBUG_TAIL_' + index + '\\n' });
    process.stdout.end(() => process.exit(0));
  }
  if (request.command === 'next') {`);
	await writeFile(join(testWorkspace.directory, 'debug-adapter.cjs'), script);
	const page = workbench.page;
	await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const pane = page.locator('[data-view-id="workbench.view.debug"]');
	await workbench.page.locator('[data-part="sidebar"]').getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await expect(pane.getByRole('status')).toContainText('stopped');
	await workbench.quickaccess.runCommand('workbench.debug.action.focusRepl');
	const output = page.getByRole('log', { name: 'Debug Console output', exact: true });
	await expect(output).toContainText('ASH_DEBUG_READY');
	await pane.getByRole('button', { name: 'Continue', exact: true }).click();
	await expect(output).toContainText('ASH_DEBUG_TAIL_199');
	const lines = (await output.textContent())!.match(/ASH_DEBUG_TAIL_\d+/gu);
	expect(lines).toEqual(Array.from({ length: 200 }, (_, index) => `ASH_DEBUG_TAIL_${index}`));
});

test('debugging locates stopped source, edits nested variables by keyboard, refreshes watches, steps and stops', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, testWorkspace }) => {
	const page = workbench.page;
	await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const pane = page.locator('[data-view-id="workbench.view.debug"]');
	await expect(page.locator('[data-part="sidebar"]').getByRole('button', { name: /^Debug configuration:/ })).toContainText('Debug smoke');
	await page.locator('[data-part="sidebar"]').getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await expect(pane.getByRole('status')).toContainText('stopped');
	await expect(pane.locator('.ash-debug-frame')).toContainText('debug-program.js:2');
	await workbench.editors.groupAt(0).editor.waitForEditorContents(content => content.includes('console.log(answer)'));
	await expect(page.getByRole('tab', { name: 'debug-program.js', exact: true, selected: true })).toContainText('debug-program.js');
	await workbench.quickaccess.runCommand('editor.debug.action.toggleBreakpoint');
	const breakpoint = pane.locator('.ash-debug-breakpoints > li').filter({ hasText: 'debug-program.js:2' });
	await expect(breakpoint).toBeVisible();
	await breakpoint.hover();
	await breakpoint.getByRole('button', { name: 'Edit breakpoint', exact: true }).click();
	await pane.getByRole('textbox', { name: 'Expression condition', exact: true }).fill('answer > 0');
	await pane.getByRole('textbox', { name: 'Hit count condition', exact: true }).fill('>= 2');
	await pane.getByRole('textbox', { name: 'Log message', exact: true }).fill('answer={answer}');
	await pane.getByRole('button', { name: 'Save breakpoint', exact: true }).click();
	const breakpointRequests = async () => (await readFile(join(testWorkspace.directory, 'debug-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; arguments?: { breakpoints?: unknown[]; }; }).filter(request => request.command === 'setBreakpoints');
	await expect.poll(async () => (await breakpointRequests()).at(-1)?.arguments?.breakpoints).toEqual([{ line: 2, condition: 'answer > 0', hitCondition: '>= 2', logMessage: 'answer={answer}' }]);
	await breakpoint.getByRole('checkbox').uncheck();
	await expect.poll(async () => (await breakpointRequests()).at(-1)?.arguments?.breakpoints).toEqual([]);
	await pane.getByRole('button', { name: 'Breakpoints', exact: true }).hover();
	await pane.getByRole('button', { name: 'Enable All Breakpoints', exact: true }).click();
	await expect.poll(async () => (await breakpointRequests()).at(-1)?.arguments?.breakpoints).toEqual([{ line: 2, condition: 'answer > 0', hitCondition: '>= 2', logMessage: 'answer={answer}' }]);
	await pane.getByRole('button', { name: 'Breakpoints', exact: true }).hover();
	await pane.getByRole('button', { name: 'Remove All Breakpoints', exact: true }).click();
	await expect.poll(async () => (await breakpointRequests()).at(-1)?.arguments?.breakpoints).toEqual([]);

	const lastArguments = async (command: string) => (await readFile(join(testWorkspace.directory, 'debug-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; arguments?: unknown; }).filter(request => request.command === command).at(-1)?.arguments;
	await pane.getByRole('button', { name: 'Breakpoints', exact: true }).hover();
	await pane.getByRole('button', { name: 'Add Function Breakpoint', exact: true }).click();
	const functionName = pane.getByRole('textbox', { name: 'Function name', exact: true });
	await functionName.fill('main');
	await pane.getByRole('textbox', { name: 'Expression condition', exact: true }).fill('answer > 0');
	await functionName.press('Enter');
	await expect.poll(() => lastArguments('launch')).toEqual({ environmentIdentity: 'ash', missingEnvironment: '' });
	await expect.poll(() => lastArguments('setFunctionBreakpoints')).toEqual({ breakpoints: [{ name: 'main', condition: 'answer > 0' }] });
	await pane.getByRole('button', { name: 'Break on data access for answer', exact: true }).click();
	await pane.getByRole('combobox', { name: 'Break on access', exact: true }).selectOption('readWrite');
	await pane.getByRole('button', { name: 'Save breakpoint', exact: true }).click();
	await expect.poll(() => lastArguments('dataBreakpointInfo')).toEqual({ name: 'answer', variablesReference: 10, frameId: 11 });
	await expect.poll(() => lastArguments('setDataBreakpoints')).toEqual({ breakpoints: [{ dataId: 'memory:answer', accessType: 'readWrite' }] });
	await pane.getByRole('button', { name: 'Call Stack', exact: true }).hover();
	await pane.getByRole('button', { name: 'Add Instruction Breakpoint', exact: true }).click();
	await expect(pane.getByRole('textbox', { name: 'Instruction address', exact: true })).toHaveValue('0x1000');
	const instructionOffset = pane.getByRole('textbox', { name: 'Instruction byte offset', exact: true });
	await instructionOffset.fill('-4');
	await instructionOffset.press('Enter');
	await expect.poll(() => lastArguments('setInstructionBreakpoints')).toEqual({ breakpoints: [{ instructionReference: '0x1000', offset: -4 }] });
	await pane.getByRole('button', { name: 'Breakpoints', exact: true }).hover();
	await pane.getByRole('button', { name: 'Disable All Breakpoints', exact: true }).click();
	for (const command of ['setFunctionBreakpoints', 'setDataBreakpoints', 'setInstructionBreakpoints']) {
		await expect.poll(() => lastArguments(command)).toEqual({ breakpoints: [] });
	}
	await pane.getByRole('button', { name: 'Breakpoints', exact: true }).hover();
	await pane.getByRole('button', { name: 'Enable All Breakpoints', exact: true }).click();
	await expect.poll(() => lastArguments('setInstructionBreakpoints')).toEqual({ breakpoints: [{ instructionReference: '0x1000', offset: -4 }] });
	await pane.getByRole('button', { name: 'Breakpoints', exact: true }).hover();
	await pane.getByRole('button', { name: 'Remove All Breakpoints', exact: true }).click();
	for (const command of ['setFunctionBreakpoints', 'setDataBreakpoints', 'setInstructionBreakpoints']) {
		await expect.poll(() => lastArguments(command)).toEqual({ breakpoints: [] });
	}

	await pane.getByRole('button', { name: 'Watch', exact: true }).hover();
	await pane.getByRole('button', { name: 'Add watch expression', exact: true }).click();
	await pane.getByRole('textbox', { name: 'Add watch expression' }).fill('answer');
	await pane.getByRole('textbox', { name: 'Add watch expression' }).press('Enter');
	await expect(pane.locator('.ash-debug-watch-value')).toHaveText('answer = 42');
	const answer = pane.locator('.ash-debug-variable').filter({ hasText: 'answer =' });
	await answer.focus();
	await answer.press('F2');
	const value = pane.getByRole('textbox', { name: 'Value of answer', exact: true });
	await expect(value).toBeFocused();
	await value.fill('100');
	await value.press('Escape');
	await expect(answer).toBeFocused();
	await expect(answer).toContainText('answer = 42');
	await answer.press('F2');
	await value.fill('invalid');
	await value.press('Enter');
	await expect(value).toHaveAttribute('aria-invalid', 'true');
	await expect(pane.getByRole('alert').filter({ hasText: 'Value must be numeric.' })).toHaveText('Value must be numeric.');
	await expect(value).toBeFocused();
	await value.fill('43');
	await value.press('Enter');
	await expect(answer).toContainText('answer = 43');
	await expect(answer).toBeFocused();
	await expect(pane.locator('.ash-debug-watch-value')).toHaveText('answer = 43');

	const locked = pane.locator('.ash-debug-variable').filter({ hasText: 'locked =' });
	await locked.focus();
	await locked.press('F2');
	await expect(pane.locator('.ash-debug-variable-edit')).toHaveCount(0);
	await pane.locator('.ash-debug-variable').filter({ hasText: 'object = Object' }).click();
	const child = pane.locator('.ash-debug-variable').filter({ hasText: 'child =' });
	await expect(child).toContainText('child = 1');
	await child.dblclick();
	await pane.getByRole('textbox', { name: 'Value of child', exact: true }).fill('2');
	await pane.getByRole('textbox', { name: 'Value of child', exact: true }).press('Enter');
	await expect(child).toContainText('child = 2');
	await expect(child).toBeFocused();

	await pane.getByRole('button', { name: 'Step Over', exact: true }).click();
	await expect(pane.locator('.ash-debug-frame')).toContainText('debug-program.js:3');
	await expect(pane.locator('.ash-debug-variable').filter({ hasText: 'answer =' })).toContainText('answer = 43');
	await pane.getByRole('button', { name: 'Call Stack', exact: true }).hover();
	await pane.getByRole('button', { name: 'Open Disassembly View', exact: true }).click();
	const disassembly = page.locator('.ash-disassembly');
	const instructions = disassembly.getByRole('grid', { name: 'Disassembly', exact: true });
	await expect(page.getByRole('tab', { name: 'Disassembly', exact: true, selected: true })).toBeVisible();
	await expect(disassembly.locator('[data-instruction-address="0x1004"]')).toHaveAttribute('aria-current', 'step');
	await expect.poll(() => lastArguments('disassemble')).toEqual({ memoryReference: '0x1004', offset: 0, instructionOffset: 0, instructionCount: 50, resolveSymbols: true });
	await instructions.focus();
	await instructions.press('F9');
	await expect.poll(() => lastArguments('setInstructionBreakpoints')).toEqual({ breakpoints: [{ instructionReference: '0x1004', offset: 0 }] });
	await instructions.press('F9');
	await expect.poll(() => lastArguments('setInstructionBreakpoints')).toEqual({ breakpoints: [] });
	await disassembly.getByRole('button', { name: 'Next instructions', exact: true }).click();
	await expect.poll(() => lastArguments('disassemble')).toEqual({ memoryReference: '0x1004', offset: 0, instructionOffset: 50, instructionCount: 50, resolveSymbols: true });
	await disassembly.getByRole('button', { name: 'Current instruction', exact: true }).click();
	await expect(disassembly.locator('[data-instruction-address="0x1004"]')).toBeVisible();
	await disassembly.getByRole('button', { name: 'Open instruction source', exact: true }).click();
	await expect(page.getByRole('tab', { name: 'debug-program.js', exact: true, selected: true })).toBeVisible();
	await workbench.editors.groupAt(0).editor.waitForEditorFocus();
	await workbench.quickaccess.runCommand('debug.action.openDisassemblyView');
	await expect(page.getByRole('tab', { name: 'Disassembly', exact: true, selected: true })).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Disassembly', exact: true })).toHaveCount(1);
	await instructions.focus();
	await instructions.press('Alt+F1');
	const help = page.getByRole('textbox', { name: 'Accessibility Help', exact: true });
	await expect(help).toHaveValue(/Press F9 to toggle its instruction breakpoint/);
	await help.press('Escape');
	await expect(instructions).toBeFocused();
	await instructions.press('Alt+F2');
	const accessible = page.getByRole('textbox', { name: 'Accessible View', exact: true });
	await expect(accessible).toHaveValue(/Current instruction: 0x1004/);
	await accessible.press('Escape');
	await expect(instructions).toBeFocused();
	await instructions.press('F10');
	await expect.poll(() => lastArguments('next')).toEqual({ threadId: 7, granularity: 'instruction' });
	await expect(disassembly.locator('[data-instruction-address="0x1008"]')).toHaveAttribute('aria-current', 'step');
	await expect(page.getByRole('tab', { name: 'Disassembly', exact: true, selected: true })).toBeVisible();
	await pane.getByRole('button', { name: 'Stop', exact: true }).click();
	await expect(disassembly.getByRole('status')).toHaveText('Pause debugging to view disassembly.');
	await expect(disassembly.locator('[data-instruction-address]')).toHaveCount(0);
	await expect(pane.locator('.ash-debug-frame, .ash-debug-variable')).toHaveCount(0);
	await expect(pane.getByRole('toolbar', { name: 'Debug controls' })).toBeHidden();
	const requests = (await readFile(join(testWorkspace.directory, 'debug-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; arguments?: unknown; });
	expect(requests.filter(request => request.command === 'setVariable').map(request => request.arguments)).toEqual([
		{ variablesReference: 10, name: 'answer', value: 'invalid' },
		{ variablesReference: 10, name: 'answer', value: '43' },
		{ variablesReference: 20, name: 'child', value: '2' },
	]);
	expect(requests.some(request => request.command === 'disconnect')).toBe(true);
});

test('configured debug inputs cancel before adapter creation and resolve nested selections through to DAP', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, testWorkspace }) => {
	const page = workbench.page;
	const directory = testWorkspace.directory;
	await writeFile(join(directory, '.vscode', 'launch.json'), JSON.stringify({
		version: '0.2.0',
		inputs: [
			{ id: 'name', type: 'promptString', description: 'Debug input name', default: 'initial' },
			{ id: 'mode', type: 'pickString', description: 'Debug build mode', options: ['debug', { label: 'Optimized', value: 'release' }], default: 'release' },
		],
		configurations: [{
			name: 'Debug inputs', type: 'smoke', request: 'launch',
			debugAdapter: { program: process.execPath, args: ['${workspaceFolder}/debug-adapter.cjs', '${workspaceFolder}/debug-program.js', '${workspaceFolder}/debug-requests.jsonl'] },
			nameArgument: '${input:name}', repeated: '${input:name}', mode: '${input:mode}',
		}],
	}));
	await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const pane = page.locator('[data-view-id="workbench.view.debug"]');
	await expect(pane.getByRole('combobox', { name: 'Debug configuration', exact: true })).toContainText('Debug inputs');
	await pane.getByRole('button', { name: 'Start Debugging', exact: true }).click();
	const prompt = page.getByRole('dialog', { name: 'Debug input name', exact: true }).getByRole('textbox', { name: 'Debug input name', exact: true });
	await expect(prompt).toBeFocused();
	await prompt.press('Escape');
	await expect(prompt).not.toBeVisible();
	expect(await readFile(join(directory, 'debug-requests.jsonl'), 'utf8')).toBe('');
	await expect(pane.getByRole('status', { includeHidden: true })).toBeHidden();
	await expect(pane.getByRole('button', { name: 'Start Debugging', exact: true })).toBeFocused();

	await pane.getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await expect(prompt).toHaveValue('initial');
	await prompt.fill('${workspaceFolder}');
	await prompt.press('Enter');
	const pick = page.getByRole('dialog', { name: 'Debug build mode', exact: true }).getByRole('combobox', { name: 'Debug build mode', exact: true });
	await expect(pick).toBeFocused();
	await pick.press('Enter');
	await expect(pane.getByRole('status')).toContainText('stopped');
	const requests = (await readFile(join(directory, 'debug-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; arguments?: unknown; });
	expect(requests.find(request => request.command === 'launch')?.arguments).toEqual({ nameArgument: directory, repeated: directory, mode: 'release' });
	await pane.getByRole('button', { name: 'Stop', exact: true }).click();
});


test('default build task selection cancels Debug before execution and starts only the selected build', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	await writeFile(join(directory, 'selected-builds.jsonl'), '');
	await writeFile(join(directory, 'select-build.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(join(directory, 'selected-builds.jsonl'))}, JSON.stringify(process.argv[2]) + '\\n');`);
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: ['Alpha build', 'Beta build'].map(label => ({ label, type: 'process', command: process.execPath, args: ['${workspaceFolder}/select-build.cjs', label], group: 'build', presentation: { echo: false, reveal: 'never' } })) }));
	await writeFile(join(directory, '.vscode', 'launch.json'), JSON.stringify({ version: '0.2.0', configurations: [{ name: 'Default build selection', type: 'smoke', request: 'launch', debugAdapter: { program: process.execPath, args: ['${workspaceFolder}/debug-adapter.cjs', '${workspaceFolder}/debug-program.js', '${workspaceFolder}/debug-requests.jsonl'] }, preLaunchTask: '${defaultBuildTask}' }] }));
	const page = workbench.page;
	await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const pane = page.locator('[data-view-id="workbench.view.debug"]');
	const start = pane.getByRole('button', { name: 'Start Debugging', exact: true });
	await expect(pane.getByRole('combobox', { name: 'Debug configuration', exact: true })).toContainText('Default build selection');
	const initialTerminals = await workbench.terminal.instances.count();
	await start.click();
	const picker = page.getByRole('dialog', { name: 'Select a build task', exact: true }).getByRole('combobox', { name: 'Select a build task', exact: true });
	await expect(picker).toBeFocused();
	expect(await readFile(join(directory, 'selected-builds.jsonl'), 'utf8')).toBe('');
	await picker.press('Escape');
	await expect(picker).not.toBeVisible();
	await expect(start).toBeFocused();
	await expect(pane.getByRole('status', { includeHidden: true })).toBeHidden();
	expect(await readFile(join(directory, 'debug-requests.jsonl'), 'utf8')).toBe('');
	await expect(workbench.terminal.instances).toHaveCount(initialTerminals);
	await start.click();
	await expect(picker).toBeFocused();
	await picker.fill('Beta build');
	await picker.press('Enter');
	await expect(pane.getByRole('status')).toContainText('stopped');
	expect((await readFile(join(directory, 'selected-builds.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual(['Beta build']);
	const requests = (await readFile(join(directory, 'debug-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
	expect(requests.filter(request => request.command === 'launch')).toHaveLength(1);
	await pane.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('installed Debug configuration provider creates launch templates and resolves the real DAP launch in Web and Electron', { tag: ['@browser-app-server', '@electron-app-server', '@darwin'] }, async ({ testWorkspace, application, workbench }) => {
	test.setTimeout(90_000);
	const directory = testWorkspace.directory;
	const root = join(directory, 'debug-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({
		schemaVersion: 1, id: 'acme/debug-provider-smoke', version: '1.0.0', displayName: 'Debug provider smoke',
		compatibility: { ash: '>=0.1.0' },
		contributions: { editorExtensions: [{ id: 'debug', runtime: 'javascript', api: 'ash', entrypoint: 'extension.js', runtimeApiVersion: 1, activationEvents: [{ type: 'onDemand', capability: 'debugAdapter' }], capabilities: ['command', 'debugAdapter'] }] },
		permissions: [{ type: 'directory', access: 'read' }],
	}));
	const template = {
		name: 'Provider smoke', type: 'smoke', request: 'launch', program: '${workspaceFolder}/debug-program.js', environmentIdentity: '${env:TERM_PROGRAM}',
		platformValue: 'default',
		windows: { platformValue: 'windows', wrongPlatform: '${command:acme.debugProvider.mustNotRun}' },
		osx: { platformValue: '${workspaceFolderBasename}' },
		linux: { platformValue: 'linux', wrongPlatform: '${command:acme.debugProvider.mustNotRun}' },
		debugAdapter: { program: process.execPath, args: [join(directory, 'debug-adapter.cjs'), join(directory, 'debug-program.js'), join(directory, 'debug-requests.jsonl')] },
	};
	await writeEditorExtensionFixture(root, `
const ash = require('@ash/sdk'); const { commands, debug, window } = ash;
exports.activate = function(context) {
	context.subscriptions.push(commands.register('acme.debugProvider.ready', async () => { await window.showInformationMessage('Debug provider registered'); }));
	context.subscriptions.push(debug.registerDebugConfigurationProvider('smoke', {
		async provideDebugConfigurations(folder) {
			if (!folder || folder.index !== 0) throw Error('Missing canonical workspace');
			await window.showInformationMessage('Debug provider registered');
			return [${JSON.stringify(template)}];
		},
		resolveDebugConfiguration(folder, config) {
			if (config.program !== '\${workspaceFolder}/debug-program.js') throw Error('Pre-resolution callback received resolved variables');
			if (!config.osx || config.platformValue !== 'default') throw Error('Pre-resolution callback lost platform source');
			return { ...config, providedFolder: folder.name };
		},
		resolveDebugConfigurationWithSubstitutedVariables(_folder, config) {
			if (config.program !== ${JSON.stringify(join(directory, 'debug-program.js'))} || config.environmentIdentity !== 'ash') throw Error('Variables were not resolved before the second callback');
			if (config.platformValue !== ${JSON.stringify(directory.split('/').at(-1))} || ['windows','osx','linux','wrongPlatform'].some(key => key in config)) throw Error('Execution platform was not selected before substitution');
			return { ...config, providerResolved: true };
		},
	}));
	context.subscriptions.push(debug.registerDebugConfigurationProvider('smoke', {
		provideDebugConfigurations(folder) {
			if (!folder || folder.index !== 0) throw Error('Missing canonical workspace');
			return [{ ...${JSON.stringify(template)}, name: 'Dynamic provider smoke', dynamicSelection: true }];
		},
	}, 2));
}`);
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('debug-extension');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/debug-provider-smoke 1.0.0');
	const manage = async (button: string): Promise<void> => {
		await workbench.dialogs.confirm(application, 'Debug provider smoke', button, async () => {
			await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
			await page.getByRole('option').filter({ has: page.getByText('Debug provider smoke', { exact: true }) }).click();
		});
	};
	await manage('Enable');
	await manage('Grant permissions');
	await expect(page.locator('.ash-notification', { hasText: 'Debug provider registered' })).toHaveCount(0);
	await unlink(join(directory, '.vscode', 'launch.json'));
	await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const pane = page.locator('[data-view-id="workbench.view.debug"]');
	await pane.getByRole('button', { name: 'Create a launch.json file', exact: true }).click();
	await expect.poll(async () => { try { return JSON.parse(await readFile(join(directory, '.vscode', 'launch.json'), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }).toEqual({ version: '0.2.0', configurations: [template] });
	await expect(page.locator('.ash-notification', { hasText: 'Debug provider registered' })).toBeVisible();
	await expect(pane.getByRole('combobox', { name: 'Debug configuration', exact: true })).toContainText('Provider smoke');
	await pane.getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await expect(pane.getByRole('status')).toContainText('stopped');
	const requests = (await readFile(join(directory, 'debug-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; arguments?: unknown; });
	expect(requests.find(request => request.command === 'launch')?.arguments).toEqual({ program: join(directory, 'debug-program.js'), environmentIdentity: 'ash', platformValue: directory.split('/').at(-1), providedFolder: directory.split('/').at(-1), providerResolved: true });
	await pane.getByRole('button', { name: 'Stop', exact: true }).click();
	await workbench.quickaccess.runCommand('workbench.action.debug.selectandstart');
	const picker = page.getByRole('dialog', { name: 'Select a debug configuration', exact: true });
	await expect(picker.getByRole('option').filter({ hasText: 'Dynamic provider smoke' })).toBeVisible();
	await picker.getByRole('combobox').press('Escape');
	await expect(picker).toBeHidden();
	const readLaunches = async (): Promise<readonly unknown[]> => (await readFile(join(directory, 'debug-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; arguments?: unknown; }).filter(request => request.command === 'launch').map(request => request.arguments);
	expect(await readLaunches()).toHaveLength(1);
	await workbench.quickaccess.runCommand('workbench.action.debug.selectandstart');
	await picker.getByRole('combobox').fill('Dynamic provider smoke');
	await expect(picker.getByRole('option')).toHaveCount(1);
	await picker.getByRole('combobox').press('Enter');
	await expect(pane.getByRole('status')).toContainText('stopped');
	expect(await readLaunches()).toEqual([
		{ program: join(directory, 'debug-program.js'), environmentIdentity: 'ash', platformValue: directory.split('/').at(-1), providedFolder: directory.split('/').at(-1), providerResolved: true },
		{ program: join(directory, 'debug-program.js'), environmentIdentity: 'ash', platformValue: directory.split('/').at(-1), dynamicSelection: true, providedFolder: directory.split('/').at(-1), providerResolved: true },
	]);
	expect(JSON.parse(await readFile(join(directory, '.vscode', 'launch.json'), 'utf8'))).toEqual({ version: '0.2.0', configurations: [template] });
	await pane.getByRole('button', { name: 'Stop', exact: true }).click();
	await manage('Revoke permissions');
	await manage('Disable');
	await manage('Uninstall');
});

test('Debug type redirection activates a second installed dormant owner before its configuration and descriptor callbacks', { tag: ['@browser-app-server', '@electron-app-server', '@darwin'] }, async ({ testWorkspace, application, workbench }) => {
	test.setTimeout(90_000);
	const directory = testWorkspace.directory;
	const page = workbench.page;
	const descriptor = {
		program: process.execPath,
		arguments: [join(directory, 'debug-adapter.cjs'), join(directory, 'debug-program.js'), join(directory, 'debug-requests.jsonl')],
	};
	for (const type of ['redirect-source', 'redirect-target']) {
		const root = join(directory, type);
		await mkdir(join(root, '.ash-plugin'), { recursive: true });
		await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({
			schemaVersion: 1, id: `acme/${type}`, version: '1.0.0', displayName: type,
			compatibility: { ash: '>=0.1.0' },
			contributions: { editorExtensions: [{ id: 'debug', runtime: 'javascript', api: 'ash', entrypoint: 'extension.js', runtimeApiVersion: 1, activationEvents: [{ type: 'onDebugType', debugType: type }], capabilities: ['debugAdapter'] }] },
			permissions: [{ type: 'directory', access: 'read' }],
		}));
		await writeEditorExtensionFixture(root, `
const ash = require('@ash/sdk'); const { debug, window } = ash;
exports.activate = function(context) {
	context.subscriptions.push(debug.registerDebugConfigurationProvider(${JSON.stringify(type)}, {
		resolveDebugConfiguration(folder, configuration) {
			if (!folder || folder.index !== 0) throw Error('Missing canonical workspace');
			const { debugAdapter, ...resolved } = configuration;
			return { ...resolved, ${type === 'redirect-source' ? "type: 'redirect-target', redirected: true" : "targetResolved: '${workspaceFolder}/debug-program.js'"} };
		},
	}));
	context.subscriptions.push(debug.registerDebugAdapterDescriptorFactory(${JSON.stringify(type)}, {
		createDebugAdapterDescriptor(session) {
   const configuration = session.configuration;
			${type === 'redirect-source' ? "throw Error('Source descriptor must not start');" : `if (configuration.targetResolved !== ${JSON.stringify(join(directory, 'debug-program.js'))}) throw Error('Target resolver did not run before substitution'); return new ash.DebugAdapterExecutable(${JSON.stringify(descriptor.program)}, ${JSON.stringify(descriptor.arguments)});`}
		},
	}));
}`);
		await workbench.quickaccess.runCommand('ash.extensions.installLocal');
		const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
		await installation.getByRole('textbox').fill(type);
		const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
		expect(installed.message).toContain(`Installed acme/${type} 1.0.0`);
		for (const button of ['Enable', 'Grant permissions']) {
			await workbench.dialogs.confirm(application, type, button, async () => {
				await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
				await page.getByRole('option').filter({ has: page.getByText(type, { exact: true }) }).click();
			});
		}
	}
	await writeFile(join(directory, '.vscode', 'launch.json'), JSON.stringify({
		version: '0.2.0', configurations: [{ name: 'Redirect dormant owner', type: 'redirect-source', request: 'launch', debugAdapter: { program: 'source-must-not-spawn' } }],
	}));
	await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const pane = page.locator('[data-view-id="workbench.view.debug"]');
	await expect(pane.getByRole('combobox', { name: 'Debug configuration', exact: true })).toContainText('Redirect dormant owner');
	await pane.getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await expect(pane.getByRole('status')).toContainText('stopped');
	const requests = (await readFile(join(directory, 'debug-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; arguments?: unknown; });
	expect(requests.find(request => request.command === 'launch')?.arguments).toEqual({ redirected: true, targetResolved: join(directory, 'debug-program.js') });
	await pane.getByRole('button', { name: 'Stop', exact: true }).click();
});


test('installed Debug observer receives early custom events and termination after adapter release', { tag: ['@browser-app-server', '@electron-app-server', '@darwin'] }, async ({ application, workbench, testWorkspace }) => {
	test.setTimeout(90_000);
	const directory = testWorkspace.directory;
	const root = join(directory, 'debug-events-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({
		schemaVersion: 1, id: 'acme/debug-events-smoke', version: '1.0.0', displayName: 'Debug events smoke', compatibility: { ash: '>=0.1.0' },
		contributions: {
			editorExtensions: [{
				id: 'debug', runtime: 'javascript', api: 'ash', entrypoint: 'extension.js', runtimeApiVersion: 1,
				activationEvents: [{ type: 'onDebugType', debugType: 'event-observer' }], capabilities: ['debugAdapter'],
			}]
		},
		permissions: [{ type: 'directory', access: 'read' }],
	}));
	await writeEditorExtensionFixture(root, `const ash = require('@ash/sdk'); const { debug, window } = ash;
exports.activate = function(context) {
	const events = [];
	const trackerPhases = [];
	const received = [];
	const sent = [];
	let sessionId;
	let trackerFactory;
	let adapterBreakpointId;
	trackerFactory = debug.registerDebugAdapterTrackerFactory('*', {
		async createDebugAdapterTracker(session) {
			if (session.type !== 'event-observer' || session.name !== 'Debug smoke' || session.configuration.request !== 'launch') throw Error('Tracker did not receive the prepared session');
			const tracker = {
				onWillStartSession() { if (this !== tracker) throw Error('Tracker receiver changed'); trackerPhases.push('start'); },
				onWillReceiveMessage(message) { if (message.type === 'request') received.push(message.command); },
				onDidSendMessage(message) { sent.push(message.type); },
				onWillStopSession() { trackerPhases.push('stop'); trackerFactory.dispose(); },
				onError(error) { if (!(error instanceof Error)) throw Error('Tracker error identity changed'); trackerPhases.push('error:' + error.name); },
				async onExit(code, signal) {
					trackerPhases.push('exit');
					await window.showInformationMessage('DEBUG_TRACKER:' + JSON.stringify({ phases: trackerPhases, received, sent, code: code ?? null, signalUnknown: signal === undefined }));
				},
			};
			return tracker;
		},
	});
	context.subscriptions.push(trackerFactory);
	async function observe(type, session) {
  if (!sessionId) sessionId = session.id;
  if (session.id !== sessionId) throw Error('Session identity changed');
  events.push(type);
  if (type === 'end') await window.showInformationMessage('DEBUG_EVENTS:' + events.join(','));
 }
 context.subscriptions.push(
  debug.onDidStartDebugSession(session => observe('start', session)),
  debug.onDidChangeActiveDebugSession(session => { events.push('active'); }),
  debug.onDidTerminateDebugSession(session => observe('end', session)),
  debug.onDidReceiveDebugSessionCustomEvent(async event => {
   if (event.event !== 'builderReady' || event.body !== null) throw Error('Early custom event changed');
   await observe('custom', event.session);
  }),
  debug.onDidChangeBreakpoints(async event => {
   for (const point of event.added) {
    if (!(point instanceof ash.SourceBreakpoint) || ![1,4].includes(point.location.range.start.line) || typeof point.id !== 'string') throw Error('Breakpoint snapshot changed');
    if (point.location.range.start.line === 4) { adapterBreakpointId = point.id; await window.showInformationMessage('DEBUG_ADAPTER_BREAKPOINT:new'); }
   }
   if (adapterBreakpointId && event.removed.some(point => point.id === adapterBreakpointId)) await window.showInformationMessage('DEBUG_ADAPTER_BREAKPOINT:removed');
   await window.showInformationMessage('DEBUG_BREAKPOINTS:' + event.added.length + ':' + event.removed.length + ':' + event.changed.length);
  })
 );}`);
	const peer = adapter.replace("  if (request.command === 'launch') event('initialized', {});", "  if (request.command === 'launch') { event('builderReady', null); event('initialized', {}); }").replace("  if (request.command === 'next') {", "  if (request.command === 'next') { event('breakpoint', line === 2 ? { reason: 'new', breakpoint: { id: 777, source: { path: source }, line: 5, verified: true } } : { reason: 'removed', breakpoint: { id: 777, verified: false } });");
	expect(peer).not.toBe(adapter);
	await writeFile(join(directory, 'debug-adapter.cjs'), "require('node:fs').writeFileSync(" + JSON.stringify(join(directory, 'debug-events-pid.txt')) + ", String(process.pid));\n" + peer);
	const configuration = JSON.parse(await readFile(join(directory, '.vscode', 'launch.json'), 'utf8'));
	configuration.configurations[0].type = 'event-observer';
	await writeFile(join(directory, '.vscode', 'launch.json'), JSON.stringify(configuration));
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('debug-events-extension');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/debug-events-smoke 1.0.0');
	const manage = (button: string) => manageDebugExtension(application, workbench, 'Debug events smoke', button);
	await manage('Enable');
	await manage('Grant permissions');
	await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const pane = page.locator('[data-view-id="workbench.view.debug"]');
	await expect(workbench.page.locator('[data-part="sidebar"]').getByRole('button', { name: /^Debug configuration:/ })).toContainText('Debug smoke');
	await workbench.page.locator('[data-part="sidebar"]').getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await expect(pane.getByRole('status')).toContainText('stopped');
	const pid = Number(await readFile(join(directory, 'debug-events-pid.txt'), 'utf8'));
	await workbench.editors.groupAt(0).editor.waitForEditorContents(content => content.includes('console.log(answer)'));
	await workbench.quickaccess.runCommand('editor.debug.action.toggleBreakpoint');
	await expect(page.locator('.ash-notification', { hasText: 'DEBUG_BREAKPOINTS:1:0:0' })).toBeVisible();
	const breakpointRequests = async () => (await readFile(join(directory, 'debug-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; arguments?: { breakpoints?: unknown[]; }; }).filter(request => request.command === 'setBreakpoints');
	await expect.poll(async () => (await breakpointRequests()).at(-1)?.arguments?.breakpoints).toEqual([{ line: 2 }]);
	await pane.getByRole('button', { name: 'Breakpoints', exact: true }).hover();
	await pane.getByRole('button', { name: 'Remove All Breakpoints', exact: true }).click();
	await expect(page.locator('.ash-notification', { hasText: 'DEBUG_BREAKPOINTS:0:1:0' })).toBeVisible();
	await expect.poll(async () => (await breakpointRequests()).at(-1)?.arguments?.breakpoints).toEqual([]);
	const sentBreakpointUpdates = (await breakpointRequests()).length;
	await pane.getByRole('button', { name: 'Step Over', exact: true }).click();
	await expect(page.locator('.ash-notification', { hasText: 'DEBUG_ADAPTER_BREAKPOINT:new' })).toBeVisible();
	await expect(pane.locator('.ash-debug-breakpoint', { hasText: 'debug-program.js:5' })).toBeVisible();
	await pane.getByRole('button', { name: 'Step Over', exact: true }).click();
	await expect(page.locator('.ash-notification', { hasText: 'DEBUG_ADAPTER_BREAKPOINT:removed' })).toBeVisible();
	await expect(pane.locator('.ash-debug-breakpoint', { hasText: 'debug-program.js:5' })).toHaveCount(0);
	expect((await breakpointRequests()).length).toBe(sentBreakpointUpdates);
	await pane.getByRole('button', { name: 'Stop', exact: true }).click();
	await expect(page.locator('.ash-notification', { hasText: 'DEBUG_EVENTS:custom,start,active,end' })).toBeVisible();
	const trackerNotice = page.locator('.ash-notification', { hasText: 'DEBUG_TRACKER:' });
	await expect(trackerNotice).toBeVisible();
	const trackerText = await trackerNotice.innerText();
	const tracker = JSON.parse(trackerText.slice(trackerText.indexOf('DEBUG_TRACKER:') + 'DEBUG_TRACKER:'.length).split('\n')[0]) as { phases: string[]; received: string[]; sent: string[]; code: number | null; signalUnknown: boolean; };
	expect(tracker.phases).toEqual(['start', 'stop', 'exit']);
	expect(tracker.received[0]).toBe('initialize');
	expect(tracker.received).toContain('launch');
	expect(tracker.received).toContain('disconnect');
	const adapterCommands = (await readFile(join(directory, 'debug-requests.jsonl'), 'utf8')).trim().split('\n').map(line => (JSON.parse(line) as { command: string; }).command);
	expect(tracker.received).toEqual(expect.arrayContaining(adapterCommands));
	expect(tracker.sent).toContain('response');
	expect(tracker.sent).toContain('event');
	expect([null, 0]).toContain(tracker.code);
	expect(tracker.signalUnknown).toBe(true);
	expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
	await manage('Disable');
	await manage('Revoke permissions');
	await manage('Uninstall');
});


for (const transport of ['server', 'pipe', 'debugServer'] as const) {
	test(`installed Debug ${transport} transport exchanges DAP and releases the connection`, { tag: ['@browser-app-server', '@electron-app-server', '@darwin'] }, async ({ application, workbench, testWorkspace }) => {
		const directory = testWorkspace.directory;
		const page = workbench.page;
		const requests: string[] = [];
		const sockets = new Set<Socket>();
		let released = false;
		let sequence = 1;
		const server = createServer(socket => {
			sockets.add(socket);
			socket.on('error', () => { });
			socket.on('close', () => { sockets.delete(socket); released = true; });
			let buffer = Buffer.alloc(0);
			const send = (message: object) => {
				const body = Buffer.from(JSON.stringify({ seq: sequence++, ...message }));
				socket.write('Content-Length: ' + body.length + '\r\n\r\n'); socket.write(body);
			};
			socket.on('data', data => {
				buffer = Buffer.concat([buffer, data]);
				while (true) {
					const headerEnd = buffer.indexOf('\r\n\r\n');
					if (headerEnd < 0) return;
					const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())![1]);
					const end = headerEnd + 4 + length;
					if (buffer.length < end) return;
					const request = JSON.parse(buffer.subarray(headerEnd + 4, end).toString()) as { seq: number; command: string; arguments?: unknown; };
					buffer = buffer.subarray(end); requests.push(request.command);
					if (request.command === 'launch') send({ type: 'event', event: 'initialized', body: {} });
					send({ type: 'response', request_seq: request.seq, command: request.command, success: true, body: request.command === 'initialize' ? { supportsConfigurationDoneRequest: true } : request.command === 'threads' ? { threads: [] } : {} });
					if (request.command === 'configurationDone') send({ type: 'event', event: 'stopped', body: { reason: 'pause' } });
					if (request.command === 'disconnect') send({ type: 'event', event: 'terminated', body: {} });
				}
			});
		});
		// A short path also works on macOS, whose Unix socket path limit is 104 bytes.
		const pipePath = join('/tmp', 'ash-dap-' + process.pid + '-' + Date.now() + '.sock');
		await new Promise<void>((resolve, reject) => { server.once('error', reject); transport === 'pipe' ? server.listen(pipePath, resolve) : server.listen(0, '127.0.0.1', resolve); });
		const address = server.address();
		const port = address && typeof address === 'object' ? address.port : undefined;
		const connection = transport === 'pipe' ? { type: 'namedPipe', path: pipePath } : { type: 'server', port };
		try {
			const root = join(directory, 'debug-network');
			await mkdir(join(root, '.ash-plugin'), { recursive: true });
			await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({
				schemaVersion: 1, id: 'acme/debug-network', version: '1.0.0', displayName: 'Debug network', compatibility: { ash: '>=0.1.0' },
				contributions: { editorExtensions: [{ id: 'debug', runtime: 'javascript', api: 'ash', entrypoint: 'extension.js', runtimeApiVersion: 1, activationEvents: [{ type: 'onDebugType', debugType: 'network' }], capabilities: ['debugAdapter'] }] },
				permissions: [{ type: 'directory', access: 'read' }],
			}));
			await writeEditorExtensionFixture(root, `
const ash = require('@ash/sdk'); const { debug, window } = ash;
exports.activate = function(context) {
 context.subscriptions.push(debug.registerDebugAdapterDescriptorFactory('network', {
  createDebugAdapterDescriptor() { ${transport === 'debugServer' ? "throw Error('debugServer must bypass the descriptor factory');" : 'return new ash.' + (connection.type === 'namedPipe' ? 'DebugAdapterNamedPipeServer(' + JSON.stringify(connection.path) + ')' : 'DebugAdapterServer(' + connection.port + ')') + ';'} }
 }));
}
`);
			await writeFile(join(directory, '.vscode', 'launch.json'), JSON.stringify({ version: '0.2.0', configurations: [{ name: 'Debug network', type: 'network', request: 'launch', ...(transport === 'debugServer' ? { debugServer: port } : {}) }] }));
			await workbench.quickaccess.runCommand('ash.extensions.installLocal');
			const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
			await installation.getByRole('textbox').fill('debug-network');
			const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
			expect(installed.message).toContain('Installed acme/debug-network 1.0.0');
			for (const button of ['Enable', 'Grant permissions']) await manageDebugExtension(application, workbench, 'Debug network', button);
			await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
			const pane = page.locator('[data-view-id="workbench.view.debug"]');
			await expect(workbench.page.locator('[data-part="sidebar"]').getByRole('button', { name: /^Debug configuration:/ })).toContainText('Debug network');
			await workbench.page.locator('[data-part="sidebar"]').getByRole('button', { name: 'Start Debugging', exact: true }).click();
			await expect(pane.getByRole('status')).toContainText('stopped');
			expect(requests).toEqual(expect.arrayContaining(['initialize', 'launch', 'configurationDone']));
			await pane.getByRole('button', { name: 'Stop', exact: true }).click();
			await expect.poll(() => released).toBe(true);
			expect(requests).toContain('disconnect');
		} finally {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
}

test('installed inline Debug implementation handles DAP and completes disposal before session end', { tag: ['@browser-app-server', '@electron-app-server', '@darwin'] }, async ({ application, workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	const page = workbench.page;
	const root = join(directory, 'debug-inline');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await mkdir(join(root, 'defaults'));
	await writeFile(join(root, 'defaults', 'package.json'), JSON.stringify({ name: 'debug-defaults', publisher: 'acme', version: '1.0.0', contributes: { debuggers: [{ type: 'inline', label: 'Inline default', runtime: 'default-must-not-spawn', runtimeArgs: ['$HOME', ''], program: './adapter.cjs', args: ['arg', '$HOME', ''] }, { type: 'pure-inline', label: 'Pure inline' }] } }));
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({
		schemaVersion: 1, id: 'acme/debug-inline', version: '1.0.0', displayName: 'Debug inline', compatibility: { ash: '>=0.1.0' },
		contributions: { editorExtensions: [{ id: 'debug', runtime: 'javascript', api: 'ash', entrypoint: 'extension.js', runtimeApiVersion: 1, activationEvents: [{ type: 'onDebugType', debugType: 'inline' }], capabilities: ['debugAdapter'] }] },
		permissions: [{ type: 'directory', access: 'read' }],
	}));
	await writeEditorExtensionFixture(root, `
const ash = require('@ash/sdk'); const { debug, window } = ash;
exports.activate = function(context) {
 let sawFrame = false;
 context.subscriptions.push(debug.onDidChangeActiveStackItem(async item => {
  if (item instanceof ash.DebugStackFrame) {
   if (item.threadId !== 0 || item.frameId !== -1) throw Error('Active stack item changed');
   sawFrame = true; await window.showInformationMessage('DEBUG_STACK_FRAME');
  } else if (item === undefined && sawFrame) await window.showInformationMessage('DEBUG_STACK_CLEAR');
 }), debug.onDidStartDebugSession(async session => {
  const source = await ash.workspace.openTextDocument(ash.debug.asDebugSourceUri({path:'/adapter-only/generated.ts',sourceReference:33}, session));
  if (source.getText() !== 'const generated = true;') throw Error('Reference source could not be loaded by the extension');
  await window.showInformationMessage('DEBUG_SOURCE_READ');
 }), debug.registerDebugAdapterDescriptorFactory('inline', {
  createDebugAdapterDescriptor(session, executable) {
   const configuration = session.configuration; const config = configuration;
   if (executable?.command !== 'default-must-not-spawn' || executable.args.length !== 6 || executable.args[0] !== '$HOME' || executable.args[1] !== '' || !executable.args[2].endsWith('/defaults/adapter.cjs') || JSON.stringify(executable.args.slice(3)) !== JSON.stringify(['arg', '$HOME', ''])) throw Error('Standard default executable was not passed to the factory');
   const listeners = new Set(); const commands = []; let sequence = 0; let disposed = false;
   function send(message) { for (const listener of listeners) listener({ seq: sequence++, ...message }); }
   return new ash.DebugAdapterInlineImplementation({
    onDidSendMessage(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
    handleMessage(request) {
     commands.push(request.command);
     if (request.command === 'launch') send({ type: 'event', event: 'initialized', body: {} });
     send({ type: 'response', request_seq: request.seq, command: request.command, success: true, body: request.command === 'initialize' ? { supportsConfigurationDoneRequest: true } : request.command === 'threads' ? { threads: [{ id: 0, name: 'main' }] } : request.command === 'stackTrace' ? { stackFrames: [{ id: -1, name: 'main', line: 1, column: 1, source: { name: 'generated.ts', path: '/adapter-only/generated.ts', sourceReference: 33 } }] } : request.command === 'source' ? { content: 'const generated = true;', mimeType: 'text/typescript' } : request.command === 'scopes' ? { scopes: [] } : {} });
     if (request.command === 'configurationDone') send({ type: 'event', event: 'stopped', body: { reason: 'pause' } });
     if (request.command === 'disconnect') send({ type: 'event', event: 'terminated', body: {} });
    },
    async dispose() {
     if (disposed || listeners.size) throw Error('Inline resource was not released exactly once');
     disposed = true;
     await window.showInformationMessage('INLINE_RELEASE:' + commands.join(','));
    }
   });
  }
 }));
}
`, [{ type: 'inline', label: 'Inline default', runtime: 'default-must-not-spawn', runtimeArgs: ['$HOME', ''], program: './defaults/adapter.cjs', args: ['arg', '$HOME', ''] }, { type: 'pure-inline', label: 'Pure inline' }]);
	await writeFile(join(directory, '.vscode', 'launch.json'), JSON.stringify({ version: '0.2.0', configurations: [{ name: 'Debug inline', type: 'inline', request: 'launch' }] }));
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('debug-inline');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/debug-inline 1.0.0');
	for (const button of ['Enable', 'Grant permissions']) await manageDebugExtension(application, workbench, 'Debug inline', button);
	await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const pane = page.locator('[data-view-id="workbench.view.debug"]');
	await expect(workbench.page.locator('[data-part="sidebar"]').getByRole('button', { name: /^Debug configuration:/ })).toContainText('Debug inline');
	await workbench.page.locator('[data-part="sidebar"]').getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await expect(pane.getByRole('status')).toContainText('stopped');
	await workbench.editors.groupAt(0).editor.waitForEditorContents(contents => contents.includes('const generated = true;'));
	await expect(page.locator('.ash-notification', { hasText: 'DEBUG_SOURCE_READ' })).toBeVisible();
	await expect(page.locator('.ash-notification', { hasText: 'DEBUG_STACK_FRAME' })).toBeVisible();
	await workbench.editors.groupAt(0).editor.input.focus();
	await page.keyboard.insertText('forbidden edit');
	await workbench.editors.groupAt(0).editor.waitForEditorContents(contents => contents === 'const generated = true;');
	await pane.getByRole('button', { name: 'Stop', exact: true }).click();
	await expect(page.locator('.ash-notification', { hasText: 'DEBUG_STACK_CLEAR' })).toBeVisible();
	const notice = page.locator('.ash-notification', { hasText: 'INLINE_RELEASE:' });
	await expect(notice).toBeVisible();
	const commands = await notice.innerText();
	for (const command of ['initialize', 'launch', 'configurationDone', 'source', 'disconnect']) expect(commands).toContain(command);
	await expect(workbench.page.locator('[data-part="sidebar"]').getByRole('button', { name: 'Start Debugging', exact: true })).toBeEnabled();
});


test('installed standard declarative Debug runtime resolves its package file and platform arguments', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	const root = join(directory, 'declarative-debug-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await mkdir(join(root, 'debugger'), { recursive: true });
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'acme/declarative-debug-smoke', version: '1.0.0', displayName: 'Declarative debug smoke', compatibility: { ash: '>=0.1.0' }, contributions: { declarativeExtensions: [{ id: 'debugger', path: 'debugger' }] }, permissions: [{ type: 'directory', access: 'read' }] }));
	const platform = process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'windows' : 'linux';
	await writeFile(join(root, 'debugger', 'package.json'), JSON.stringify({
		name: 'declarative-debug', publisher: 'acme', version: '1.0.0', contributes: {
			debuggers: [{
				type: 'installed-debug', label: 'Installed Debug', program: 'missing-base.cjs', runtime: process.execPath, runtimeArgs: ['--no-warnings'], args: ['base'],
				[platform]: { program: './adapter.cjs', args: [join(directory, 'debug-program.js'), join(directory, 'debug-requests.jsonl'), '', '$HOME', '${extensionInstallFolder:acme.declarative-debug}'] },
			}]
		}
	}));
	await writeFile(join(root, 'debugger', 'adapter.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'declarative-debug-result.json'))}, JSON.stringify({ program: process.argv[1], args: process.argv.slice(2), runtimeArgs: process.execArgv, pid: process.pid }));\n` + adapter);
	await writeFile(join(directory, '.vscode', 'launch.json'), JSON.stringify({ version: '0.2.0', configurations: [{ name: 'Declarative Debug', type: 'installed-debug', request: 'launch' }] }));
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('declarative-debug-extension');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/declarative-debug-smoke 1.0.0');
	const manage = async (button: string): Promise<void> => {
		await workbench.dialogs.confirm(application, 'Declarative debug smoke', button, async () => {
			await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
			await page.getByRole('option').filter({ has: page.getByText('Declarative debug smoke', { exact: true }) }).click();
		});
	};
	await manage('Enable');
	await manage('Grant permissions');
	await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const pane = page.locator('[data-view-id="workbench.view.debug"]');
	await expect(pane.getByRole('combobox', { name: 'Debug configuration', exact: true })).toContainText('Declarative Debug');
	await pane.getByRole('button', { name: 'Start Debugging', exact: true }).click();
	try {
		await expect(pane.getByRole('status')).toContainText('stopped');
	} catch (error) {
		const files = ['declarative-debug-result.json', 'debug-requests.jsonl'];
		const evidence = await Promise.all(files.map(async name => ({ name, content: await readFile(join(directory, name), 'utf8').catch(() => '<missing>') })));
		await test.info().attach('declarative-debug-io', { body: JSON.stringify(evidence), contentType: 'application/json' });
		throw error;
	}
	const result = JSON.parse(await readFile(join(directory, 'declarative-debug-result.json'), 'utf8'));
	expect(result.program.endsWith(join('debugger', 'adapter.cjs'))).toBe(true);
	expect(result.args).toEqual([join(directory, 'debug-program.js'), join(directory, 'debug-requests.jsonl'), '', '$HOME', result.program.slice(0, -'adapter.cjs'.length - 1)]);
	expect(result.runtimeArgs).toEqual(['--no-warnings']);
	await pane.getByRole('button', { name: 'Stop', exact: true }).click();
	await expect.poll(() => { try { process.kill(result.pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } }).toBe(false);
	await manage('Disable');
	await manage('Revoke permissions');
	await manage('Uninstall');
});

test('installed standard Debug command aliases activate their owner and resolve once per launch', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, workbench, testWorkspace, restartWorkbench }) => {
	const directory = testWorkspace.directory;
	const root = join(directory, 'alias-debug-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await mkdir(join(root, 'debugger'), { recursive: true });
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'acme/alias-debug-smoke', version: '1.0.0', displayName: 'Alias debug smoke', compatibility: { ash: '>=0.1.0' }, contributions: { declarativeExtensions: [{ id: 'debugger', path: 'debugger' }], editorExtensions: [{ id: 'commands', runtime: 'javascript', api: 'ash', entrypoint: 'extension.cjs', runtimeApiVersion: 1, activationEvents: [{ type: 'onCommand', id: 'acme.debugAlias.pick' }], capabilities: ['command'] }] }, permissions: [{ type: 'directory', access: 'read' }] }));
	await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'debug-alias-command', publisher: 'acme', version: '1.0.0', engines: { ash: '*' }, main: './extension.cjs', contributes: { commands: [{ command: 'acme.debugAlias.pick', title: 'Pick Debug target' }] } }));
	const bootstrapRoot = join(directory, 'bootstrap-debug-extension');
	await mkdir(join(bootstrapRoot, '.ash-plugin'), { recursive: true });
	await writeFile(join(bootstrapRoot, '.ash-plugin', 'plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'acme/bootstrap-debug-smoke', version: '1.0.0', displayName: 'Bootstrap debug smoke', compatibility: { ash: '>=0.1.0' }, contributions: { editorExtensions: [{ id: 'commands', runtime: 'javascript', api: 'ash', entrypoint: 'extension.cjs', runtimeApiVersion: 1, activationEvents: [{ type: 'onCommand', id: 'acme.debugAlias.bootstrap' }], capabilities: ['command'] }] }, permissions: [{ type: 'directory', access: 'read' }] }));
	await writeFile(join(bootstrapRoot, 'package.json'), JSON.stringify({ name: 'debug-bootstrap-command', publisher: 'acme', version: '1.0.0', engines: { ash: '*' }, main: './extension.cjs', l10n: './l10n', contributes: { commands: [{ command: 'acme.debugAlias.bootstrap', title: 'Debug bootstrap' }] } }));
	await mkdir(join(bootstrapRoot, 'l10n'));
	await writeFile(join(bootstrapRoot, 'l10n', 'bundle.l10n.zh-cn.json'), JSON.stringify({ 'Target {0}': '目标 {0}' }));
	await writeFile(join(bootstrapRoot, 'extension.cjs'), `const v = require('@ash/sdk'); const message = v.l10n.t('Target {0}', 'worker'); exports.activate = context => context.subscriptions.push(v.commands.register('acme.debugAlias.bootstrap', () => {
require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'node-bootstrap-pid.txt'))}, String(process.pid));
require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'node-localization-proof.json'))}, JSON.stringify({ language: v.env.language, message, bundle: v.l10n.bundle ?? null, uri: v.l10n.uri?.fsPath ?? null }));
return 'nested activation reached editor API'; }));`);
	await writeFile(join(root, 'extension.cjs'), `const fs = require('node:fs'); try { const raw = require('@ash/sdk'); const v = raw && raw.__esModule ? raw : { ...raw, default: raw }; let calls = 0;
if (v.default !== raw || v.commands !== raw.commands) throw Error('CommonJS API identity differs');
class DebugItem extends v.TreeItem { constructor() { super('Debug target', v.TreeItemCollapsibleState.Expanded); this.checkboxState = v.TreeItemCheckboxState.Checked; } }
const debugItem = new DebugItem();
if (debugItem.label !== 'Debug target' || debugItem.collapsibleState !== 2 || debugItem.checkboxState !== 1) throw Error('Debug item contract differs');
const folders = v.workspace.workspaceFolders;
const saved = v.workspace.getConfiguration('debug').get('saveBeforeStart');
if (!folders || folders.length !== 1 || folders[0].uri.fsPath !== ${JSON.stringify(directory)} || saved !== 'allEditorsInActiveGroup') throw Error('Package evaluation did not receive window facts');
const check = v.workspace.getConfiguration('debug').inspect('saveBeforeStart');
if (!check || check.defaultValue !== saved || v.workspace.getWorkspaceFolder(v.Uri.joinPath(folders[0].uri, 'debug-program.js')) !== folders[0]) throw Error('Configuration or workspace identity differs');
const net = require('node:net'); const cp = require('node:child_process');
exports.activate = async context => {
 try {
  const captured = v.workspace.getConfiguration('debug');
  context.subscriptions.push(v.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('debug.saveBeforeStart')) return;
    fs.writeFileSync(${JSON.stringify(join(directory, 'node-config-proof.json'))}, JSON.stringify({ current: v.workspace.getConfiguration('debug').get('saveBeforeStart'), captured: captured.get('saveBeforeStart'), parent: event.affectsConfiguration('debug'), unrelated: event.affectsConfiguration('unrelated') }));
  }));
  await v.window.showInformationMessage('Node activation reached Workbench');
  const bootstrap = await v.commands.execute('acme.debugAlias.bootstrap');
  fs.writeFileSync(${JSON.stringify(join(directory, 'node-startup-proof.txt'))}, bootstrap);
  context.subscriptions.push(v.commands.register('acme.debugAlias.pick', async config => {
  const server = net.createServer(socket => socket.end('Node network'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const network = await new Promise((resolve, reject) => { const client = net.connect(server.address().port, '127.0.0.1'); let text = ''; client.on('data', bytes => text += bytes); client.on('end', () => resolve(text)); client.on('error', reject); });
  await new Promise(resolve => server.close(resolve));
  const child = cp.execFileSync(process.execPath, ['-e', 'process.stdout.write("Node child")'], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  fs.writeSync(1, 'Node raw extension stdout');
  cp.execFileSync(process.execPath, ['-e', 'process.stdout.write("Node inherited Debug child stdout")'], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  fs.writeFileSync(${JSON.stringify(join(directory, 'node-host-proof.json'))}, JSON.stringify({ network, child, buffer: Buffer.from('Node Buffer').toString(), pid: process.pid }));
  if (config.type !== 'installed-alias-debug' || config.request !== 'launch') throw Error('Missing launch configuration');
  const result = 'picked-' + (++calls);
  setTimeout(async () => {
    await v.window.showInformationMessage('Node background reached Workbench');
    fs.writeFileSync(${JSON.stringify(join(directory, 'node-background-proof.txt'))}, result);
  }, 25);
  return result;
}));
 } catch (error) { fs.writeFileSync(${JSON.stringify(join(directory, 'node-startup-error.txt'))}, String(error.stack)); throw error; }
 }; } catch (error) { fs.writeFileSync(${JSON.stringify(join(directory, 'node-startup-error.txt'))}, String(error.stack)); throw error; }`);
	const platform = process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'windows' : 'linux';
	await writeFile(join(root, 'debugger', 'package.json'), JSON.stringify({
		name: 'alias-debug', publisher: 'acme', version: '1.0.0', contributes: {
			debuggers: [{
				type: 'installed-alias-debug', label: 'Installed Debug', variables: { PickProcess: 'acme.debugAlias.pick' }, program: 'missing-base.cjs', runtime: process.execPath, runtimeArgs: ['--no-warnings'], args: ['base'],
				[platform]: { program: './adapter.cjs', args: [join(directory, 'debug-program.js'), join(directory, 'debug-requests.jsonl'), '', '$HOME', '${command:PickProcess}'] },
			}]
		}
	}));
	await writeFile(join(root, 'debugger', 'adapter.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'alias-debug-result.json'))}, JSON.stringify({ program: process.argv[1], args: process.argv.slice(2), runtimeArgs: process.execArgv, pid: process.pid, buildRuns: Number(require('node:fs').readFileSync(${JSON.stringify(join(directory, 'alias-build-runs.txt'))}, 'utf8')) }));\n` + adapter);
	await writeFile(join(directory, '.vscode', 'launch.json'), JSON.stringify({ version: '0.2.0', configurations: [{ name: 'Alias Debug', type: 'installed-alias-debug', request: 'launch', program: '${command:PickProcess}', preLaunchTask: '${defaultBuildTask}' }] }));
	await writeFile(join(directory, 'alias-build-runs.txt'), '0');
	await writeFile(join(directory, 'alias-build.cjs'), `const fs = require('node:fs'); const file = ${JSON.stringify(join(directory, 'alias-build-runs.txt'))}; fs.writeFileSync(file, String(Number(fs.readFileSync(file, 'utf8')) + 1));`);
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Alias build', type: 'process', command: process.execPath, args: ['${workspaceFolder}/alias-build.cjs'], group: { kind: 'build', isDefault: true }, presentation: { echo: false, reveal: 'never' } }] }));
	let page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('alias-debug-extension');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/alias-debug-smoke 1.0.0');
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const bootstrapInstallation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await bootstrapInstallation.getByRole('textbox').fill('bootstrap-debug-extension');
	const bootstrapInstalled = await workbench.dialogs.expectMessage(application, 'Information', () => bootstrapInstallation.getByRole('textbox').press('Enter'));
	expect(bootstrapInstalled.message).toContain('Installed acme/bootstrap-debug-smoke 1.0.0');
	const manage = async (button: string, title = 'Alias debug smoke') => {
		return workbench.dialogs.confirm(application, title, button, async () => {
			await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
			await page.getByRole('option').filter({ has: page.getByText(title, { exact: true }) }).click();
		});
	};
	await manage('Enable', 'Bootstrap debug smoke');
	await manage('Grant permissions', 'Bootstrap debug smoke');
	await manage('Enable');
	await manage('Grant permissions');
	await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const pane = page.locator('[data-view-id="workbench.view.debug"]');
	await expect(pane.getByRole('combobox', { name: 'Debug configuration', exact: true })).toContainText('Alias Debug');
	await pane.getByRole('button', { name: 'Start Debugging', exact: true }).click();
	try {
		await expect(pane.getByRole('status')).toContainText('stopped');
	} catch (error) {
		const files = ['alias-debug-result.json', 'debug-requests.jsonl', 'node-startup-error.txt', 'node-startup-proof.txt', 'node-bootstrap-pid.txt'];
		const evidence = await Promise.all(files.map(async name => ({ name, content: await readFile(join(directory, name), 'utf8').catch(() => '<missing>') })));
		await test.info().attach('alias-debug-io', { body: JSON.stringify(evidence), contentType: 'application/json' });
		throw error;
	}
	const nodeProof = JSON.parse(await readFile(join(directory, 'node-host-proof.json'), 'utf8'));
	expect(nodeProof).toMatchObject({ network: 'Node network', child: 'Node child', buffer: 'Node Buffer' });
	const hostPids = [nodeProof.pid, Number(await readFile(join(directory, 'node-bootstrap-pid.txt'), 'utf8'))];
	expect(hostPids.every(pid => Number.isSafeInteger(pid) && pid > 0)).toBe(true);
	await expect(page.getByLabel('Notifications', { exact: true }).getByText('Node activation reached Workbench', { exact: true })).toBeVisible();
	await expect(page.getByLabel('Notifications', { exact: true }).getByText('Node background reached Workbench', { exact: true })).toBeVisible();
	expect(await readFile(join(directory, 'node-startup-proof.txt'), 'utf8')).toBe('nested activation reached editor API');
	expect(JSON.parse(await readFile(join(directory, 'node-localization-proof.json'), 'utf8'))).toEqual({ language: 'en', message: 'Target worker', bundle: null, uri: null });
	await expect.poll(() => readFile(join(directory, 'node-background-proof.txt'), 'utf8').catch(() => '')).toBe('picked-1');
	const result = JSON.parse(await readFile(join(directory, 'alias-debug-result.json'), 'utf8'));
	expect(result.program.endsWith(join('debugger', 'adapter.cjs'))).toBe(true);
	expect(result.args).toEqual([join(directory, 'debug-program.js'), join(directory, 'debug-requests.jsonl'), '', '$HOME', 'picked-1']);
	expect(result.runtimeArgs).toEqual(['--no-warnings']);
	expect(result.buildRuns).toBe(1);
	await pane.getByRole('button', { name: 'Stop', exact: true }).click();
	await expect.poll(() => { try { process.kill(result.pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } }).toBe(false);
	await workbench.quickaccess.runCommand('workbench.action.openSettings');
	const settings = page.getByRole('dialog', { name: 'Ash Settings', exact: true });
	await settings.getByRole('searchbox', { name: 'Search settings' }).fill('@id:debug.saveBeforeStart');
	await settings.getByRole('combobox', { name: 'Save before debugging', exact: true }).click();
	await page.getByRole('option', { name: 'Do not save', exact: true }).click();
	await expect.poll(() => readFile(join(directory, 'node-config-proof.json'), 'utf8').then(text => JSON.parse(text)).catch(() => null)).toEqual({ current: 'none', captured: 'allEditorsInActiveGroup', parent: true, unrelated: false });
	await settings.press('Escape');
	await pane.getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await expect(pane.getByRole('status')).toContainText('stopped');
	const second = JSON.parse(await readFile(join(directory, 'alias-debug-result.json'), 'utf8'));
	expect(second.args.at(-1)).toBe('picked-2');
	expect(second.buildRuns).toBe(2);
	const launches = (await readFile(join(directory, 'debug-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(request => request.command === 'launch');
	expect(launches.map(request => request.arguments.program)).toEqual(['picked-1', 'picked-2']);
	await pane.getByRole('button', { name: 'Stop', exact: true }).click();
	await expect.poll(() => { try { process.kill(second.pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } }).toBe(false);
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const locale = page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await locale.fill('简体中文');
	await locale.press('Enter');
	({ application, workbench } = await restartWorkbench());
	page = workbench.page;
	for (const pid of hostPids) {
		await expect.poll(() => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } }).toBe(false);
	}
	await workbench.quickaccess.runCommand('acme.debugAlias.bootstrap');
	await expect.poll(() => readFile(join(directory, 'node-localization-proof.json'), 'utf8').then(text => JSON.parse(text))).toMatchObject({ language: 'zh-CN', message: '目标 worker', bundle: { 'Target {0}': '目标 {0}' } });
	const translated = JSON.parse(await readFile(join(directory, 'node-localization-proof.json'), 'utf8'));
	expect(translated.uri).toMatch(/\/l10n\/bundle\.l10n\.zh-cn\.json$/);
	const restartedBootstrapPid = Number(await readFile(join(directory, 'node-bootstrap-pid.txt'), 'utf8'));
	const notice = await manage('禁用');
	expect(notice.detail).toContain('VS Code 扩展使用产品 Node 宿主');
	expect(notice.detail).toContain('Ash SDK 扩展继续使用受限 V8 宿主');
	await manage('撤销权限');
	await manage('卸载');
	await manage('禁用', 'Bootstrap debug smoke');
	await expect.poll(() => { try { process.kill(restartedBootstrapPid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } }).toBe(false);
	await manage('撤销权限', 'Bootstrap debug smoke');
	await manage('卸载', 'Bootstrap debug smoke');
});

// The fixture is an installed IO peer. It uses the public broker operation shape
// so the same client-owned sessions and console model are exercised in both hosts.
test('installed Debug child shares its parent console and stops both owned adapters', { tag: ['@browser-app-server', '@electron-app-server', '@darwin'] }, async ({ application, workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	const root = join(directory, 'debug-session-options');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({
		schemaVersion: 1, id: 'acme/debug-session-options', version: '1.0.0', displayName: 'Debug session options', compatibility: { ash: '>=0.1.0' },
		contributions: {
			editorExtensions: [{
				id: 'debug', runtime: 'javascript', api: 'ash', entrypoint: 'extension.js', runtimeApiVersion: 1,
				activationEvents: [{ type: 'onDebugType', debugType: 'session-options' }], capabilities: ['debugAdapter']
			}]
		},
		permissions: [{ type: 'directory', access: 'read' }],
	}));
	await writeEditorExtensionFixture(root, `
const ash = require('@ash/sdk'); const { debug, window } = ash;
exports.activate = function(context) {
 let parentId;
 context.subscriptions.push(debug.onDidStartDebugSession(async session => {
  if (session.configuration.name !== 'Parent') return;
  parentId = session.id;
  if (!await debug.startDebugging(undefined, {name:'Child',type:'session-options',request:'launch'}, {parentSession:session,lifecycleManagedByParent:true,consoleMode:ash.DebugConsoleMode.MergeWithParent})) throw Error('Child startup failed');
  await window.showInformationMessage('DEBUG_HIERARCHY_READY');
 }));
 context.subscriptions.push(debug.registerDebugAdapterDescriptorFactory('session-options', {
  createDebugAdapterDescriptor(session) {
   const configuration = session.configuration;
   if (configuration.noDebug !== true || configuration.name === 'Child' && (session.parentSession?.id !== parentId || session.workspaceFolder !== undefined)) throw Error('Factory session options changed');
   const listeners = new Set(); let sequence = 0; let closed = false;
   function send(message) { for (const listener of listeners) listener({seq:sequence++,...message}); }
   return new ash.DebugAdapterInlineImplementation({
    onDidSendMessage(listener) { listeners.add(listener); return {dispose(){listeners.delete(listener);}}; },
    handleMessage(request) {
     if (['setBreakpoints','setFunctionBreakpoints','setDataBreakpoints','setInstructionBreakpoints'].includes(request.command)) throw Error('noDebug installed a breakpoint');
     if (request.command === 'setExceptionBreakpoints' && request.arguments.filters.length) throw Error('noDebug enabled an exception filter');
     if (request.command === 'launch') {
      if (request.arguments.noDebug !== true) throw Error('DAP launch omitted noDebug');
      send({type:'event',event:'initialized',body:{}});
     }
     const body = request.command === 'initialize' ? {supportsConfigurationDoneRequest:true} : request.command === 'evaluate' ? {result:configuration.name + '_ANSWER',variablesReference:0} : {};
     send({type:'response',request_seq:request.seq,command:request.command,success:true,body});
     if (request.command === 'configurationDone') send({type:'event',event:'output',body:{output:configuration.name + '_OUTPUT\\n'}});
     if (request.command === 'disconnect') send({type:'event',event:'terminated',body:{}});
    },
    async dispose() {
     if (closed || listeners.size) throw Error('Adapter listener lifetime changed');
     closed = true;
     await window.showInformationMessage('DEBUG_HIERARCHY_RELEASE:' + configuration.name);
    }
   });
  }
 }));
}
`);
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('debug-session-options');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/debug-session-options 1.0.0');
	for (const button of ['Enable', 'Grant permissions']) {
		await manageDebugExtension(application, workbench, 'Debug session options', button);
	}
	await writeFile(join(directory, '.vscode', 'launch.json'), JSON.stringify({ version: '0.2.0', configurations: [{ name: 'Parent', type: 'session-options', request: 'launch', noDebug: true }] }));
	await workbench.quickaccess.runCommand('workbench.action.debug.start');
	await expect(page.locator('.ash-notification', { hasText: 'DEBUG_HIERARCHY_READY' })).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.debug.action.focusRepl');
	const consoleSelection = page.locator('[data-view-id="workbench.panel.debugConsole"] select[aria-label="Debug Console session"]');
	await expect(consoleSelection.locator('option')).toHaveCount(1);
	await expect(consoleSelection).toContainText('Parent');
	await expect(consoleSelection).toBeHidden();
	const output = page.getByRole('log', { name: 'Debug Console output', exact: true });
	await expect(output).toContainText('Parent_OUTPUT');
	await expect(output).toContainText('Child_OUTPUT');
	const expression = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	await fillReplInput(expression, 'answer');
	await expression.press('Enter');
	await expect(output).toContainText('Child_ANSWER');
	await workbench.quickaccess.runCommand('workbench.action.debug.stop');
	for (const name of ['Parent', 'Child']) await expect(page.locator('.ash-notification', { hasText: 'DEBUG_HIERARCHY_RELEASE:' + name })).toBeVisible();
	await expect(expression).toHaveAttribute('aria-readonly', 'true');
	await expect(output).toContainText('Child_ANSWER');
});

test('installed adapter starts a DAP child and acknowledges its independent lifecycle', { tag: ['@browser-app-server', '@electron-app-server', '@darwin'] }, async ({ application, workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	const root = join(directory, 'debug-reverse-start');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'acme/debug-reverse', version: '1.0.0', displayName: 'Debug reverse request', compatibility: { ash: '>=0.1.0' }, contributions: { editorExtensions: [{ id: 'debug', runtime: 'javascript', api: 'ash', entrypoint: 'extension.js', runtimeApiVersion: 1, activationEvents: [{ type: 'onDebugType', debugType: 'reverse-start' }], capabilities: ['debugAdapter'] }] }, permissions: [{ type: 'directory', access: 'read' }] }));
	await writeEditorExtensionFixture(root, `
const ash = require('@ash/sdk'); const { debug, window } = ash;
exports.activate = function(context) {
 let parentId; let childId;
 context.subscriptions.push(debug.registerDebugAdapterDescriptorFactory('reverse-start', {
  createDebugAdapterDescriptor(session) {
   const configuration = session.configuration;
   if (configuration.name === 'ReverseParent') parentId = session.id;
   else {
    if (configuration.name !== 'ReverseChild' || session.parentSession?.id !== parentId || session.workspaceFolder !== undefined) throw Error('Reverse child identity changed');
    childId = session.id;
   }
   const listeners = new Set(); let sequence = 0; let closed = false;
   function send(message) { for (const listener of listeners) listener({seq:sequence++,...message}); }
   return new ash.DebugAdapterInlineImplementation({
    onDidSendMessage(listener) { listeners.add(listener); return {dispose(){listeners.delete(listener);}}; },
    async handleMessage(request) {
     if (request.type === 'response') {
      if (request.command !== 'startDebugging' || request.request_seq !== 91 || request.success !== true || request.body !== undefined) throw Error('Invalid reverse response');
      if (!childId || childId === parentId) throw Error('Reverse child is missing');
      await window.showInformationMessage('DEBUG_REVERSE_READY');
      return;
     }
     if (request.command === 'initialize' && request.arguments.supportsStartDebuggingRequest !== true) throw Error('Reverse startup was not advertised');
     if (['setBreakpoints','setFunctionBreakpoints','setDataBreakpoints','setInstructionBreakpoints'].includes(request.command)) throw Error('Reverse child did not inherit noDebug');
     if (request.command === 'launch' || request.command === 'attach') {
      if (request.arguments.noDebug !== true) throw Error('Reverse child omitted noDebug');
      send({type:'event',event:'initialized',body:{}});
     }
     const body = request.command === 'initialize' ? {supportsConfigurationDoneRequest:true} : request.command === 'evaluate' ? {result:configuration.name + '_ANSWER',variablesReference:0} : {};
     send({type:'response',request_seq:request.seq,command:request.command,success:true,body});
     if (request.command === 'configurationDone') {
      send({type:'event',event:'output',body:{output:configuration.name + '_OUTPUT\\n'}});
      if (configuration.name === 'ReverseParent') send({seq:91,type:'request',command:'startDebugging',arguments:{request:'attach',configuration:{name:'ReverseChild'}}});
     }
     if (request.command === 'disconnect') send({type:'event',event:'terminated',body:{}});
    },
    async dispose() {
     if (closed || listeners.size) throw Error('Reverse adapter was not released exactly once');
     closed = true; await window.showInformationMessage('DEBUG_REVERSE_RELEASE:' + configuration.name);
    }
   });
  }
 }));
}
`);
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('debug-reverse-start');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/debug-reverse 1.0.0');
	for (const button of ['Enable', 'Grant permissions']) {
		await manageDebugExtension(application, workbench, 'Debug reverse request', button);
	}
	await writeFile(join(directory, '.vscode', 'launch.json'), JSON.stringify({ version: '0.2.0', configurations: [{ name: 'ReverseParent', type: 'reverse-start', request: 'launch', noDebug: true }] }));
	await workbench.quickaccess.runCommand('workbench.action.debug.start');
	await expect(page.locator('.ash-notification', { hasText: 'DEBUG_REVERSE_READY' })).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.debug.action.focusRepl');
	const selection = page.getByRole('combobox', { name: 'Debug Console session', exact: true });
	await expect(selection.locator('option')).toHaveCount(2);
	await expect(selection).toHaveValue(await selection.locator('option', { hasText: 'ReverseChild' }).getAttribute('value') ?? '');
	const output = page.getByRole('log', { name: 'Debug Console output', exact: true });
	await expect(output).toContainText('ReverseChild_OUTPUT');
	const expression = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	await fillReplInput(expression, 'answer');
	await expression.press('Enter');
	await expect(output).toContainText('ReverseChild_ANSWER');
	await workbench.quickaccess.runCommand('workbench.action.debug.stop');
	await expect(page.locator('.ash-notification', { hasText: 'DEBUG_REVERSE_RELEASE:ReverseChild' })).toBeVisible();
	await fillReplInput(expression, 'answer');
	await expression.press('Enter');
	await expect(output).toContainText('ReverseParent_ANSWER');
	await workbench.quickaccess.runCommand('workbench.action.debug.stop');
	await expect(page.locator('.ash-notification', { hasText: 'DEBUG_REVERSE_RELEASE:ReverseParent' })).toBeVisible();
	await expect(expression).toHaveAttribute('aria-readonly', 'true');
});


test('Debug provider undefined cancels and null opens the configuration in both resolution phases without starting Tasks or DAP', { tag: ['@browser-app-server', '@electron-app-server', '@darwin'] }, async ({ application, workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	const root = join(directory, 'debug-cancellation');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'acme/debug-cancellation', version: '1.0.0', displayName: 'Debug cancellation', compatibility: { ash: '>=0.1.0' }, contributions: { editorExtensions: [{ id: 'debug', runtime: 'javascript', api: 'ash', entrypoint: 'extension.js', runtimeApiVersion: 1, activationEvents: [{ type: 'onDebugType', debugType: 'cancel-provider' }], capabilities: ['command', 'debugAdapter'] }] }, permissions: [{ type: 'directory', access: 'read' }] }));
	await mkdir(join(root, 'defaults'));
	await writeFile(join(root, 'defaults', 'package.json'), JSON.stringify({ name: 'empty-debug-defaults', publisher: 'acme', version: '1.0.0', contributes: { debuggers: [{ type: 'empty-descriptor', label: 'Empty descriptor', debugAdapter: { program: process.execPath, args: [join(directory, 'debug-adapter.cjs'), join(directory, 'debug-program.js'), join(directory, 'debug-requests.jsonl')] } }] } }));
	const mustNotRun = join(directory, 'task-must-not-run');
	await writeFile(join(directory, 'task-must-not-run.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(mustNotRun)}, 'started');`);
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Must not run', type: 'process', command: process.execPath, args: [join(directory, 'task-must-not-run.cjs')] }] }));
	const configuration = { name: 'Cancel', type: 'cancel-provider', request: 'launch', program: '${workspaceFolder}/debug-program.js', preLaunchTask: 'Must not run', debugAdapter: { program: process.execPath, args: [join(directory, 'debug-adapter.cjs'), join(directory, 'debug-program.js'), join(directory, 'debug-requests.jsonl')] } };
	await writeEditorExtensionFixture(root, `
const ash = require('@ash/sdk'); const { commands, debug, window } = ash;
exports.activate = function(context) {
 let retiredSession;
 context.subscriptions.push(debug.registerDebugAdapterDescriptorFactory('empty-descriptor', {
  createDebugAdapterDescriptor(session, executable) {
   retiredSession = session;
   const configuration = session.configuration; const config = configuration;
   if (executable?.command !== ${JSON.stringify(process.execPath)}) throw Error('Default executable was not supplied');
   return config.outcome === 'null' ? null : undefined;
  }
 }));
 for (const outcome of ['undefined', 'null']) {
  context.subscriptions.push(commands.register('acme.debugCancellation.descriptor.' + outcome, async () => {
   let rejected = false;
   try {
    await debug.startDebugging(ash.workspace.workspaceFolders[0], {name:'Empty',type:'empty-descriptor',request:'launch',outcome});
   } catch (error) {
    if (error.code !== 'internal') throw error;
    rejected = true;
   }
   if (!rejected) throw Error('Empty descriptor was accepted');
   if (debug.activeDebugSession) throw Error('Prepared empty descriptor session survived');
   await window.showInformationMessage('ASH_DEBUG_EMPTY_DESCRIPTOR_' + outcome);
  }));
 }
 context.subscriptions.push(debug.registerDebugConfigurationProvider('cancel-provider', {
  resolveDebugConfiguration(_folder, config) { return config.phase === 'before' ? config.outcome === 'null' ? null : undefined : config; },
  resolveDebugConfigurationWithSubstitutedVariables(_folder, config) { return config.phase === 'after' ? config.outcome === 'null' ? null : undefined : config; }
 }));
 for (const phase of ['before', 'after']) for (const outcome of ['undefined', 'null']) {
  const name = phase + '.' + outcome;
  context.subscriptions.push(commands.register('acme.debugCancellation.' + name, async () => {
   const result = await debug.startDebugging(ash.workspace.workspaceFolders[0], {...${JSON.stringify(configuration)}, phase, outcome});
   if (result !== false) throw Error('Canceled provider started a session');
   await window.showInformationMessage('ASH_DEBUG_CANCEL_' + name);
  }));
 }
 context.subscriptions.push(commands.register('acme.debugCancellation.error', async () => {
  let rejected = false;
  try {
   await debug.startDebugging(ash.workspace.workspaceFolders[0], ${JSON.stringify(configuration)}, {parentSession:retiredSession});
  } catch (error) {
   if (!(error instanceof TypeError)) throw error;
   rejected = true;
  }
  if (!rejected) throw Error('A retired parent session was accepted');
  await window.showInformationMessage('ASH_DEBUG_ERROR_RECOVERED');
 }));
 void window.showInformationMessage('ASH_DEBUG_CANCELLATION_ACTIVATED');
}`, [{ type: 'empty-descriptor', label: 'Empty descriptor', debugAdapter: { program: process.execPath, args: [join(directory, 'debug-adapter.cjs'), join(directory, 'debug-program.js'), join(directory, 'debug-requests.jsonl')] } }, { type: 'cancel-provider', label: 'Cancellation provider' }]);
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = workbench.page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('debug-cancellation');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/debug-cancellation 1.0.0');
	const manage = async (button: string): Promise<void> => {
		await manageDebugExtension(application, workbench, 'Debug cancellation', button);
	};
	await manage('Enable');
	await manage('Grant permissions');
	// Activate the declared Debug type before exercising its registered commands.
	await writeFile(join(directory, '.vscode', 'launch.json'), JSON.stringify({ version: '0.2.0', configurations: [{ ...configuration, name: 'Debug smoke', phase: 'before', outcome: 'undefined' }] }));
	await workbench.quickaccess.runCommand('workbench.action.debug.start');
	await expect(workbench.page.locator('.ash-notification', { hasText: 'ASH_DEBUG_CANCELLATION_ACTIVATED' })).toBeVisible();
	await workbench.quickaccess.open('debug-program.js');
	await workbench.quickaccess.select('debug-program.js');
	const group = workbench.editors.groupAt(0);
	await group.editor.waitForEditorContents(text => text.includes('const answer = 42'));
	const original = await readFile(join(directory, '.vscode', 'launch.json'), 'utf8');
	for (const phase of ['before', 'after']) {
		for (const outcome of ['undefined', 'null']) {
			const name = `${phase}.${outcome}`;
			await workbench.quickaccess.runCommand('acme.debugCancellation.' + name);
			await expect(workbench.page.locator('.ash-notification', { hasText: 'ASH_DEBUG_CANCEL_' + name })).toBeVisible();
			const launchTab = group.tabs.filter({ hasText: 'launch.json' });
			if (outcome === 'null') {
				await expect(launchTab).toHaveAttribute('aria-selected', 'true');
				await group.editor.waitForEditorContents(text => text.includes('Debug smoke'));
				await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
			} else {
				await expect(launchTab).toHaveCount(0);
				await expect(group.tabs.filter({ hasText: 'debug-program.js' })).toHaveAttribute('aria-selected', 'true');
			}
			expect(await readFile(join(directory, 'debug-requests.jsonl'), 'utf8')).toBe('');
			await expect.poll(async () => { try { await readFile(mustNotRun); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }).toBe(false);
			expect(await readFile(join(directory, '.vscode', 'launch.json'), 'utf8')).toBe(original);
		}
	}
	for (const outcome of ['undefined', 'null']) {
		await workbench.quickaccess.runCommand('acme.debugCancellation.descriptor.' + outcome);
		await expect(workbench.page.locator('.ash-notification', { hasText: 'ASH_DEBUG_EMPTY_DESCRIPTOR_' + outcome })).toBeVisible();
	}
	await workbench.quickaccess.runCommand('acme.debugCancellation.error');
	await expect(workbench.page.locator('.ash-notification', { hasText: 'ASH_DEBUG_ERROR_RECOVERED' })).toBeVisible();
	expect(await readFile(join(directory, 'debug-requests.jsonl'), 'utf8')).toBe('');
	await expect.poll(async () => { try { await readFile(mustNotRun); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }).toBe(false);
	await manage('Revoke permissions');
	await manage('Disable');
	await manage('Uninstall');
});


test('Debug configure command reopens the existing launch document in the selected display language', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, testWorkspace, restartWorkbench }) => {
	const resource = join(testWorkspace.directory, '.vscode', 'launch.json');
	const original = await readFile(resource, 'utf8');
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ workbench } = await restartWorkbench());
	await workbench.quickaccess.open('>workbench.action.debug.configure');
	await expect(workbench.quickaccess.items.filter({ hasText: '打开 launch.json' })).toHaveCount(1);
	await workbench.quickaccess.select('打开 launch.json');
	await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text.includes('Debug smoke'));
	expect(await readFile(resource, 'utf8')).toBe(original);
	await workbench.quickaccess.runCommand('workbench.action.openSettings');
	const settings = workbench.page.getByRole('dialog', { name: 'Ash 设置' });
	await settings.getByRole('searchbox', { name: '搜索设置' }).fill('@id:debug.saveBeforeStart');
	await expect(settings.getByText('调试前保存', { exact: true })).toBeVisible();
	await expect(settings.getByText('控制启动调试会话之前保存哪些编辑器。', { exact: true })).toBeVisible();
});

const developerEnvironmentTest = test.extend({
	testWorkspace: async ({ testWorkspace }, use) => {
		// This fixture runs before either backend starts and restores this worker's environment.
		const values = { OPENAI_API_KEY: 'ash-synthetic-developer-key', ASH_DEVELOPER_REMOVED: 'remove me', CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN: 'ash-synthetic-host-control' };
		const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
		try {
			Object.assign(process.env, values);
			await use(testWorkspace);
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) { delete process.env[key]; }
				else { process.env[key] = value; }
			}
		}
	},
});

developerEnvironmentTest('developer environment reaches the debug adapter and shared launch variable resolution', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	await writeFile(join(directory, 'debug-adapter.cjs'), `require('node:fs').writeFileSync('debug-environment.json', JSON.stringify({ credential: process.env.OPENAI_API_KEY, removed: process.env.ASH_DEVELOPER_REMOVED === undefined, privateExcluded: process.env.CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN === undefined }));\n` + adapter);
	const resource = join(directory, '.vscode', 'launch.json');
	const document = JSON.parse(await readFile(resource, 'utf8'));
	document.configurations[0].developerCredential = '${env:OPENAI_API_KEY}';
	document.configurations[0].debugAdapter.env = { ASH_DEVELOPER_REMOVED: null };
	await writeFile(resource, JSON.stringify(document));
	await workbench.quickaccess.runCommand('workbench.action.debug.start');
	await expect(workbench.page.locator('.ash-debug-status')).toContainText('stopped');
	expect(JSON.parse(await readFile(join(directory, 'debug-environment.json'), 'utf8'))).toEqual({ credential: 'ash-synthetic-developer-key', removed: true, privateExcluded: true });
	const requests = (await readFile(join(directory, 'debug-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
	expect(requests.find(request => request.command === 'launch').arguments.developerCredential).toBe('ash-synthetic-developer-key');
});

/** Exercise the retained details editor; only permission review and uninstall use dialogs. */
async function manageDebugExtension(application: PlaywrightApplication, workbench: Workbench, label: string, action: string): Promise<void> {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
	await page.getByRole('listbox', { name: 'Installed Extensions', exact: true }).getByRole('option').filter({ has: page.getByText(label, { exact: true }) }).click();
	const editor = page.locator('.ash-extension-editor').filter({ has: page.getByRole('heading', { name: label, exact: true }) });
	const click = () => editor.getByRole('button', { name: action, exact: true }).click();
	if (action === 'Enable' || action === 'Disable') {
		await click();
		await expect(editor.getByRole('button', { name: action === 'Enable' ? 'Disable' : 'Enable', exact: true })).toBeEnabled();
	} else {
		await workbench.dialogs.confirm(application, action === 'Uninstall' ? 'Uninstall extension' : label, action, click);
		if (action === 'Uninstall') await expect(editor.getByRole('status')).toHaveText('Uninstalled');
		else await expect(editor.getByRole('button', { name: action === 'Grant permissions' ? 'Revoke permissions' : 'Grant permissions', exact: true })).toBeEnabled();
	}
}

test('Debug workspace definitions migrate from Memento, survive reload and resume interrupted cleanup', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, workbench, testWorkspace, webAppServer, reloadWorkbench }) => {
	const workspaceId = await workbench.page.evaluate(async () => {
		const host = globalThis as unknown as { ashWebWorkbenchHost?: { workspace: { id: string; }; }; ash?: { ipcRenderer: { invoke(channel: string): Promise<{ id: string; }>; }; }; };
		return host.ashWebWorkbenchHost?.workspace.id ?? (await host.ash!.ipcRenderer.invoke('ash:workspace:context:read')).id;
	});
	const identity = { scope: StorageScope.WORKSPACE, id: workspaceId };
	const source = pathToFileURL(join(testWorkspace.directory, 'debug-program.js')).toString();
	const legacy = JSON.stringify({ version: 1, breakpoints: [{ resource: source, lineNumber: 2, enabled: false, condition: 'answer > 0' }], watchExpressions: ['answer'], exceptionBreakpoints: {} });
	const seed = () => seedStorageOnNextLoad(application, workbench.page, identity, { 'memento/debug.workspace': { value: legacy, target: StorageTarget.USER } });
	const profile = webAppServer?.profileDirectory ?? ('windows' in application ? join(await application.evaluate(({ app }) => app.getPath('userData')), 'profile') : undefined);
	if (!profile) throw new Error('Debug persistence acceptance requires its App Server profile');
	const saved = (): { breakpoints: { id: string; enabled: boolean; condition?: string; }[]; watchExpressions: string[]; } | undefined => {
		const database = new DatabaseSync(join(profile, 'state.sqlite3'), { readOnly: true });
		try {
			const record = database.prepare('SELECT document FROM debug_workspaces WHERE workspace_id = ?').get(workspaceId) as { document: string; } | undefined;
			return record ? JSON.parse(record.document) : undefined;
		} finally { database.close(); }
	};
	await seed();
	({ application, workbench } = await reloadWorkbench());
	const open = async () => {
		const pane = workbench.page.locator('[data-view-id="workbench.view.debug"]');
		const tab = workbench.page.getByRole('tab', { name: 'Run and Debug', exact: true }).first();
		if (await tab.getAttribute('aria-selected') !== 'true' || !await pane.isVisible()) await tab.click();
		await expect(pane).toBeVisible();
		return pane;
	};
	let pane = await open();
	await expect(pane.locator('.ash-debug-breakpoints > li').filter({ hasText: 'debug-program.js:2' })).toBeVisible();
	await expect.poll(() => saved()?.watchExpressions).toEqual(['answer']);
	await expect.poll(async () => (await readStorageEntries(application, workbench.page, identity))['memento/debug.workspace']).toBeUndefined();
	expect(saved()?.breakpoints).toEqual([{ id: `${source}:2`, enabled: false, condition: 'answer > 0', resource: source, lineNumber: 2 }]);
	await pane.getByRole('button', { name: 'Watch', exact: true }).hover();
	await pane.getByRole('button', { name: 'Add watch expression', exact: true }).click();
	await pane.getByRole('textbox', { name: 'Add watch expression', exact: true }).fill('answer + 1');
	await pane.getByRole('textbox', { name: 'Add watch expression', exact: true }).press('Enter');
	await expect.poll(() => saved()?.watchExpressions).toEqual(['answer', 'answer + 1']);
	// Restore the original source to model a crash before legacy deletion.
	await seed();
	({ application, workbench } = await reloadWorkbench());
	pane = await open();
	await expect(pane.locator('.ash-debug-watch-value')).toHaveCount(2);
	await expect.poll(async () => (await readStorageEntries(application, workbench.page, identity))['memento/debug.workspace']).toBeUndefined();
	expect(saved()?.watchExpressions).toEqual(['answer', 'answer + 1']);
	await pane.locator('.ash-debug-breakpoints > li').filter({ hasText: 'debug-program.js:2' }).getByRole('button', { name: 'Remove breakpoint', exact: true }).click();
	await pane.locator('.ash-debug-watch-remove').first().click();
	await pane.locator('.ash-debug-watch-remove').first().click();
	await expect.poll(() => ({ points: saved()?.breakpoints, watches: saved()?.watchExpressions })).toEqual({ points: [], watches: [] });
	({ application, workbench } = await reloadWorkbench());
	pane = await open();
	await expect(pane.locator('.ash-debug-breakpoints > li')).toHaveCount(0);
	await expect(pane.locator('.ash-debug-watch-value')).toHaveCount(0);
});

test('Debug live exception filters and structured output are owned by Rust', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	const stopped = "event('stopped', { reason: 'breakpoint', threadId: 7, allThreadsStopped: true });";
	const peer = adapter
		.replace('supportsConfigurationDoneRequest: true,', "supportsConfigurationDoneRequest: true, exceptionBreakpointFilters: [{filter:'uncaught',label:'Uncaught',default:true},{filter:'caught',label:'Caught',default:false}],")
		.replace('let success = true;', "let success = !(request.command === 'setExceptionBreakpoints' && args.filters.includes('caught'));")
		.replace("message: 'Value must be numeric.'", "message: request.command === 'setExceptionBreakpoints' ? 'Filter refused.' : 'Value must be numeric.'")
		.replace(stopped, stopped + String.raw`
    event('output', {group:'startCollapsed',output:'RUST_GROUP\n'});
    event('output', {category:'stderr',output:'RUST_OBJECT',variablesReference:20,source:{name:'debug-program.js',path:source},line:2,column:1,data:{owner:'rust'}});
    event('output', {group:'end'});
    event('output', {output:'part '});
    event('output', {output:'line\n'});
`);
	await writeFile(join(directory, 'debug-adapter.cjs'), peer);
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.debug.start');
	const pane = page.locator('[data-view-id="workbench.view.debug"]');
	await expect(pane.getByRole('status')).toContainText('stopped');
	const uncaught = pane.getByRole('checkbox', { name: 'Uncaught', exact: true });
	const caught = pane.getByRole('checkbox', { name: 'Caught', exact: true });
	const selections = async () => (await readFile(join(directory, 'debug-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; arguments?: { filters?: string[]; }; }).filter(request => request.command === 'setExceptionBreakpoints');
	await expect(uncaught).toBeChecked();
	await uncaught.uncheck();
	await expect.poll(async () => (await selections()).at(-1)?.arguments?.filters).toEqual([]);
	await expect(uncaught).not.toBeChecked();
	await caught.check();
	await expect(pane.getByRole('status')).toContainText('Filter refused.');
	await expect(caught).not.toBeChecked();
	await expect(pane.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
	await uncaught.check();
	await expect.poll(async () => (await selections()).at(-1)?.arguments?.filters).toEqual(['uncaught']);
	await expect(uncaught).toBeChecked();
	await workbench.quickaccess.runCommand('workbench.debug.action.focusRepl');
	const output = page.getByRole('log', { name: 'Debug Console output', exact: true });
	const tree = output.getByRole('tree', { name: 'Debug Console output', exact: true });
	const group = output.getByRole('treeitem').filter({ hasText: 'RUST_GROUP' });
	await expect(group).toBeVisible();
	await group.locator('.ash-tree-twistie').click();
	await expect(group).toHaveAttribute('aria-expanded', 'true');
	await tree.press('ArrowLeft');
	await expect(group).toHaveAttribute('aria-expanded', 'false');
	await tree.press('ArrowRight');
	const object = output.getByRole('treeitem').filter({ hasText: 'RUST_OBJECT' });
	await object.locator('.ash-tree-twistie').click();
	await expect(object).toHaveAttribute('aria-expanded', 'true');
	await expect(output).toContainText('child: 1');
	await expect(output).toContainText('"owner": "rust"');
	const source = output.getByRole('button', { name: 'debug-program.js:2', exact: true });
	await source.focus();
	await source.press('Enter');
	await workbench.editors.groupAt(0).editor.waitForEditorContents(content => content.includes('console.log(answer)'));
	const partial = output.locator('.ash-repl-entry').filter({ hasText: /^part/ });
	const line = output.locator('.ash-repl-entry').filter({ hasText: /^line/ });
	expect(await partial.evaluate(element => element.getClientRects()[0].top)).toBe(await line.evaluate(element => element.getClientRects()[0].top));
	await uncaught.uncheck();
	await expect.poll(async () => (await selections()).at(-1)?.arguments?.filters).toEqual([]);
	await workbench.quickaccess.runCommand('workbench.action.debug.stop');
	await workbench.quickaccess.runCommand('workbench.action.debug.start');
	await expect(pane.getByRole('status')).toContainText('stopped');
	await expect(uncaught).not.toBeChecked();
	await expect.poll(async () => (await selections()).at(-1)?.arguments?.filters).toEqual([]);
	await workbench.quickaccess.runCommand('workbench.action.debug.stop');
});

test('Debug Console filters, workspace history and DAP completions use the production owners', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, testWorkspace, reloadWorkbench }) => {
	const directory = testWorkspace.directory;
	const peer = adapter
		.replace('supportsConfigurationDoneRequest: true,', "supportsConfigurationDoneRequest: true, supportsCompletionsRequest: true, supportsCancelRequest: true, completionTriggerCharacters: ['.'],")
		.replace("if (request.command === 'evaluate')", "if (request.command === 'completions') body = { targets: [{label:'answer',start:1,length:args.column-1},{label:'another',start:1,length:args.column-1}] };\n  if (request.command === 'evaluate')")
		.replace("event('output', { category: 'console', output: 'ASH_DEBUG_READY\\n' });", "event('output', { category: 'console', output: 'ASH_DEBUG_READY\\n' }); event('output', {output:'ALPHA visible\\n'}); event('output', {output:'BETA hidden\\n'});");
	await writeFile(join(directory, 'debug-adapter.cjs'), peer);
	const requests = async () => (await readFile(join(directory, 'debug-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; arguments?: { text?: string; expression?: string; column?: number; line?: number; frameId?: number; context?: string; }; });
	const page = workbench.page;
	await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	await page.locator('[data-part="sidebar"]').getByRole('button', { name: 'Start Debugging', exact: true }).click();
	const pane = page.locator('[data-view-id="workbench.view.debug"]');
	await expect(pane.getByRole('status')).toContainText('stopped');
	await pane.getByRole('button', { name: 'main debug-program.js:2', exact: true }).click();
	await workbench.quickaccess.runCommand('workbench.debug.action.focusRepl');
	const consolePane = page.locator('[data-view-id="workbench.panel.debugConsole"]');
	const output = consolePane.getByRole('log', { name: 'Debug Console output', exact: true });
	await expect(output).toContainText('ALPHA visible');
	const filter = page.getByRole('textbox', { name: 'Filter Debug Console', exact: true });
	await filter.fill('ALPHA, !hidden');
	await filter.press('Enter');
	await expect(output.getByRole('treeitem').filter({ hasText: 'ALPHA visible' })).toBeVisible();
	await expect(output.getByRole('treeitem').filter({ hasText: 'BETA hidden' })).toBeHidden();
	await filter.press('Escape');
	await expect(output.getByRole('treeitem').filter({ hasText: 'BETA hidden' })).toBeVisible();
	const input = consolePane.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	await fillReplInput(input, 'an');
	await input.press('Control+Space');
	const suggestions = consolePane.getByRole('listbox', { name: 'Debug Console suggestions', exact: true });
	await expect(suggestions.getByRole('option')).toHaveCount(2);
	await input.press('ArrowDown');
	await input.press('Enter');
	await expectReplInput(input, 'answer');
	expect((await requests()).filter(request => request.command === 'evaluate' && request.arguments?.context === 'repl')).toEqual([]);
	expect((await requests()).filter(request => request.command === 'completions').at(-1)?.arguments).toMatchObject({ text: 'an', column: 3, line: 1, frameId: 11 });
	await input.press('Enter');
	await expect(output).toContainText('42');
	await expect.poll(async () => (await requests()).filter(request => request.command === 'evaluate' && request.arguments?.context === 'repl').at(-1)?.arguments?.frameId).toBe(11);
	await fillReplInput(input, 'draft');
	await input.press('ArrowUp');
	await expectReplInput(input, 'answer');
	await input.press('ArrowDown');
	await expectReplInput(input, 'draft');
	await workbench.quickaccess.runCommand('workbench.debug.panel.action.clearReplAction');
	await expect(output.getByRole('treeitem')).toHaveCount(0);
	await workbench.quickaccess.runCommand('workbench.action.debug.stop');
	const resumed = await reloadWorkbench();
	const restoredDebugPane = resumed.workbench.page.locator('[data-view-id="workbench.view.debug"]');
	// The selected activity tab toggles a restored sidebar closed when clicked again.
	if (!await restoredDebugPane.isVisible()) await resumed.workbench.page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	await expect(restoredDebugPane).toBeVisible();
	await resumed.workbench.page.locator('[data-part="sidebar"]').getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await expect(restoredDebugPane.getByRole('status')).toContainText('stopped');
	await restoredDebugPane.getByRole('button', { name: 'main debug-program.js:2', exact: true }).click();
	await resumed.workbench.quickaccess.runCommand('workbench.debug.action.focusRepl');
	const restoredInput = resumed.workbench.page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	await restoredInput.press('ArrowUp');
	await expectReplInput(restoredInput, 'answer');
	const restoredFilter = resumed.workbench.page.getByRole('textbox', { name: 'Filter Debug Console', exact: true });
	await restoredFilter.press('ArrowUp');
	await expect(restoredFilter).toHaveValue('ALPHA, !hidden');
	await fillReplInput(restoredInput, 'answer +');
	await restoredInput.press('Shift+Enter');
	await resumed.workbench.page.keyboard.insertText('😀an');
	await restoredInput.press('Control+Space');
	const restoredConsole = resumed.workbench.page.locator('[data-view-id="workbench.panel.debugConsole"]');
	await expect(restoredConsole.getByRole('option', { name: 'answer', exact: true })).toBeVisible();
	await restoredInput.press('ArrowDown');
	await restoredInput.press('Enter');
	await expectReplInput(restoredInput, 'answer +\nanswer');
	const multiline = (await requests()).filter(request => request.command === 'completions').at(-1)?.arguments;
	expect(multiline).toMatchObject({ text: 'answer +\n😀an', line: 2, column: 5, frameId: 11 });
	await restoredInput.press('Enter');
	await expect.poll(async () => (await requests()).filter(request => request.command === 'evaluate' && request.arguments?.context === 'repl').at(-1)?.arguments).toMatchObject({ expression: 'answer +\nanswer', frameId: 11 });
	await resumed.workbench.quickaccess.runCommand('workbench.action.debug.stop');
});

// The disposable SSH host runs on this machine, but has a separate profile,
// transport and backend process. This exercises Remote routing without relying
// on a developer's SSH configuration or another machine's availability.
test('SSH Desktop Debug routes inspection and multiline REPL through the remote Rust owner', { tag: ['@electron-app-server', '@darwin'] }, async ({ testWorkspace }, testInfo) => {
	test.setTimeout(180_000);
	const packageRoot = developmentAshPackagePath(process.env.ASH_SMOKE_DESKTOP_DIRECTORY ?? resolve('.'));
	const fixture = await createSshFixture(join(packageRoot, 'bin/ash-app-server-daemon'));
	const directory = testWorkspace.directory;
	const ownership = join(directory, 'remote-debug-owner.json');
	await writeFile(join(directory, 'debug-adapter.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(ownership)}, JSON.stringify({ pid: process.pid, profile: process.env.ASH_HOME }));\n` + adapter);
	let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
	try {
		desktop = await launchElectron({
			appServerMode: 'required', userDataDirectory: join(fixture.root, 'desktop'),
			workspaceDirectory: directory, workspacePermissions: 'development', startupTimeout: 60_000,
			extraArgs: [`--remote-ssh=${fixture.host}`],
			environment: { ...process.env, ASH_SSH_PATH: fixture.ssh, ASH_REMOTE_ASH_PATH: join(packageRoot, 'bin/ash-remote-server') },
		});
		const { workbench } = desktop.driver;
		const page = workbench.page;
		await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
		await expect(page.locator('[data-statusbar-item-id="ash.status.remote"]')).toHaveAttribute('aria-label', `Remote connection to SSH host ${fixture.host} is ready`);
		await workbench.quickaccess.runCommand('workbench.action.debug.start');
		const pane = page.locator('[data-view-id="workbench.view.debug"]');
		await expect(pane.getByRole('status')).toContainText('stopped');
		await expect(pane.locator('.ash-debug-variables')).toContainText('answer = 42');
		await expect(pane.locator('.ash-debug-variables')).toContainText('object = Object');
		await pane.getByRole('button', { name: 'main debug-program.js:2', exact: true }).click();
		const owner = JSON.parse(await readFile(ownership, 'utf8')) as { pid: number; profile: string; };
		expect(await realpath(owner.profile)).toBe(await realpath(join(fixture.root, 'remote-profile')));
		expect(() => process.kill(owner.pid, 0)).not.toThrow();
		await workbench.quickaccess.runCommand('workbench.debug.action.focusRepl');
		const input = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
		await fillReplInput(input, 'answer +');
		await input.press('Shift+Enter');
		await page.keyboard.insertText('1');
		await expectReplInput(input, 'answer +\n1');
		await input.press('Enter');
		await expect(page.getByRole('log', { name: 'Debug Console output', exact: true })).toContainText('42');
		const requests = () => readFile(join(directory, 'debug-requests.jsonl'), 'utf8').then(text => text.trim().split('\n').map(line => JSON.parse(line) as { command: string; arguments?: { expression?: string; context?: string; frameId?: number; }; }));
		await expect.poll(async () => (await requests()).filter(request => request.command === 'evaluate' && request.arguments?.context === 'repl').at(-1)?.arguments).toMatchObject({ expression: 'answer +\n1', frameId: 11 });
		await workbench.quickaccess.runCommand('workbench.action.debug.stop');
		await expect(input).toHaveAttribute('aria-readonly', 'true');
		await expect.poll(() => { try { process.kill(owner.pid, 0); return false; } catch { return true; } }).toBe(true);
		await testInfo.attach('remote-debug-owner', { body: JSON.stringify({ ...owner, adapterReclaimed: true, multilineFrame: 11 }), contentType: 'application/json' });
	} finally {
		try {
			if (desktop) {
				try {
					const path = testInfo.outputPath('trace.zip');
					await desktop.driver.workbench.page.context().tracing.stop({ path });
					await testInfo.attach('trace', { path, contentType: 'application/zip' });
				} finally { await desktop.close(); }
			}
		} finally { await fixture.close(); }
	}
});
