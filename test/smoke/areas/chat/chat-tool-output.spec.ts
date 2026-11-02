import { expect, test } from '../../../automation/test.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';

test.use({ gitRepository: true });

test('Chat presents real tool activity and independently readable input and output', { tag: ['@electron-app-server'] }, async ({ application, webAppServer, workbench, testWorkspace }, testInfo) => {
	test.setTimeout(180_000);
	const page = workbench.page;
	const connection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
	try {
		const { client } = connection;
		const created = await client.request(APP_SERVER_METHODS['session/create'], {
			commandId: 'tool-output-session', title: 'Tool output presentation', agent: { type: 'default' },
			executionTarget: { type: 'local', root: testWorkspace.directory },
		});
		const sessionId = created.session.sessionId;
		const threadId = created.session.threads[0].threadId;
		const read = async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread;
		const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
		if (!await chat.isVisible()) {
			await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
		}
		const sidebar = page.locator('.ash-chat-sessions-sidebar');
		if (!await sidebar.isVisible()) {
			await page.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button').click();
		}
		await sidebar.locator('.ash-agent-session-row').filter({ hasText: 'Tool output presentation' }).click();
		await expect(chat).toHaveAttribute('data-thread-id', threadId);
		const command = process.platform === 'win32'
			? 'echo tool-stdout & echo tool-stderr 1>&2'
			: "printf 'tool-stdout\\n'; printf 'tool-stderr\\n' >&2";
		await client.request(APP_SERVER_METHODS['session/request'], {
			sessionId, commandId: 'tool-output-turn',
			request: {
				type: 'startShellTurn', threadId, expectedSequence: (await read()).sequence,
				approvalMode: 'bypassPermissions', command, workingDirectory: '.',
			},
		});
		await expect.poll(async () => (await read()).turns.at(-1)?.status, { timeout: 30_000 }).toBe('completed');
		await testInfo.attach('tool-evidence.json', { body: JSON.stringify((await read()).turns.at(-1), null, 2), contentType: 'application/json' });
		const tool = chat.locator('.ash-chat-tool-invocation');
		const summary = tool.locator(':scope > summary');
		await expect(summary).toContainText('Run ');
		await expect(summary).toContainText('Completed');
		await summary.focus();
		await page.keyboard.press('Enter');
		for (const [key, label, evidence] of [
			['input', 'Input', 'tool-stdout'],
			['result', 'Result', 'tool-stdout'],
		] as const) {
			const section = tool.locator(`[data-tool-section="${key}"]`);
			await section.locator('summary').focus();
			await page.keyboard.press('Space');
			const region = section.getByRole('region', { name: label, exact: true });
			await expect(region).toContainText(evidence);
			await page.keyboard.press('Tab');
			await expect(region).toBeFocused();
		}
		// Shell turns retain stdout/stderr in the durable result. Separate stream
		// regions are shown only when the transcript actually contains toolOutput.
		await expect(tool.locator('[data-tool-section="result"]').getByRole('region')).toContainText('tool-stderr');
		await expect(tool.locator('[data-tool-section="stdout"]')).toBeHidden();
		await expect(tool.locator('[data-tool-section="stderr"]')).toBeHidden();
		await expect(tool.locator('[data-tool-section="input"]')).toHaveAttribute('open');
		await expect(tool.locator('[data-tool-section="result"]')).toHaveAttribute('open');
		await expect(summary).toContainText('Completed');
		await testInfo.attach('tool-input-output.png', { body: await page.screenshot(), contentType: 'image/png' });
	} finally {
		await connection.close();
	}
});
