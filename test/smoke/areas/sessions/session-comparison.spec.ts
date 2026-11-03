import { createServer, type ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from './sessionProfileFixture.js';

test('Sessions automatically judges a comparison and supports retry and synthesis in the conversation', { tag: ['@electron-app-server'] }, async ({ application, target, workbench, webAppServer, testWorkspace }, testInfo) => {
	test.setTimeout(90_000);
	const definitions = join(testWorkspace.directory, '.ash', 'agents');
	await mkdir(definitions, { recursive: true });
	for (const name of ['comparison-alpha', 'comparison-beta']) {
		await writeFile(join(definitions, `${name}.md`), `---\nname: ${name}\ndescription: Compare a fixture answer\n---\n\nAnswer the user.\n`);
	}
	const heldAttempts: ServerResponse[] = [];
	const heldJudges: ServerResponse[] = [];
	let syntheses = 0;
	let receivedPlan = false;
	let readManifest = false;
	let acceptedVerdict = false;
	const verdict = {
		winner: 2, comparison: 'Both answers considered', validation: 'Fixture verified', quality: 'Clearer explanation', solution: 'Prefer the second answer',
		decisions: [{ topic: 'Error handling', recommended: 2, options: [{ attempt: 1, assessment: 'Detailed' }, { attempt: 2, assessment: 'Concise' }] }],
	};
	const chunk = (delta: object, finishReason: string | null) => `data: ${JSON.stringify({
		id: 'comparison-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finishReason }],
	})}

`;
	const callTool = (response: ServerResponse, name: string, id: string, args: object) => {
		response.end(chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n');
	};
	let retryTool: string | undefined;
	const finish = (response: ServerResponse, content: string): void => {
		response.end(chunk({ content }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
	};
	const server = createServer(async (request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'comparison-model' }] }));
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = Buffer.concat(chunks).toString();
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		response.flushHeaders();
		if (body.includes('Judge the recorded attempts')) {
			const request = JSON.parse(body);
			const toolResult = (id: string) => request.messages.find((message: { role: string; tool_call_id?: string; content: unknown; }) => message.role === 'tool' && message.tool_call_id === id)?.content;
			const submitted = toolResult('comparison-verdict');
			const manifest = toolResult('comparison-manifest');
			if (submitted) {
				acceptedVerdict = JSON.stringify(submitted).includes('Both answers considered');
				finish(response, 'Verdict submitted through the tool.');
			} else if (manifest && retryTool) {
				const evidence = JSON.stringify(manifest);
				readManifest = evidence.includes('First attempt evidence') && evidence.includes('Second attempt evidence') && evidence.includes('verification');
				callTool(response, retryTool, 'comparison-verdict', { verdict_json: JSON.stringify(verdict) });
			} else {
				heldJudges.push(response);
				if (heldJudges.length === 2) {
					const names: string[] = request.tools?.map((tool: { function: { name: string; }; }) => tool.function.name) ?? [];
					retryTool = names.find(name => name.endsWith('complete_attempt_comparison'));
					const readTool = names.find(name => name.endsWith('read_attempt_comparison'));
					if (readTool && retryTool) callTool(response, readTool, 'comparison-manifest', {});
					else finish(response, 'Comparison tools were absent from the request.');
				}
			}
		}
		else if (body.includes('Synthesize a new solution')) {
			syntheses++;
			receivedPlan = body.includes('Follow these explicit user choices') && body.includes('Error handling') && body.includes('Keep the answer concise');
			finish(response, 'Combined fixture answer');
		} else heldAttempts.push(response);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		connection = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
		const { client } = connection;
		const roles = await client.request(APP_SERVER_METHODS['agent/roles/list'], {});
		expect(roles.agents.map(role => role.name)).toEqual(expect.arrayContaining(['comparison-alpha', 'comparison-beta']));
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Comparison model has no port');
		const provider = 'custom-session-comparison-fixture';
		const model = { provider, model: 'comparison-model' };
		const config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['provider/configure'], {
			commandId: 'comparison-provider', expectedRevision: config.revision,
			config: {
				connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
				custom: { name: 'Comparison fixture model', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
				modelContext: { 'comparison-model': { contextWindow: 272_000 } },
			},
		});
		await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'isolated-fixture-key' });
		const configured = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['config/update'], { commandId: 'comparison-default', expectedRevision: configured.revision, model });
		await client.request(APP_SERVER_METHODS['session/create'], {
			commandId: 'comparison-source', title: 'Comparison source', agent: { type: 'default' },
			executionTarget: { type: 'local', root: testWorkspace.directory },
		});

		const page = await workbench.openAgentsWindow(target.kind);
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Comparison source' }).click({ button: 'right' });
		const compare = page.getByRole('menuitem', { name: 'Compare Agents…', exact: true });
		await expect(compare).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath('00-session-menu.png') });
		await compare.click();
		const picker = () => page.locator('.ash-quick-pick:visible');
		const choose = (label: string) => picker().getByText(label, { exact: true }).click({ timeout: 6000 });
		await choose('comparison-alpha');
		await choose('comparison-beta');
		await page.keyboard.press('Enter');
		await choose('Compare answers');
		await choose('comparison-alpha');
		await page.screenshot({ path: testInfo.outputPath('00-participant-settings.png') });
		await choose('Configure participants…');
		await choose('comparison-beta');
		for (let participant = 0; participant < 4; participant++) {
			await choose('Use host default');
			await choose('Use host default');
		}
		const task = page.getByRole('dialog', { name: 'Task for all selected agents' }).getByRole('textbox');
		await task.fill('Compare two fixture answers');
		await task.press('Enter');

		const controls = page.getByRole('region', { name: 'Agent comparison' });
		await expect.poll(() => heldAttempts.length).toBe(2);
		await expect(controls.getByRole('status')).toContainText('Attempts finished: 0 of 2');
		await page.screenshot({ path: testInfo.outputPath('01-attempts-running.png') });
		finish(heldAttempts[0]!, 'First attempt evidence');
		await expect(controls.getByRole('status')).toContainText('Attempts finished: 1 of 2');
		expect(heldJudges).toHaveLength(0);
		finish(heldAttempts[1]!, 'Second attempt evidence');
		await expect.poll(() => heldJudges.length).toBe(1);
		await expect(controls.getByRole('status')).toContainText('Judge is still running');
		await page.screenshot({ path: testInfo.outputPath('02-automatic-judge.png') });
		finish(heldJudges[0]!, 'Unusable verdict');
		const retry = controls.getByRole('button', { name: 'Retry Judge' });
		await expect(retry).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath('03-retry-judge.png') });
		await retry.click();
		await expect.poll(() => heldJudges.length).toBe(2);
		await expect.poll(() => ({ readManifest, acceptedVerdict })).toEqual({ readManifest: true, acceptedVerdict: true });
		await expect(controls.getByRole('status')).toHaveText('Recommended: Attempt 2');
		await controls.getByText('Judge reasoning', { exact: true }).click();
		await page.screenshot({ path: testInfo.outputPath('04-recommendation.png') });
		await expect(controls.getByRole('button', { name: 'Synthesize Recommended' })).toBeVisible();
		await controls.getByText('Custom Synthesis', { exact: true }).click();
		await controls.getByLabel('Error handling').selectOption('1');
		const instructions = controls.getByLabel('Additional synthesis instructions (optional)');
		await instructions.fill('Keep the answer concise');
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Comparison source' }).click();
		await expect(controls).toBeHidden();
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Attempt 1' }).click();
		await controls.getByText('Custom Synthesis', { exact: true }).click();
		await expect(controls.getByLabel('Error handling')).toHaveValue('1');
		await expect(instructions).toHaveValue('Keep the answer concise');
		await page.screenshot({ path: testInfo.outputPath('04b-custom-synthesis.png') });
		await controls.getByRole('button', { name: 'Start Custom Synthesis' }).click();
		await expect.poll(() => syntheses).toBe(1);
		expect(receivedPlan).toBe(true);
		await controls.getByRole('button', { name: 'Open Synthesis' }).click();
		await expect(page.getByText('Combined fixture answer', { exact: true }).last()).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath('05-synthesis-result.png') });
	} finally {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
		await connection?.close();
	}
});
