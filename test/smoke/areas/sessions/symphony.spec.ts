import { createServer, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { expect, test as base } from '../../../automation/test.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from './sessionProfileFixture.js';

interface ModelFixture { readonly url: string; readonly requests: string[]; readonly held: ServerResponse[] }
const test = base.extend<{ symphonyModel: ModelFixture }>({
	symphonyModel: async ({ }, use) => {
		const requests: string[] = [];
		const held: ServerResponse[] = [];
		let slowCalls = 0;
		const server = createServer(async (request, response) => {
			if (request.method !== 'POST' || request.url !== '/v1/responses') { response.writeHead(404).end(); return; }
			let text = '';
			for await (const chunk of request) { text += chunk; }
			requests.push(text);
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			if (text.includes('symphony-cleanup') || (text.includes('symphony-slow') && ++slowCalls === 1)) { held.push(response); response.flushHeaders(); return; }
			response.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: `symphony-response-${requests.length}`, status: 'completed', output: [{ type: 'message', id: `answer-${requests.length}`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Symphony task finished' }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })}\n\n`);
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (!address || typeof address === 'string') { throw new Error('Expected fixture model address'); }
		try { await use({ url: `http://127.0.0.1:${address.port}/v1`, requests, held }); }
		finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
	},
	backendConfiguration: async ({ symphonyModel }, use) => {
		const hookRules = ['after-create', 'before-run', 'after-run', 'before-remove'].map(name => `\n[[execPolicy.rules]]\nid = "fixture-symphony-${name}"\nselector = { kind = "source", source = "user", source_id = "user:hook:symphony-${name}" }\neffect = { kind = "allow_unsandboxed" }\njustification = "Only fixture hook scripts in isolated temporary workspaces are permitted."\n`).join('');
		await use(`schemaVersion = 10\n[agent.model]\nprovider = "custom-symphony-fixture"\nmodel = "gpt-6.1-sol"\n[connections.custom-symphony-fixture]\nprovider = "custom-symphony-fixture"\nconnection = "custom-symphony-fixture"\nbaseUrl = ${JSON.stringify(symphonyModel.url)}\n[connections.custom-symphony-fixture.custom]\nprotocol = "responses"\nname = "Symphony test model"\ncontextWindow = 272000\norder = 0\nmodel = "gpt-6.1-sol"\n${hookRules}`);
	},
});

test('built-in Symphony concurrently runs tasks, pauses, resumes and preserves cumulative conversation totals', async ({ target, application, workbench, testWorkspace, symphonyModel, webAppServer }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the product App Server');
	if (webAppServer) {
		const host = await test.step('Connect fixture directory permission host', () => connectProfile(application, webAppServer, testWorkspace.directory, workbench.page, { directoryPermissionsHost: true }));
		try {
			const config = await test.step('Read fixture directory permissions', () => host.client.request(APP_SERVER_METHODS['config/dirPermissions/list'], {}));
			await test.step('Grant fixture command execution', () => host.client.request(APP_SERVER_METHODS['config/dirPermissions/set'], { commandId: 'symphony-fixture-commands', expectedRevision: config.revision, path: testWorkspace.directory, permissions: ['readFiles', 'writeFiles', 'executeCommands', 'watchFiles', 'browseFiles', 'searchFiles', 'inspectRepository', 'mutateRepository'] }));
		} finally { await host.close(); }
	}
	const workflow = join(testWorkspace.directory, 'WORKFLOW.md');
	const workspaceRoot = join(testWorkspace.directory, 'symphony-workspaces');
	const hookLog = join(testWorkspace.directory, 'symphony-hooks.log');
	const quotedLog = `'${hookLog.replaceAll("'", "'\\''")}'`;
	await writeFile(workflow, `---\ntracker:\n  kind: local\nworkspace:\n  root: ${JSON.stringify(workspaceRoot)}\nagent:\n  max_concurrent_agents: 2\nhooks:\n  after_create: printf 'after_create\\n' >> ${quotedLog}\n  before_run: printf 'before_run\\n' >> ${quotedLog}\n  after_run: printf 'after_run\\n' >> ${quotedLog}\n  before_remove: printf 'before_remove\\n' >> ${quotedLog}\n---\n{{ issue.description }}\n`);
	let page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Symphony', exact: true }).click();
	let tasks = page.locator('.ash-symphony-tasks');
	await tasks.getByRole('textbox', { name: 'Workflow file' }).fill(workflow);
	await tasks.getByRole('button', { name: 'Load workflow', exact: true }).click();
	await expect(tasks.getByRole('combobox', { name: 'Workflow' })).toContainText('WORKFLOW.md');
	await tasks.getByRole('textbox', { name: 'Task title' }).fill('Slow task');
	await tasks.getByRole('textbox', { name: 'Instructions' }).fill('symphony-slow');
	await tasks.getByRole('button', { name: 'Create task', exact: true }).click();
	await expect(page.locator('.ash-symphony-monitor')).toContainText('Running');
	await expect.poll(() => symphonyModel.held.length).toBe(1);
	await tasks.getByRole('textbox', { name: 'Task title' }).fill('Fast task');
	await tasks.getByRole('textbox', { name: 'Instructions' }).fill('symphony-fast');
	await tasks.getByRole('button', { name: 'Create task', exact: true }).click();
	await expect(tasks.getByRole('option', { name: /^Fast task/ })).toContainText('Completed');
	await expect(page.locator('.ash-symphony-monitor')).toContainText('15 tokens');
	const slow = tasks.getByRole('option', { name: /^Slow task/ });
	const fast = tasks.getByRole('option', { name: /^Fast task/ });
	await expect(fast).toHaveAttribute('aria-selected', 'true');
	await expect(fast).toHaveClass(/\bselected\b/);
	await slow.click();
	await expect(slow).toHaveAttribute('aria-selected', 'true');
	await expect(slow).toHaveClass(/\bselected\b/);
	await expect(fast).toHaveAttribute('aria-selected', 'false');
	await expect(fast).not.toHaveClass(/\bselected\b/);
	await tasks.getByRole('listbox', { name: 'Conversations' }).press('End');
	await expect(tasks.getByRole('option').last()).toHaveAttribute('aria-selected', 'true');
	await expect(tasks.getByRole('option').last()).toHaveClass(/\bselected\b/);
	await expect(tasks.locator('.ash-symphony-row.selected')).toHaveCount(1);
	await tasks.getByRole('listbox', { name: 'Conversations' }).press('Home');
	await expect(tasks.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
	await expect(tasks.getByRole('option').first()).toHaveClass(/\bselected\b/);
	await expect(tasks.locator('.ash-symphony-row.selected')).toHaveCount(1);
	await slow.click();
	await page.locator('.ash-symphony-monitor').getByRole('button', { name: 'Pause', exact: true }).click();
	await expect(slow).toContainText('Paused');
	await page.locator('.ash-symphony-monitor').getByRole('button', { name: 'Resume', exact: true }).click();
	await expect(slow).toContainText('Completed');
	await expect(page.locator('.ash-symphony-messages')).toContainText('Symphony task finished');
	const id = await slow.getAttribute('data-conversation');
	await expect(page.locator('.ash-symphony-monitor')).toContainText('15 tokens');
	await page.locator('.ash-symphony-monitor').getByRole('button', { name: 'Resume', exact: true }).click();
	await expect(slow).toContainText('Completed');
	await expect(page.locator('.ash-symphony-monitor')).toContainText('30 tokens');
	await expect(tasks.getByRole('option')).toHaveCount(2);
	await tasks.getByRole('listbox').focus();
	await expect(tasks.getByRole('listbox')).toBeFocused();
	await page.keyboard.press('End');
	await expect(tasks.getByRole('listbox')).toHaveAttribute('aria-activedescendant', /^symphony-/);
	await slow.click();
	const calls = symphonyModel.requests.length;
	page = await workbench.reopenAgentsWindow(application, page);
	tasks = page.locator('.ash-symphony-tasks');
	await expect(tasks.locator(`[data-conversation="${id}"]`)).toHaveAttribute('aria-selected', 'true');
	await expect(tasks.locator(`[data-conversation="${id}"]`)).toHaveClass(/\bselected\b/);
	await expect(page.locator('.ash-symphony-monitor')).toContainText('30 tokens');
	expect(symphonyModel.requests.length).toBe(calls);
	await expect(page.getByRole('button', { name: /Open dashboard|Open in VS Code|View changes|Commit/ })).toHaveCount(0);
	const beforeCleanup = await readdir(workspaceRoot);
	await tasks.getByRole('textbox', { name: 'Task title' }).fill('Cleanup task');
	await tasks.getByRole('textbox', { name: 'Instructions' }).fill('symphony-cleanup');
	await tasks.getByRole('button', { name: 'Create task', exact: true }).click();
	await expect.poll(() => symphonyModel.held.length).toBe(2);
	await expect.poll(async () => (await readdir(workspaceRoot)).length).toBe(beforeCleanup.length + 1);
	await page.locator('.ash-symphony-monitor').getByRole('button', { name: 'Complete', exact: true }).click();
	await expect(tasks.getByRole('option', { name: /^Cleanup task/ })).toContainText('Completed');
	await expect.poll(() => readdir(workspaceRoot)).toEqual(beforeCleanup);
	const events = (await readFile(hookLog, 'utf8')).trim().split('\n');
	expect(events.filter(event => event === 'after_create')).toHaveLength(3);
	expect(events.filter(event => event === 'before_run')).toHaveLength(5);
	expect(events.filter(event => event === 'after_run')).toHaveLength(5);
	expect(events.filter(event => event === 'before_remove')).toHaveLength(1);
});

test('Symphony keyboard help and controls use Chinese in the Agents Window', async ({ target, application, workbench, restartWorkbench }) => {
	await workbench.page.keyboard.press('ControlOrMeta+,');
	const settings = workbench.page.locator('.ash-settings-editor');
	await settings.locator('[data-settings-category-id="general"]').click();
	const language = settings.locator('[data-settings-item-id="workbench.locale"]').getByRole('combobox');
	await language.click(); await workbench.page.keyboard.press('End'); await workbench.page.keyboard.press('Enter');
	await expect(language).toHaveText('简体中文');
	({ application, workbench } = await restartWorkbench());
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Symphony', exact: true }).click();
	const tasks = page.locator('.ash-symphony-tasks');
	await expect(tasks.getByRole('button', { name: '载入工作流', exact: true })).toBeVisible();
	await tasks.getByRole('textbox', { name: '工作流文件' }).focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.getByRole('dialog', { name: '无障碍帮助' }).getByRole('textbox')).toHaveValue(/Symphony 在 Ash 内调度任务/u);
	await page.keyboard.press('Escape');
	await expect(tasks.getByRole('textbox', { name: '工作流文件' })).toBeFocused();
	await page.keyboard.press('ControlOrMeta+,');
	const execution = page.locator('.ash-sessions-settings-dialog');
	await execution.getByRole('button', { name: '执行与权限', exact: true }).click();
	const approval = execution.getByRole('combobox', { name: '默认审批模式' });
	await expect(approval).toBeVisible(); await approval.focus(); await page.keyboard.press('Alt+F1');
	await expect(page.getByRole('dialog', { name: '无障碍帮助' }).getByRole('textbox')).toHaveValue(/执行与权限设置/u);
	await page.keyboard.press('Escape'); await expect(approval).toBeFocused();
});

test('Execution and permissions settings persist defaults, govern ordinary chats and Symphony, and edit host directory grants', async ({ target, application, workbench, testWorkspace, webAppServer }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the product App Server');
	const host = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page, { directoryPermissionsHost: true });
	try {
		// Browser transport does not acquire directory permission authority.
		if (webAppServer) {
			const grants = await host.client.request(APP_SERVER_METHODS['config/dirPermissions/list'], {});
			await host.client.request(APP_SERVER_METHODS['config/dirPermissions/set'], { commandId: 'execution-fixture-workspace', expectedRevision: grants.revision, path: testWorkspace.directory, permissions: ['readFiles', 'writeFiles', 'executeCommands', 'watchFiles', 'browseFiles', 'searchFiles', 'inspectRepository', 'mutateRepository'] });
		}
		let page = await workbench.openAgentsWindow(target.kind);
		await page.keyboard.press('ControlOrMeta+,');
		let settings = page.locator('.ash-sessions-settings-dialog');
		await expect(settings).toBeVisible();
		await settings.getByRole('button', { name: 'Execution and permissions', exact: true }).click();
		const approval = settings.getByRole('combobox', { name: 'Default approval mode' });
		await expect(approval).toBeEnabled();
		await approval.focus(); await page.keyboard.press('Alt+F1');
		await expect(page.getByRole('dialog', { name: 'Accessibility Help', exact: true }).getByRole('textbox')).toHaveValue(/New chats and workflows/);
		await page.keyboard.press('Escape'); await expect(approval).toBeFocused();
		await approval.click(); await page.getByRole('option', { name: 'Auto', exact: true }).click();
		const files = settings.getByRole('combobox', { name: 'Command file access' });
		await files.click(); await page.getByRole('option', { name: 'Read only', exact: true }).click();
		const network = settings.getByRole('combobox', { name: 'Command network access' });
		await network.click(); await page.getByRole('option', { name: 'Allowed', exact: true }).click();
		await settings.getByRole('button', { name: 'Save execution defaults', exact: true }).click();
		await expect(settings.getByRole('button', { name: 'Save execution defaults', exact: true })).toBeDisabled();
		expect((await host.client.request(APP_SERVER_METHODS['config/read'], {})).execution).toEqual({ approvalMode: 'auto', commandFileAccess: 'readOnly', commandNetworkAccess: 'allowed' });
		const directory = settings.getByRole('textbox', { name: 'Directory path on the App Server host' });
		if (webAppServer) {
			await expect(directory).toBeDisabled();
		} else {
			const extra = join(testWorkspace.directory, 'execution-grant');
			await mkdir(extra);
			await directory.fill(extra);
			const access = settings.getByRole('combobox', { name: 'Directory file and command permissions' });
			await access.click(); await page.getByRole('option', { name: 'Read, write and run commands', exact: true }).click();
			await settings.getByRole('button', { name: 'Save directory permissions', exact: true }).click();
			await expect(settings).toContainText('Saved capabilities: Read files');
			const grants = await host.client.request(APP_SERVER_METHODS['config/dirPermissions/list'], {});
			const canonicalExtra = await realpath(extra);
			expect(grants.entries.find(entry => entry.path === canonicalExtra)?.permissions).toContain('executeCommands');
			await settings.getByRole('button', { name: 'Revoke directory grant', exact: true }).click();
			await expect(settings.getByRole('button', { name: 'Revoke directory grant', exact: true })).toBeDisabled();
			expect((await host.client.request(APP_SERVER_METHODS['config/dirPermissions/list'], {})).entries.some(entry => entry.path === canonicalExtra)).toBe(false);
		}
		await page.keyboard.press('Escape');
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Code', exact: true }).click();
		await expect(page.locator('.ash-sessions-chat-input').getByRole('button', { name: 'Permissions: Auto', exact: true })).toBeVisible();
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Symphony', exact: true }).click();
		const workflow = join(testWorkspace.directory, 'EXECUTION.md');
		await writeFile(workflow, '---\ntracker:\n  kind: local\n---\n{{ issue.description }}\n');
		const tasks = page.locator('.ash-symphony-tasks');
		await tasks.getByRole('textbox', { name: 'Workflow file' }).fill(workflow);
		await tasks.getByRole('button', { name: 'Load workflow', exact: true }).click();
		await expect(tasks.getByRole('combobox', { name: 'Workflow' })).toContainText('EXECUTION.md');
		await tasks.getByRole('textbox', { name: 'Task title' }).fill('Execution defaults');
		await tasks.getByRole('textbox', { name: 'Instructions' }).fill('execution-settings');
		await tasks.getByRole('button', { name: 'Create task', exact: true }).click();
		await expect(tasks.getByRole('option', { name: /^Execution defaults/ })).toContainText('Completed');
		const state = await host.client.request(APP_SERVER_METHODS['symphony/read'], {});
		const conversation = state.conversations.find(item => item.title === 'Execution defaults')!;
		const catalog = await host.client.request(APP_SERVER_METHODS['session/list'], {});
		const session = catalog.sessions.find(item => item.threads.some(thread => thread.threadId === conversation.threadId))!;
		const thread = await host.client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId: session.sessionId, threadId: conversation.threadId! });
		expect(thread.thread.turns.at(-1)?.approvalMode).toBe('auto');
		page = await workbench.reopenAgentsWindow(application, page);
		await expect(page.locator('.ash-symphony-tasks')).toBeVisible();
		if (target.kind === 'browser') {
			await page.locator('.ash-sessions-activity-bottom button').last().click();
			await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
		} else { await page.keyboard.press('ControlOrMeta+,'); }
		settings = page.locator('.ash-sessions-settings-dialog');
		await expect(settings).toBeVisible();
		await settings.getByRole('button', { name: 'Execution and permissions', exact: true }).click();
		await expect(settings.getByRole('combobox', { name: 'Default approval mode' })).toHaveText('Auto');
		await expect(settings.getByRole('combobox', { name: 'Command file access' })).toHaveText('Read only');
		await expect(settings.getByRole('combobox', { name: 'Command network access' })).toHaveText('Allowed');
	} finally { await host.close(); }
});
