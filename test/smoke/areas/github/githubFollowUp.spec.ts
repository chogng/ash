import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { expect, test } from '../../../automation/test.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

// The real profile host must retain and stop a conditional plan even with its optional account absent.
// Provider observations and Turn recovery are exercised separately by the backend's deterministic tests.
test(
	'PR follow-up persists across Agents windows and pauses without dropping its condition',
	{ tag: ['@electron-app-server'] },
	async ({ workbench, target, application, webAppServer, testWorkspace }) => {
		const connection = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
		try {
			expect(connection.client.capabilities?.contracts?.automationConditions?.version).toBe(1);
			const source = await connection.client.request(APP_SERVER_METHODS['session/create'], {
				commandId: 'follow-up-source',
				title: 'PR follow-up source',
				agent: { type: 'default' },
				executionTarget: { type: 'local', root: testWorkspace.directory },
			});
			const sessionId = source.session.sessionId;
			const condition = {
				type: 'gitHubChecks' as const,
				host: 'github.com',
				owner: 'ash-fixture',
				repository: 'follow-up',
				number: 7,
				accountId: 'fixture-unavailable',
				credentialRevision: '1',
			};
			await connection.client.request(APP_SERVER_METHODS['automation/write'], {
				commandId: 'follow-up-plan',
				id: 'follow-up',
				expectedRevision: 0,
				status: 'enabled',
				definition: {
					title: 'Follow PR fixture',
					prompt: 'Investigate CI using normal permissions.',
					directory: testWorkspace.directory,
					session: { type: 'continue', sessionId, threadId: sessionId },
					schedule: { type: 'interval', anchor: Date.now() + 3_600_000, minutes: 1 },
					condition,
				},
			});
			const run = await connection.client.request(APP_SERVER_METHODS['automation/run'], {
				id: 'follow-up',
				commandId: 'check-without-account',
			});
			let page = await workbench.openAgentsWindow(target.kind);
			await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
			await page.locator('[data-action-id="sessionsView.manageAutomations"] button').click();
			const card = () => page.locator('.ash-automation-card').filter({ hasText: 'Follow PR fixture' });
			await expect(card()).toHaveAttribute('data-enabled', 'true');
			page = await workbench.reopenAgentsWindow(application, page);
			await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
			await page.locator('[data-action-id="sessionsView.manageAutomations"] button').click();
			await expect(card()).toHaveAttribute('data-enabled', 'true');
			const pause = card().getByRole('button', { name: 'Pause', exact: true });
			await pause.focus();
			await pause.press('Enter');
			await expect(card()).toHaveAttribute('data-enabled', 'false');
			await expect.poll(async () => (await connection.client.request(APP_SERVER_METHODS['automation/run/read'], { runId: run.id })).status).toBe('stopped');
			const plans = await connection.client.request(APP_SERVER_METHODS['automation/list'], {});
			expect(plans.automations[0]!.definition.condition).toEqual(condition);
			expect(plans.automations[0]!.definition.session).toEqual({
				type: 'continue',
				sessionId,
				threadId: sessionId,
			});
			const thread = await connection.client.request(APP_SERVER_METHODS['session/thread/read'], {
				sessionId,
				threadId: sessionId,
			});
			expect(thread.thread.turns).toHaveLength(0);
			await card().getByRole('button', { name: 'Follow PR fixture', exact: true }).click();
			await expect(page.getByRole('button', { name: 'Edit automation', exact: true })).toBeDisabled();
		} finally {
			await connection.close();
		}
	},
);
