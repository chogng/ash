import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test as base } from '../../../automation/test.js';

// This real stdio peer records both initialize and workspace/configuration. No renderer
// service is replaced: the workspace file watcher, connection and LSP supervisor own the flow.
const server = String.raw`
const fs = require('node:fs');
let pending = Buffer.alloc(0);
const record = value => fs.appendFileSync(process.env.LSP_RECORD, JSON.stringify(value) + '\n');
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
      send({ method: 'window/showMessage', params: { type: 2, message: 'Fixture build script warning' } });
    } else if (message.id === 'settings') {
      record({ configuration: message.result[0] });
    } else if (message.method === 'exit') {
      process.exit(0);
    } else if (message.id !== undefined) {
      send({ id: message.id, result: null });
    }
  }
});
`;

const test = base.extend({
	useDefaultLanguageServer: false,
	backendConfiguration: async ({ testWorkspace }, use) => {
		const executable = join(testWorkspace.directory, 'language-server.cjs');
		await writeFile(executable, server);
		await mkdir(join(testWorkspace.directory, '.vscode'));
		await writeFile(join(testWorkspace.directory, '.vscode/settings.json'), '// workspace JSONC\n{ "rust-analyzer.cargo.allTargets": false, "rust-analyzer.cargo.buildScripts.enable": false, "rust-analyzer.cargo.extraEnv": { "NATIVE_LIB": "/prepared/workspace/lib" }, }');
		await use(`[languageServers.servers.rust-analyzer]\nmode = "enabled"\nexecutable = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(executable)}]\nenvironment = { LSP_RECORD = ${JSON.stringify(join(testWorkspace.directory, 'lsp.jsonl'))} }\n`);
	},
	electronUserSettings: async ({ }, use) => { await use({ 'rust-analyzer.cargo.allTargets': true, 'rust-analyzer.check.workspace': false }); },
});

test('Rust workspace settings reach initialize and configuration, reload on edit, and warnings use notifications', { tag: ['@electron-app-server'] }, async ({ workbench, testWorkspace }) => {
	const page = workbench.page;
	const records = async (): Promise<Array<{ initialization?: unknown; configuration?: unknown; }>> => {
		const source = await readFile(join(testWorkspace.directory, 'lsp.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
		return source.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
	};
	await page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.rs' }).click();
	const expected = { cargo: { allTargets: false, buildScripts: { enable: false }, extraEnv: { NATIVE_LIB: '/prepared/workspace/lib' } }, check: { workspace: false } };
	await expect.poll(async () => (await records()).find(value => value.configuration)?.configuration).toEqual(expected);
	expect((await records()).find(value => value.initialization)?.initialization).toEqual(expected);
	const toast = page.getByRole('region', { name: 'Notifications', exact: true }).getByRole('article').filter({ hasText: 'Fixture build script warning' });
	await expect(toast).toBeVisible();
	await expect(toast).toContainText('rust-analyzer');
	await expect(page.locator('.ash-dialog-message')).toHaveCount(0);
	await toast.getByRole('button', { name: 'Show Output', exact: true }).focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('[data-view-id="ash.output"]')).toContainText('Fixture build script warning');
	await writeFile(join(testWorkspace.directory, '.vscode/settings.json'), '{}\n');
	await expect.poll(async () => (await records()).filter(value => value.configuration).at(-1)?.configuration).toEqual({ cargo: { allTargets: true }, check: { workspace: false } });
	expect((await records()).filter(value => value.initialization).at(-1)?.initialization).toEqual({ cargo: { allTargets: true }, check: { workspace: false } });
});
