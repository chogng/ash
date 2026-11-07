import { expect, test } from '../../../automation/test.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Workbench } from '../../../automation/workbench.js';

test.use({ gitRepository: true });

async function reloadWindow(workbench: Workbench): Promise<void> {
	await Promise.all([
		workbench.page.waitForEvent('domcontentloaded'),
		workbench.quickaccess.runCommand('workbench.action.reloadWindow'),
	]);
	await workbench.waitForReady();
}

test('Chat restores the selected thread and side bar visibility alongside Welcome', { tag: ['@electron-app-server'] }, async ({ application, webAppServer, workbench, testWorkspace }) => {
	const page = workbench.page;
	const connection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
	try {
		const { session } = await connection.client.request(APP_SERVER_METHODS['session/create'], {
			commandId: 'reload-chat-session', kind: 'code', title: 'Chat reload session', agent: { type: 'default' },
			executionTarget: { type: 'local', root: testWorkspace.directory },
		});
		const welcome = page.locator('.ash-agent-sessions-welcome');
		const titleBarActions = page.getByRole('toolbar', { name: 'Title Bar global actions' });
		const showSideBar = titleBarActions.getByRole('button', { name: 'Show Secondary Side Bar', exact: true });
		const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
		await expect(welcome).toBeVisible();
		if (!await chat.isVisible()) { await showSideBar.click(); }
		const sidebar = page.locator('.ash-chat-sessions-sidebar');
		if (!await sidebar.isVisible()) {
			await page.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button').click();
		}
		await sidebar.locator('.ash-agent-session-row').filter({ hasText: session.title }).click();
		await expect(chat).toHaveAttribute('data-thread-id', session.threads[0].threadId);

		await reloadWindow(workbench);
		await expect(welcome).toBeVisible();
		await expect(chat).toHaveAttribute('data-thread-id', session.threads[0].threadId);

		await titleBarActions.getByRole('button', { name: 'Hide Secondary Side Bar', exact: true }).click();
		await reloadWindow(workbench);
		await expect(welcome).toBeVisible();
		await expect(showSideBar).toBeVisible();
		await expect(chat).toBeHidden();
		await showSideBar.click();
		await expect(chat).toHaveAttribute('data-thread-id', session.threads[0].threadId);
	} finally {
		await connection.close();
	}
});

for (const approvalMode of ['bypassPermissions', 'manual'] as const) test(`Chat presents real tool activity and independently readable input and output (${approvalMode})`, { tag: ['@electron-app-server'] }, async ({ application, webAppServer, workbench, testWorkspace }, testInfo) => {
	test.setTimeout(180_000);
	const page = workbench.page;
	const connection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
	try {
		const { client } = connection;
		const created = await client.request(APP_SERVER_METHODS['session/create'], {
			commandId: 'tool-output-session', kind: 'code', title: 'Tool output presentation', agent: { type: 'default' },
			executionTarget: { type: 'local', root: testWorkspace.directory },
			branchName: 'ash/tool-output',
		});
		const sessionId = created.session.sessionId;
		const threadId = created.session.threads[0].threadId;
		const read = async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread;
		// The marker lives only in the Thread worktree, so resolving "." against the window fails.
		const { directory } = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId });
		if (directory?.type !== 'local') { throw new Error('Expected a local Thread worktree'); }
		const sessionDirectory = directory.root;
		expect(await realpath(sessionDirectory)).not.toBe(await realpath(testWorkspace.directory));
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
		const releaseName = 'tool-release';
		const release = join(sessionDirectory, releaseName);
		let command: string;
		let inputEvidence: string;
		if (process.platform === 'win32') {
			// Use the system executable, which the separate sandbox account can read.
			const systemRoot = process.env.SystemRoot;
			if (!systemRoot) { throw new Error('Windows tool output fixture requires SystemRoot'); }
			const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
			const script = [
				"$ErrorActionPreference='Stop'",
				`while (!(Test-Path -LiteralPath '${releaseName}')) { Start-Sleep -Milliseconds 50 }`,
				"[Console]::WriteLine('tool-stdout')",
				"[Console]::Error.WriteLine('tool-stderr')",
			].join('; ');
			command = `"${powershell}" -NoProfile -NonInteractive -Command "${script}"`;
			inputEvidence = releaseName;
		} else {
			const script = 'silent-tool.cjs';
			await writeFile(join(sessionDirectory, script), `const fs = require('node:fs');
const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(releaseName)})) return;
    clearInterval(timer);
    process.stdout.write('tool-stdout\\n');
    process.stderr.write('tool-stderr\\n');
}, 20);`);
			const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
			command = `${quote(process.execPath)} ${quote(script)}`;
			inputEvidence = script;
		}
		if (approvalMode === 'manual') {
			const config = await client.request(APP_SERVER_METHODS['config/read'], {});
			// Sandboxed commands may run without a prompt even in manual mode. Require
			// approval explicitly in this isolated profile to exercise the real wait.
			await client.request(APP_SERVER_METHODS['execPolicy/rule/upsert'], {
				commandId: 'tool-output-approval-rule', expectedRevision: config.revision,
				rule: {
					id: 'tool-output-approval', selector: { type: 'source', source: 'built_in_tool', sourceId: 'shell-command' },
					effect: { type: 'requireApproval' }, justification: 'Exercise approval of the synthetic stdout/stderr command in this isolated smoke profile.',
				},
			});
		}
		await client.request(APP_SERVER_METHODS['session/request'], {
			sessionId, commandId: 'tool-output-turn',
			request: {
				type: 'startShellTurn', threadId, expectedSequence: (await read()).sequence,
				approvalMode, command, workingDirectory: '.',
			},
		});
		const tool = chat.locator('.ash-chat-tool-invocation');
		const summary = tool.locator(':scope > summary');
		const expectRunning = async () => {
			try {
				await expect(summary).toContainText('Running');
			} catch (error) {
				const result = (await read()).turns.at(-1)?.items.find(item => item.type === 'toolResult');
				throw new Error(`Tool did not stay running: ${JSON.stringify(result)}`, { cause: error });
			}
		};
		if (approvalMode === 'manual') {
			await expect.poll(async () => (await read()).turns.at(-1)?.status, { timeout: 30_000 }).toBe('waitingForApproval');
			const waiting = (await read()).turns.at(-1)!;
			expect(waiting.pendingInteraction?.kind).toBe('approval');
			const call = waiting.items.find(item => item.type === 'toolCall');
			expect(waiting.pendingInteraction?.itemId).toBe(call?.itemId);
			await expect(summary).toContainText('Awaiting approval');
			await expect(tool).toHaveAttribute('aria-busy', 'false');
			await expect(summary.locator('.ash-icon-lock')).toBeVisible();
			await reloadWindow(workbench);
			await expect(chat).toHaveAttribute('data-thread-id', threadId);
			await expect(summary).toContainText('Awaiting approval');
			await chat.getByRole('button', { name: 'Approve once', exact: true }).click();
		}
		await expect.poll(async () => (await read()).turns.at(-1)?.startedToolCallIds?.length).toBe(1);
		const indexed = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId, history: { type: 'latest', turnLimit: 10 } });
		await testInfo.attach('running-tool-history.json', { body: JSON.stringify(indexed.thread, null, 2), contentType: 'application/json' });
		expect(indexed.thread.turns.at(-1)?.startedToolCallIds).toEqual((await read()).turns.at(-1)?.startedToolCallIds);
		await expectRunning();
		await expect(tool).toHaveAttribute('aria-busy', 'true');
		await expect(tool.locator('[data-tool-section="stdout"]')).toBeHidden();
		await reloadWindow(workbench);
		await expect(chat).toHaveAttribute('data-thread-id', threadId);
		await expectRunning();
		await writeFile(release, 'continue');
		await expect.poll(async () => (await read()).turns.at(-1)?.status, { timeout: 30_000 }).toBe('completed');
		await testInfo.attach('tool-evidence.json', { body: JSON.stringify((await read()).turns.at(-1), null, 2), contentType: 'application/json' });
		await expect(summary).toContainText('Run ');
		await expect(summary).toContainText('Completed');
		await summary.focus();
		await page.keyboard.press('Enter');
		for (const [key, label, evidence] of [
			['input', 'Input', inputEvidence],
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
