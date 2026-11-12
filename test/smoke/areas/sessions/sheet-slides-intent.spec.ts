import { createServer } from 'node:http';
import type { Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { Workbench } from '../../../automation/workbench.js';
import { connectProfile, enableFixtureModel } from './sessionProfileFixture.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';

async function configureFixtureModel(client: Awaited<ReturnType<typeof connectProfile>>['client'], workbench: Workbench, model: { provider: string; model: string; }, port: number): Promise<void> {
	const config = await client.request(APP_SERVER_METHODS['config/read'], {});
	await client.request(APP_SERVER_METHODS['provider/configure'], {
		commandId: 'sheet-slides-provider', expectedRevision: config.revision,
		config: {
			connection: model.provider, provider: model.provider, baseUrl: `http://127.0.0.1:${port}/v1`,
			custom: { name: 'Isolated artifact model', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
			modelContext: { [model.model]: { contextWindow: 272_000 } }
		},
	});
	await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: model.provider, apiKey: 'isolated-artifact-fixture-key' });
	const configured = await client.request(APP_SERVER_METHODS['config/read'], {});
	await client.request(APP_SERVER_METHODS['config/update'], { commandId: 'sheet-slides-default', expectedRevision: configured.revision, model });
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

test('Sheet and Slides reach the local provider with their selected directions', { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ target, application, workbench, webAppServer, testWorkspace }, testInfo) => {
	test.setTimeout(120_000);
	const model = { provider: 'custom-creation-intent-fixture', model: 'creation-intent-model' };
	const posts: string[] = [];
	const releaseSlides = Promise.withResolvers<void>();
	const modelServer = createServer(async (request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ data: [{ id: model.model }] }));
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = Buffer.concat(chunks).toString('utf8');
		posts.push(body);
		if (posts.length === 1) await releaseSlides.promise;
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		const chunk = (delta: object, finish: string | null) => JSON.stringify({
			id: 'creation-intent', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }],
		});
		response.end(`data: ${chunk({ content: 'Fixture response' }, null)}\n\ndata: ${chunk({}, 'stop')}\n\ndata: [DONE]\n\n`);
	});
	await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve));
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	let page = workbench.page;
	try {
		const address = modelServer.address();
		if (!address || typeof address === 'string') throw new Error('Creation intent fixture has no port');
		connection = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
		await configureFixtureModel(connection.client, workbench, model, address.port);
		let agentsWorkbench = workbench;
		if (target.kind === 'browser') {
			page = await workbench.page.context().newPage();
			await page.goto(workbench.page.url(), { waitUntil: 'domcontentloaded' });
			agentsWorkbench = new Workbench(page);
			await agentsWorkbench.waitForReady();
		}
		page = await agentsWorkbench.openAgentsWindow(target.kind);
		const chat = page.locator('[data-part="sessions"] :is(.chat-composer, .native-chat-composer):visible');
		const pill = chat.locator('.ash-chat-input-artifact-pill:visible');
		const editor = new Editor(chat);
		const select = async (kind: 'sheet' | 'slides') => {
			await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
			await page.locator(`.ash-artifacts-create.${kind}`).press('Enter');
			await expect(pill).toHaveAttribute('data-artifact-kind', kind);
		};
		const replacePrompt = async (prompt: string) => {
			await editor.waitForEditorFocus();
			await page.keyboard.press('ControlOrMeta+A');
			await editor.waitForTypeInEditor(prompt);
		};
		const send = async (prompt: string) => {
			await editor.waitForEditorFocus();
			await editor.waitForEditorContents(text => text === prompt);
			await page.keyboard.press('Enter');
		};

		await select('sheet');
		await select('slides');
		await replacePrompt('Create a plan for the launch');
		await chooseFixtureModel(page, chat, model.model);
		await send('Create a plan for the launch');
		await expect.poll(() => posts[0]).toContain('ash.creation.slides');
		expect(posts[0]).toContain('slide-by-slide content');
		expect(posts[0]).toContain('Create a plan for the launch');
		expect(posts[0]).not.toContain('ash.creation.sheet');

		// Open another composer while the first provider request is still streaming.
		await select('sheet');
		releaseSlides.resolve();
		await replacePrompt('Create a budget for the launch');
		await chooseFixtureModel(page, chat, model.model);
		await expect(pill).toHaveAttribute('data-artifact-kind', 'sheet');
		await send('Create a budget for the launch');
		await expect.poll(() => posts[1]).toContain('ash.creation.sheet');
		expect(posts[1]).toContain('Structure the rows and columns');
		expect(posts[1]).toContain('Create a budget for the launch');
		expect(posts[1]).not.toContain('ash.creation.slides');
		expect(posts[1]).not.toContain('Create a plan for the launch');

		await select('slides');
		await replacePrompt('Discuss the launch');
		await pill.getByRole('button', { name: 'Remove Ash Slides', exact: true }).press('Enter');
		await expect(pill).toHaveCount(0);
		await chooseFixtureModel(page, chat, model.model);
		await send('Discuss the launch');
		await expect.poll(() => posts[2]).toContain('Discuss the launch');
		expect(posts[2]).not.toMatch(/ash\.creation\./u);
	} catch (error) {
		if (!page.isClosed()) await testInfo.attach('creation-intent-sessions', { body: await page.screenshot(), contentType: 'image/png' });
		throw error;
	} finally {
		releaseSlides.resolve();
		try { await connection?.close(); }
		finally { await new Promise<void>(resolve => modelServer.close(() => resolve())); }
	}
});
