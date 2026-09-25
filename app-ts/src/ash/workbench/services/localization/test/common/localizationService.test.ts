import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter } from "../../../../../base/common/event.js";
import { InMemoryConfigurationService } from "../../../../../platform/configuration/common/inMemoryConfigurationService.js";
import type { IMarketplaceService } from "../../../../../platform/marketplace/common/marketplaceService.js";
import { MarketplaceLanguagePackService } from "../../../../../platform/languagePacks/browser/marketplaceLanguagePackService.js";
import { builtinLanguagePackCatalogs } from "../../common/localizationCatalogs.js";
import { LocalizationConfiguration, WorkbenchLocaleService, normalizeLocale, resolveLocale } from "../../common/locale.js";
import { WorkbenchLocalizationService } from "../../browser/workbenchLocalizationService.js";
import { resetNlsResolver } from '../../../../../nls.js';
import { commandActionLabel, localizedString } from '../../../../../platform/action/common/action.js';
import { JSDOM } from 'jsdom';
import { QuickInputController } from '../../../../../platform/quickinput/browser/quickInputController.js';
import { JsonSchemasRegistry } from '../../../../../platform/jsonschemas/common/jsonSchemaRegistry.js';
import { colorThemeSchemaId, registerColorThemeSchemas } from '../../../themes/common/colorThemeSchema.js';
import '../../../../common/theme.js';

test("locale resolution prefers exact, base-language, and English fallback matches", () => {
	assert.equal(normalizeLocale("ZH_cn"), "zh-CN");
	assert.equal(resolveLocale("zh-cn", ["en", "zh-CN", "fr"]), "zh-CN");
	assert.equal(resolveLocale("fr-CA", ["en", "fr"]), "fr");
	assert.equal(resolveLocale("de", ["en", "zh-CN"]), "en");
});

test("locale selection is client-local and only accepts installed packs", async () => {
	using configuration = new InMemoryConfigurationService();
	using languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);

	await localeService.whenReady;
	await assert.rejects(localeService.setLocale("fr"), /not installed/);
	await localeService.setLocale("zh_cn");
	assert.equal(localeService.locale, "zh-CN");
	assert.equal(configuration.getValue(LocalizationConfiguration.locale), "zh-CN");
});

test("localization lookup falls back to English and formats parameters", async () => {
	using configuration = new InMemoryConfigurationService();
	const languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);
	using localization = new WorkbenchLocalizationService(localeService, languagePacks);

	await localization.whenReady;
	assert.equal(localization.translate("ash.settings", "displayLanguage.title", "Fallback"), "Display Language");
	assert.equal(localization.translate("ash.missing", "missing", "Hello {name}", { name: "Ada" }), "Hello Ada");
	await localeService.setLocale('zh-CN');
	assert.deepEqual([
		commandActionLabel(localizedString('ash.menu', 'file', 'File')),
		commandActionLabel(localizedString('ash.actions', 'showPanel', 'Show Panel')),
		commandActionLabel(localizedString('ash', 'workbench.openFolder', 'Open Folder...')),
	], ['文件', '显示面板', '打开文件夹...']);
	assert.equal(localization.translate('ash.regions', 'searchCommands', 'Search commands'), '搜索命令');
	assert.equal(localization.translate('ash', 'iPadShowKeyboard.label', 'Show Keyboard'), '显示键盘');
	assert.equal(localization.translate('ash', 'inspectTokens.label', 'Developer: Inspect Tokens'), '开发者：检查词法单元');
	assert.equal(localization.translate('ash', 'inspectTokens.scope', 'Token type'), '词法单元类型');
	assert.equal(localization.translate('ash', 'quickHelp.dialog', 'Quick Access Help'), '快速访问帮助');
	assert.equal(localization.translate('ash', 'quickCommand.placeholder', 'Type > for commands, ? for help, or @ for symbols'), '输入 > 查找命令、? 查看帮助，或 @ 查找符号');
	assert.equal(localization.translate('ash', 'chat.settings.advisorDisable', 'Turn Advisor off'), '关闭顾问');
	assert.equal(localization.translate('ash', 'chat.advisor.configure', 'Configure an advisor model in Chat Settings before asking for a second opinion'), '请先在聊天设置中配置顾问模型，再请求第二意见');
});

test('minimap menu uses the selected Chinese language catalog', async () => {
	using configuration = new InMemoryConfigurationService();
	using languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);
	using localization = new WorkbenchLocalizationService(localeService, languagePacks);
	await localization.whenReady;
	await localeService.setLocale('zh-CN');
	assert.equal(localization.translate('ash', 'context.minimap.enabled', 'Minimap'), '小地图');
});

test('theme color descriptions in the JSON schema follow locale changes', async () => {
	using configuration = new InMemoryConfigurationService();
	using languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);
	using localization = new WorkbenchLocalizationService(localeService, languagePacks);
	using schemaRegistration = registerColorThemeSchemas();
	const schema = JsonSchemasRegistry.getSchema(colorThemeSchemaId)!;
	const description = (id: string): string | undefined => schema.properties?.colors?.properties?.[id]?.description;
	try {
		await localization.whenReady;
		assert.equal(description('input.background'), 'Input background.');
		await localeService.setLocale('zh-CN');
		assert.deepEqual([
			description('input.background'),
			description('minimapSlider.background'),
			description('charts.green'),
			description('editorGroup.border'),
		], [
			'输入框背景色。',
			'小地图视口滑块的背景色。',
			'图表中绿色数据系列的颜色。',
			'编辑器分组之间的边框颜色。',
		]);
		await localeService.setLocale('en');
		assert.equal(description('input.background'), 'Input background.');
	} finally {
		resetNlsResolver();
	}
});

test('paste and drop controls use the selected Chinese language catalog', async () => {
	using configuration = new InMemoryConfigurationService();
	using languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);
	using localization = new WorkbenchLocalizationService(localeService, languagePacks);
	await localization.whenReady;
	await localeService.setLocale('zh-CN');
	assert.deepEqual([
		localization.translate('ash', 'dropOrPaste.pasteAs', 'Paste As...'),
		localization.translate('ash', 'dropOrPaste.selectPasteAction', 'Select Paste Action'),
		localization.translate('ash', 'dropOrPaste.pasteOptions', 'Paste options'),
		localization.translate('ash', 'dropOrPaste.selectorHelp', 'Use arrow keys to choose an edit. Press Escape to return to the editor.'),
		localization.translate('ash', 'dropOrPaste.invalidEdit', 'Could not prepare edit: {0}'),
		localization.translate('ash', 'dropOrPaste.snippetUnavailable', 'Snippet navigation is unavailable in this editor.'),
		localization.translate('ash', 'dropOrPaste.switchFailed', 'Could not change edit: {0}'),
	], [
		'选择性粘贴...',
		'选择粘贴方式',
		'粘贴选项',
		'使用方向键选择编辑方式。按 Escape 返回编辑器。',
		'无法准备编辑：{0}',
		'此编辑器无法使用代码片段占位符导航。',
		'无法切换编辑：{0}',
	]);
});

test('folding command metadata uses the selected Chinese language catalog', async () => {
	using configuration = new InMemoryConfigurationService();
	using languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);
	using localization = new WorkbenchLocalizationService(localeService, languagePacks);
	try {
		await localization.whenReady;
		await localeService.setLocale('zh-CN');
		await import('../../../../../editor/contrib/folding/browser/folding.js');
		const { EditorExtensionsRegistry } = await import('../../../../../editor/browser/editorExtensions.js');
		const actions = [...EditorExtensionsRegistry.getEditorActions()];
		const fold = actions.find(action => action.id === 'editor.fold')!.metadata!;
		const unfold = actions.find(action => action.id === 'editor.unfold')!.metadata!;
		assert.deepEqual([fold.description, unfold.description], [
			{ original: 'Collapse the selected folding ranges.', value: '折叠选定的范围。' },
			{ original: 'Expand the selected folding ranges.', value: '展开选定的折叠范围。' },
		]);
		assert.equal(fold.args![0]!.name, '折叠选项');
		assert.match(fold.args![0]!.description!, /从 0 开始的行号/);
	} finally {
		resetNlsResolver();
	}
});

test('editor action labels use the selected Chinese language catalog', async () => {
	using configuration = new InMemoryConfigurationService();
	using languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);
	using localization = new WorkbenchLocalizationService(localeService, languagePacks);
	try {
		await localization.whenReady;
		await localeService.setLocale('zh-CN');
		await import('../../../../../editor/contrib/tokenization/browser/tokenization.js');
		await import('../../../../../editor/contrib/caretOperations/browser/caretOperations.js');
		await import('../../../../../editor/contrib/insertFinalNewLine/browser/insertFinalNewLine.js');
		const { EditorExtensionsRegistry } = await import('../../../../../editor/browser/editorExtensions.js');
		const actions = [...EditorExtensionsRegistry.getEditorActions()];
		assert.deepEqual([
			actions.find(action => action.id === 'editor.action.forceRetokenize')?.label,
			actions.find(action => action.id === 'editor.action.moveCarretLeftAction')?.label,
			actions.find(action => action.id === 'editor.action.moveCarretRightAction')?.label,
			actions.find(action => action.id === 'editor.action.insertFinalNewLine')?.label,
		], ['开发者：强制重新分词', '将选中文本左移', '将选中文本右移', '插入文件末尾换行符']);
		const { localize } = await import('../../../../../nls.js');
		assert.equal(localize('parameterHints.dialog', 'Parameter hints'), '参数提示');
		assert.equal(localize('chat.providerKeys.manage', 'Manage Model API Keys'), '管理模型 API 密钥');
		assert.equal(localize('chat.providerKeys.inputTitle', 'API key for {0}', 'OpenAI'), 'OpenAI 的 API 密钥');
	} finally {
		resetNlsResolver();
	}
});

test('Quick Input uses Chinese labels from the selected catalog', async () => {
	using configuration = new InMemoryConfigurationService();
	using languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);
	using localization = new WorkbenchLocalizationService(localeService, languagePacks);
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		await localization.whenReady;
		await localeService.setLocale('zh-CN');
		using controller = new QuickInputController(dom.window.document.body);
		using picker = controller.createQuickPick();
		picker.show();
		assert.equal(dom.window.document.querySelector('[role="dialog"]')?.getAttribute('aria-label'), '快速选择');
		assert.equal(dom.window.document.querySelector('[role="listbox"]')?.getAttribute('aria-label'), '快速选择结果');
		picker.items = [];
		assert.equal(dom.window.document.querySelector('.ash-quick-pick-empty')?.textContent, '没有匹配结果');
	} finally {
		resetNlsResolver();
		dom.window.close();
	}
});

test('Go to Offset uses the selected Chinese language catalog', async () => {
	using configuration = new InMemoryConfigurationService();
	using languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);
	using localization = new WorkbenchLocalizationService(localeService, languagePacks);
	try {
		await localization.whenReady;
		await localeService.setLocale('zh-CN');
		const { GotoOffsetAction } = await import('../../../../../editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js');
		assert.equal(new GotoOffsetAction().label, '转到字符偏移量...');
		assert.equal(localization.translate('ash', 'gotoOffset.input', 'Character offset'), '字符偏移量');
	} finally {
		resetNlsResolver();
	}
});

test('Source Control settings use the selected Chinese language catalog', async () => {
	using configuration = new InMemoryConfigurationService();
	using languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);
	using localization = new WorkbenchLocalizationService(localeService, languagePacks);
	try {
		await localization.whenReady;
		await localeService.setLocale('zh-CN');
		const { localize } = await import('../../../../../nls.js');
		assert.deepEqual([
			localize('git.settings.groupDescription', 'Configure Git fetching and Source Control diff decorations.'),
			localize('git.autofetch.title', 'Auto Fetch'),
			localize('git.autofetch.description', 'Periodically fetch updates without changing local branches or files.'),
			localize('git.autofetch.off', 'Off'),
			localize('git.autofetch.default', 'Default remote'),
			localize('git.autofetch.all', 'All remotes'),
		], [
			'配置 Git 自动获取和源代码管理差异标记。',
			'自动获取远端更新',
			'定期获取所有已打开仓库的远端更新，不更改本地分支或文件。',
			'关闭',
			'默认远端',
			'所有远端',
		]);
	} finally {
		resetNlsResolver();
	}
});

function createMarketplace(): IMarketplaceService {
	const changes = new Emitter<void>();
	return {
		onDidChangeInstalled: changes.event,
		cachedBrowse: () => undefined,
		browse: () => Promise.reject(new Error("unused")),
		refreshBrowse: () => Promise.reject(new Error("unused")),
		search: async () => [],
		get: () => Promise.reject(new Error("unused")),
		download: () => Promise.reject(new Error("unused")),
		install: () => Promise.reject(new Error("unused")),
		update: () => Promise.reject(new Error("unused")),
		uninstall: () => Promise.reject(new Error("unused")),
		listInstalled: async () => [],
		acquireCapability: () => Promise.reject(new Error("unused")),
		releaseCapability: async () => {},
		openResource: () => Promise.reject(new Error("unused")),
	};
}
