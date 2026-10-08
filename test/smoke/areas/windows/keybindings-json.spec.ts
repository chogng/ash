import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { Schemas } from '../../../../src/ash/base/common/network.js';
import { URI } from '../../../../src/ash/base/common/uri.js';

const profileKeybindingsResource = URI.from({ scheme: Schemas.vscodeUserData, path: '/user/keybindings.json' }).toString();

interface RecorderSaveGate {
	held: boolean;
	settled: boolean;
	mutations: number;
	focusCalls: number;
	observeRetiredPane(): void;
	release(abort: boolean): void;
	restore(): void;
}

interface RecorderDiskSaveGate {
	held: boolean;
	settled: boolean;
	observed: string[];
	release(reject: boolean): void;
	restore(): void;
}

declare global {
	var ashTestRecorderSaveGate: RecorderSaveGate | undefined;
	var ashTestRecorderDiskSaveGate: RecorderDiskSaveGate | undefined;
}

test.afterEach(async ({ runningApplication }, testInfo) => {
	const { pageErrors, consoleErrors, errors } = runningApplication.diagnostics;
	await testInfo.attach('keybindings-runtime-diagnostics', { body: JSON.stringify({ pageErrors, consoleErrors, forbiddenErrors: errors }), contentType: 'application/json' });
});

async function replaceJson(input: Locator, source: string): Promise<void> {
	await input.press('ControlOrMeta+A');
	await input.evaluate((element, source) => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', source);
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	}, source);
}

async function readBrowserProfile(input: Locator): Promise<string> {
	return input.evaluate(async (_input, resource) => {
		const open = indexedDB.open('ash-user-data-files');
		const database = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
		try {
			const read = database.transaction('files').objectStore('files').get(resource);
			const entry = await new Promise<{ bytes: Uint8Array; }>((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); });
			return new TextDecoder().decode(entry.bytes);
		} finally { database.close(); }
	}, profileKeybindingsResource);
}

/** Retains the removed pane solely to observe late DOM changes and focus requests. */
async function observeRecorderSave(root: Locator): Promise<void> {
	await root.evaluate(root => {
		const controls = [...root.querySelectorAll<HTMLElement>('input, button, [role="status"], .ash-keybindings-recorder')];
		const focusMethods = new Map<HTMLElement, HTMLElement['focus']>();
		let observer: MutationObserver | undefined;
		const gate: RecorderSaveGate = {
			held: false, settled: false, mutations: 0, focusCalls: 0,
			observeRetiredPane() {
				observer = new MutationObserver(records => { gate.mutations += records.length; });
				for (const control of [root, ...controls]) observer.observe(control, { attributes: true, childList: true, characterData: true, subtree: true });
				for (const control of controls.filter(control => control.tagName === 'INPUT')) {
					const focus = control.focus;
					focusMethods.set(control, focus);
					control.focus = options => { gate.focusCalls += 1; focus.call(control, options); };
				}
			},
			release() { gate.held = false; },
			restore() {
				gate.release(false);
				observer?.disconnect();
				for (const [control, focus] of focusMethods) control.focus = focus;
				globalThis.ashTestRecorderSaveGate = undefined;
			},
		};
		globalThis.ashTestRecorderSaveGate = gate;
	});
}

/** Keeps the actual profile transaction alive; no file data or product service is replaced. */
async function holdRecorderProfileWrite(root: Locator, binding: string): Promise<void> {
	await observeRecorderSave(root);
	await root.evaluate((_root, { binding, resource }) => {
		const originalPut = IDBObjectStore.prototype.put;
		const gate = globalThis.ashTestRecorderSaveGate!;
		const restore = gate.restore;
		let transaction: IDBTransaction | undefined;
		gate.release = abort => {
			gate.held = false;
			if (abort && transaction && !gate.settled) transaction.abort();
		};
		gate.restore = () => {
			gate.release(false);
			IDBObjectStore.prototype.put = originalPut;
			restore();
		};
		IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
			const request = originalPut.call(this, value, key);
			const entry = value as { bytes?: Uint8Array; };
			if (!transaction && this.transaction.db.name === 'ash-user-data-files' && String(key) === resource && entry.bytes && new TextDecoder().decode(entry.bytes).includes(binding)) {
				transaction = this.transaction;
				gate.held = true;
				transaction.addEventListener('complete', () => { gate.settled = true; });
				transaction.addEventListener('abort', () => { gate.settled = true; });
				// A queued read keeps this real readwrite transaction open across UI actions.
				const store = this;
				const keepAlive = (): void => {
					if (!gate.held) return;
					const read = store.get(key!);
					read.onsuccess = keepAlive;
				};
				keepAlive();
			}
			return request;
		};
	}, { binding, resource: profileKeybindingsResource });
}

/** Pauses Main's actual atomic publication of only this isolated profile's shortcut file. */
async function holdRecorderDiskWrite(application: ElectronApplication, binding: string): Promise<void> {
	await application.evaluate(async (_electron, binding) => {
		const fs = process.getBuiltinModule('fs').promises;
		// Main and the fixture can spell macOS temporary paths through different aliases.
		const path = await fs.realpath(`${process.env.ASH_HOME}/keybindings.json`);
		const rename = fs.rename;
		let release: ((reject: boolean) => void) | undefined;
		let captured = false;
		const gate: RecorderDiskSaveGate = {
			held: false, settled: false, observed: [],
			release(reject) { gate.held = false; release?.(reject); release = undefined; },
			restore() { gate.release(false); fs.rename = rename; globalThis.ashTestRecorderDiskSaveGate = undefined; },
		};
		globalThis.ashTestRecorderDiskSaveGate = gate;
		fs.rename = async (source, destination) => {
			if (String(destination).endsWith('/keybindings.json')) gate.observed.push(`${source} -> ${destination}`);
			if (captured || !String(destination).endsWith('/keybindings.json') || await fs.realpath(destination) !== path || !(await fs.realpath(source)).startsWith(`${path}.`) || !(await fs.readFile(source, 'utf8')).includes(binding)) return rename(source, destination);
			captured = true;
			gate.held = true;
			try {
				await new Promise<void>((resolve, reject) => {
					release = fail => fail ? reject(new Error('Test profile save rejected before publication.')) : resolve();
				});
				await rename(source, destination);
			} finally { gate.settled = true; }
		};
	}, binding);
}

interface BrowserBackupRecord {
	key: string;
	workspaceId: string;
	resource: string;
	content: string;
	updatedAt: number;
}

async function readBrowserBackups(input: Locator): Promise<BrowserBackupRecord[]> {
	return input.evaluate(async (_input, resource) => {
		const open = indexedDB.open('ash-working-copy-backups');
		const database = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
		try {
			const read = database.transaction('backups').objectStore('backups').getAll();
			const records = await new Promise<BrowserBackupRecord[]>((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); });
			return records.filter(record => record.resource === resource);
		} finally { database.close(); }
	}, profileKeybindingsResource);
}

async function recordBackupTraffic(page: Page) {
	const session = await page.context().newCDPSession(page);
	await session.send('Network.enable');
	const requests = new Set<string>();
	const events: { at: number; direction: 'sent' | 'received'; frame: Record<string, unknown>; }[] = [];
	const record = (direction: 'sent' | 'received', connection: string, payload: string): void => {
		let frame: Record<string, unknown>;
		try { frame = JSON.parse(payload) as Record<string, unknown>; } catch { return; }
		const id = `${connection}:${String(frame.id)}`;
		if (direction === 'sent') {
			if (typeof frame.method !== 'string' || !frame.method.startsWith('backup/')) return;
			requests.add(id);
		} else if (!requests.delete(id)) return;
		events.push({ at: Date.now(), direction, frame });
	};
	session.on('Network.webSocketFrameSent', event => record('sent', event.requestId, event.response.payloadData));
	session.on('Network.webSocketFrameReceived', event => record('received', event.requestId, event.response.payloadData));
	return { events, dispose: () => session.detach() };
}

for (const outcome of ['resolve', 'abort'] as const) {
	test(`Keyboard Shortcuts recorder pending profile write ${outcome} after closing its tab leaves the next editor focused`, async ({ target, workbench }) => {
		test.skip(target.kind !== 'browser', 'Exercises the real IndexedDB profile transaction; filesystem lifecycle cases use the unit owner fixture.');
		await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
		const group = workbench.editors.groupAt(0);
		const source = '// keep pending recorder comment\n[{"key":"ctrl+alt+y","command":"workbench.action.openSettings"}]';
		await replaceJson(group.editor.input, source);
		await workbench.quickaccess.runCommand('workbench.action.files.save');
		const jsonTab = group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' });
		await expect(jsonTab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
		await workbench.quickaccess.runCommand('workbench.action.openKeyboardShortcuts');
		const root = workbench.page.locator('.ash-keybindings-editor');
		await root.getByRole('searchbox').fill('workbench.action.openSettings');
		await root.locator('.ash-keybindings-row.is-user').getByRole('button', { name: 'Edit', exact: true }).click();
		const input = root.getByRole('textbox', { name: 'Record keybinding', exact: true });
		const binding = 'ctrl+alt+[KeyK] ctrl+alt+[KeyP]';
		await input.press('Control+Alt+K');
		await input.press('Control+Alt+P');
		await holdRecorderProfileWrite(root, binding);
		try {
			await root.getByRole('button', { name: 'Save', exact: true }).click();
			await expect.poll(() => workbench.page.evaluate(() => globalThis.ashTestRecorderSaveGate?.held)).toBe(true);
			await expect(root.locator('.ash-keybindings-recorder')).toHaveAttribute('aria-busy', 'true');
			await expect(input).toBeDisabled();
			const tab = group.tabs.filter({ hasText: 'Keyboard Shortcuts', hasNotText: '(JSON)' });
			await tab.locator('..').getByRole('button', { name: /Close/u }).click();
			await expect(tab).toHaveCount(0);
			await group.editor.input.focus();
			await expect(group.editor.input).toBeFocused();
			await workbench.page.evaluate(() => globalThis.ashTestRecorderSaveGate!.observeRetiredPane());
			await workbench.page.evaluate(abort => globalThis.ashTestRecorderSaveGate!.release(abort), outcome === 'abort');
			await expect.poll(() => workbench.page.evaluate(() => globalThis.ashTestRecorderSaveGate?.settled)).toBe(true);
			await group.editor.waitForEditorContents(content => content.includes(binding) && content.startsWith('// keep pending recorder comment'));
			await expect(group.editor.input).toBeFocused();
			if (outcome === 'abort') await expect(jsonTab.locator('..')).toHaveAttribute('data-state', /dirty/u);
			else await expect(jsonTab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
			const retired = await workbench.page.evaluate(() => ({ mutations: globalThis.ashTestRecorderSaveGate!.mutations, focusCalls: globalThis.ashTestRecorderSaveGate!.focusCalls }));
			expect(retired).toEqual({ mutations: 0, focusCalls: 0 });
			const persisted = await readBrowserProfile(group.editor.input);
			if (outcome === 'abort') {
				expect(persisted).toBe(source);
				await workbench.quickaccess.runCommand('workbench.action.files.save');
				await expect(jsonTab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
			} else {
				expect(persisted).toContain(binding);
				expect(persisted).toContain('// keep pending recorder comment');
			}
		} finally { await workbench.page.evaluate(() => globalThis.ashTestRecorderSaveGate?.restore()); }
	});
}

for (const outcome of ['resolve', 'reject'] as const) {
	test(`Keyboard Shortcuts recorder pending disk publication ${outcome} after closing its tab leaves the next editor focused`, async ({ target, application, workbench }, testInfo) => {
		test.skip(target.kind !== 'electron', 'Exercises Main atomic file publication in an isolated Desktop profile.');
		if (!('windows' in application)) throw new Error('Requires Electron');
		const profile = await application.evaluate(() => process.env.ASH_HOME);
		if (!profile) throw new Error('Test profile unavailable');
		await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
		const group = workbench.editors.groupAt(0);
		const source = '// keep pending recorder comment\n[{"key":"ctrl+alt+y","command":"workbench.action.openSettings"}]';
		await replaceJson(group.editor.input, source);
		await workbench.quickaccess.runCommand('workbench.action.files.save');
		const jsonTab = group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' });
		await expect(jsonTab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
		await expect.poll(() => readFile(join(profile, 'keybindings.json'), 'utf8')).toBe(source);
		await workbench.quickaccess.runCommand('workbench.action.openKeyboardShortcuts');
		const root = workbench.page.locator('.ash-keybindings-editor');
		await root.getByRole('searchbox').fill('workbench.action.openSettings');
		await root.locator('.ash-keybindings-row.is-user').getByRole('button', { name: 'Edit', exact: true }).click();
		const input = root.getByRole('textbox', { name: 'Record keybinding', exact: true });
		const binding = 'ctrl+alt+[KeyK] ctrl+alt+[KeyP]';
		await input.press('Control+Alt+K');
		await input.press('Control+Alt+P');
		await observeRecorderSave(root);
		await holdRecorderDiskWrite(application, binding);
		try {
			await root.getByRole('button', { name: 'Save', exact: true }).click();
			await expect.poll(() => application.evaluate(() => globalThis.ashTestRecorderDiskSaveGate?.held)).toBe(true);
			await expect(root.locator('.ash-keybindings-recorder')).toHaveAttribute('aria-busy', 'true');
			await expect(input).toBeDisabled();
			expect(await readFile(join(profile, 'keybindings.json'), 'utf8')).toBe(source);
			const tab = group.tabs.filter({ hasText: 'Keyboard Shortcuts', hasNotText: '(JSON)' });
			await tab.locator('..').getByRole('button', { name: /Close/u }).click();
			await expect(tab).toHaveCount(0);
			await group.editor.input.focus();
			await expect(group.editor.input).toBeFocused();
			await workbench.page.evaluate(() => globalThis.ashTestRecorderSaveGate!.observeRetiredPane());
			await application.evaluate((_electron, reject) => globalThis.ashTestRecorderDiskSaveGate!.release(reject), outcome === 'reject');
			await expect.poll(() => application.evaluate(() => globalThis.ashTestRecorderDiskSaveGate?.settled)).toBe(true);
			await group.editor.waitForEditorContents(content => content.includes(binding) && content.startsWith('// keep pending recorder comment'));
			await expect(group.editor.input).toBeFocused();
			if (outcome === 'reject') {
				await expect(jsonTab.locator('..')).toHaveAttribute('data-state', /dirty/u);
				expect(await readFile(join(profile, 'keybindings.json'), 'utf8')).toBe(source);
				// Retry queues behind the failed real save, so all late callbacks have settled.
				await workbench.quickaccess.runCommand('workbench.action.files.save');
			}
			await expect(jsonTab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
			await expect.poll(() => readFile(join(profile, 'keybindings.json'), 'utf8')).toContain(binding);
			await expect(group.editor.input).toBeFocused();
			const retired = await workbench.page.evaluate(() => ({ mutations: globalThis.ashTestRecorderSaveGate!.mutations, focusCalls: globalThis.ashTestRecorderSaveGate!.focusCalls }));
			expect(retired).toEqual({ mutations: 0, focusCalls: 0 });
		} finally {
			await testInfo.attach('recorder-disk-publication-gate', { body: JSON.stringify(await application.evaluate(() => ({ held: globalThis.ashTestRecorderDiskSaveGate?.held, settled: globalThis.ashTestRecorderDiskSaveGate?.settled, observed: globalThis.ashTestRecorderDiskSaveGate?.observed }))), contentType: 'application/json' });
			await application.evaluate(() => globalThis.ashTestRecorderDiskSaveGate?.restore());
			await workbench.page.evaluate(() => globalThis.ashTestRecorderSaveGate?.restore());
		}
	});
}

for (const waitForRemoval of [false, true]) {
	test(`Keybindings JSON repeated saves retain the latest file text after reload without opening the recorder ${waitForRemoval ? 'after backup removal' : 'immediately'}`, async ({ target, workbench, reloadWorkbench }, testInfo) => {
		test.skip(target.kind !== 'browser' || target.appServerMode !== 'required', 'Read-only backup traffic diagnosis uses the real Web backend.');
		const traffic = await recordBackupTraffic(workbench.page);
		const stages: { stage: string; at: number; rendered: string; file: string; state: string | null; backups: BrowserBackupRecord[]; }[] = [];
		let group = workbench.editors.groupAt(0);
		const snapshot = async (stage: string): Promise<void> => {
			stages.push({ stage, at: Date.now(), rendered: (await group.editor.lines.allTextContents()).join('\n').replace(/\u00a0/g, ' '), file: await readBrowserProfile(group.editor.input), state: await group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' }).locator('..').getAttribute('data-state'), backups: await readBrowserBackups(group.editor.input) });
		};
		try {
			await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
			const original = '[{"key":"ctrl+alt+y","command":"workbench.action.files.newUntitledFile"}]';
			const dirty = '// unsaved recorder comment\n' + original;
			await replaceJson(group.editor.input, original);
			await workbench.quickaccess.runCommand('workbench.action.files.save');
			await snapshot('initial save');
			await replaceJson(group.editor.input, dirty);
			await expect(group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' }).locator('..')).toHaveAttribute('data-state', /dirty/u);
			await expect.poll(async () => (await readBrowserBackups(group.editor.input)).some(record => record.content === dirty)).toBe(true);
			await snapshot('dirty backup acknowledged');
			await workbench.quickaccess.runCommand('workbench.action.files.save');
			await expect(group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
			await snapshot('first clean save');
			const latest = '// unsaved recorder comment\n[\n  {\n    "key": "ctrl+alt+[KeyK] ctrl+alt+[KeyP]",\n    "command": "workbench.action.files.newUntitledFile",\n    "when": "true"\n  }\n]';
			await replaceJson(group.editor.input, latest);
			await workbench.quickaccess.runCommand('workbench.action.files.save');
			await expect(group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
			await expect.poll(() => readBrowserProfile(group.editor.input)).toBe(latest);
			await snapshot('second clean save');
			if (waitForRemoval) {
				await expect.poll(async () => (await readBrowserBackups(group.editor.input)).length).toBe(0);
				await snapshot('backup removed');
			}
			({ workbench } = await reloadWorkbench());
			await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
			group = workbench.editors.groupAt(0);
			await snapshot('after reload');
			expect(stages.at(-1)?.file).toBe(latest);
			await group.editor.waitForEditorContents(content => content === latest);
		} finally {
			await testInfo.attach('json-only-save-backup-traffic', { body: JSON.stringify({ stages, events: traffic.events }), contentType: 'application/json' });
			await traffic.dispose();
		}
	});
}

test('Keyboard Shortcuts shares one input across split panes and restores it after the final close', async ({ target, workbench, reloadWorkbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the real profile file and editor restoration');
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	const firstGroup = workbench.editors.groupAt(0);
	const source = '// keep shared input comment\n[{"key":"ctrl+alt+y","command":"workbench.action.openSettings"},{"key":"ctrl+alt+z","command":"workbench.action.openKeyboardShortcuts"},]\n';
	await replaceJson(firstGroup.editor.input, source);
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	await expect(firstGroup.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	await workbench.quickaccess.runCommand('workbench.action.openKeyboardShortcuts');
	await workbench.quickaccess.runCommand('workbench.action.openKeyboardShortcuts');
	await expect(firstGroup.tabs.filter({ hasText: 'Keyboard Shortcuts', hasNotText: '(JSON)' })).toHaveCount(1);
	const firstPane = firstGroup.content.locator('.ash-keybindings-editor');
	await firstPane.getByRole('searchbox').fill('workbench.action.openSettings');
	await workbench.quickaccess.runCommand('workbench.action.splitEditorHorizontal');
	await expect(workbench.editors.groups).toHaveCount(2);
	const secondPane = workbench.editors.groupAt(1).content.locator('.ash-keybindings-editor');
	await expect(secondPane.getByRole('searchbox')).toHaveValue('');
	await secondPane.getByRole('searchbox').fill('workbench.action.openKeyboardShortcuts');
	await expect(firstPane.getByRole('searchbox')).toHaveValue('workbench.action.openSettings');
	await expect(firstPane.locator('.ash-keybindings-row.is-user .ash-keybindings-command-id')).toHaveText('workbench.action.openSettings');
	await expect(secondPane.locator('.ash-keybindings-row.is-user .ash-keybindings-command-id')).toHaveText('workbench.action.openKeyboardShortcuts');

	await secondPane.locator('.ash-keybindings-row.is-user').getByRole('button', { name: 'Edit', exact: true }).click();
	const recording = secondPane.getByRole('textbox', { name: 'Record keybinding', exact: true });
	await recording.press('Control+Alt+P');
	await recording.press('Enter');
	await expect(secondPane.getByRole('status')).toHaveText('Keybinding saved.');
	await expect(firstPane.locator('.ash-keybindings-row.is-user .ash-keybindings-command-id')).toHaveText('workbench.action.openSettings');
	await firstGroup.tabs.filter({ hasText: 'Keyboard Shortcuts', hasNotText: '(JSON)' }).locator('..').getByRole('button', { name: 'Close Keyboard Shortcuts', exact: true }).click();
	let remainingPane = workbench.page.locator('.ash-keybindings-editor');
	await expect(remainingPane).toHaveCount(1);
	await expect(remainingPane.getByRole('searchbox')).toHaveValue('workbench.action.openKeyboardShortcuts');
	await remainingPane.getByRole('searchbox').focus();

	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	const json = workbench.editors.groups.filter({ has: remainingPane });
	await replaceJson(json.locator('.stanza-editor-input'), source.replace('ctrl+alt+y', 'ctrl+alt+x').replace('ctrl+alt+z', 'ctrl+alt+[KeyP]'));
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	await expect(json.getByRole('tab', { name: 'Keyboard Shortcuts (JSON)', exact: true }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	await workbench.quickaccess.runCommand('workbench.action.openKeyboardShortcuts');
	await remainingPane.getByRole('searchbox').fill('workbench.action.openSettings');
	await expect(remainingPane.locator('.ash-keybindings-row.is-user .ash-keybindings-key')).toContainText('X');
	await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
	await expect(remainingPane).toHaveCount(0);
	await workbench.quickaccess.runCommand('workbench.action.openKeyboardShortcuts');
	await expect(remainingPane).toHaveCount(1);
	await remainingPane.getByRole('searchbox').fill('workbench.action.openSettings');
	await expect(remainingPane.locator('.ash-keybindings-row.is-user .ash-keybindings-key')).toContainText('X');

	({ workbench } = await reloadWorkbench());
	remainingPane = workbench.page.locator('.ash-keybindings-editor');
	await expect(remainingPane).toHaveCount(1);
	await workbench.quickaccess.runCommand('workbench.action.openKeyboardShortcuts');
	await expect(remainingPane).toHaveCount(1);
	await remainingPane.getByRole('searchbox').fill('workbench.action.openSettings');
	await expect(remainingPane.locator('.ash-keybindings-row.is-user .ash-keybindings-key')).toContainText('X');
});

test('Keyboard Shortcuts recorder persists and executes an ordered four-chord binding after reload', async ({ target, application, workbench, reloadWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	let group = workbench.editors.groupAt(0);
	const source = '// keep recorder comment\n[{"key":"ctrl+alt+y","command":"runCommands","args":{"commands":["workbench.action.files.newUntitledFile",{"command":"workbench.action.openSettings","args":"general"}]},"when":"true"},{"key":"ctrl+alt+z","command":"workbench.action.openKeyboardShortcuts"},]\n';
	await replaceJson(group.editor.input, source);
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	await expect(group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	await workbench.quickaccess.runCommand('workbench.action.openKeyboardShortcuts');
	const root = workbench.page.locator('.ash-keybindings-editor');
	await root.getByRole('searchbox').fill('runCommands');
	await root.locator('.ash-keybindings-row.is-user').getByRole('button', { name: 'Edit', exact: true }).click();
	const input = root.getByRole('textbox', { name: 'Record keybinding', exact: true });
	for (const letter of ['K', 'P', 'C', 'D']) await input.press(`Control+Alt+${letter}`);
	const binding = 'ctrl+alt+[KeyK] ctrl+alt+[KeyP] ctrl+alt+[KeyC] ctrl+alt+[KeyD]';
	await expect(input).toHaveValue(binding);
	await input.press('Enter');
	await expect(root.getByRole('status')).toHaveText('Keybinding saved.');
	await expect(root.locator('.ash-keybindings-recorder')).toBeHidden();
	await expect(root.getByRole('searchbox')).toBeFocused();
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	await group.editor.waitForEditorContents(content => content.includes(binding));
	const persisted = (await group.editor.lines.allTextContents()).join('\n').replace(/\u00a0/g, ' ');
	expect(persisted).toContain('// keep recorder comment');
	expect(persisted).toContain('"commands":["workbench.action.files.newUntitledFile",{"command":"workbench.action.openSettings","args":"general"}]');
	expect(persisted).toMatch(/"args"\s*:\s*"general"/u);
	expect(persisted).toMatch(/"when"\s*:\s*"true"/u);
	expect(persisted).toContain('"key":"ctrl+alt+z","command":"workbench.action.openKeyboardShortcuts"');
	if (target.kind === 'electron' && 'windows' in application) {
		const profile = await application.evaluate(() => process.env.ASH_HOME);
		if (!profile) throw new Error('Test profile unavailable');
		await expect.poll(() => readFile(join(profile, 'keybindings.json'), 'utf8')).toBe(persisted);
	} else await expect.poll(() => readBrowserProfile(group.editor.input)).toBe(persisted);
	({ workbench } = await reloadWorkbench());
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	group = workbench.editors.groupAt(0);
	await group.editor.waitForEditorContents(content => content === persisted);
	for (const letter of ['K', 'P', 'C']) {
		await group.editor.input.press(`Control+Alt+${letter}`);
		await expect(workbench.settingsEditor.element).toBeHidden();
		await expect(group.element.getByRole('tab', { name: /^Untitled-/u })).toHaveCount(0);
	}
	await group.editor.input.press('Control+Alt+D');
	await expect(workbench.settingsEditor.element).toBeVisible();
	await expect(group.element.getByRole('tab', { name: /^Untitled-/u })).toHaveCount(1);
});

test('Keyboard Shortcuts recorder retains a failed draft and retries after saving the dirty JSON model', async ({ target, application, workbench, reloadWorkbench }, testInfo) => {
	const backupTraffic = target.kind === 'browser' && target.appServerMode === 'required' ? await recordBackupTraffic(workbench.page) : undefined;
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	let group = workbench.editors.groupAt(0);
	const source = '[{"key":"ctrl+alt+y","command":"workbench.action.files.newUntitledFile"}]';
	await replaceJson(group.editor.input, source);
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	const jsonTab = group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' });
	await expect(jsonTab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	await replaceJson(group.editor.input, '// unsaved recorder comment\n' + source);
	await expect(jsonTab.locator('..')).toHaveAttribute('data-state', /dirty/u);
	await workbench.quickaccess.runCommand('workbench.action.openKeyboardShortcuts');
	const root = workbench.page.locator('.ash-keybindings-editor');
	await root.getByRole('searchbox').fill('workbench.action.files.newUntitledFile');
	await root.locator('.ash-keybindings-row.is-user').getByRole('button', { name: 'Edit', exact: true }).click();
	const input = root.getByRole('textbox', { name: 'Record keybinding', exact: true });
	const binding = 'ctrl+alt+[KeyK] ctrl+alt+[KeyP]';
	await input.press('Control+Alt+K');
	await input.press('Control+Alt+P');
	await root.getByRole('textbox', { name: 'Keybinding when condition', exact: true }).fill('true');
	await root.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(root.getByRole('status')).toHaveText('Save keybindings.json before changing a shortcut in the Keyboard Shortcuts editor.');
	await expect(input).toHaveValue(binding);
	await expect(input).toBeEnabled();
	await expect(input).toBeFocused();
	await expect(root.getByRole('textbox', { name: 'Keybinding when condition', exact: true })).toHaveValue('true');
	await jsonTab.click();
	await group.editor.waitForEditorContents(content => content === '// unsaved recorder comment\n' + source);
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	await expect(jsonTab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	await group.tabs.filter({ hasText: 'Keyboard Shortcuts', hasNotText: '(JSON)' }).click();
	await expect(input).toHaveValue(binding);
	await root.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(root.getByRole('status')).toHaveText('Keybinding saved.');
	await expect(root.locator('.ash-keybindings-recorder')).toBeHidden();
	await jsonTab.click();
	await group.editor.waitForEditorContents(content => content.includes(binding) && content.startsWith('// unsaved recorder comment'));
	await expect(jsonTab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	const persisted = (await group.editor.lines.allTextContents()).join('\n').replace(/\u00a0/g, ' ');
	if (target.kind === 'electron' && 'windows' in application) {
		const profile = await application.evaluate(() => process.env.ASH_HOME);
		if (!profile) throw new Error('Test profile unavailable');
		await expect.poll(() => readFile(join(profile, 'keybindings.json'), 'utf8')).toBe(persisted);
	} else await expect.poll(() => readBrowserProfile(group.editor.input)).toBe(persisted);
	const backupBeforeReload = backupTraffic ? await readBrowserBackups(group.editor.input) : undefined;
	({ workbench, application } = await reloadWorkbench());
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	group = workbench.editors.groupAt(0);
	const reloadedProfile = target.kind === 'electron' && 'windows' in application
		? await readFile(join((await application.evaluate(() => process.env.ASH_HOME))!, 'keybindings.json'), 'utf8')
		: await readBrowserProfile(group.editor.input);
	await testInfo.attach('recorder-retry-profile-after-reload', { body: JSON.stringify({ persisted, reloadedProfile }), contentType: 'application/json' });
	if (backupTraffic) {
		await testInfo.attach('recorder-backup-traffic-after-reload', { body: JSON.stringify({ backupBeforeReload, rendered: (await group.editor.lines.allTextContents()).join('\n').replace(/\u00a0/g, ' '), state: await group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' }).locator('..').getAttribute('data-state'), backups: await readBrowserBackups(group.editor.input), events: backupTraffic.events }), contentType: 'application/json' });
		await backupTraffic.dispose();
	}
	expect(reloadedProfile).toBe(persisted);
	if (target.kind === 'electron') await group.editor.waitForEditorContents(content => content === persisted);
	await group.editor.input.press('Control+Alt+K');
	await expect(group.element.getByRole('tab', { name: /^Untitled-/u })).toHaveCount(0);
	await group.editor.input.press('Control+Alt+P');
	await expect(group.element.getByRole('tab', { name: /^Untitled-/u })).toHaveCount(1);
	await expect(group.element.getByRole('tab', { name: 'Untitled-1', exact: true })).toHaveAttribute('aria-selected', 'true');
	await testInfo.attach('recorder-two-chord-execution-after-reload', { body: JSON.stringify({ prefixTabs: 0, completeTabs: await group.element.getByRole('tab', { name: /^Untitled-/u }).count() }), contentType: 'application/json' });
	if (target.kind === 'browser') {
		await group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' }).click();
		await group.editor.waitForEditorContents(content => content === persisted);
	}
});

test('Keyboard Shortcuts recorder explains controls in Chinese and announces a fifth-chord restart', async ({ workbench, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ workbench } = await restartWorkbench());
	await workbench.quickaccess.runCommand('workbench.action.openKeyboardShortcuts');
	const root = workbench.page.locator('.ash-keybindings-editor');
	await root.getByRole('searchbox').fill('workbench.action.openGlobalKeybindingsFile');
	const add = root.locator('.ash-keybindings-row').getByRole('button', { name: 'Add', exact: true });
	await add.click();
	const input = root.getByRole('textbox', { name: 'Record keybinding', exact: true });
	const helpId = await input.getAttribute('aria-describedby');
	await expect(root.locator(`[id="${helpId}"]`)).toContainText('单独的 Enter、Escape、Tab 或 Shift+Tab 请在键盘快捷方式（JSON）中编辑');
	const layout = await root.locator('.ash-keybindings-recorder').evaluate(recorder => {
		const help = recorder.querySelector('.ash-keybindings-recorder-help')!.getBoundingClientRect();
		const fields = recorder.querySelector('.ash-keybindings-recorder-fields')!.getBoundingClientRect();
		const actions = recorder.querySelector('.ash-keybindings-recorder-actions')!.getBoundingClientRect();
		return { helpBottom: help.bottom, fieldsTop: fields.top, actionsTop: actions.top, fits: recorder.scrollWidth <= recorder.clientWidth };
	});
	expect(layout.helpBottom).toBeLessThanOrEqual(layout.fieldsTop);
	expect(layout.helpBottom).toBeLessThanOrEqual(layout.actionsTop);
	expect(layout.fits).toBe(true);
	await input.press('Tab');
	await expect(root.getByRole('textbox', { name: 'Keybinding when condition', exact: true })).toBeFocused();
	await workbench.page.keyboard.press('Shift+Tab');
	await expect(input).toBeFocused();
	await input.press('Control+K');
	await input.press('Shift+Enter');
	await input.press('Alt+Escape');
	await input.press('Control+Enter');
	await expect(input).toHaveValue('ctrl+[KeyK] shift+[Enter] alt+[Escape] ctrl+[Enter]');
	await input.press('Control+Y');
	await expect(input).toHaveValue('ctrl+[KeyY]');
	await expect(root.getByRole('status')).toHaveText('已录满 4 段，开始新序列：ctrl+[KeyY]。');
	await input.press('Escape');
	await expect(input).toHaveValue('');
	await expect(root.getByRole('status')).toHaveText('快捷键已清空。请录制新序列，或再次按 Escape 取消。');
	await input.press('Escape');
	await expect(root.locator('.ash-keybindings-recorder')).toBeHidden();
	await expect(add).toBeFocused();
	await add.click();
	await input.press('Control+K');
	await input.press('Control+P');
	await input.press('Enter');
	await expect(root.getByRole('status')).toHaveText('快捷键已保存。');
	await expect(root.locator('.ash-keybindings-recorder')).toBeHidden();
});

test('runCommands executes a saved shortcut in order and stops on a failed command', async ({ workbench, reloadWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	let group = workbench.editors.groupAt(0);
	await replaceJson(group.editor.input, JSON.stringify([
		{
			key: 'ctrl+alt+y', command: 'runCommands', when: String.raw`true && !false && resourceFilename =~ /keybindings[.]json$/`, args: {
				commands: [
					'workbench.action.files.newUntitledFile',
					{ command: 'workbench.action.files.newUntitledFile', args: [] },
				]
			}
		},
		{
			key: 'ctrl+alt+z', command: 'runCommands', args: {
				commands: [
					'workbench.action.files.newUntitledFile',
					'ash.test.missingCommand',
					'workbench.action.files.newUntitledFile',
				]
			}
		},
	]));
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	await expect(group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	({ workbench } = await reloadWorkbench());
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	group = workbench.editors.groupAt(0);
	await group.editor.input.press('Control+Alt+Y');
	await expect(group.element.getByRole('tab', { name: /^Untitled-/u })).toHaveCount(2);
	await expect(group.element.getByRole('tab', { name: 'Untitled-2', exact: true })).toHaveAttribute('aria-selected', 'true');
	await group.editor.input.press('Control+Alt+Z');
	await expect(workbench.page.locator('.ash-notification', { hasText: 'Unknown command: ash.test.missingCommand' })).toBeVisible();
	await expect(group.element.getByRole('tab', { name: /^Untitled-/u })).toHaveCount(3);
	await expect(group.element.getByRole('tab', { name: 'Untitled-3', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('runCommands loads in Sessions and executes the saved shortcut through its editor services', async ({ target, workbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	const group = workbench.editors.groupAt(0);
	await replaceJson(group.editor.input, JSON.stringify([
		{
			key: 'ctrl+alt+y', command: 'runCommands', args: {
				commands: [
					'sessions.open.code',
					'workbench.action.files.newUntitledFile',
					{ command: 'workbench.action.files.newUntitledFile', args: [] },
				]
			}
		},
	]));
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	await expect(group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	const page = await workbench.openAgentsWindow(target.kind);
	await page.keyboard.press('Control+Alt+Y');
	const editors = page.locator('[data-part="editor"]');
	await expect(editors.getByRole('tab', { name: /^Untitled-/u })).toHaveCount(2);
	await expect(editors.getByRole('tab', { name: 'Untitled-2', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(editors.getByRole('textbox', { name: 'Untitled-2', exact: true })).toBeVisible();
});

test('Keybindings JSON saves the profile file, applies shortcuts after reload and uses Chinese labels', async ({ target, application, workbench, reloadWorkbench, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	let group = workbench.editors.groupAt(0);
	let tab = group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' });
	await expect(tab).toHaveCount(1);
	await expect(tab.locator('..')).not.toHaveClass(/preview/u);
	await expect(group.editor.input).toBeFocused();
	const source = '// keep this comment\n[{"key":"ctrl+alt+y","command":"workbench.action.openKeyboardShortcuts","args":{"source":"json"}},]\n';
	await replaceJson(group.editor.input, source);
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	await expect(tab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	if (target.kind === 'electron' && 'windows' in application) {
		const profile = await application.evaluate(() => process.env.ASH_HOME);
		if (!profile) throw new Error('Test profile unavailable');
		await expect.poll(() => readFile(join(profile, 'keybindings.json'), 'utf8')).toBe(source);
	}
	({ workbench } = await reloadWorkbench());
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	group = workbench.editors.groupAt(0);
	await group.editor.waitForEditorContents(content => content === source);
	await group.editor.input.press('Control+Alt+Y');
	await expect(group.tabs.filter({ hasText: 'Keyboard Shortcuts', hasNotText: '(JSON)' })).toHaveCount(1);
	await expect(group.content.getByRole('searchbox')).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ workbench } = await restartWorkbench());
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	group = workbench.editors.groupAt(0);
	await expect(group.tabs.filter({ hasText: '键盘快捷方式（JSON）' })).toHaveCount(1);
	await group.editor.waitForEditorContents(content => content === source);
});

test('runCommands offers command names and nested batch arguments in Keybindings JSON', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires product JSON language declarations');
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	const group = workbench.editors.groupAt(0);
	const commandNames = '[{"key":"ctrl+alt+y","command":"runCommands","args":{"commands":["run"]}}]';
	const nestedArguments = '[{"key":"ctrl+alt+y","command":"runCommands","args":{"commands":[{"command":"runCommands","args":{}}]}}]';
	for (const [source, offset, suggestion] of [
		[commandNames, commandNames.indexOf('["run"]') + '["run'.length, 'runCommands'],
		[nestedArguments, nestedArguments.lastIndexOf('{}') + 1, 'commands'],
	] as const) {
		await replaceJson(group.editor.input, source);
		await group.editor.input.press('ControlOrMeta+End');
		for (let count = offset; count < source.length; count++) await group.editor.input.press('ArrowLeft');
		await group.editor.input.press('Control+Space');
		await expect(group.content.locator('.stanza-editor-completion-option').filter({ hasText: suggestion })).toBeVisible();
		await group.editor.input.press('Escape');
	}
});

test('Keybindings JSON completes paste command arguments and ordered provider preferences', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires product JSON language declarations');
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	const group = workbench.editors.groupAt(0);
	const options = group.content.locator('.stanza-editor-completion-option');
	for (const argument of ['kind', 'preferences']) {
		await replaceJson(group.editor.input, `[{"key":"ctrl+alt+y","command":"editor.action.pasteAs","args":{${argument === 'kind' ? '"kind":""' : '"preferences":[""]'}}}]`);
		await group.editor.input.press('ControlOrMeta+End');
		for (let count = 0; count < (argument === 'kind' ? 4 : 5); count++) await group.editor.input.press('ArrowLeft');
		await group.editor.input.press('Control+Space');
		await expect(options.filter({ hasText: 'uri.path.relative' })).toBeVisible();
		const relative = options.filter({ hasText: 'uri.path.relative' });
		const index = Number(await relative.getAttribute('data-completion-index'));
		for (let count = 0; count < index; count++) await group.editor.input.press('ArrowDown');
		await expect(relative).toHaveAttribute('aria-selected', 'true');
		await group.editor.input.press('Enter');
		await group.editor.waitForEditorContents(content => content.includes('uri.path.relative'));
		await workbench.quickaccess.runCommand('workbench.action.files.save');
		await expect(group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	}
});

test('Keybindings external changes reload clean models and preserve dirty text on save conflict', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron', 'Uses an external profile-file writer');
	if (!('windows' in application)) throw new Error('Requires Electron');
	const profile = await application.evaluate(() => process.env.ASH_HOME);
	if (!profile) throw new Error('Test profile unavailable');
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	const group = workbench.editors.groupAt(0);
	const source = '[{"key":"ctrl+alt+y","command":"workbench.action.openKeyboardShortcuts"}]';
	await writeFile(join(profile, 'keybindings.json'), source);
	await group.editor.waitForEditorContents(content => content === source);
	await replaceJson(group.editor.input, '// unsaved\n' + source);
	await writeFile(join(profile, 'keybindings.json'), '[]');
	await workbench.dialogs.expectMessage(application, 'File changed on disk', () => workbench.quickaccess.runCommand('workbench.action.files.save'));
	await expect(group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' }).locator('..')).toHaveAttribute('data-state', /conflict/u);
	await group.editor.waitForEditorContents(content => content === '// unsaved\n' + source);
	expect(await readFile(join(profile, 'keybindings.json'), 'utf8')).toBe('[]');
});
