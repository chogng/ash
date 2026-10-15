import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ISessionsLayoutService, type ISessionsEntry } from '../../../../services/layout/common/sessionsLayoutService.js';
import { ChatGPTWebContribution, chatGPTScrollOptimization } from '../../browser/chatGPTWeb.js';
import { IChatGPTService, chatGPTNavigationContainerId } from '../../browser/chatGPTService.js';
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

	test('open and restore use a normal editor resource and independent sidebar without a BrowserView', async () => {
		using resources = new DisposableStore();
		const entries: { entry: ISessionsEntry; source?: string; }[] = [];
		let initialized = 0;
		const services = resources.add(new InstantiationService(new ServiceCollection(
			[IChatGPTService, { initialize: () => initialized++ } as unknown as IChatGPTService],
			[ISessionsLayoutService, { openEntry: async (entry, _arg, options) => { entries.push({ entry, source: options?.source }); } } as ISessionsLayoutService],
		)));
		resources.add(services.createInstance(ChatGPTWebContribution));
		await services.invokeFunction(CommandsRegistry.getCommand('sessions.show.chatgpt')!, undefined);
		await services.invokeFunction(CommandsRegistry.getCommand('sessions.show.chatgpt')!, 'restore');
		assert.equal(initialized, 2);
		assert.equal(entries.length, 2);
		assert.equal(entries[1]!.source, 'restore');
		for (const { entry } of entries) {
			assert.equal(entry.sidebarContainerId, chatGPTNavigationContainerId);
			assert.equal(entry.content, 'editor');
			assert.equal(entry.showEditorTabs, false);
			assert.equal(entry.editorInput!.resource.scheme, 'ash-chatgpt');
		}
	});
});
