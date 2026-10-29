import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test as base } from '../../../automation/test.js';
import { readUserSettings } from '../../../automation/settings.js';

// This real stdio peer records both initialize and workspace/configuration. No renderer
// service is replaced: the workspace file watcher, connection and LSP supervisor own the flow.
const server = String.raw`
const fs = require('node:fs');
let pending = Buffer.alloc(0);
const record = value => fs.appendFileSync(process.env.LSP_RECORD, JSON.stringify(value) + '\n');
record({ started: process.pid });
const send = value => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...value }));
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n');
  process.stdout.write(body);
};
process.stdin.on('data', chunk => {
  pending = Buffer.concat([pending, chunk]);
  while (true) {
    const end = pending.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(pending.subarray(0, end).toString())[1]);
    if (pending.length < end + 4 + length) return;
    const message = JSON.parse(pending.subarray(end + 4, end + 4 + length));
    pending = pending.subarray(end + 4 + length);
    if (message.method === 'initialize') {
      record({ initialization: message.params.initializationOptions });
      send({ id: message.id, result: { capabilities: { textDocumentSync: 1, hoverProvider: true } } });
    } else if (message.method === 'initialized') {
      send({ id: 'settings', method: 'workspace/configuration', params: { items: [{ section: 'rust-analyzer' }] } });
    } else if (message.id === 'settings') {
      record({ configuration: message.result[0] });
      if (process.env.LSP_REPORT_MESSAGES === '1') {
        send({ method: 'window/showMessage', params: { type: 2, message: 'Fixture build script warning' } });
        send({ method: 'window/showMessage', params: { type: 1, message: 'Fixture startup failure' } });
      }
    } else if (message.method === 'textDocument/didClose') {
      record({ closed: message.params.textDocument.uri });
    } else if (message.method === 'textDocument/hover') {
      record({ hover: message.params.textDocument.uri });
      send({ id: message.id, result: { contents: { kind: 'plaintext', value: 'Fixture Rust hover' } } });
    } else if (message.method === 'shutdown') {
      record({ shutdown: process.pid });
      send({ id: message.id, result: null });
    } else if (message.method === 'exit') {
      process.exit(0);
    } else if (message.id !== undefined) {
      send({ id: message.id, result: null });
    }
  }
});
`;

const test = base.extend<{ reportLanguageServerMessages: boolean }>({
	reportLanguageServerMessages: [true, { option: true }],
	useDefaultLanguageServer: false,
	backendConfiguration: async ({ testWorkspace, reportLanguageServerMessages }, use) => {
		const executable = join(testWorkspace.directory, 'language-server.cjs');
		await writeFile(executable, server);
		await mkdir(join(testWorkspace.directory, '.vscode'));
		await writeFile(
			join(testWorkspace.directory, '.vscode/settings.json'),
			'// workspace JSONC\n{ "rust-analyzer.cargo.allTargets": false, "rust-analyzer.cargo.buildScripts.enable": false, "rust-analyzer.cargo.extraEnv": { "NATIVE_LIB": "/prepared/workspace/lib" }, }',
		);
		await use(
			`[languageServers.servers.rust-analyzer]\nmode = "enabled"\nexecutable = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(executable)}]\nenvironment = { LSP_RECORD = ${JSON.stringify(join(testWorkspace.directory, 'lsp.jsonl'))}, LSP_REPORT_MESSAGES = "${reportLanguageServerMessages ? '1' : '0'}" }\n`,
		);
	},
	electronUserSettings: async ({}, use) => {
		await use({ 'rust-analyzer.cargo.allTargets': true, 'rust-analyzer.check.workspace': false });
	},
});

test('Rust workspace settings reach initialize and configuration, reload on edit, and server messages remain accessible', { tag: ['@electron-app-server'] }, async ({ workbench, testWorkspace }) => {
	const page = workbench.page;
	const records = async (): Promise<Array<{ initialization?: unknown; configuration?: unknown }>> => {
		const source = await readFile(join(testWorkspace.directory, 'lsp.jsonl'), 'utf8').catch(error => {
			if (error.code === 'ENOENT') return '';
			throw error;
		});
		return source
			.trim()
			.split('\n')
			.filter(Boolean)
			.map(line => JSON.parse(line));
	};
	await page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.rs' }).click();
	const expected = {
		cachePriming: { enable: false },
		cargo: {
			allTargets: false,
			buildScripts: { enable: false },
			extraEnv: { NATIVE_LIB: '/prepared/workspace/lib' },
		},
		check: { workspace: false },
	};
	await expect.poll(async () => (await records()).find(value => value.configuration)?.configuration).toEqual(expected);
	expect((await records()).find(value => value.initialization)?.initialization).toEqual(expected);
	const notifications = page.getByRole('region', { name: 'Notifications', exact: true });
	const toast = notifications.getByRole('article').filter({ hasText: 'Fixture startup failure' });
	await expect(toast).toBeVisible();
	await expect(toast).toContainText('rust-analyzer');
	await expect(notifications.getByRole('article').filter({ hasText: 'Fixture build script warning' })).toHaveCount(0);
	await expect(page.locator('.ash-dialog-message')).toHaveCount(0);
	await toast.getByRole('button', { name: 'View Logs', exact: true }).focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('[data-view-id="ash.output"]')).toContainText('Fixture build script warning');
	await writeFile(join(testWorkspace.directory, '.vscode/settings.json'), '{ "rust-analyzer.cachePriming.enable": true }\n');
	const primed = { cachePriming: { enable: true }, cargo: { allTargets: true }, check: { workspace: false } };
	await expect.poll(async () => (await records()).filter(value => value.configuration).at(-1)?.configuration).toEqual(primed);
	expect((await records()).filter(value => value.initialization).at(-1)?.initialization).toEqual(primed);
	await writeFile(join(testWorkspace.directory, '.vscode/settings.json'), '{}\n');
	const unprimed = { cachePriming: { enable: false }, cargo: { allTargets: true }, check: { workspace: false } };
	await expect.poll(async () => (await records()).filter(value => value.configuration).at(-1)?.configuration).toEqual(unprimed);
	expect((await records()).filter(value => value.initialization).at(-1)?.initialization).toEqual(unprimed);
});

for (const locale of ['en', 'zh-CN']) {
	test.describe(`Rust settings ${locale}`, () => {
		test.use({
			reportLanguageServerMessages: false,
			electronUserSettings: {
				'workbench.locale': locale,
				'rust-analyzer.cargo.allTargets': true,
				'rust-analyzer.check.workspace': false,
			},
		});
		test('Rust settings stay lazy and apply cache capacity and thread modes on first use', { tag: ['@electron-app-server'] }, async ({ application, workbench, testWorkspace }, testInfo) => {
			const page = workbench.page;
			const chinese = locale === 'zh-CN';
			const saved = async () => JSON.parse((await readUserSettings(page)).content);
			const records = async (): Promise<Array<{ started?: number; initialization?: unknown; configuration?: unknown }>> => {
				const source = await readFile(join(testWorkspace.directory, 'lsp.jsonl'), 'utf8').catch(error => {
					if (error.code === 'ENOENT') return '';
					throw error;
				});
				return source
					.trim()
					.split('\n')
					.filter(Boolean)
					.map(line => JSON.parse(line));
			};
			await workbench.settingsEditor.openUserSettingsUI();
			const settings = workbench.settingsEditor.element;
			await workbench.settingsEditor.selectGroup('editor');
			await workbench.settingsEditor.selectCategory('editor-language');
			const release = settings.locator('[data-configuration-key="languageServers.autoSuspend"]');
			await expect(release).toHaveAttribute('aria-label', chinese ? '自动释放闲置语言服务器' : 'Release idle language servers');
			await expect(release).toHaveAttribute('aria-checked', 'false');
			await expect(settings).toContainText(chinese ? '磁盘上的 Cargo 编译产物不能恢复这份缓存' : 'Cargo build artifacts on disk do not restore this cache');
			await testInfo.attach('language-cache-defaults', {
				body: await page.screenshot(),
				contentType: 'image/png',
			});
			await release.focus();
			await release.press('Space');
			await expect.poll(async () => (await saved())['languageServers.autoSuspend']).toBe(true);
			const waiting = settings.locator('[data-configuration-key="languageServers.idleTimeoutMinutes"]');
			await expect(waiting).toHaveValue('10');
			await waiting.fill('15');
			await waiting.press('Tab');
			await expect.poll(async () => (await saved())['languageServers.idleTimeoutMinutes']).toBe(15);
			await testInfo.attach('language-idle-settings', {
				body: await page.screenshot(),
				contentType: 'image/png',
			});
			await workbench.settingsEditor.selectGroup('extensions');
			await expect(settings.locator('[data-settings-category-id="extension.ash.rust"]')).toHaveText('Rust');
			await workbench.settingsEditor.selectCategory('extension.ash.rust');
			await expect(settings.locator('.ash-settings-page h3')).toHaveText('Rust');
			const search = settings.getByRole('searchbox');
			await search.fill('@id:rust-analyzer.cachePriming.enable');
			const priming = settings.locator('[data-configuration-key="rust-analyzer.cachePriming.enable"]');
			await expect(priming).toHaveAttribute('role', 'switch');
			await expect(priming).toHaveAttribute('aria-label', chinese ? '缓存：启动时预热' : 'Cache Priming: Enable');
			await expect(priming).toHaveAttribute('aria-checked', 'false');
			await priming.focus();
			await priming.press('Space');
			await expect.poll(async () => (await saved())['rust-analyzer.cachePriming.enable']).toBe(true);
			await workbench.menus.select(application, () => settings.locator('[data-settings-item-id="rust-analyzer.cachePriming.enable"] .ash-setting-item-actions-trigger').click(), [
				chinese ? '重置设置' : 'Reset Setting',
			]);
			await expect(priming).toHaveAttribute('aria-checked', 'false');
			await expect.poll(async () => (await saved())['rust-analyzer.cachePriming.enable']).toBeUndefined();
			await search.fill('@id:rust-analyzer.check.command');
			const command = settings.locator('[data-configuration-key="rust-analyzer.check.command"]');
			await expect(command).toHaveValue('check');
			await command.fill('clippy');
			await command.press('Tab');
			await expect.poll(async () => (await saved())['rust-analyzer.check.command']).toBe('clippy');
			await search.fill('@id:rust-analyzer.imports.granularity.group');
			await settings.locator('[data-configuration-key="rust-analyzer.imports.granularity.group"]').getByRole('combobox').click();
			await page.getByRole('option', { name: 'module', exact: true }).click();
			await expect.poll(async () => (await saved())['rust-analyzer.imports.granularity.group']).toBe('module');
			await search.fill('@id:rust-analyzer.lru.capacity');
			await expect(settings).toContainText(chinese ? '单位是条目，不是 MB' : 'counts entries, not megabytes');
			const cache = settings.locator('[data-configuration-key="rust-analyzer.lru.capacity"]');
			await expect(cache).toHaveAttribute('type', 'number');
			await expect(cache).toHaveAttribute('placeholder', chinese ? '自动' : 'Automatic');
			for (const value of [32, 0]) {
				await cache.fill(String(value));
				await cache.press('Tab');
				await expect.poll(async () => (await saved())['rust-analyzer.lru.capacity']).toBe(value);
			}
			await cache.fill('-1');
			await cache.press('Tab');
			await expect(cache).toHaveValue('0');
			await cache.fill('');
			await cache.press('Tab');
			await expect.poll(async () => (await saved())['rust-analyzer.lru.capacity']).toBeUndefined();
			await expect(cache).toHaveAttribute('placeholder', chinese ? '自动' : 'Automatic');
			await cache.fill('32');
			await cache.press('Tab');
			await expect.poll(async () => (await saved())['rust-analyzer.lru.capacity']).toBe(32);
			const cacheActions = settings.locator('[data-settings-item-id="rust-analyzer.lru.capacity"] .ash-setting-item-actions-trigger');
			await cacheActions.focus();
			await workbench.menus.select(application, () => cacheActions.press('Enter'), [chinese ? '重置设置' : 'Reset Setting']);
			await expect.poll(async () => (await saved())['rust-analyzer.lru.capacity']).toBeUndefined();
			await cache.fill('32');
			await cache.press('Tab');
			await expect.poll(async () => (await saved())['rust-analyzer.lru.capacity']).toBe(32);
			await search.fill('@id:rust-analyzer.numThreads');
			const threads = settings.locator('[data-configuration-key="rust-analyzer.numThreads"]');
			await expect(threads).toHaveAttribute('type', 'number');
			await threads.fill('4');
			await threads.press('Tab');
			await expect.poll(async () => (await saved())['rust-analyzer.numThreads']).toBe(4);
			const mode = settings.locator('[data-settings-item-id="rust-analyzer.numThreads"]').getByRole('combobox');
			await mode.click();
			await page
				.getByRole('option', {
					name: chinese ? '使用逻辑核心数。' : 'Use the number of logical cores',
					exact: true,
				})
				.click();
			await expect.poll(async () => (await saved())['rust-analyzer.numThreads']).toBe('logical');
			await expect(threads).toHaveValue('');
			await mode.click();
			await page.getByRole('option', { name: chinese ? '自定义数值' : 'Custom number', exact: true }).click();
			await expect(threads).toBeFocused();
			await threads.fill('4');
			await threads.press('Tab');
			await expect.poll(async () => (await saved())['rust-analyzer.numThreads']).toBe(4);
			await search.fill('rust-analyzer @modified');
			await expect(cache).toBeVisible();
			await expect(threads).toBeVisible();
			await testInfo.attach('rust-memory-settings', {
				body: await page.screenshot(),
				contentType: 'image/png',
			});
			expect(await records(), 'Opening and editing Rust settings must not start a server').toEqual([]);
			await settings.locator('.ash-modal-editor-close').click();
			await expect(settings).toBeHidden();
			await page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.rs' }).click();
			await workbench.editors.groupAt(0).editor.waitForEditorFocus();
			const expected = {
				cachePriming: { enable: false },
				lru: { capacity: 32 },
				numThreads: 4,
				check: { command: 'clippy' },
				imports: { granularity: { group: 'module' } },
			};
			await expect.poll(async () => (await records()).find(value => value.configuration)?.configuration).toMatchObject(expected);
			expect((await records()).find(value => value.initialization)?.initialization).toMatchObject(expected);
			expect((await records()).filter(value => value.started)).toHaveLength(1);
			await testInfo.attach('lazy-rust-settings-events', {
				body: JSON.stringify(await records(), null, 2),
				contentType: 'application/json',
			});
		});
	});
}

test.describe('Language server warm retention', () => {
	test.use({ reportLanguageServerMessages: false });
	test('default policy reuses the same process after closing and reopening Rust', { tag: ['@electron-app-server'] }, async ({ workbench, testWorkspace }, testInfo) => {
		const page = workbench.page;
		const records = async (): Promise<Array<{ started?: number; shutdown?: number; closed?: string; hover?: string }>> => {
			const source = await readFile(join(testWorkspace.directory, 'lsp.jsonl'), 'utf8').catch(error => {
				if (error.code === 'ENOENT') return '';
				throw error;
			});
			return source
				.trim()
				.split('\n')
				.filter(Boolean)
				.map(line => JSON.parse(line));
		};
		const rust = page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.rs' });
		await rust.click();
		await expect.poll(async () => (await records()).filter(value => value.started).length).toBe(1);
		const pid = (await records()).find(value => value.started)!.started!;
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorFocus();
		await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
		await expect.poll(async () => (await records()).filter(value => value.closed).length).toBe(1);
		expect((await records()).filter(value => value.shutdown)).toHaveLength(0);
		expect(() => process.kill(pid, 0)).not.toThrow();
		await rust.click();
		await editor.waitForEditorFocus();
		await editor.input.press('ControlOrMeta+Home');
		await editor.input.press('ControlOrMeta+k');
		await editor.input.press('ControlOrMeta+i');
		await expect(page.getByText('Fixture Rust hover', { exact: true })).toBeVisible();
		expect((await records()).filter(value => value.started).map(value => value.started)).toEqual([pid]);
		await testInfo.attach('warm-retention-events', {
			body: JSON.stringify(await records(), null, 2),
			contentType: 'application/json',
		});
	});
});

test.describe('Language server idle release', () => {
	test.use({
		reportLanguageServerMessages: false,
		electronUserSettings: { 'languageServers.autoSuspend': true, 'languageServers.idleTimeoutMinutes': 1 },
	});
	test('last-file grace releases the process and reopening restores language features', { tag: ['@electron-app-server'] }, async ({ application, workbench, testWorkspace }, testInfo) => {
		test.setTimeout(120_000);
		const page = workbench.page;
		const records = async (): Promise<Array<{ started?: number; shutdown?: number; closed?: string; hover?: string; configuration?: unknown }>> => {
			const source = await readFile(join(testWorkspace.directory, 'lsp.jsonl'), 'utf8').catch(error => {
				if (error.code === 'ENOENT') return '';
				throw error;
			});
			return source
				.trim()
				.split('\n')
				.filter(Boolean)
				.map(line => JSON.parse(line));
		};
		const rust = page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.rs' });
		await rust.click();
		await expect.poll(async () => (await records()).filter(value => value.started).length).toBe(1);
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorFocus();
		expect(
			(await records()).filter(value => value.shutdown),
			JSON.stringify(await records()),
		).toHaveLength(0);
		const closedAt = Date.now();
		await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
		await expect.poll(async () => (await records()).filter(value => value.closed).length).toBe(1);
		expect(
			(await records()).filter(value => value.shutdown),
			JSON.stringify(await records()),
		).toHaveLength(0);
		// Advancing the whole renderer clock also expires unrelated in-flight RPCs.
		// Unit tests own exact timer boundaries; Desktop verifies real release and reuse.
		await expect.poll(async () => (await records()).filter(value => value.shutdown).length, { timeout: 75_000 }).toBe(1);
		expect(Date.now() - closedAt).toBeGreaterThanOrEqual(60_000);
		const pid = (await records()).find(value => value.started)!.started!;
		await expect
			.poll(() => {
				try {
					process.kill(pid, 0);
					return true;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
					throw error;
				}
			})
			.toBe(false);
		await rust.click();
		await expect.poll(async () => (await records()).filter(value => value.started).length).toBe(2);
		await expect.poll(async () => (await records()).filter(value => value.configuration).length).toBe(2);
		await editor.waitForEditorFocus();
		await editor.input.press('ControlOrMeta+Home');
		await editor.input.press('ControlOrMeta+k');
		await editor.input.press('ControlOrMeta+i');
		await expect(page.getByText('Fixture Rust hover', { exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		expect((await records()).filter(value => value.shutdown)).toHaveLength(1);
		await workbench.menus.select(application, () => page.locator('[data-statusbar-item-id="ash.status.languageServers"]').click(), ['rust-analyzer', 'Stop Server']);
		await expect.poll(async () => (await records()).filter(value => value.shutdown).length).toBe(2);
		await expect.poll(() => editor.element.locator('[style*="--ash-editor-token-foreground"]').count()).toBeGreaterThan(0);
		await editor.foldAtLine(1);
		await editor.unfoldAtLine(1);
		await editor.waitForEditorFocus();
		await editor.input.press('ControlOrMeta+Home');
		await page.keyboard.insertText('// syntax stays available\n');
		await editor.waitForEditorContents(text => text.includes('syntax stays available'));
		await expect.poll(() => editor.element.locator('[style*="--ash-editor-token-foreground"]').count()).toBeGreaterThan(0);
		expect((await records()).filter(value => value.started)).toHaveLength(2);
		await testInfo.attach('rust-syntax-with-lsp-stopped', {
			body: await page.screenshot(),
			contentType: 'image/png',
		});
	});
});
