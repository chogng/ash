import { AgentSessionsPicker } from '../../../browser/agentSessions/agentSessionsPicker.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../../test/unit/browser/context.js';
import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test, teardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter } from '../../../../../../base/common/event.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPick } from '../../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { CommandService } from '../../../../../services/commands/common/commandService.js';
import { TestConfigurationService } from '../../../../../services/configuration/test/common/testServices.js';
import { registerChatActions } from '../../../browser/actions/chatActions.js';
import { IChatSessionNavigationService } from '../../../../../services/chat/common/chatSessionNavigationService.js';
import { IAgentSessionsService } from '../../../browser/agentSessions/agentSessionsService.js';
import type { IAgentSession } from '../../../browser/agentSessions/agentSessionsModel.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IViewsService } from '../../../../../services/views/common/viewsService.js';
import type { IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import { SHOW_CHAT_HISTORY_COMMAND_ID } from '../../../common/chat.js';

registerChatActions();

test('Workbench history renders a borrowed host catalog without Session services and releases its subscription', async () => {
	const dom = new JSDOM('<!doctype html><body><button>History</button></body>');
	try {
		using services = new InstantiationService();
		using changes = new Emitter<void>();
		using configuration = new TestConfigurationService();
		using quickInput = new TestQuickInputService({ container: dom.window.document.body, instantiationService: services });
		const opened: string[] = [];
		const entry = (id: string, label: string, providerLabel: string): IAgentSession => ({
			id, label, providerLabel, resource: URI.from({ scheme: 'test-session', path: `/${id}` }),
			description: '', kind: 'session', active: false, target: { sessionId: id, threadId: 'root' },
			isArchived: () => false, isPinned: () => false,
			open: () => { opened.push(id); },
		});
		let items = [entry('host-a', 'Alpha', 'Build A'), entry('host-b', 'Alpha', 'Build B')];
		services.registerInstance(IAgentSessionsService, {
			getSession: resource => items.find(item => item.resource.toString() === resource.toString()),
			model: {
				onDidChangeSessions: changes.event,
				get sessions() { return items; }, state: 'ready', error: undefined,
				getSession: resource => items.find(item => item.resource.toString() === resource.toString()),
			}
		});
		services.registerInstance(IChatSessionNavigationService, {} as IChatSessionNavigationService);
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IQuickInputService, quickInput);
		services.registerInstance(IViewsService, { focusView: async () => true } as unknown as IViewsService);
		services.registerInstance(INotificationService, { error: () => assert.fail('The host operation must succeed') } as unknown as INotificationService);
		const anchor = dom.window.document.querySelector('button')!;
		assert.throws(() => services.createInstance(AgentSessionsPicker, anchor, undefined), /Unknown service: commandService/u);
		using commands = new CommandService(services);
		services.registerInstance(ICommandService, commands);
		const picking = commands.executeCommand(SHOW_CHAT_HISTORY_COMMAND_ID, anchor);
		const picker = quickInput.currentQuickInput as IQuickPick<IQuickPickItem & { id: string; session: IAgentSession; }>;
		assert.equal(picker.anchor, anchor);
		assert.equal(picker.anchorPosition, 'below');
		assert.equal(changes.hasListeners(), true);
		picker.value = 'Alpha';
		const choices = picker.items.filter((item): item is IQuickPickItem & { id: string; session: IAgentSession; } => !('type' in item));
		assert.deepEqual(choices.map(item => [item.label, item.detail]), [['Alpha', 'Build A'], ['Alpha', 'Build B']]);
		picker.activeItems = [choices[1]!];
		items = [items[0]!, entry('host-b', 'Alpha renamed', 'Build B')];
		changes.fire();
		assert.equal(picker.value, 'Alpha');
		assert.equal(picker.activeItems[0]?.label, 'Alpha renamed');
		picker.selectedItems = [picker.activeItems[0]!];
		items[1] = { ...items[1]!, open: () => { opened.push('current host-b'); } };
		await picker.accept();
		await picking;
		assert.deepEqual(opened, ['current host-b']);
		assert.equal(changes.hasListeners(), false);
		assert.equal(dom.window.document.querySelector('.ash-quick-pick'), null);
	} finally {
		dom.window.close();
	}
});


declare global {
	interface Window {
		agentSessionsPickerFixture: {
			readonly actions: string[];
			hideMenu(): void;
			dispose(): void;
		};
	}
}

suite('Agent Sessions picker with shared Quick Input layout', () => {
	const browser = useBrowserTests();
	teardown(async () => { await browser.page.evaluate(() => window.agentSessionsPickerFixture?.dispose()); });

	for (const [locale, theme] of [['en', 0], ['zh-CN', 2]] as const) {
		test(`history descriptions and actions remain readable and return focus (${locale}, theme ${theme})`, async () => {
			const { page } = browser;
			await page.goto(`/agentSessions.html?locale=${locale}&theme=${theme}`);
			const origin = page.getByRole('button', { name: 'Open history', exact: true });
			await origin.click();
			const picker = page.locator('.ash-quick-pick');
			const row = picker.getByRole('option').filter({ hasText: 'Beta conversation' });
			const description = row.locator('.ash-quick-pick-row-description');
			const actions = row.locator('.ash-quick-pick-row-actions');
			await row.hover();
			await expect(description).toBeVisible();
			await expect(row.getByRole('button', { name: locale === 'en' ? 'Pin session' : '置顶整个会话', exact: true })).toHaveCSS('opacity', '1');
			const bounds = await Promise.all([description.boundingBox(), actions.boundingBox()]);
			expect(bounds[0]!.x + bounds[0]!.width).toBeLessThanOrEqual(bounds[1]!.x);
			await expect(row.locator('.ash-quick-pick-row-label')).toHaveCSS('text-overflow', 'ellipsis');
			await row.getByRole('button', { name: locale === 'en' ? 'Pin session' : '置顶整个会话', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.agentSessionsPickerFixture.actions)).toEqual(['pin:Beta']);
			await expect(picker).toBeVisible();
			const more = row.getByRole('button', { name: locale === 'en' ? 'More session actions' : '更多会话操作', exact: true });
			await more.click();
			await expect(more).toHaveAttribute('aria-expanded', 'true');
			await expect(description).toBeVisible();
			await page.evaluate(() => window.agentSessionsPickerFixture.hideMenu());
			const search = picker.getByRole('combobox');
			await expect(search).toBeFocused();
			await search.press('Escape');
			await expect(picker).toHaveCount(0);
			await expect(origin).toBeFocused();
		});
	}
});
