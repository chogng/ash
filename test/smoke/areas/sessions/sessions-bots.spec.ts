import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test as base } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from './sessionProfileFixture.js';

const reviewLine = 160;
const reviewedText = 'const reviewedAnswer = 43;';
const reviewFile = ['const answer = 42;',
	...Array.from({ length: reviewLine - 2 }, (_, index) => `// Review fixture line ${index + 2}`), reviewedText,
	...Array.from({ length: 40 }, (_, index) => `// Review fixture line ${reviewLine + index + 1}`), ''].join('\n');
const reviewPatch = ['*** Begin Patch', '*** Add File: review.ts',
	...reviewFile.trimEnd().split('\n').map(line => `+${line}`), '*** End Patch'].join('\n');

const test = base.extend<{ reviewModelUrl: string; }>({
	reviewModelUrl: async ({ }, use) => {
		let applied = false;
		const server = createServer(async (request, response) => {
			if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
				response.writeHead(404).end();
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = Buffer.concat(chunks).toString('utf8');
			const { messages } = JSON.parse(body) as { messages: { role: string; content: unknown; }[]; };
			// The provider can append other user-role messages after the fixture prompt.
			const hasPrompt = (phrase: string): boolean => messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(phrase));
			const applyPatch = !applied && hasPrompt('Source-only prompt');
			const answer = hasPrompt('Check concurrent edits') ? JSON.stringify({
				findings: [], overall_correctness: 'patch is correct',
				overall_explanation: 'Independent review completed.', overall_confidence_score: 1,
			}) : hasPrompt('Use the personal role instructions') && body.includes('Revised helper fixture instructions')
				? 'Personal helper used its updated instructions.'
				: body.includes('Use the personal role instructions') && body.includes('Personal helper fixture instructions')
					? 'Personal helper followed its instructions.'
					: body.includes('Check the migration plan') ? 'Advisor recommends checking saved drafts.'
						: hasPrompt('Prove project mention') ? 'Ash received the project mention.'
							: hasPrompt('Prove project default') && body.includes('Project fixture role instructions') ? 'Project default received the task.'
								: hasPrompt('Prove workspace routing') && body.includes('Fixture role instructions') ? 'Workspace role received the task.'
									: hasPrompt('Explain the next step') ? 'Follow-up from Code Review'
										: hasPrompt('Check the order') ? 'Review reply from Code Review' : 'Source-only answer';
			const delta = applyPatch ? {
				tool_calls: [{
					index: 0, id: 'fixture-write', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ patch: reviewPatch }) },
				}]
			} : { content: answer };
			applied ||= applyPatch;
			const packet = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.end(packet({ id: 'review-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })
				+ packet({ id: 'review-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: applyPatch ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Expected review fixture address');
		try { await use(`http://127.0.0.1:${address.port}/v1`); }
		finally {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	},
	backendConfiguration: async ({ reviewModelUrl }, use) => {
		await use(`schemaVersion = 10
[agent.model]
provider = "custom-bots-fixture"
model = "gpt-6.1-sol"
[connections.custom-bots-fixture]
provider = "custom-bots-fixture"
connection = "custom-bots-fixture"
baseUrl = ${JSON.stringify(reviewModelUrl)}
[connections.custom-bots-fixture.custom]
protocol = "chatCompletions"
name = "Code Review fixture"
contextWindow = 272000
order = 0
model = "gpt-6.1-sol"
`);
	},
});
// Every line in the fixture is added. Keep the desktop scenario focused on range navigation.
test.use({ gitRepository: true, electronUserSettings: { 'diffEditor.hideUnchangedRegions.enabled': false } });

test.describe('Localized Bots', () => {
	test.use({ electronUserSettings: { 'workbench.locale': 'zh-CN' } });

	test('My Bots manages a personal Agent and preserves conversations when removing it', { tag: ['@electron-app-server'] }, async ({ application, target, workbench, testWorkspace }, testInfo) => {
		let page = await workbench.openAgentsWindow(target.kind);
		const connection = await connectProfile(application, undefined, testWorkspace.directory, page);
		try {
			const { client } = connection;
			const codeMode = () => page.locator('.ash-window-mode-control:visible').getByRole('button', { name: '代码', exact: true });
			const openBots = () => page.locator('.ash-sessions-activity-content').getByRole('button', { name: '机器人', exact: true }).click();
			const botTree = () => page.locator('.ash-bots-sidebar').getByRole('tree');
			const botPage = () => page.locator('.ash-bots-page');
			const botName = 'personal-helper';
			const projectId = 'personal-bot-project';
			await client.request(APP_SERVER_METHODS['project/create'], {
				commandId: 'create-personal-bot-project', projectId, name: 'Personal Bot project', description: '', scope: 'code',
				materials: [{ kind: 'folder', path: pathToFileURL(testWorkspace.directory).href, name: 'Fixture folder' }],
			});
			const readProject = async () => (await client.request(APP_SERVER_METHODS['project/read'], { projectId, scope: 'code' })).project;
			const readUserRole = async () => (await client.request(APP_SERVER_METHODS['agent/roles/catalog'], {})).agents.find(role => role.name === botName);
			await codeMode().click();
			await openBots();
			await botTree().getByRole('treeitem', { name: '我的机器人', exact: true }).click();
			await botPage().getByRole('button', { name: '创建机器人', exact: true }).click();
			const dialog = page.getByRole('dialog', { name: '创建机器人', exact: true });
			await expect(dialog.getByRole('textbox', { name: '机器人名称', exact: true })).toBeFocused();
			await dialog.getByRole('textbox', { name: '机器人名称', exact: true }).fill(botName);
			await dialog.getByRole('textbox', { name: '描述', exact: true }).fill('Personal engineering helper');
			await dialog.getByRole('textbox', { name: '指令', exact: true }).fill('Personal helper fixture instructions.\nReturn concise answers.');
			await testInfo.attach('create-personal-bot', { body: await dialog.screenshot(), contentType: 'image/png' });
			await dialog.getByRole('button', { name: '创建机器人', exact: true }).click();
			await expect(dialog).toBeHidden();
			await expect(botPage().getByRole('heading', { name: botName, exact: true })).toBeVisible();
			expect((await readUserRole())?.source).toEqual({ type: 'user' });
			await botPage().getByRole('button', { name: '新建对话', exact: true }).click();
			const send = async (container: ReturnType<typeof botPage>, prompt: string) => {
				const composer = new Editor(container.locator('.ash-chat-input-part'));
				await composer.waitForEditorFocus();
				await composer.waitForTypeInEditor(prompt);
				await composer.input.press('Enter');
			};
			await send(botPage(), 'Use the personal role instructions in Bots');
			await expect(botPage().getByRole('log')).toContainText('Personal helper followed its instructions.');
			expect((await readProject()).sessionIds).toEqual([]);
			const personalSession = (await client.request(APP_SERVER_METHODS['session/list'], {})).sessions.find(session => session.title === botName);
			expect(personalSession).toBeDefined();

			page = await workbench.reopenAgentsWindow(application, page);
			await expect(botTree().or(codeMode()).filter({ visible: true }).first()).toBeVisible();
			if (!await botTree().isVisible()) {
				await codeMode().click();
				await openBots();
			}
			await botTree().getByRole('treeitem', { name: botName, exact: true }).click();
			await expect(botPage().getByRole('log')).toContainText('Personal helper followed its instructions.');
			await page.locator('[data-part="sidebar"]').getByRole('button', { name: '后退', exact: true }).press('Enter');
			const project = page.getByRole('button', { name: 'Personal Bot project', exact: true });
			const manager = page.getByRole('dialog', { name: '机器人管理', exact: true });
			const botRow = (name: string) => manager.getByRole('list', { name: '项目机器人', exact: true }).getByRole('listitem')
				.filter({ has: page.getByText(name, { exact: true }) });
			const openManager = async () => {
				await project.press('Shift+F10');
				await page.getByRole('menuitem', { name: '机器人管理', exact: true }).press('Enter');
				await expect(manager).toBeVisible();
			};
			const addPersonalBot = async () => {
				await manager.getByRole('button', { name: '添加机器人', exact: true }).press('Enter');
				const search = manager.getByRole('textbox', { name: '搜索机器人' });
				await expect(search).toBeFocused();
				await search.fill(botName);
				await manager.getByRole('button', { name: `添加 ${botName}`, exact: true }).press('Enter');
				await expect(search).toBeFocused();
				await expect(botRow(botName)).toContainText('@personal-helper · 我的机器人');
			};
			const setPersonalDefault = async () => {
				await botRow(botName).getByRole('button', { name: `将 ${botName} 设为默认`, exact: true }).press('Enter');
				await expect(botRow(botName).getByText('默认', { exact: true })).toBeVisible();
			};
			await openManager();
			await expect(botRow('Ash').getByText('默认', { exact: true })).toBeVisible();
			await expect(manager.getByRole('heading', { name: '项目机器人', exact: true })).toBeFocused();
			await page.keyboard.press('Tab');
			await page.keyboard.press('Tab');
			await expect(manager.getByRole('button', { name: '添加机器人', exact: true })).toBeFocused();
			expect((await readProject()).defaultTeamId).toBeUndefined();
			await addPersonalBot();
			await expect.poll(async () => (await readProject()).defaultTeamId).toBeTruthy();
			const teamId = (await readProject()).defaultTeamId!;
			const readTeam = async () => (await client.request(APP_SERVER_METHODS['team/read'], { teamId })).team;
			await expect.poll(async () => (await readTeam()).members.find(member => member.name === botName)?.role)
				.toEqual({ type: 'exact', source: { type: 'user' }, name: botName });
			await setPersonalDefault();
			await manager.getByRole('textbox', { name: '搜索机器人' }).fill('');
			await testInfo.attach('project-bot-management-zh-CN', { body: await manager.screenshot(), contentType: 'image/png' });
			await page.keyboard.press('Escape');
			await expect(manager).toBeHidden();
			await expect(project).toBeFocused();
			await expect.poll(async () => {
				const team = await readTeam();
				return team.members.find(member => member.agentId === team.coordinatorId)?.name;
			}).toBe(botName);
			await project.press('Shift+F10');
			await page.getByRole('menuitem', { name: '在此项目中新建对话', exact: true }).click();
			const chat = page.locator('.ash-sessions-chat-slot.active:visible');
			await send(chat, 'Use the personal role instructions in the project');
			await expect(chat.getByRole('log')).toContainText('Personal helper followed its instructions.');
			await expect(chat.getByRole('log')).not.toContainText('Use the personal role instructions in Bots');
			const [sessionId] = (await readProject()).sessionIds;
			expect(sessionId).toBeTruthy();

			const teamBeforeEdit = await readTeam();
			await openBots();
			await botTree().getByRole('treeitem', { name: botName, exact: true }).click();
			const editButton = botPage().getByRole('button', { name: '编辑机器人', exact: true });
			await editButton.press('Enter');
			const edit = page.getByRole('dialog', { name: '编辑机器人', exact: true });
			const name = edit.getByRole('textbox', { name: '机器人名称', exact: true });
			const description = edit.getByRole('textbox', { name: '描述', exact: true });
			const instructions = edit.getByRole('textbox', { name: '指令', exact: true });
			await expect(name).toHaveValue(botName);
			await expect(name).toHaveJSProperty('readOnly', true);
			await expect(description).toBeFocused();
			await expect(description).toHaveValue('Personal engineering helper');
			await expect(instructions).toHaveValue('Personal helper fixture instructions.\nReturn concise answers.');
			await description.fill('Updated personal engineering helper');
			await instructions.fill('Revised helper fixture instructions.\nUse the updated rules.');
			await testInfo.attach('edit-personal-bot', { body: await edit.screenshot(), contentType: 'image/png' });
			await edit.getByRole('button', { name: '保存', exact: true }).click();
			await expect(edit).toBeHidden();
			await expect(editButton).toBeFocused();
			await expect(botPage().getByText('Updated personal engineering helper', { exact: true })).toBeVisible();
			expect(await readTeam()).toEqual(teamBeforeEdit);
			await page.locator('[data-part="sidebar"]').getByRole('button', { name: '后退', exact: true }).press('Enter');
			await expect(chat.getByRole('log')).toContainText('Personal helper followed its instructions.');
			await send(chat, '@personal-helper Use the personal role instructions in a branch');
			await expect.poll(async () => {
				const { session } = await client.request(APP_SERVER_METHODS['session/catalog/read'], { sessionId: sessionId! });
				const branch = session?.threads.find(thread => thread.title === botName && thread.threadId !== sessionId);
				if (!branch) return undefined;
				const { thread } = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId: sessionId!, threadId: branch.threadId });
				const turn = thread.turns.at(-1);
				return [thread.turns.length, turn?.status, turn?.items.filter(item => item.type === 'agentMessage').map(item => item.text).join('')];
			}).toEqual([2, 'completed', 'Personal helper used its updated instructions.']);

			await project.press('Shift+F10');
			await page.getByRole('menuitem', { name: '在此项目中新建对话', exact: true }).click();
			await send(chat, 'Use the personal role instructions in a new project task');
			await expect(chat.getByRole('log')).toContainText('Personal helper used its updated instructions.');
			expect((await readProject()).sessionIds).toHaveLength(2);
			expect(await readTeam()).toEqual(teamBeforeEdit);

			const ashId = teamBeforeEdit.members.find(member => member.name === 'Ash')!.agentId;
			const originalTasks = (await readProject()).sessionIds;
			await openManager();
			const remove = botRow(botName).getByRole('button', { name: `移除 ${botName}`, exact: true });
			await remove.press('Enter');
			const confirmRemoval = page.getByRole('dialog').filter({ has: page.getByText(`从项目中移除 ${botName}？`, { exact: true }) });
			await expect(confirmRemoval).toContainText('Ash 将接手新任务。已有任务和对话会保留。');
			await page.keyboard.press('Escape');
			await expect(confirmRemoval).toBeHidden();
			await expect(remove).toBeFocused();
			expect(await readTeam()).toEqual(teamBeforeEdit);
			await remove.press('Enter');
			await confirmRemoval.getByRole('button', { name: '移除', exact: true }).click();
			await expect(botRow(botName)).toHaveCount(0);
			await expect(botRow('Ash').getByText('默认', { exact: true })).toBeVisible();
			await manager.getByRole('button', { name: '完成', exact: true }).press('Enter');
			await expect.poll(async () => {
				const team = await readTeam();
				return [team.revision, team.coordinatorId, team.members.map(member => member.agentId)];
			}).toEqual([teamBeforeEdit.revision + 1, ashId, [ashId]]);
			expect((await readUserRole())?.description).toBe('Updated personal engineering helper');
			expect((await readProject()).sessionIds).toEqual(originalTasks);
			await project.press('Shift+F10');
			await page.getByRole('menuitem', { name: '在此项目中新建对话', exact: true }).click();
			await send(chat, 'Verify project fallback');
			await expect(chat.getByRole('log')).toContainText('Source-only answer');
			const fallbackSession = (await readProject()).sessionIds.find(id => !originalTasks.includes(id));
			expect(fallbackSession).toBeTruthy();
			const { thread: ashThread } = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId: fallbackSession!, threadId: fallbackSession! });
			expect(ashThread.agentId).toBe(ashId);

			await openManager();
			await addPersonalBot();
			await expect.poll(async () => (await readTeam()).members.some(member => member.name === botName)).toBe(true);
			await setPersonalDefault();
			await manager.getByRole('button', { name: '完成', exact: true }).click();
			await expect.poll(async () => (await readTeam()).coordinatorId).not.toBe(ashId);
			const teamBeforeDelete = await readTeam();
			await client.request(APP_SERVER_METHODS['team/command'], {
				teamId, commandId: 'remove-ash-through-team-settings', expectedRevision: teamBeforeDelete.revision,
				command: { type: 'removeMember', agentId: ashId },
			});
			const otherProjectId = 'other-personal-bot-project';
			await client.request(APP_SERVER_METHODS['project/create'], {
				commandId: 'create-other-personal-bot-project', projectId: otherProjectId, name: 'Other Bot project', description: '', scope: 'code', materials: [],
			});
			const { project: other } = await client.request(APP_SERVER_METHODS['project/team/ensure'], { projectId: otherProjectId, coordinatorResponsibility: 'Handle new tasks.' });
			const otherTeamId = other.defaultTeamId!;
			const { team: otherTeam } = await client.request(APP_SERVER_METHODS['team/read'], { teamId: otherTeamId });
			const otherMember = { agentId: 'other-personal-bot-member', name: botName, responsibility: 'Help with tasks.', role: { type: 'exact', source: { type: 'user' }, name: botName } } as const;
			await client.request(APP_SERVER_METHODS['team/command'], {
				teamId: otherTeamId, commandId: 'add-other-personal-bot-member', expectedRevision: otherTeam.revision,
				command: { type: 'addMember', member: otherMember },
			});

			await openBots();
			const personalBot = botTree().getByRole('treeitem', { name: botName, exact: true });
			await personalBot.click();
			await botPage().getByRole('button', { name: '删除机器人', exact: true }).press('Enter');
			const confirmDelete = page.getByRole('dialog').filter({ hasText: `删除机器人「${botName}」？` });
			await expect(confirmDelete).toContainText('已有对话仍可在代码页面打开。');
			await testInfo.attach('delete-personal-bot', { body: await confirmDelete.screenshot(), contentType: 'image/png' });
			await confirmDelete.getByRole('button', { name: '删除机器人', exact: true }).click();
			await expect(personalBot).toHaveCount(0);
			await expect(botPage().getByRole('button', { name: '创建机器人', exact: true })).toBeFocused();
			expect(await readUserRole()).toBeUndefined();
			const teamAfterDelete = await readTeam();
			expect(teamAfterDelete.coordinatorId).toBe(ashId);
			expect(teamAfterDelete.members.map(member => member.role)).toEqual([{ type: 'default' }]);
			const { team: remaining } = await client.request(APP_SERVER_METHODS['team/read'], { teamId: otherTeamId });
			expect(remaining.coordinatorId).toBe(otherTeam.coordinatorId);
			expect(remaining.members).toEqual(otherTeam.members);
			await expect(client.request(APP_SERVER_METHODS['team/command'], {
				teamId: otherTeamId, commandId: 'retry-from-stale-bot-picker', expectedRevision: remaining.revision,
				command: { type: 'addMember', member: otherMember },
			})).rejects.toMatchObject({ errorName: 'ResourceNotFound' });
			expect((await readProject()).sessionIds).toEqual(expect.arrayContaining(originalTasks));
			const { session: preserved } = await client.request(APP_SERVER_METHODS['session/catalog/read'], { sessionId: sessionId! });
			expect(preserved?.threads.some(thread => thread.title === botName)).toBe(true);
			await page.locator('[data-part="sidebar"]').getByRole('button', { name: '后退', exact: true }).press('Enter');
			await page.locator(`[data-item="session:${personalSession!.sessionId}"]`).getByText(botName, { exact: true }).click();
			await expect(chat.getByRole('log')).toContainText('Personal helper followed its instructions.');
			await send(chat, 'Use the personal role instructions after deletion');
			await expect(chat.getByRole('log').getByText('Personal helper followed its instructions.', { exact: true })).toHaveCount(2);
		} finally { await connection.close(); }
	});

	test('A project Team supplies the default Bot and handles explicit mentions under one Session', { tag: ['@electron-app-server'] }, async ({ application, target, workbench, testWorkspace }) => {
		const directory = join(testWorkspace.directory, '.ash', 'agents');
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, 'fixture-project-bot.md'), '---\nname: fixture-project-bot\ndescription: Works on tasks for the fixture project.\n---\nProject fixture role instructions.\n');
		const page = await workbench.openAgentsWindow(target.kind);
		const connection = await connectProfile(application, undefined, testWorkspace.directory, page);
		try {
			const { client } = connection;
			const config = await client.request(APP_SERVER_METHODS['config/read'], {});
			await client.request(APP_SERVER_METHODS['config/update'], {
				commandId: 'project-bots-advisor', expectedRevision: config.revision,
				advisor: { enabled: true, model: { provider: 'custom-bots-fixture', model: 'gpt-6.1-sol' }, maxCalls: 2, maxOutputTokens: 2048 },
			});
			const projectId = 'project-bots-fixture';
			await client.request(APP_SERVER_METHODS['project/create'], {
				commandId: 'create-project-bots-fixture', projectId, name: 'Project Bots fixture', description: '', scope: 'code',
				materials: [{ kind: 'folder', path: pathToFileURL(testWorkspace.directory).href, name: 'Fixture folder' }],
			});
			const readProject = async () => (await client.request(APP_SERVER_METHODS['project/read'], { projectId, scope: 'code' })).project;
			const readTeam = async () => {
				const { defaultTeamId } = await readProject();
				return defaultTeamId ? (await client.request(APP_SERVER_METHODS['team/read'], { teamId: defaultTeamId })).team : undefined;
			};
			await page.locator('.ash-window-mode-control').getByRole('button', { name: '代码', exact: true }).click();
			const project = page.locator(`.ash-sessions-list:visible [data-project-id="${projectId}"]`);
			const more = project.getByRole('button', { name: '更多项目操作', exact: true });
			await project.getByRole('button', { name: 'Project Bots fixture', exact: true }).hover();
			await more.click();
			await page.getByRole('menuitem', { name: '机器人管理', exact: true }).click();
			const manager = page.getByRole('dialog', { name: '机器人管理', exact: true });
			await manager.getByRole('button', { name: '添加机器人', exact: true }).click();
			const addBot = async (name: string) => {
				await manager.getByRole('textbox', { name: '搜索机器人' }).fill(name);
				await manager.getByRole('button', { name: `添加 ${name}`, exact: true }).click();
				await expect(manager.getByRole('list', { name: '项目机器人', exact: true }).getByText(name, { exact: true })).toBeVisible();
			};
			await addBot('fixture-project-bot');
			await expect.poll(async () => (await readTeam())?.members.map(member => member.name).sort()).toEqual(['Ash', 'fixture-project-bot']);
			await addBot('顾问');
			await expect.poll(async () => (await readTeam())?.members.length).toBe(3);
			await addBot('代码审查');
			await expect.poll(async () => (await readTeam())?.members.length).toBe(4);
			await addBot('议题');
			const makeFixtureDefault = manager.getByRole('button', { name: '将 fixture-project-bot 设为默认' });
			await makeFixtureDefault.click();
			await manager.getByRole('button', { name: '将 Ash 设为默认' }).click();
			await expect(manager.getByRole('listitem').filter({ has: page.getByText('Ash', { exact: true }) }).getByText('默认', { exact: true })).toBeVisible();
			await makeFixtureDefault.click();
			await manager.getByRole('button', { name: '移除 议题' }).click();
			await expect(manager.getByRole('list', { name: '项目机器人', exact: true }).getByText('议题', { exact: true })).toHaveCount(0);
			await expect.poll(async () => {
				const team = await readTeam();
				return team?.members.find(member => member.agentId === team.coordinatorId)?.name;
			}).toBe('fixture-project-bot');
			const team = (await readTeam())!;
			await manager.getByRole('button', { name: '完成', exact: true }).click();
			await project.getByRole('button', { name: 'Project Bots fixture', exact: true }).press('Shift+F10');
			await page.getByRole('menuitem', { name: '在此项目中新建对话', exact: true }).click();
			const chat = page.locator('.ash-sessions-chat-slot.active:visible');
			const composer = new Editor(chat.locator('.ash-chat-input-part'));
			await composer.waitForEditorFocus();
			await composer.waitForTypeInEditor('Prove project default');
			await composer.input.press('Enter');
			await expect(chat.getByRole('log')).toContainText('Project default received the task.');
			const [sessionId] = (await readProject()).sessionIds;
			expect(sessionId).toBeTruthy();
			const read = (threadId = sessionId!) => client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId: sessionId!, threadId });
			expect((await read()).thread.agentId).toBe(team.coordinatorId);

			await composer.waitForEditorFocus();
			await composer.waitForTypeInEditor('@');
			await expect(page.getByText('项目机器人', { exact: true }).filter({ visible: true })).toBeVisible();
			await page.getByRole('option', { name: /@Ash/u }).click();
			await composer.waitForTypeInEditor('Prove project mention');
			await composer.input.press('Enter');
			const readBranches = async () => (await client.request(APP_SERVER_METHODS['session/catalog/read'], { sessionId: sessionId! })).session?.threads ?? [];
			await expect.poll(async () => (await readBranches()).find(thread => thread.title === 'Ash')?.threadId).toBeTruthy();
			const ash = (await readBranches()).find(thread => thread.title === 'Ash')!;
			await expect.poll(async () => {
				const { thread } = await read(ash.threadId);
				return [thread.turns.length, thread.turns.at(-1)?.status];
			}).toEqual([2, 'completed']);
			expect((await read(ash.threadId)).thread.agentId).toBe(team.members.find(member => member.name === 'Ash')!.agentId);
			expect((await read()).thread.turns).toHaveLength(1);

			await composer.waitForTypeInEditor('@Advisor Check the migration plan');
			await composer.input.press('Enter');
			await expect(chat.getByRole('log')).toContainText('Advisor recommends checking saved drafts.');
			await expect.poll(async () => (await read()).thread.turns.at(-1)?.status).toBe('completed');
			expect((await read()).thread.turns.map(turn => turn.kind)).toEqual(['coding', 'advisor']);

			await composer.waitForTypeInEditor('@CodeReview Check concurrent edits');
			await composer.input.press('Enter');
			await expect.poll(async () => (await readBranches()).find(thread => thread.title === '代码审查')?.threadId).toBeTruthy();
			const review = (await readBranches()).find(thread => thread.title === '代码审查')!;
			await expect.poll(async () => {
				const turn = (await read(review.threadId)).thread.turns.at(-1);
				return [turn?.kind, turn?.status];
			}).toEqual(['review', 'completed']);
			await page.locator('.ash-sessions-list:visible').getByText('Ash', { exact: true }).click();
			await expect(chat.getByRole('log')).toContainText('Ash received the project mention.');
		} finally { await connection.close(); }
	});

	test('Bots routes Reviewer, Advisor, Issue and workspace roles to their existing owners', { tag: ['@electron-app-server'] }, async ({ application, target, workbench, testWorkspace }) => {
		const roleDirectory = join(testWorkspace.directory, '.ash', 'agents');
		await mkdir(roleDirectory, { recursive: true });
		await writeFile(join(roleDirectory, 'fixture-agent.md'), '---\nname: fixture-agent\ndescription: Answers fixture questions.\n---\nFixture role instructions.\n');
		const page = await workbench.openAgentsWindow(target.kind);
		const connection = await connectProfile(application, undefined, testWorkspace.directory, page);
		try {
			const { client } = connection;
			const config = await client.request(APP_SERVER_METHODS['config/read'], {});
			const model = { provider: 'custom-bots-fixture', model: 'gpt-6.1-sol' };
			await client.request(APP_SERVER_METHODS['config/update'], {
				commandId: 'bots-fixture-advisor', expectedRevision: config.revision,
				advisor: { model, enabled: true, maxCalls: 3, maxOutputTokens: 2048 },
			});
			const created = await client.request(APP_SERVER_METHODS['session/create'], {
				commandId: 'bots-roles-source', kind: 'code', title: 'Bots fixture source', agent: { type: 'default' },
				executionTarget: { type: 'local', root: testWorkspace.directory },
			});
			const sessionId = created.session.sessionId;
			const threadId = created.session.threads[0]!.threadId;
			const source = { sessionId, threadId };
			const read = () => client.request(APP_SERVER_METHODS['session/thread/read'], source);
			await client.request(APP_SERVER_METHODS['session/request'], {
				sessionId, commandId: 'bots-roles-seed', request: {
					type: 'startTurn', threadId, expectedSequence: (await read()).thread.sequence, model,
					input: [{ type: 'text', text: 'Role fixture seed' }],
				},
			});
			await expect.poll(async () => (await read()).thread.turns.at(-1)?.status).toBe('completed');
			await page.locator('.ash-window-mode-control').getByRole('button', { name: '代码', exact: true }).click();
			await page.locator('.ash-sessions-list-item').filter({ hasText: 'Bots fixture source' }).click();
			const openBots = () => page.locator('.ash-sessions-activity-content').getByRole('button', { name: '机器人', exact: true }).click();
			await openBots();
			const bots = page.locator('.ash-bots-page');
			const sidebar = page.locator('.ash-bots-sidebar');
			const prompt = page.locator('.ash-quick-input-host input:visible');
			const chat = page.locator('.ash-sessions-chat-slot.active:visible');
			const submit = async (message: string) => {
				const composer = new Editor(chat.locator('.ash-chat-input-part'));
				await composer.waitForEditorFocus();
				await composer.waitForTypeInEditor(message);
				await composer.input.press('Enter');
			};

			await bots.getByRole('button', { name: '查找问题', exact: true }).click();
			await prompt.fill('Check concurrent edits');
			await prompt.press('Enter');
			await expect(bots.getByRole('heading', { name: '审查已保存的更改', exact: true })).toBeVisible();
			await expect(bots.getByRole('log')).toContainText('Independent review completed.');
			await expect(bots.getByRole('log')).not.toContainText('Role fixture seed');
			expect((await read()).thread.turns).toHaveLength(1);
			await bots.getByRole('button', { name: '查找问题', exact: true }).click();
			await expect(prompt).toHaveValue('Check concurrent edits');
			await prompt.press('Escape');

			const tree = sidebar.getByRole('tree');
			await tree.press('End');
			await tree.press('ArrowUp');
			await tree.press('ArrowUp');
			await tree.press('ArrowUp');
			await tree.press('Enter');
			await bots.getByRole('button', { name: '咨询顾问', exact: true }).click();
			await prompt.fill('Check the migration plan');
			await prompt.press('Enter');
			await expect(bots.getByRole('region', { name: '顾问咨询记录' })).toContainText('Advisor recommends checking saved drafts.');
			expect((await read()).thread.turns.map(turn => turn.kind)).toEqual(['coding', 'advisor']);

			await sidebar.getByRole('treeitem', { name: '工作区机器人', exact: true }).click();
			await bots.getByRole('button', { name: '选择智能体', exact: true }).click();
			await page.getByRole('option', { name: /fixture-agent/ }).click();
			await expect(bots).toBeHidden();
			await expect(page.getByText('智能体：fixture-agent', { exact: true })).toBeVisible();
			await submit('Prove workspace routing');
			await expect(chat.getByRole('log')).toContainText('Workspace role received the task.');

			await openBots();
			await sidebar.getByRole('treeitem', { name: '议题', exact: true }).click();
			await bots.getByRole('button', { name: '开始处理议题', exact: true }).click();
			await expect(bots).toBeHidden();
			await expect(page.getByText('智能体：issue', { exact: true })).toBeVisible();
			await submit('Prove issue routing');
			// This profile has no GitHub connector or skill. The role must reach its launch gate.
			await expect(page.locator('.ash-notification-host').getByText("CoreOperationFailed: Agent requires unavailable Skill 'github'", { exact: true })).toBeVisible();
		} finally { await connection.close(); }
	});
});

test('Code Review sends and continues a Bots thread with its saved line comparison', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, target, webAppServer, workbench, testWorkspace }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const setup = await connectProfile(application, webAppServer, testWorkspace.directory, page, { directoryGrantsHost: !!webAppServer });
	try {
		if (webAppServer) {
			const grants = await setup.client.request(APP_SERVER_METHODS['config/directoryGrants/list'], {});
			await setup.client.request(APP_SERVER_METHODS['config/directoryGrants/set'], {
				commandId: 'bots-fixture-directory', expectedRevision: grants.revision, path: testWorkspace.directory,
				permissions: ['readFiles', 'writeFiles', 'executeCommands', 'watchFiles', 'browseFiles', 'searchFiles', 'inspectRepository', 'mutateRepository'],
			});
		}
		await setup.client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: 'custom-bots-fixture', apiKey: 'isolated-bots-fixture-key' });
	} finally { await setup.close(); }
	// The browser connection seeds changes in the same directory runtime that the UI reads.
	const connection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
	const { client } = connection;
	try {
		const created = await client.request(APP_SERVER_METHODS['session/create'], {
			commandId: 'bots-fixture-session', kind: 'code', title: 'Code Review source', agent: { type: 'default' },
			executionTarget: { type: 'local', root: testWorkspace.directory },
		});
		const sessionId = created.session.sessionId;
		const threadId = created.session.threads[0]!.threadId;
		const source = { sessionId, threadId };
		const read = () => client.request(APP_SERVER_METHODS['session/thread/read'], source);
		await client.request(APP_SERVER_METHODS['session/request'], {
			sessionId, commandId: 'bots-fixture-source-turn',
			request: {
				type: 'startTurn', threadId, expectedSequence: (await read()).thread.sequence,
				input: [{ type: 'text', text: 'Source-only prompt' }],
				model: { provider: 'custom-bots-fixture', model: 'gpt-6.1-sol' },
				approvalMode: 'bypassPermissions',
			},
		});
		await expect.poll(async () => (await read()).thread.turns.at(-1)?.status).toBe('completed');
		const results = (await read()).thread.turns.at(-1)!.items.filter(item => item.type === 'toolResult');
		expect(results).toEqual([expect.objectContaining({ isError: false })]);
		const changeSets = async () => (await client.request(APP_SERVER_METHODS['turnChanges/list'], source)).changeSets;
		await expect.poll(async () => (await changeSets())[0]?.captureState).toBe('sealed');
		const capture = (await changeSets())[0]!;
		const comparison = await client.request(APP_SERVER_METHODS['turnChanges/read'], { ...source, changeSetId: capture.changeSetId });
		expect(comparison.files.map(file => file.path)).toEqual(['review.ts']);
		const modeControl = page.locator('.ash-window-mode-control');
		const code = modeControl.getByRole('button', { name: 'Code', exact: true });
		await code.click();
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Code Review source' }).click();
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Bots', exact: true }).click();
		const bots = page.locator('.ash-bots-page');
		await bots.getByRole('button', { name: 'Review Changes', exact: true }).click();
		const detail = bots.getByRole('region', { name: 'Comparison', exact: true });
		const multiDiff = detail.locator('.stanza-multi-diff-editor');
		const modifiedLines = detail.locator('.stanza-diff-editor-side.modified .view-line');
		const reviewedLine = modifiedLines.filter({ hasText: reviewedText });
		await expect(detail).toContainText('const answer = 42;');
		await expect(modeControl).toBeHidden();
		await expect(reviewedLine).not.toBeInViewport();
		const lineHeight = await modifiedLines.filter({ hasText: 'const answer = 42;' }).evaluate(element => element.getBoundingClientRect().height);
		await multiDiff.hover();
		await page.mouse.wheel(0, (reviewLine - 6) * lineHeight);
		await expect(reviewedLine).toBeInViewport();
		await detail.locator('.stanza-diff-editor-side.modified .line-numbers').getByText(String(reviewLine), { exact: true }).hover({ force: true });
		await detail.getByRole('button', { name: `Add comment on line ${reviewLine}`, exact: true }).click();
		await detail.getByRole('textbox', { name: 'Comment for the agent' }).fill('Check the order');
		await detail.getByRole('button', { name: 'Save Draft', exact: true }).click();
		await detail.getByRole('button', { name: 'Send to Code Review', exact: true }).click();
		await expect(detail).toBeHidden();
		const transcript = bots.getByRole('log', { name: 'Chat transcript' });
		await expect(transcript).toContainText('Review reply from Code Review');
		await expect(modeControl).toBeHidden();
		const pageBackground = await page.locator('.ash-desktop-editor-area').evaluate(element => getComputedStyle(element).backgroundColor);
		await expect(bots.locator('.ash-chat')).toHaveCSS('background-color', pageBackground);
		await expect(transcript).not.toContainText('Source-only prompt');
		await expect(bots.getByRole('heading', { name: 'Review review.ts' })).toBeVisible();
		const reference = transcript.getByRole('button', { name: `review.ts · Line ${reviewLine}` });
		await reference.click();
		await expect(detail).toContainText('Saved comparison');
		await expect(reviewedLine).toBeInViewport();
		await expect.poll(() => multiDiff.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
		await expect(multiDiff.getByText('Check the order', { exact: true })).toBeInViewport();
		await testInfo.attach('code-review-deep-line', { body: await detail.screenshot(), contentType: 'image/png' });
		await detail.getByRole('button', { name: 'Close Comparison' }).press('Escape');
		await expect(detail).toBeHidden();
		await expect(reference).toBeFocused();
		const composer = new Editor(bots.locator('.ash-chat-input-part'));
		await composer.waitForEditorFocus();
		await composer.waitForTypeInEditor('Explain the next step');
		await composer.input.press('Enter');
		await expect(transcript).toContainText('Follow-up from Code Review');
		const assistant = bots.locator('.ash-chat-item-agentMessage .ash-chat-participant').first();
		const user = bots.locator('.ash-chat-user-message .ash-chat-participant').first();
		await expect(assistant).toHaveText('Code Review');
		await expect(user).toHaveText('You');
		const assistantAvatar = await assistant.locator('.ash-chat-participant-avatar').boundingBox();
		const userAvatar = await user.locator('.ash-chat-participant-avatar').boundingBox();
		expect(assistantAvatar!.x + assistantAvatar!.width).toBeLessThan(userAvatar!.x);
		expect((await read()).thread.turns).toHaveLength(1);
		await testInfo.attach('bots-review', { body: await page.screenshot(), contentType: 'image/png' });
		const sidebar = page.locator('[data-part="sidebar"]');
		await sidebar.getByRole('button', { name: 'Back', exact: true }).press('Enter');
		await expect(bots).toBeHidden();
		await expect(code).toBeVisible();
		await expect(code).toHaveAttribute('aria-pressed', 'true');
	} finally { await connection.close(); }
});
