import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { Workbench } from '../../../automation/workbench.js';
import type { PlaywrightApplication } from '../../../automation/playwrightDriver.js';
import { connectTraceAppServer } from './traceFixture.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';

async function resize(page: Page, application: PlaywrightApplication, width: number): Promise<void> {
	if ('windows' in application) {
		const window = await application.browserWindow(page);
		try {
			await window.evaluate((window, width) => window.setSize(width, 800), width);
		} finally {
			await window.dispose();
		}
	} else {
		await page.setViewportSize({ width, height: 800 });
	}
	await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(width);
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
	// Evidence annotation is owned by this test; product controls and assertions remain unchanged.
	await page.evaluate(() => {
		const caption = document.createElement('aside');
		caption.id = 'trace-navigation-evidence-caption';
		caption.textContent = 'REAL APP SERVER SHELL TURN FIXTURE · no paid model · Execution Trace from conversation commands';
		Object.assign(caption.style, {
			position: 'fixed',
			bottom: '8px',
			left: '8px',
			right: '8px',
			padding: '8px',
			background: '#101828',
			color: '#fff',
			zIndex: '2147483647',
			pointerEvents: 'none',
			font: '12px system-ui',
		});
		document.body.append(caption);
	});
	try {
		const path = testInfo.outputPath(name);
		await page.screenshot({ path });
		await testInfo.attach(name, { path, contentType: 'image/png' });
	} finally {
		await page.evaluate(() => document.getElementById('trace-navigation-evidence-caption')?.remove());
	}
}

const offline = {
	formatVersion: 3,
	sessionId: 'navigation-offline-fixture',
	historyPrefixes: [],
	threads: [
		{
			threadId: 'offline-thread',
			events: [
				{
					eventId: 'offline-event',
					sequence: 1,
					recordedAt: 1,
					event: { type: 'threadCreated', threadId: 'offline-thread', title: 'Offline navigation fixture' },
				},
			],
		},
	],
};

test('Workbench commands open Trace without adding an Activity Bar destination', async ({ workbench }) => {
	const page = workbench.page;
	const bar = page.locator('[data-part="activitybar"]');
	const entry = bar.getByRole('tab', { name: 'Trace', exact: true });
	await expect(entry).toHaveCount(0);
	const scripts = new Set<string>();
	const cdp = await page.context().newCDPSession(page);
	cdp.on('Debugger.scriptParsed', ({ url }) => {
		if (/\/(chatDebugEditor|traceEditor|agentTrace)-[^/]+\.js(?:$|\?)/.test(url)) scripts.add(url);
	});
	try {
		// Resource Timing omits Electron file loads. Debugger reports loaded scripts in both hosts,
		// including scripts already parsed before attachment, without reading their contents.
		await cdp.send('Debugger.enable');
		expect([...scripts]).toEqual([]);
		await new QuickAccess(page).runCommand('workbench.action.chat.openAgentDebugPanel');
		await expect(entry).toHaveCount(0);
		const viewer = page.locator('.ash-agent-trace:visible');
		await expect(viewer).toBeVisible();
		await expect.poll(() => [...scripts].some(name => /\/chatDebugEditor-/.test(name))).toBe(true);
		await expect(entry).toHaveCount(0);
		await viewer.locator('input[type=file]').setInputFiles({
			name: 'navigation.trace.json',
			mimeType: 'application/json',
			buffer: Buffer.from(JSON.stringify(offline)),
		});
		await expect(viewer.getByRole('status')).toContainText('Imported');
		await viewer.getByRole('textbox', { name: 'Filter execution events' }).fill('offline-event');
		await bar.getByRole('tab', { name: 'Explorer', exact: true }).click();
		await expect(entry).toHaveCount(0);
		await expect(viewer.getByRole('status')).toContainText('Imported');
		await expect(viewer.getByRole('textbox', { name: 'Filter execution events' })).toHaveValue('offline-event');
		const filter = viewer.getByRole('textbox', { name: 'Filter execution events' });
		await filter.focus();
		await page.keyboard.press('Alt+F1');
		await expect(page.getByRole('dialog', { name: 'Accessibility Help' }).getByRole('textbox')).toHaveValue(/Execution Trace/);
		await page.keyboard.press('Escape');
		await expect(filter).toBeFocused();
	} finally {
		await cdp.detach();
	}
});

test('Sessions commands retain offline Trace inspection without a navigation destination', async ({ application, target, workbench }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	await new QuickAccess(page).runCommand('sessions.trace.import');
	let viewer = page.locator('.ash-agent-trace:visible');
	await expect(viewer).toBeVisible();
	await expect(page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Trace', exact: true })).toHaveCount(0);
	await viewer.locator('input[type=file]').setInputFiles({
		name: 'navigation.trace.json',
		mimeType: 'application/json',
		buffer: Buffer.from(JSON.stringify(offline)),
	});
	await viewer.getByRole('textbox', { name: 'Filter execution events' }).fill('offline-event');
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Chat', exact: true }).click();
	await expect(viewer).toBeHidden();
	await new QuickAccess(page).runCommand('sessions.open.trace');
	await expect(viewer.getByRole('textbox', { name: 'Filter execution events' })).toHaveValue('offline-event');
	await expect(viewer.getByRole('status')).toContainText('Imported');
	page = await workbench.reopenAgentsWindow(application, page);
	viewer = page.locator('.ash-agent-trace:visible');
	await expect(viewer).toBeVisible();
	await expect(page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Trace', exact: true })).toHaveCount(0);
	await expect(viewer.locator('.ash-agent-trace-empty')).toContainText('Open a saved conversation');
});

test(
	'Agent Output and Trace commands preserve reviewed Session and locate exact execution events',
	{ tag: ['@browser-app-server', '@electron-app-server'] },
	async ({ application, target, workbench, testWorkspace }, testInfo) => {
		const workbenchUrl = workbench.page.url();
		let themePage: Page | undefined;
		let page = await workbench.openAgentsWindow(target.kind);
		const connection = await connectTraceAppServer(application, page, testWorkspace.directory);
		const client = connection.client;
		try {
			const create = async (title: string, suffix: string): Promise<{ sessionId: string; threadId: string; turnId: string }> => {
				const created = await client.request(APP_SERVER_METHODS['session/create'], {
					commandId: 'trace-navigation-session-' + suffix,
					title,
					agent: { type: 'default' },
					executionTarget: { type: 'local', root: testWorkspace.directory },
				});
				const sessionId = created.session.sessionId;
				const thread = await client.request(APP_SERVER_METHODS['session/request'], {
					commandId: 'trace-navigation-thread-' + suffix,
					sessionId,
					request: { type: 'createThread', title: 'Navigation ' + suffix },
				});
				if (thread.type !== 'thread') {
					throw new Error('Expected navigation fixture Thread');
				}
				const threadId = thread.value.threadId;
				const before = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId });
				await client.request(APP_SERVER_METHODS['session/request'], {
					commandId: 'trace-navigation-turn-' + suffix,
					sessionId,
					request: {
						type: 'startShellTurn',
						threadId,
						expectedSequence: before.thread.sequence,
						command: 'echo trace-navigation-' + suffix,
						workingDirectory: '.',
						approvalMode: 'bypassPermissions',
					},
				});
				await expect.poll(async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread.turns.at(-1)?.status).toBe('completed');
				return {
					sessionId,
					threadId,
					turnId: (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread.turns.at(-1)!.turnId,
				};
			};
			const first = await create('Trace navigation A', 'a');
			await page.locator('.ash-sessions-list-item').filter({ hasText: 'Trace navigation A' }).click();
			await new QuickAccess(page).runCommand('sessions.trace.showOutput');
			const output = page.locator('[data-part="panel"] [data-view-id="ash.output"]');
			await expect(output).toBeVisible();
			await expect(output).toContainText('Turn completed');
			await expect(page.locator('[data-action-id="ash.output.selectChannel"] button')).toContainText('Trace navigation A');
			await new QuickAccess(page).runCommand('sessions.trace.open');
			let viewer = page.locator('.ash-agent-trace:visible');
			await expect(viewer.locator('.ash-agent-trace-location')).toHaveText(`Located ${first.threadId} / ${first.turnId}.`);
			await expect(page.locator('[data-part="sessions"]')).toBeHidden();
			await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Chat', exact: true }).click();
			const second = await create('Trace navigation B', 'b');
			await page.locator('.ash-sessions-list-item').filter({ hasText: 'Trace navigation B' }).click();
			await new QuickAccess(page).runCommand('sessions.open.trace');
			await expect(viewer.locator('.ash-agent-trace-location')).toHaveText(`Located ${first.threadId} / ${first.turnId}.`);
			await new QuickAccess(page).runCommand('sessions.trace.open');
			await expect(viewer.locator('.ash-agent-trace-location')).toHaveText(`Located ${second.threadId} / ${second.turnId}.`);
			page = await workbench.reopenAgentsWindow(application, page);
			viewer = page.locator('.ash-agent-trace:visible');
			await expect(page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Trace', exact: true })).toHaveCount(0);
			await expect(viewer.locator('.ash-agent-trace-location')).toHaveText(`Located ${second.threadId} / ${second.turnId}.`);
			await expect(viewer.locator('[role=treeitem][aria-selected=true] .ash-agent-trace-event')).toHaveAttribute('data-turn-id', second.turnId);
			await expect(page.locator('[data-part="sessions"]')).toBeHidden();
			await resize(page, application, 1280);
			// Theme selection is contributed by Workbench; its profile preference updates both windows.
			let themeWorkbench = workbench;
			if (target.kind === 'browser') {
				themePage = await page.context().newPage();
				await themePage.goto(workbenchUrl);
				themeWorkbench = new Workbench(themePage);
				await themeWorkbench.waitForReady();
			}
			for (const [theme, width, id] of [
				['Ash Dark', 1280, 'ash-dark'],
				['Ash Light', 900, 'ash-light'],
				['Ash High Contrast Dark', 900, 'ash-high-contrast-dark'],
				['Ash High Contrast Light', 900, 'ash-high-contrast-light'],
			] as const) {
				await themeWorkbench.quickaccess.runCommand('workbench.action.selectTheme');
				const picker = themeWorkbench.page.locator('.ash-quick-pick').getByRole('combobox');
				await picker.fill(theme);
				await picker.press('Enter');
				await expect(themeWorkbench.page.locator('.ash-quick-pick')).toHaveCount(0);
				await expect(page.locator('#app')).toHaveAttribute('data-color-theme', id);
				await resize(page, application, width);
				const entry = page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Trace', exact: true });
				await expect(entry).toHaveCount(0);
				await viewer.getByRole('textbox', { name: 'Filter execution events' }).focus();
				await expect(viewer.getByRole('tree')).toBeVisible();
				await expect(viewer.getByRole('tab', { name: 'Overview', exact: true })).toBeVisible();
				await expect
					.poll(() =>
						viewer.evaluate(element => {
							const bounds = element.getBoundingClientRect();
							return bounds.width > 350 && bounds.left >= 0 && bounds.right <= window.innerWidth + 1;
						}),
					)
					.toBe(true);
				if (theme === 'Ash Dark') {
					await capture(page, testInfo, 'trace-navigation-dark-wide.png');
				}
				if (theme === 'Ash Light') {
					await capture(page, testInfo, 'trace-navigation-light-narrow.png');
				}
			}
		} finally {
			await themePage?.close();
			await connection.close();
		}
	},
);
