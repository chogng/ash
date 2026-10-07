import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '../../../automation/test.js';
import { launchElectron, type ElectronLaunchResult } from '../../../automation/playwrightElectron.js';
import { Workbench } from '../../../automation/workbench.js';
import type { ISandboxGlobals } from '../../../../src/ash/base/parts/sandbox/electron-browser/sandboxTypes.js';
import type { Page } from '@playwright/test';
import { URI } from '../../../../src/ash/base/common/uri.js';

test.beforeEach(({ target }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Shared backup recovery requires the Electron App Server product.');
});

function records(directory: string): readonly { resource: string; content: string; }[] {
	const database = new DatabaseSync(join(directory, 'profile', 'state.sqlite3'), { readOnly: true });
	try { return database.prepare('SELECT resource, content FROM backup_contents WHERE client_id = ?').all('ash-editor') as { resource: string; content: string; }[]; }
	finally { database.close(); }
}

async function profile(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'ash-backup-'));
	await mkdir(join(directory, 'profile'), { recursive: true });
	await writeFile(join(directory, 'profile', 'settings.json'), JSON.stringify({ 'window.restoreWindows': 'none', 'workbench.startupEditor': 'none' }));
	return directory;
}

async function recoveredWindow(desktop: ElectronLaunchResult, text: string): Promise<Workbench> {
	await expect.poll(async () => {
		for (const page of desktop.application.windows()) {
			if (await page.locator('[data-part="editor"] .stanza-editor').filter({ hasText: text }).count()) return true;
		}
		return false;
	}, { timeout: 30_000, message: 'backend catalog reopens the window with unsaved content' }).toBe(true);
	const pages = desktop.application.windows();
	for (const page of pages) {
		if (await page.locator('[data-part="editor"] .stanza-editor').filter({ hasText: text }).count()) {
			const workbench = new Workbench(page);
			await workbench.waitForReady();
			return workbench;
		}
	}
	throw new Error('Recovered editor window disappeared');
}

test('Desktop restores an unsaved file from shared storage despite window restore none and clears it after saving', async ({ testWorkspace }) => {
	test.setTimeout(120_000);
	const directory = await profile();
	let desktop: ElectronLaunchResult | undefined;
	try {
		desktop = await launchElectron({ appServerMode: 'required', userDataDirectory: directory, workspaceDirectory: testWorkspace.directory, workspacePermissions: 'development' });
		const page = desktop.driver.workbench.page;
		const row = page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' });
		await expect(row).toHaveCount(1);
		await row.click();
		const input = page.locator('[data-part="editor"] .stanza-editor-input');
		await input.focus();
		await input.press('ControlOrMeta+A');
		await input.type('const sharedRecovery = 42;');
		await expect.poll(() => records(directory).some(record => JSON.parse(record.content).content === 'const sharedRecovery = 42;')).toBe(true);
		expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 1;\n');
		// The launcher destroys windows without a save/revert handshake, then stops the backend.
		await test.step('Stop the first application and its backend', () => desktop!.close());
		desktop = undefined;
		desktop = await test.step('Start a replacement application with the same profile', () => launchElectron({ appServerMode: 'required', userDataDirectory: directory }));
		const recovered = await recoveredWindow(desktop, 'const sharedRecovery = 42;');
		await expect(recovered.page.locator('.ash-tab').filter({ hasText: 'main.ts' })).toHaveAttribute('data-state', 'dirty');
		await recovered.page.locator('[data-part="editor"] .stanza-editor-input').press('ControlOrMeta+S');
		await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toBe('const sharedRecovery = 42;');
		await expect.poll(() => records(directory)).toEqual([]);
		expect(desktop.application.windows()).toHaveLength(2);
	} finally { try { await desktop?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
});

test('Desktop reopens an empty workspace with its untitled draft exactly once after backend restart', async () => {
	test.setTimeout(120_000);
	const directory = await profile();
	let desktop: ElectronLaunchResult | undefined;
	try {
		desktop = await launchElectron({ appServerMode: 'required', userDataDirectory: directory });
		const page = desktop.driver.workbench.page;
		await page.keyboard.press('ControlOrMeta+N');
		await page.locator('[data-part="editor"] .stanza-editor-input').focus();
		await page.keyboard.type('unsaved empty workspace draft');
		await expect.poll(() => records(directory).some(record => JSON.parse(record.content).content === 'unsaved empty workspace draft')).toBe(true);
		await desktop.close();
		desktop = undefined;
		desktop = await launchElectron({ appServerMode: 'required', userDataDirectory: directory });
		const recovered = await recoveredWindow(desktop, 'unsaved empty workspace draft');
		await expect(recovered.page.locator('.ash-tab').filter({ hasText: 'Untitled-1' })).toHaveAttribute('data-state', 'dirty');
		expect(desktop.application.windows()).toHaveLength(2);
		await recovered.page.reload({ waitUntil: 'domcontentloaded' });
		await recoveredWindow(desktop, 'unsaved empty workspace draft');
		expect(desktop.application.windows()).toHaveLength(2);
		expect(records(directory)).toHaveLength(1);
	} finally { try { await desktop?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
});

test('Desktop migrates an IndexedDB draft only after shared storage acknowledges its content', async () => {
	test.setTimeout(90_000);
	const directory = await profile();
	let desktop: ElectronLaunchResult | undefined;
	try {
		desktop = await launchElectron({ appServerMode: 'required', userDataDirectory: directory });
		const page = desktop.driver.workbench.page;
		await seedLegacy(page, 'untitled:/Untitled-1', 'legacy draft 内容');
		await page.reload({ waitUntil: 'domcontentloaded' });
		await recoveredWindow(desktop, 'legacy draft 内容');
		expect(records(directory).map(record => JSON.parse(record.content).content)).toEqual(['legacy draft 内容']);
		expect(await legacyCount(page)).toBe(0);
	} finally { try { await desktop?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
});

test('Desktop retains conflicting legacy content until an explicit save prevents its resurrection', async ({ testWorkspace }) => {
	test.setTimeout(90_000);
	const directory = await profile();
	let desktop: ElectronLaunchResult | undefined;
	try {
		desktop = await launchElectron({ appServerMode: 'required', userDataDirectory: directory, workspaceDirectory: testWorkspace.directory, workspacePermissions: 'development' });
		const page = desktop.driver.workbench.page;
		await page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' }).click();
		const input = page.locator('[data-part="editor"] .stanza-editor-input');
		await input.focus();
		await input.press('ControlOrMeta+A');
		await input.type('latest durable content');
		await expect.poll(() => records(directory).some(record => JSON.parse(record.content).content === 'latest durable content')).toBe(true);
		await seedLegacy(page, URI.file(testWorkspace.file).toString(), 'older legacy content');
		await page.reload({ waitUntil: 'domcontentloaded' });
		await recoveredWindow(desktop, 'latest durable content');
		expect(await legacyCount(page)).toBe(1);
		await page.locator('[data-part="editor"] .stanza-editor-input').press('ControlOrMeta+S');
		await expect.poll(() => records(directory)).toEqual([]);
		await expect.poll(() => legacyCount(page)).toBe(0);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await new Workbench(page).waitForReady();
		expect(await readFile(testWorkspace.file, 'utf8')).toBe('latest durable content');
		expect(records(directory)).toEqual([]);
	} finally { try { await desktop?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
});

async function seedLegacy(page: Page, resource: string, content: string): Promise<void> {
	await page.evaluate(async ({ resource, content }) => {
		const bridge = (globalThis as unknown as { ash: ISandboxGlobals; }).ash;
		const workspace = await bridge.ipcRenderer.invoke('ash:workspace:context:read') as { id: string; };
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const opening = indexedDB.open('ash-working-copy-backups', 1);
			opening.onsuccess = () => resolve(opening.result);
			opening.onerror = () => reject(opening.error);
		});
		try {
			await new Promise<void>((resolve, reject) => {
				const transaction = database.transaction('backups', 'readwrite');
				transaction.objectStore('backups').put({ key: `${workspace.id}\0${resource}`, workspaceId: workspace.id, resource, kind: 'text', content, updatedAt: 1, languageId: 'plaintext' });
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error);
			});
		} finally { database.close(); }
	}, { resource, content });
}

async function legacyCount(page: Page): Promise<number> {
	return page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('ash-working-copy-backups', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
		try { return await new Promise<number>((resolve, reject) => { const request = database.transaction('backups', 'readonly').objectStore('backups').count(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
		finally { database.close(); }
	});
}
