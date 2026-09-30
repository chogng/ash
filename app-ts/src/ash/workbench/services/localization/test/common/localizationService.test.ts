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
	assert.equal(localization.translate('ash', 'sessions.chat.welcome', 'What can we work on?'), '今天想做些什么？');
	assert.deepEqual([
		localization.translate('ash', 'scm.history.actions', 'History actions'),
		localization.translate('ash', 'scm.history.references', 'History references'),
		localization.translate('ash', 'scm.history.remotes', 'Repository remotes'),
	], ['历史记录操作', '历史记录引用', '仓库远端']);
	assert.equal(localization.translate('ash', 'git.completeMerge', 'Complete Merge'), '完成合并');
	assert.equal(localization.translate('ash', 'git.mergeUnresolved', 'Review or resolve every conflict before completing the merge.'), '请先检查或处理所有冲突，再完成合并。');
	assert.equal(localization.translate('ash', 'git.markHandled', 'Mark Handled'), '标记为已处理');
	assert.equal(localization.translate('ash', 'chat.draftHandoffConflict', 'The Agents Window already has an unsent draft in this chat.'), 'Agents 窗口中的这个聊天已有未发送的草稿。');
	assert.deepEqual([
		localization.translate('ash', 'workbench.startupError.title', 'Unable to start Ash'),
		localization.translate('ash', 'workbench.startupError.copy', 'Copy details'),
		localization.translate('ash', 'workbench.startupError.copyFailed', 'Could not copy. Select the details above to copy them manually.'),
	], ['无法启动 Ash', '复制详情', '无法复制。请选中上方详情并手动复制。']);
	assert.deepEqual([
		commandActionLabel(localizedString('ash.menu', 'file', 'File')),
		commandActionLabel(localizedString('ash.actions', 'showPanel', 'Show Panel')),
		commandActionLabel(localizedString('ash.actions', 'openAgentsWindow', 'Open Agents Window')),
		commandActionLabel(localizedString('ash.actions', 'openInAgents', 'Open in Agents')),
		commandActionLabel(localizedString('ash.actions', 'openInAgentsWindow', 'Open in Agents Window')),
		commandActionLabel(localizedString('ash', 'workbench.openFolder', 'Open Folder...')),
		commandActionLabel(localizedString('ash', 'workbench.toggleDeveloperTools', 'Developer: Toggle Developer Tools')),
		commandActionLabel(localizedString('ash', 'workbench.switchWindow', 'Switch Window...')),
		commandActionLabel(localizedString('ash', 'workbench.navigateEditorBack', 'Go Back')),
		commandActionLabel(localizedString('ash', 'workbench.navigateEditorForward', 'Go Forward')),
		commandActionLabel(localizedString('ash', 'workbench.navigateBackInEditLocations', 'Go Back in Edit Locations')),
		commandActionLabel(localizedString('ash', 'workbench.navigateForwardInEditLocations', 'Go Forward in Edit Locations')),
		commandActionLabel(localizedString('ash', 'workbench.navigateBackInNavigationLocations', 'Go Back in Navigation Locations')),
		commandActionLabel(localizedString('ash', 'workbench.navigateForwardInNavigationLocations', 'Go Forward in Navigation Locations')),
		commandActionLabel(localizedString('ash', 'workbench.installShellCommand', 'Install ash Command in PATH')),
	], ['文件', '显示面板', '打开 Agents 窗口', '在 Agents 中打开', '在 Agents 窗口中打开', '打开文件夹...', '开发者：切换开发者工具', '切换窗口...', '后退', '前进', '返回上一编辑位置', '前往下一编辑位置', '返回上一跳转位置', '前往下一跳转位置', '在 PATH 中安装 ash 命令']);
	assert.equal(localization.translate('ash', 'openAgentsWindow.systemWideFailed', 'Some system-wide shortcuts could not be registered ({0}); they may be used by another application.', { '0': 'Ctrl+A' }), '部分系统级快捷键无法注册（Ctrl+A）；它们可能已被其他应用占用。');
	assert.equal(localization.translate('ash', 'sessions.list.search', 'Search sessions'), '搜索会话');
	assert.equal(localization.translate('ash', 'sessions.menu.workbench', 'Return to Workbench'), '返回工作台');
	assert.deepEqual([
		localization.translate('ash', 'sessions.navigation.actions', 'Session window actions'),
		localization.translate('ash', 'sessions.navigation.menu', 'Session menu'),
		localization.translate('ash', 'sessions.navigation.showSidebar', 'Show sidebar'),
		localization.translate('ash', 'sessions.navigation.hideSidebar', 'Hide sidebar'),
		localization.translate('ash', 'sessions.activity.chat', 'Chat'),
		localization.translate('ash', 'sessions.mode.code', 'Code'),
	], ['会话窗口操作', '会话菜单', '显示侧边栏', '隐藏侧边栏', '聊天', '代码']);
	assert.match(localization.translate('ash', 'sessions.activity.help', ''), /代码将打开代码页面并保留聊天草稿/u);
	assert.equal(localization.translate('ash', 'chat.modelPicker.context', '{0} context tokens', { '0': '128,000' }), '上下文：128,000 个词元');
	assert.equal(localization.translate('ash', 'chat.defaultModel.title', 'Default chat model'), '默认聊天模型');
	assert.deepEqual([
		localization.translate('ash', 'chat.modelPicker.auto', 'Auto'),
		localization.translate('ash', 'chat.modelPicker.addModels', 'Add Models'),
		localization.translate('ash', 'chat.modelPicker.contextWindow', '{0} context window', { '0': '200,000' }),
		localization.translate('ash', 'chat.modelPicker.thinkingEffort', 'Thinking Level'),
	], ['自动', '添加模型', '上下文窗口：200,000 个词元', '推理强度']);
	assert.deepEqual([
		localization.translate('ash', 'sessions.activity.chat', 'Chat'),
		localization.translate('ash', 'sessions.activity.colab', 'Collaboration'),
		localization.translate('ash', 'sessions.activity.library', 'Library'),
		localization.translate('ash', 'sessions.activity.mobile', 'Mobile devices'),
		localization.translate('ash', 'sessions.activity.unavailable', '{0} (coming soon)', { '0': '协作' }),
	], ['聊天', '协作', '资料库', '移动设备', '协作（即将推出）']);
	assert.equal(localization.translate('ash', 'sessions.activityBar.location.title', 'Sessions Activity Bar Position'), '活动栏位置');
	assert.equal(localization.translate('ash', 'sessions.activityBar.compact.title', 'Compact Sessions Activity Bar'), '紧凑活动栏');
	assert.equal(localization.translate('ash', 'sessions.header.chatCount', '{0} chats', { '0': 3 }), '3 个聊天');
	assert.equal(localization.translate('ash', 'dialog.input', 'Input'), '输入');
	assert.equal(localization.translate('ash', 'collaboration.dialog.tokenMessage', 'Enter the remote collaboration server bearer token.'), '输入远程协作服务器的访问令牌。');
	assert.equal(localization.translate('ash.regions', 'searchCommands', 'Search commands'), '搜索命令');
	assert.equal(localization.translate('ash.regions', 'titleBarLeftActions', 'Title bar left actions'), '标题栏左侧操作');
	assert.deepEqual([
		localization.translate('ash', 'workbench.activityBarGlobalActions', 'Activity Bar global actions'),
		localization.translate('ash', 'workbench.titleBarGlobalActions', 'Title Bar global actions'),
		localization.translate('ash', 'workbench.activityBarPosition', 'Activity Bar Position'),
		localization.translate('ash', 'workbench.activityBarPositionDefault', 'Default'),
		localization.translate('ash', 'workbench.activityBarPositionTop', 'Top'),
		localization.translate('ash', 'workbench.activityBarPositionBottom', 'Bottom'),
		localization.translate('ash', 'workbench.activityBarPositionHidden', 'Hidden'),
		localization.translate('ash', 'workbench.activityBarSize', 'Activity Bar Size'),
		localization.translate('ash', 'workbench.activityBar.location.description', 'Choose where the Activity Bar appears.'),
		localization.translate('ash', 'workbench.activityBar.compact.title', 'Compact Activity Bar'),
		localization.translate('ash', 'workbench.sideBar.location.title', 'Primary Side Bar Position'),
		localization.translate('ash', 'workbench.movePrimarySideBarRight', 'Move Primary Side Bar Right'),
		localization.translate('ash', 'workbench.hideActivityBarView', "Hide '{0}'", { '0': '资源管理器' }),
		localization.translate('ash', 'workbench.keepActivityBarView', "Keep '{0}'", { '0': '资源管理器' }),
		localization.translate('ash', 'workbench.accounts', 'Accounts'),
		localization.translate('ash', 'workbench.accountWithProvider', '{0} ({1})', { '0': 'Ada', '1': 'GitHub' }),
		localization.translate('ash', 'workbench.signOut', 'Sign Out'),
		localization.translate('ash', 'workbench.signInWithChatGPT', 'Sign in with ChatGPT'),
		localization.translate('ash', 'workbench.signOutAccount', 'Sign out of {0}', { '0': 'Ada' }),
	], ['活动栏全局操作', '标题栏全局操作', '活动栏位置', '默认', '顶部', '底部', '隐藏', '活动栏大小', '选择活动栏的显示位置。', '紧凑活动栏', '主侧栏位置', '将主侧栏移到右侧', '隐藏“资源管理器”', '保留“资源管理器”', '账户', 'Ada（GitHub）', '退出登录', '使用 ChatGPT 登录', '退出 Ada']);
	assert.deepEqual([
		localization.translate('ash', 'workbench.manage', 'Manage'),
		commandActionLabel(localizedString('ash', 'workbench.commandPalette', 'Command Palette...')),
		commandActionLabel(localizedString('ash', 'workbench.manageSettings', 'Settings')),
		commandActionLabel(localizedString('ash', 'workbench.manageExtensions', 'Extensions')),
		commandActionLabel(localizedString('ash', 'workbench.manageKeyboardShortcuts', 'Keyboard Shortcuts')),
		commandActionLabel(localizedString('ash', 'workbench.manageRunTask', 'Run Task...')),
		commandActionLabel(localizedString('ash', 'workbench.manageThemes', 'Themes')),
		commandActionLabel(localizedString('ash', 'update.checkForUpdates', 'Check for Updates...')),
		commandActionLabel(localizedString('ash', 'workbench.selectColorTheme', 'Color Theme')),
		commandActionLabel(localizedString('ash', 'workbench.selectFileIconTheme', 'File Icon Theme')),
		commandActionLabel(localizedString('ash', 'workbench.selectProductIconTheme', 'Product Icon Theme')),
	], ['管理', '命令面板...', '设置', '扩展', '键盘快捷方式', '运行任务...', '主题', '检查更新...', '颜色主题', '文件图标主题', '产品图标主题']);
	assert.equal(localization.translate('ash', 'update.available', 'Ash {0} is available. You are using {1}.', { '0': '0.2.0', '1': '0.1.0' }), 'Ash 0.2.0 已可更新。当前版本为 0.1.0。');
	assert.equal(localization.translate('ash', 'update.ready', 'Ash {0} is ready to install.', { '0': '0.2.0' }), 'Ash 0.2.0 已准备好安装。');
	assert.equal(localization.translate('ash', 'update.install', 'Install and Restart'), '安装并重启');
	assert.equal(localization.translate('ash', 'update.policyTitle', 'Update channel'), '更新通道');
	assert.equal(localization.translate('ash', 'iPadShowKeyboard.label', 'Show Keyboard'), '显示键盘');
	assert.equal(localization.translate('ash', 'inspectTokens.label', 'Developer: Inspect Tokens'), '开发者：检查词法单元');
	assert.equal(localization.translate('ash', 'inspectTokens.scope', 'Token type'), '词法单元类型');
	assert.equal(localization.translate('ash', 'quickHelp.dialog', 'Quick Access Help'), '快速访问帮助');
	assert.equal(localization.translate('ash', 'quickCommand.placeholder', 'Type > for commands, ? for help, or @ for symbols'), '输入 > 查找命令、? 查看帮助，或 @ 查找符号');
	assert.deepEqual([
		localization.translate('ash', 'workbench.editorPinnedTabHint', 'Pinned tab. Press Alt+Enter to unpin.'),
		localization.translate('ash', 'workbench.editorPreviewTabHint', 'Double-click to keep this tab open. Press Alt+Enter to pin this tab.'),
		localization.translate('ash', 'workbench.editorUnpinnedTabHint', 'Press Alt+Enter to pin this tab.'),
	], ['已固定的标签。按 Alt+Enter 可取消固定。', '双击可保留此标签。按 Alt+Enter 可固定此标签。', '按 Alt+Enter 可固定此标签。']);
	assert.deepEqual([
		localization.translate('ash', 'workbench.closeOtherEditors', 'Close Other Editors'),
		localization.translate('ash', 'workbench.pinEditor', 'Pin Editor'),
		localization.translate('ash', 'workbench.unpinEditor', 'Unpin Editor'),
	], ['关闭其他编辑器', '固定编辑器', '取消固定编辑器']);
	assert.deepEqual([
		localization.translate('ash', 'workbench.closeFolder', 'Close Folder'),
		localization.translate('ash', 'workbench.closeWorkspace', 'Close Workspace'),
	], ['关闭文件夹', '关闭工作区']);
	assert.equal(localization.translate('ash', 'chat.settings.advisorDisable', 'Turn Advisor off'), '关闭顾问');
	assert.equal(localization.translate('ash', 'chat.advisor.configure', 'Configure an advisor model in Chat Settings before asking for a second opinion'), '请先在聊天设置中配置顾问模型，再请求第二意见');
	assert.deepEqual([
		localization.translate('ash', 'editorWelcome.openFolder', 'Open folder'),
		localization.translate('ash', 'editorWelcome.cloneRepo', 'Clone repo'),
		localization.translate('ash', 'editorWelcome.connectViaSsh', 'Connect via SSH'),
		localization.translate('ash', 'editorWelcome.connectGitHub', 'Connect GitHub'),
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
	assert.deepEqual([
		localization.translate('ash', 'workbench.editorOpenWarning', 'Warning'),
		localization.translate('ash', 'workbench.editorOpenBinaryMessage', ''),
		localization.translate('ash', 'workbench.editorOpenNotFound', ''),
		localization.translate('ash', 'workbench.editorOpenCreateFile', ''),
		localization.translate('ash', 'workbench.editorOpenTooLarge', '', { '0': '128.0' }),
	], ['警告', '此文件是二进制文件或使用不支持的文本编码，无法显示为文本。', '找不到此文件，无法打开。', '创建文件', '此文件过大，无法作为文本打开（128.0 MiB）。']);
	assert.match(localization.translate('ash', 'accessibility.explorerHelp', 'Explorer'), /Option\+Command\+V/);
	assert.equal(localization.translate('ash', 'accessibility.explorerSystemFilesPasted', 'Files pasted into the selected folder.'), '文件已粘贴到选中的文件夹。');
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
		assert.equal(localize('chat.providerKeys.manage', 'Manage Model Connections'), '管理模型接入');
		assert.equal(localize('chat.input.dictate', 'Dictate message'), '语音输入');
		assert.equal(localize('dictation.cloudProvider.title', 'Cloud dictation provider'), '云端听写供应商');
		assert.equal(localize('dictation.cloudProvider.description', 'Choose the cloud transcription provider. Its API key is required.'), '选择云端语音转写供应商，并配置对应的 API 密钥。');
		assert.equal(localize('chat.agentPicker.mode', 'Agent: {0}', 'reviewer'), '智能体：reviewer');
		assert.equal(localize('chat.agentPicker.default', 'Default Agent'), '默认智能体');
		assert.equal(localize('chat.input.voice', 'Voice conversation'), '语音对话');
		assert.equal(localize('chat.providerKeys.inputTitle', 'API key for {0}', 'OpenAI'), 'OpenAI 的 API 密钥');
		assert.equal(localize('onboarding.stepProgress', 'Step {0} of {1}', 2, 3), '第 2 步，共 3 步');
		assert.equal(localize('settings.workbench.layout.description', 'Configure the Workbench layout and window zoom.'), '配置工作台布局和窗口缩放。');
		assert.equal(localize({ bundle: 'ash.settings', key: 'groups.workbench.label' }, 'Workbench'), '工作台');
		assert.equal(localize({ bundle: 'ash.settings', key: 'categories.layout.label' }, 'Layout'), '布局');
		assert.equal(localize('releaseNotes.open', 'Show Release Notes'), '显示版本说明');
		assert.equal(localize('workspaceTrust.restrictedStatus', 'Restricted workspace'), '受限工作区');
		assert.equal(localize('workspaceTrust.restrictedStatusDetail', 'Some workspace features are limited by directory permissions.'), '目录权限限制了部分工作区功能。');
		assert.equal(localize({ bundle: 'ash', key: 'workbench.copyPath' }, 'Copy Path'), '复制路径');
		assert.equal(localize({ bundle: 'ash', key: 'workbench.copyRelativePath' }, 'Copy Relative Path'), '复制相对路径');
		assert.equal(localize({ bundle: 'ash', key: 'workbench.newFile' }, 'New File...'), '新建文件...');
		assert.equal(localize({ bundle: 'ash', key: 'workbench.newFileName' }, 'New File Name'), '新建文件名称');
		assert.equal(localize({ bundle: 'ash', key: 'files.newFolder' }, 'New Folder...'), '新建文件夹...');
		assert.equal(localize({ bundle: 'ash', key: 'files.deleteConfirm' }, 'Permanently delete {0}?', 'old.ts'), '永久删除 old.ts？');
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
			localize('git.noFolder', 'Open a folder to use Git.'),
			localize('git.noRepository', 'No Git repository found in the open folder.'),
			localize('git.unavailable', 'Git is unavailable for this workspace. Check folder access and retry.'),
			localize('git.keepCurrentDeletion', 'Keep Current Deletion'),
			localize('git.keepIncomingDeletion', 'Keep Incoming Deletion'),
			localize('git.previousConflict', 'Previous Conflict'),
			localize('git.nextConflict', 'Next Conflict'),
			localize('git.nextUnresolvedConflict', 'Next Unresolved'),
			localize('git.acceptCombination', 'Accept Combination'),
			localize('git.showBase', 'Show Base'),
			localize('git.useColumns', 'Use Columns'),
			localize('git.acceptRemainingIncoming', 'Accept Remaining Incoming'),
		], [
			'配置 Git 自动获取和源代码管理差异标记。',
			'自动获取远端更新',
			'定期获取所有已打开仓库的远端更新，不更改本地分支或文件。',
			'关闭',
			'默认远端',
			'所有远端',
			'打开文件夹后即可使用 Git。',
			'打开的文件夹中未找到 Git 仓库。',
			'此工作区暂时无法使用 Git。请检查文件夹访问权限后重试。',
			'保留当前删除结果',
			'保留传入删除结果',
			'上一个冲突',
			'下一个冲突',
			'下一个未解决冲突',
			'采用自动合并结果',
			'显示共同祖先',
			'使用横向三栏',
			'剩余冲突均采用传入版本',
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
