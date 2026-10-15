import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IBrowserViewService, type IBrowserContentVisibilityRule } from '../../../../../platform/browserView/common/browserView.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { BrowserEditorInput, type IBrowserEditorInputData } from '../../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { ISessionsLayoutService, type ISessionsEntry } from '../../../../services/layout/common/sessionsLayoutService.js';
import { ChatGPTWebContribution, chatGPTBrowserId, chatGPTScrollOptimization } from '../../browser/chatGPTWeb.js';
import '../../browser/chatGPTWeb.contribution.js';
import { localize, setNlsMessages } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { DefaultSettings } from '../../../../../workbench/services/preferences/common/settingsModels.js';

suite('ChatGPT Web entry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('the Workbench Browser settings expose the translated ChatGPT scrolling control', async () => {
		setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
		try {
			assert.equal(localize('sessions.chatgpt.toggleOptimization', 'ChatGPT: Toggle Scrolling Optimization'), 'ChatGPT：切换滚动优化');
			assert.equal(localize('sessions.chatgpt.reloadShort', 'Reload'), '刷新');
			const { createSettingsLayout, SettingsNavigation } = await import('../../../../../workbench/contrib/preferences/browser/settingsLayout.js');
			const defaults = new DefaultSettings();
			const browser = createSettingsLayout([defaults.get(chatGPTScrollOptimization)]).find(category => category.id === 'browser')!;
			assert.equal(browser.descriptor.label, '浏览器');
			assert.equal(browser.groups[0]!.description, '配置此窗口中的 ChatGPT 网页。');
			assert.equal(browser.groups[0]!.settings[0]!.title, 'ChatGPT 滚动优化');
			assert.deepEqual(SettingsNavigation.filter(entry => 'categories' in entry && entry.categories.some(category => category.id === browser.id)).map(entry => entry.id), ['workbench']);
		}
		finally { setNlsMessages('en', {}); }
	});
	test('open and restore commands reuse the page, and the profile switch updates its rendering rule', async () => {
		using resources = new DisposableStore();
		const configuration = resources.add(new InMemoryConfigurationService());
		const changed = resources.add(new Emitter<void>());
		const known = new Map<string, BrowserEditorInput>();
		const windowPages = new Set<string>();
		const entries: { entry: ISessionsEntry; restore: boolean; }[] = [];
		const rules: (IBrowserContentVisibilityRule | undefined)[] = [];
		const creations: string[] = [];
		const refreshed: string[] = [];
		const pages = {
			onDidEvent: Event.None,
			getOrCreateBrowserView: async (id: string, options: { initialUrl: string; session: unknown; }) => {
				creations.push(options.initialUrl);
				return { id, host: { windowId: 1 }, owner: { type: 'user' }, session: options.session, state: { targetId: id, url: options.initialUrl, title: 'ChatGPT', loading: false, canGoBack: false, canGoForward: false, visible: false } };
			},
			getState: async () => ({ targetId: chatGPTBrowserId, url: 'ash-browser-page://chatgpt/browser/chatgpt/chatgpt.html?locale=en#retained', title: 'Retained conversation', loading: false, canGoBack: true, canGoForward: false, visible: false }),
			setContentVisibility: async (id: string, rule: IBrowserContentVisibilityRule | undefined) => { assert.equal(id, chatGPTBrowserId); rules.push(rule); },
			reload: async (id: string) => { refreshed.push(id); },
		} as unknown as IBrowserViewService;
		const services = resources.add(new InstantiationService(new ServiceCollection(
			[IBrowserViewService, pages], [IConfigurationService, configuration],
			[INotificationService, { error: () => { throw new Error('Unexpected rendering error'); } } as unknown as INotificationService],
			[ISessionsLayoutService, { openEntry: async (entry: ISessionsEntry, _initialize: unknown, options?: { source: string; }) => { entries.push({ entry, restore: options?.source === 'restore' }); } } as unknown as ISessionsLayoutService],
		)));
		services.registerInstance(ICommandService, {
			executeCommand: async (id: string) => services.invokeFunction(CommandsRegistry.getCommand(id)!),
		} as unknown as ICommandService);
		services.registerInstance(IBrowserViewWorkbenchService, {
			initialize: async () => { assert.equal(windowPages.has(chatGPTBrowserId), true); },
			getKnownBrowserViews: () => known, onDidChangeBrowserViews: changed.event,
			registerWindowBrowserView: (id: string, presentation: { showControls?: boolean; }) => {
				assert.equal(presentation.showControls, false);
				windowPages.add(id);
				return toDisposable(() => { windowPages.delete(id); });
			},
			getOrCreateLazy: (data: IBrowserEditorInputData) => {
				let input = known.get(data.id);
				if (!input) { input = resources.add(services.createInstance(BrowserEditorInput, data)); known.set(data.id, input); }
				return input;
			},
		} as unknown as IBrowserViewWorkbenchService);
		const contribution = resources.add(services.createInstance(ChatGPTWebContribution));
		assert.deepEqual(creations, []);
		const open = CommandsRegistry.getCommand('sessions.show.chatgpt')!;
		const reload = CommandsRegistry.getCommand('sessions.chatgpt.reload')!;
		await services.invokeFunction(reload);
		await services.invokeFunction(open, 'restore');
		assert.deepEqual(creations, ['ash-browser-page://chatgpt/browser/chatgpt/chatgpt.html?locale=en']);
		assert.equal(entries[0]!.entry.editorInput, entries[1]!.entry.editorInput);
		assert.equal(entries[0]!.entry.content, 'editor');
		assert.equal(entries[0]!.entry.sidebarContainerId, undefined);
		assert.equal(entries[0]!.entry.showEditorTabs, false);
		assert.equal(entries[1]!.restore, true);
		assert.equal(known.get(chatGPTBrowserId)!.model!.state.url, 'ash-browser-page://chatgpt/browser/chatgpt/chatgpt.html?locale=en#retained');
		await services.invokeFunction(reload);
		assert.deepEqual(refreshed, [chatGPTBrowserId]);
		assert.equal(entries.length, 2);
		assert.deepEqual(rules[0], { origin: 'ash-browser-page://chatgpt', selector: '.ash-chatgpt-turn.complete' });
		await configuration.updateValue(chatGPTScrollOptimization, false);
		assert.equal(rules.at(-1), undefined);
		contribution.dispose();
		assert.equal(windowPages.size, 0);
	});
});
