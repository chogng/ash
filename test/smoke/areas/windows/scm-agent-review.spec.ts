import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';
import { APP_SERVER_METHODS as methods } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

const run = promisify(execFile);
test.use({ gitRepository: true });

test('SCM split review starts reviewer Turns for each scope and keeps the current-change default', { tag: ['@electron-app-server'] }, async ({ application, webAppServer, testWorkspace, workbench }, testInfo) => {
	test.setTimeout(180_000);
	const provider = 'custom-scm-review-fixture';
	const model = { provider, model: 'scm-review-fixture' };
	const reviewModel = { provider, model: 'scm-review-specialist' };
	const server = createServer(async (request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ data: [{ id: model.model }, { id: reviewModel.model }] }));
			return;
		}
		for await (const _chunk of request) { /* Consume only synthetic review input. */ }
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		const content = JSON.stringify({ findings: [], overall_correctness: 'patch is correct', overall_explanation: 'Synthetic SCM review completed.', overall_confidence_score: 1 });
		response.end(`data: ${JSON.stringify({ id: 'scm-review-response', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'scm-review-response', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		connection = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
		const { client } = connection;
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing synthetic model port');
		const config = await client.request(methods['config/read'], {});
		await client.request(methods['provider/configure'], {
			commandId: 'scm-review-provider', expectedRevision: config.revision,
			config: { connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`, custom: { name: 'SCM review fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 }, modelContext: { [model.model]: { contextWindow: 272_000 }, [reviewModel.model]: { contextWindow: 272_000 } } },
		});
		await client.request(methods['provider/apiKey/set'], { connection: provider, apiKey: 'synthetic-fixture-key' });
		const configured = await client.request(methods['config/read'], {});
		await client.request(methods['config/update'], { commandId: 'scm-review-default', expectedRevision: configured.revision, model });
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('agents');
		await workbench.settingsEditor.selectCategory('models');
		const enabled = workbench.page.getByRole('switch', { name: `Enable ${reviewModel.model}`, exact: true });
		if (!await enabled.isChecked()) { await enabled.press('Space'); }
		await workbench.settingsEditor.selectCategory('agents');
		const reviewSelector = workbench.page.locator('[data-settings-item-id="chat.codeReview"]').getByRole('combobox');
		await expect(reviewSelector).toBeEnabled();
		await reviewSelector.click();
		await workbench.page.getByRole('option', { name: reviewModel.model, exact: true }).click();
		await expect.poll(async () => (await client.request(methods['config/read'], {})).codeReviewModel).toEqual(reviewModel);
		expect((await client.request(methods['config/read'], {})).model).toEqual(model);
		await expect(reviewSelector).toBeEnabled();
		await expect(workbench.page.getByText('Loading Advisor settings…', { exact: true })).toBeHidden();
		await expect(workbench.page.getByRole('heading', { name: 'Review model', exact: true })).toHaveCount(1);
		await workbench.page.screenshot({ path: testInfo.outputPath('code-review-model-settings.png') });
		const commitSelector = workbench.page.locator('[data-settings-item-id="chat.commitMessage"]').getByRole('combobox');
		await expect(commitSelector).toHaveText('Inherit conversation model');
		await commitSelector.press('Enter');
		await workbench.page.getByRole('option', { name: reviewModel.model, exact: true }).click();
		await expect.poll(async () => (await client.request(methods['config/read'], {})).commitMessageModel).toEqual(reviewModel);
		const commitToggle = workbench.page.getByRole('switch', { name: 'Automatically generate commit messages', exact: true });
		await expect(commitToggle).not.toBeChecked();
		await commitToggle.press('Space');
		await expect.poll(async () => (await client.request(methods['config/read'], {})).commitMessageEnabled).toBe(true);
		await expect(commitToggle).toBeEnabled();
		await commitToggle.press('Space');
		await expect.poll(async () => (await client.request(methods['config/read'], {})).commitMessageEnabled).toBe(false);
		await expect(commitSelector).toHaveText(reviewModel.model);

		expect((await client.request(methods['config/read'], {})).codeReviewModel).toEqual(reviewModel);
		await expect(commitSelector).toBeEnabled();
		await commitSelector.press('Enter');
		await workbench.page.getByRole('option', { name: 'Inherit conversation model', exact: true }).click();
		await expect.poll(async () => (await client.request(methods['config/read'], {})).commitMessageModel ?? null).toBeNull();
		expect((await client.request(methods['config/read'], {})).model).toEqual(model);
		await workbench.page.locator('.ash-modal-editor-close').click();
		await run('git', ['branch', 'review-base'], { cwd: testWorkspace.directory });
		await writeFile(testWorkspace.file, 'const staged = 1;\n');
		await run('git', ['add', '.'], { cwd: testWorkspace.directory });
		await writeFile(testWorkspace.file, 'const staged = 2;\n');

		const page = workbench.page;
		await workbench.git.open();
		const review = page.locator('[data-view-id="ash.gitAgentReview"]');
		const primary = review.getByRole('button', { name: 'Find Issues', exact: true });
		if (!await primary.isVisible()) await review.locator('.ash-pane-view-header').click();
		await expect(primary).toBeEnabled();
		await expect(review.locator('.ash-scm-empty')).toBeHidden();
		const dropdown = review.getByRole('button', { name: 'Choose Review Scope', exact: true });
		const commit = page.locator('.ash-scm-commit');
		const commitDropdown = page.locator('.ash-scm-commit-dropdown');
		const colors = await primary.evaluate(element => {
			const style = getComputedStyle(element);
			return { background: style.backgroundColor, foreground: style.color };
		});
		for (const button of [commit, commitDropdown, dropdown]) {
			expect(await button.evaluate(element => {
				const style = getComputedStyle(element);
				return { background: style.backgroundColor, foreground: style.color };
			})).toEqual(colors);
		}
		await primary.hover();
		const hoverBackground = await primary.evaluate(element => getComputedStyle(element).backgroundColor);
		for (const button of [commit, commitDropdown, dropdown]) {
			await button.hover();
			expect(await button.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(hoverBackground);
		}
		expect((await primary.boundingBox())!.height).toBe((await commit.boundingBox())!.height);
		expect((await dropdown.boundingBox())!.height).toBe(24);
		await page.screenshot({ path: testInfo.outputPath('scm-review-split-button.png') });

		const before = new Set((await client.request(methods['session/list'], {})).sessions.map(session => session.sessionId));
		const reviews: string[] = [];
		const readReview = async (count: number, expectedModel = reviewModel) => {
			await expect.poll(async () => (await client.request(methods['session/list'], {})).sessions.filter(session => !before.has(session.sessionId)).length).toBe(count);
			const sessions = (await client.request(methods['session/list'], {})).sessions;
			const session = sessions.find(item => !before.has(item.sessionId) && !reviews.includes(item.sessionId))!;
			reviews.push(session.sessionId);
			const threadId = session.threads[0]!.threadId;
			const read = async () => (await client.request(methods['session/thread/read'], { sessionId: session.sessionId, threadId })).thread;
			await expect.poll(async () => (await read()).turns.at(-1)?.status).toBe('completed');
			const turn = (await read()).turns.at(-1)!;
			expect(turn.kind).toBe('review');
			expect(turn.model).toEqual(expectedModel);
			await expect(page.locator('.ash-chat-view-pane')).toContainText('Synthetic SCM review completed.');
			return turn.items.filter(item => item.type === 'userMessage').map(item => item.type === 'userMessage' ? item.text : '').join('\n');
		};

		await workbench.menus.select(application, () => dropdown.click(), ['Review Staged Changes Only']);
		expect(await readReview(1)).toContain('git diff --cached');
		await primary.click();
		expect(await readReview(2)).not.toContain('git diff --cached');
		await workbench.menus.select(application, () => dropdown.click(), ['Review Branch Changes...']);
		await expect(page.getByPlaceholder('Select a base branch to review against')).toBeVisible({ timeout: 5_000 });
		await page.screenshot({ path: testInfo.outputPath('scm-review-branch-picker.png') });
		await page.getByRole('option').filter({ hasText: 'review-base' }).click({ timeout: 5_000 });
		expect(await readReview(3)).toContain('refs/heads/review-base');
		await workbench.menus.select(application, () => dropdown.click(), ['Custom Review...']);
		const focus = page.getByPlaceholder('Review current changes, focusing on concurrency, security, tests...');
		await focus.fill('Check concurrency and tests');
		await focus.press('Enter');
		expect(await readReview(4)).toContain('Check concurrency and tests');
		await primary.click();
		const defaultReview = await readReview(5);
		expect(defaultReview).not.toContain('Check concurrency and tests');
		expect(defaultReview).not.toContain('git diff --cached');
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('agents');
		await workbench.settingsEditor.selectCategory('agents');
		await expect(reviewSelector).toContainText(reviewModel.model);
		await reviewSelector.click();
		await page.getByRole('option', { name: 'Follow Current Model', exact: true }).click();
		await expect.poll(async () => (await client.request(methods['config/read'], {})).codeReviewModel ?? null).toBeNull();
		expect((await client.request(methods['config/read'], {})).model).toEqual(model);
		await page.locator('.ash-modal-editor-close').click();
		await primary.click();
		await readReview(6, model);
	} finally {
		await connection?.close();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});
