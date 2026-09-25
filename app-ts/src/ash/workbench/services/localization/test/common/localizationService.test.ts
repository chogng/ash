import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter } from "../../../../../base/common/event.js";
import { InMemoryConfigurationService } from "../../../../../platform/configuration/common/inMemoryConfigurationService.js";
import type { IMarketplaceService } from "../../../../../platform/marketplace/common/marketplaceService.js";
import { MarketplaceLanguagePackService } from "../../../../../platform/languagePacks/browser/marketplaceLanguagePackService.js";
import { builtinLanguagePackCatalogs } from "../../common/localizationCatalogs.js";
import { normalizeLocale } from "../../../../../platform/languagePacks/common/languagePackCatalog.js";
import { LocalizationConfiguration } from "../../common/locale.js";
import { WorkbenchLocaleService } from "../../browser/localeService.js";
import { WorkbenchLocalizationService } from "../../browser/workbenchLocalizationService.js";
import { resetNlsResolver } from '../../../../../nls.js';
import { commandActionLabel, localizedString } from '../../../../../platform/action/common/action.js';
import { JSDOM } from 'jsdom';
import { QuickInputController } from '../../../../../platform/quickinput/browser/quickInputController.js';
import { JsonSchemasRegistry } from '../../../../../platform/jsonschemas/common/jsonSchemaRegistry.js';
import { colorThemeSchemaId, registerColorThemeSchemas } from '../../../themes/common/colorThemeSchema.js';
import '../../../../common/theme.js';

test("locale selection resolves installed variants and falls back to English", async () => {
	assert.equal(normalizeLocale("ZH_cn"), "zh-CN");
	using configuration = new InMemoryConfigurationService();
	using languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);
	await localeService.whenReady;
	await localeService.setLocale({ id: 'zh-cn', label: 'Chinese' });
	assert.equal(localeService.locale, 'zh-CN');
	await configuration.updateValue(LocalizationConfiguration.locale, 'de');
	assert.equal(localeService.locale, 'en');
});

test("locale selection stores a configured value and only accepts installed packs", async () => {
	using configuration = new InMemoryConfigurationService();
	using languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);

	await localeService.whenReady;
	await assert.rejects(localeService.setLocale({ id: 'fr', label: 'French' }), /not installed/);
	await localeService.setLocale({ id: 'zh_cn', label: 'Chinese' });
	assert.equal(localeService.locale, "zh-CN");
	assert.equal(configuration.getValue(LocalizationConfiguration.locale), "zh-CN");
	await localeService.clearLocalePreference();
	assert.equal(localeService.locale, 'en');
	assert.equal(configuration.getValue(LocalizationConfiguration.locale), 'en');
	assert.equal(configuration.inspect(LocalizationConfiguration.locale).userValue, undefined);
});

test("localization lookup falls back to English and formats parameters", async () => {
	using configuration = new InMemoryConfigurationService();
	const languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);
	using localization = new WorkbenchLocalizationService(localeService, languagePacks);

	await localization.whenReady;
	assert.equal(localization.translate("ash.settings", "displayLanguage.title", "Fallback"), "Display Language");
	assert.equal(localization.translate("ash.missing", "missing", "Hello {name}", { name: "Ada" }), "Hello Ada");
	await localeService.setLocale({ id: 'zh-CN', label: 'Chinese' });
	assert.deepEqual([
		commandActionLabel(localizedString('ash.menu', 'file', 'File')),
		commandActionLabel(localizedString('ash.actions', 'showPanel', 'Show Panel')),
		commandActionLabel(localizedString('ash.actions', 'openAgentsWindow', 'Open Agents Window')),
		commandActionLabel(localizedString('ash', 'workbench.openFolder', 'Open Folder...')),
		commandActionLabel(localizedString('ash', 'workbench.toggleDeveloperTools', 'Developer: Toggle Developer Tools')),
		commandActionLabel(localizedString('ash', 'workbench.switchWindow', 'Switch Window...')),
		commandActionLabel(localizedString('ash', 'workbench.installShellCommand', 'Install ash Command in PATH')),
	], ['文件', '显示面板', '打开 Agents 窗口', '打开文件夹...', '开发者：切换开发者工具', '切换窗口...', '在 PATH 中安装 ash 命令']);
	assert.equal(localization.translate('ash', 'openAgentsWindow.systemWideFailed', 'Some system-wide shortcuts could not be registered ({0}); they may be used by another application.', { '0': 'Ctrl+A' }), '部分系统级快捷键无法注册（Ctrl+A）；它们可能已被其他应用占用。');
	assert.equal(localization.translate('ash', 'dialog.input', 'Input'), '输入');
	assert.equal(localization.translate('ash', 'collaboration.dialog.tokenMessage', 'Enter the remote collaboration server bearer token.'), '输入远程协作服务器的访问令牌。');
	assert.equal(localization.translate('ash.regions', 'searchCommands', 'Search commands'), '搜索命令');
	assert.equal(localization.translate('ash', 'iPadShowKeyboard.label', 'Show Keyboard'), '显示键盘');
	assert.equal(localization.translate('ash', 'inspectTokens.label', 'Developer: Inspect Tokens'), '开发者：检查词法单元');
	assert.equal(localization.translate('ash', 'inspectTokens.scope', 'Token type'), '词法单元类型');
	assert.equal(localization.translate('ash', 'quickHelp.dialog', 'Quick Access Help'), '快速访问帮助');
	assert.equal(localization.translate('ash', 'quickCommand.placeholder', 'Type > for commands, ? for help, or @ for symbols'), '输入 > 查找命令、? 查看帮助，或 @ 查找符号');
	assert.equal(localization.translate('ash', 'chat.settings.advisorDisable', 'Turn Advisor off'), '关闭顾问');
	assert.equal(localization.translate('ash', 'chat.advisor.configure', 'Configure an advisor model in Chat Settings before asking for a second opinion'), '请先在聊天设置中配置顾问模型，再请求第二意见');
	assert.deepEqual([
		localization.translate('ash', 'editorWelcome.openFolder', 'open folder'),
		localization.translate('ash', 'editorWelcome.cloneRepo', 'clone repo'),
		localization.translate('ash', 'editorWelcome.connectViaSsh', 'connect via ssh'),
		localization.translate('ash', 'editorWelcome.connectGitHub', 'connect github'),
	], ['打开文件夹', '克隆仓库', '通过 SSH 连接', '连接 GitHub']);
	assert.deepEqual([
		localization.translate('ash', 'files.openEditors.title', 'Open Editors'),
		localization.translate('ash', 'files.openEditors.group', 'Group {0}', { '0': 2 }),
		localization.translate('ash', 'files.openEditors.unsaved', 'Unsaved changes'),
		localization.translate('ash', 'files.nesting.enabledTitle', 'File nesting'),
		localization.translate('ash', 'files.findInExplorer', 'Find files in Explorer'),
		localization.translate('ash', 'files.saveConflictTitle', 'File changed on disk'),
		localization.translate('ash', 'files.openBinaryAsText', 'Open as Read-Only Text'),
	], ['打开的编辑器', '第 2 组', '未保存的更改', '文件嵌套', '在资源管理器中查找文件', '磁盘上的文件已更改', '以只读文本打开']);
});

test('minimap menu uses the selected Chinese language catalog', async () => {
	using configuration = new InMemoryConfigurationService();
	using languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);
	using localization = new WorkbenchLocalizationService(localeService, languagePacks);
	await localization.whenReady;
	await localeService.setLocale({ id: 'zh-CN', label: 'Chinese' });
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
		await localeService.setLocale({ id: 'zh-CN', label: 'Chinese' });
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
		await localeService.setLocale({ id: 'en', label: 'English' });
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
	await localeService.setLocale({ id: 'zh-CN', label: 'Chinese' });
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
		await localeService.setLocale({ id: 'zh-CN', label: 'Chinese' });
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
		await localeService.setLocale({ id: 'zh-CN', label: 'Chinese' });
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
		assert.equal(localize('onboarding.stepProgress', 'Step {0} of {1}', 2, 3), '第 2 步，共 3 步');
		assert.equal(localize('onboarding.commandCenter.title', 'Find commands quickly'), '快速查找命令');
		assert.equal(localize('releaseNotes.open', 'Show Release Notes'), '显示版本说明');
		assert.equal(localize({ bundle: 'ash', key: 'workbench.copyPath' }, 'Copy Path'), '复制路径');
		assert.equal(localize({ bundle: 'ash', key: 'workbench.copyRelativePath' }, 'Copy Relative Path'), '复制相对路径');
		assert.equal(localize({ bundle: 'ash', key: 'workbench.newFile' }, 'New File...'), '新建文件...');
		assert.equal(localize({ bundle: 'ash', key: 'workbench.newFileName' }, 'New File Name'), '新建文件名称');
		assert.equal(localize('workbench.explorerDecoratedFile', '{0}, {1}', 'link', localize('workbench.explorerSymbolicLink', 'Symbolic Link')), 'link，符号链接');
		assert.equal(localize({ bundle: 'ash', key: 'workbench.downloadFile' }, 'Download File...'), '下载文件...');
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
		await localeService.setLocale({ id: 'zh-CN', label: 'Chinese' });
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
		await localeService.setLocale({ id: 'zh-CN', label: 'Chinese' });
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
		await localeService.setLocale({ id: 'zh-CN', label: 'Chinese' });
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
