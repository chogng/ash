import { createServer } from 'node:http';
import type { Page } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { Workbench } from '../../../automation/workbench.js';
import { connectProfile, enableFixtureModel } from './sessionProfileFixture.js';
import { URI } from '../../../../src/ash/base/common/uri.js';
import { Schemas } from '../../../../src/ash/base/common/network.js';
import { LOCAL_FILE_SYSTEM_CHANNEL_NAME } from '../../../../src/ash/platform/files/common/diskFileSystemProviderClient.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';

async function configureFixtureModel(client: Awaited<ReturnType<typeof connectProfile>>['client'], workbench: Workbench, model: { provider: string; model: string; }, port: number): Promise<void> {
	const config = await client.request(APP_SERVER_METHODS['config/read'], {});
	await client.request(APP_SERVER_METHODS['provider/configure'], {
		commandId: 'generated-files-provider', expectedRevision: config.revision,
		config: {
			connection: model.provider, provider: model.provider, baseUrl: `http://127.0.0.1:${port}/v1`,
			custom: { name: 'Isolated artifact model', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
			modelContext: { [model.model]: { contextWindow: 272_000 } }
		},
	});
	await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: model.provider, apiKey: 'isolated-artifact-fixture-key' });
	const configured = await client.request(APP_SERVER_METHODS['config/read'], {});
	await client.request(APP_SERVER_METHODS['config/update'], { commandId: 'generated-files-default', expectedRevision: configured.revision, model });
	await enableFixtureModel(workbench, model, 'en');
}

async function chooseFixtureModel(page: Page, chat: ReturnType<Page['locator']>, modelId: string): Promise<void> {
	await chat.locator('.ash-chat-input-model-action').press('ArrowDown');
	const picker = page.getByRole('dialog', { name: 'Choose a chat model', exact: true });
	await expect(picker).toBeVisible();
	const modelButton = picker.locator('.ash-chat-slider-model-button');
	if (await modelButton.count()) {
		if (await modelButton.getAttribute('aria-expanded') !== 'true') await modelButton.press('Enter');
		await picker.getByRole('menuitemradio', { name: modelId, exact: true }).press('Enter');
	} else {
		const automatic = picker.getByRole('switch', { name: 'Auto', exact: true });
		if (await automatic.count() && await automatic.isChecked()) await automatic.press('Space');
		const search = picker.getByRole('combobox');
		await search.fill(modelId);
		await expect(picker.getByRole('menuitemradio')).toHaveCount(1);
		await search.press('Enter');
	}
}

test('A Docs request publishes a Markdown file that can be edited and reopened after restart', { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ target, application, workbench, webAppServer, testWorkspace, reloadWorkbench }, testInfo) => {
	test.setTimeout(120_000);
	const title = 'Persistent generated document';
	const original = `# ${title}\n\nOriginal content`;
	const model = { provider: 'custom-generated-docs-fixture', model: 'generated-docs-model' };
	let modelRequest: string | undefined;
	const release = Promise.withResolvers<void>();
	const modelServer = createServer(async (request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ data: [{ id: model.model }] }));
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		modelRequest = Buffer.concat(chunks).toString('utf8');
		await release.promise;
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		const chunk = (delta: object, finish: string | null) => JSON.stringify({
			id: 'generated-docs', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }],
		});
		response.end(`data: ${chunk({ content: original }, null)}\n\ndata: ${chunk({}, 'stop')}\n\ndata: [DONE]\n\n`);
	});
	await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve));
	const address = modelServer.address();
	if (!address || typeof address === 'string') throw new Error('Generated Docs model fixture has no port');
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	let page = workbench.page;
	try {
		connection = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
		const { client } = connection;
		await configureFixtureModel(client, workbench, model, address.port);

		let agentsWorkbench = workbench;
		if (target.kind === 'browser') {
			page = await workbench.page.context().newPage();
			await page.goto(workbench.page.url(), { waitUntil: 'domcontentloaded' });
			agentsWorkbench = new Workbench(page);
			await agentsWorkbench.waitForReady();
		}
		page = await agentsWorkbench.openAgentsWindow(target.kind);
		const showArtifacts = async () => page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
		await showArtifacts();
		await page.locator('.ash-chat-creation').getByRole('button', { name: 'Docs', exact: true }).press('Enter');
		const chat = () => page.locator('[data-part="sessions"] :is(.chat-composer, .native-chat-composer):visible');
		const pill = () => chat().locator('.ash-chat-input-artifact-pill:visible');
		await expect(pill()).toHaveText('Ash Docs');
		const request = 'Write a short document about preserving edits.';
		await new Editor(chat()).waitForEditorFocus();
		await new Editor(chat()).waitForTypeInEditor(request);
		await chooseFixtureModel(page, chat(), model.model);
		await expect(pill()).toHaveText('Ash Docs');
		await new Editor(chat()).waitForEditorContents(text => text === request);
		await new Editor(chat()).waitForEditorFocus();
		await page.keyboard.press('Enter');
		await expect.poll(() => modelRequest).toContain('ash.creation.docs');

		const root = webAppServer?.profileDirectory ?? URI.parse(await page.evaluate(channel =>
			globalThis.ashTestMainProcess.call<string>(channel, 'userDataHome'), LOCAL_FILE_SYSTEM_CHANNEL_NAME)).fsPath;
		const directory = join(root, 'generated-files');

		// Check the disk before the catalogue's retry path can perform publication.
		// The completion must publish without an Agents renderer reading its thread.
		if ('windows' in application) {
			const window = await application.browserWindow(page);
			const closed = page.waitForEvent('close');
			await window.evaluate(window => window.close());
			await closed;
		} else {
			await page.close();
		}
		release.resolve();
		await expect.poll(async () => (await readdir(directory).catch(() => [])).filter(name => name.endsWith('.md'))).toHaveLength(1);
		const list = () => client.request(APP_SERVER_METHODS['generatedFile/list'], { clientId: 'generated-docs-smoke' });
		await expect.poll(async () => (await list()).files.map(file => file.title)).toEqual([title]);
		const file = (await list()).files[0]!;
		expect(file.source).toMatchObject({ providerId: 'local-agent-host', partId: 'markdown' });

		if (target.kind === 'browser') {
			page = await workbench.page.context().newPage();
			await page.goto(workbench.page.url(), { waitUntil: 'domcontentloaded' });
			agentsWorkbench = new Workbench(page);
			await agentsWorkbench.waitForReady();
		}
		page = await agentsWorkbench.openAgentsWindow(target.kind);
		const card = () => page.locator('[data-generated-file-resource]').filter({ hasText: title });
		const openFromSourceChat = async () => {
			await card().press('Enter');
			await expect(card()).toBeHidden();
			await expect(page.locator('.ash-docs-workspace:visible')).toHaveCount(0);
			const fileInChat = page.locator('.ash-chat-file-buttons').getByRole('button', { name: title, exact: true });
			await expect(fileInChat).toBeVisible();
			const artifacts = chat().getByRole('button', { name: 'Artifacts', exact: true });
			await artifacts.press('Enter');
			const picker = page.getByRole('dialog', { name: 'Artifacts', exact: true });
			const document = picker.getByRole('option', { name: title, exact: true });
			await expect(document).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(picker).toHaveCount(0);
			await expect(artifacts).toBeFocused();
			await artifacts.press('Space');
			await expect(document).toBeVisible();
			await page.keyboard.press('Enter');
		};
		await showArtifacts();
		await expect(card()).toHaveAttribute('data-generated-file-resource', file.resource);
		await openFromSourceChat();
		const document = () => new Editor(page.locator('.ash-docs-workspace[data-docs-format="markdown"]:visible'));
		await document().waitForEditorContents(text => text === original);
		await document().waitForEditorFocus();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.insertText('\n\nUser edit saved automatically');
		const edited = original + '\n\nUser edit saved automatically';
		await document().waitForEditorContents(text => text === edited);
		const resource = URI.parse(file.resource);
		expect(resource.scheme).toBe(target.kind === 'browser' ? Schemas.file : Schemas.vscodeUserData);
		const diskPath = join(directory, basename(resource.path));
		await expect.poll(() => readFile(diskPath, 'utf8')).toBe(edited);
		await new QuickAccess(page).runCommand('workbench.action.closeActiveEditor');
		await expect(page.getByRole('dialog', { name: 'Save Changes', exact: true })).toHaveCount(0);
		await showArtifacts();
		if ('windows' in application) {
			const window = await application.browserWindow(page);
			const closed = page.waitForEvent('close');
			await window.evaluate(window => window.close());
			await closed;
			await connection.close();
			connection = undefined;
			const restarted = await reloadWorkbench();
			page = await restarted.workbench.openAgentsWindow(target.kind);
		} else {
			page = await agentsWorkbench.reopenAgentsWindow(application, page);
		}
		await showArtifacts();
		await expect(card()).toHaveCount(1);
		await expect(card()).toHaveAttribute('data-generated-file-resource', file.resource);
		await openFromSourceChat();
		await document().waitForEditorContents(text => text === edited);
		await page.screenshot({ path: testInfo.outputPath('generated-markdown-reopened.png') });
	} catch (error) {
		if (!page.isClosed()) await testInfo.attach('generated-file-sessions', { body: await page.screenshot(), contentType: 'image/png' });
		throw error;
	} finally {
		release.resolve();
		try { await connection?.close(); }
		finally { await new Promise<void>(resolve => modelServer.close(() => resolve())); }
	}
});
