import { IExecutionSettingsService } from '../../../../../platform/execution/common/executionSettingsService.js';
import { IPromptsService } from '../../../chat/common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../../chat/common/promptSyntax/service/promptsServiceImpl.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IAccountService } from '../../../../../platform/accounts/common/accountService.js';
import { IGitHubService } from '../../../../../platform/github/common/githubService.js';
import { IGitHubConnectionService } from '../../../../../workbench/services/accounts/common/gitHubConnectionService.js';
import { GitHubReviewModel, IGitHubReviewModel } from '../../../../../workbench/contrib/github/browser/githubReviewModel.js';
import { KeybindingTestServices } from '../../../../services/keybinding/test/browser/keybindingTestServices.js';
import { createTestLocaleService } from '../../../../services/localization/test/common/localizationTestUtils.js';
import '../../../chat/common/languageModelsConfiguration.js';
import '../../../chat/browser/chat.shared.contribution.js';
import { ILanguageModelsService } from '../../../../contrib/chat/common/languageModels.js';
import type { SettingsContentItem } from '../../browser/settingsTreeModels.js';
import { IFileTextModelService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { IPreferencesService, type ISetting } from '../../../../services/preferences/common/preferences.js';
import type { IRegisteredConfiguration } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { IDictationService } from '../../../../../platform/dictation/common/dictationService.js';
import { ChatSpeechToTextService, IChatSpeechToTextService } from '../../../chat/browser/speechToText/chatSpeechToTextService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { NotificationService } from '../../../../services/notification/common/notificationService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../../services/dialogs/common/dialogService.js';
import { IAppServerSkillApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { IMarketplaceService } from '../../../../../platform/marketplace/common/marketplaceService.js';
import { ILanguageServerService } from '../../../../../platform/language/common/languageServerService.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { createTestFileService, createTestEditorServices } from '../../../../test/common/testEditorServices.js';
import assert from 'node:assert/strict';
import { suiteTeardown, test } from 'mocha';
import { installEditorTestDom } from '../../../../../editor/test/browser/editorTestGlobals.js';
import { JSDOM } from 'jsdom';
import { formatNlsMessage, localize, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { Separator, type IAction } from '../../../../../base/common/actions.js';
import type { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import type { IContextMenuService as ContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import type { ILocalizationService } from '../../../../services/localization/common/localizationService.js';
import type { IGitService } from '../../../git/common/gitService.js';
import type { IChatService } from '../../../../services/chat/common/chatService.js';
import type { IAppServerRemoteAgentService } from '../../../../services/remote/common/appServerRemoteAgentService.js';
import type { RemoteAgentConnection } from '../../../../../platform/remote/common/remoteAgentApi.js';
import type { RemoteConnectionState } from '../../../../../platform/remote/common/remote.js';
import type { IDirPermissionsService } from '../../../../../platform/dirPermissions/common/dirPermissionsService.js';
import type { ILanguagePackService, LanguagePackInfo } from '../../../../../platform/languagePacks/common/languagePacksService.js';
import type { ILocalTranscriptionModelStatus, ILocalTranscriptionService as LocalTranscriptionService, LocalTranscriptionModelState as ModelState } from '../../../../../platform/localTranscription/common/localTranscription.js';

import { DeferredPromise } from '../../../../../base/common/async.js';
import { IHooksService, type HookSource } from '../../../../../platform/hooks/common/hooksService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { IAccessibleViewService, AccessibleViewType } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { URI } from '../../../../../base/common/uri.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const keybindingProfile = new KeybindingTestServices();
suiteTeardown(() => keybindingProfile.dispose());

const browserEnvironment = new JSDOM('<!doctype html><body></body>', {
	pretendToBeVisual: true,
});
Object.defineProperty(browserEnvironment.window.Element.prototype, 'scrollTo', {
	configurable: true,
	value() { },
});
Object.defineProperty(browserEnvironment.window.Element.prototype, 'scrollIntoView', {
	configurable: true,
	value() { },
});
const installedGlobals = installEditorTestDom(browserEnvironment, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent'], {
	navigator: browserEnvironment.window.navigator,
});
suiteTeardown(() => {
	installedGlobals.dispose();
	browserEnvironment.window.close();
});

const { h } = await import('../../../../../base/browser/dom.js');
const { Emitter, Event } = await import('../../../../../base/common/event.js');
const { DisposableStore, toDisposable } = await import('../../../../../base/common/lifecycle.js');
const { ConfigurationRegistry, ConfigurationScope, Extensions: ConfigurationExtensions } = await import('../../../../../platform/configuration/common/configurationRegistry.js');
const { IClipboardService: ClipboardServiceId } = await import('../../../../../platform/clipboard/common/clipboardService.js');
const { IConfigurationService: ConfigurationServiceId } = await import('../../../../../platform/configuration/common/configuration.js');
const { IContextMenuService } = await import('../../../../../platform/contextview/browser/contextView.js');
const { IContextViewService } = await import('../../../../../platform/contextview/browser/contextView.js');
const { BrowserContextViewService } = await import('../../../../../platform/contextview/browser/contextViewService.js');
const { InstantiationService } = await import('../../../../../platform/instantiation/common/instantiationService.js');
const { Registry } = await import('../../../../../platform/registry/common/platform.js');
const { darkColorTheme } = await import('../../../../../platform/theme/common/colorTheme.js');
const { AccessibilityConfiguration } = await import('../../../../../platform/accessibility/common/accessibility.js');
const { HoverConfiguration } = await import('../../../../../platform/hover/common/hoverService.js');
const { SashConfiguration } = await import('../../../sash/common/sash.js');
const { DictationConfiguration } = await import('../../../../../platform/dictation/common/dictationConfiguration.js');
const { WorkbenchConfiguration } = await import('../../../../common/configuration.js');
const { SessionsConfiguration } = await import('../../../../../sessions/common/configuration.js');
const { WorkbenchThemesRegistry } = await import('../../../../common/theme.js');
const { EditorSelectionConfiguration } = await import('../../../../common/editorSelectionConfiguration.js');
const { CodeEditorConfiguration } = await import('../../../codeEditor/common/editorConfiguration.js');
const { EDITOR_FONT_DEFAULTS } = await import('../../../../../editor/common/config/fontInfo.js');
const { ContentSearchConfiguration } = await import('../../../search/common/searchConfiguration.js');
const { GitConfiguration } = await import('../../../git/common/gitConfiguration.js');
await import('../../../scm/browser/scm.contribution.js');
const { IGitService: GitServiceId } = await import('../../../git/common/gitService.js');
const { IChatService: ChatServiceId } = await import('../../../../services/chat/common/chatService.js');
await import('../../../../services/chat/common/modelCatalog.js');
const { IContentSearchConfigurationService } = await import('../../../../../platform/search/common/search.js');
const { INetworkDiagnosticsService } = await import('../../../../../platform/networkDiagnostics/common/networkDiagnosticsService.js');
const { IAgentCapabilitiesService } = await import('../../../../../platform/agentCapabilities/common/agentCapabilitiesService.js');
const { ITraceSettingsService } = await import('../../../../../platform/trace/common/traceSettingsService.js');
const { IFileDialogService } = await import('../../../../../platform/dialogs/common/dialogs.js');
const { IAppServerRemoteAgentService: RemoteAgentServiceId } = await import('../../../../services/remote/common/appServerRemoteAgentService.js');
const { IDirPermissionsService: DirPermissionsServiceId } = await import('../../../../../platform/dirPermissions/common/dirPermissionsService.js');
const configurationRegistry = Registry.as<InstanceType<typeof ConfigurationRegistry>>(ConfigurationExtensions.Configuration);
const { EditorPart } = await import('../../../../browser/parts/editor/editorPart.js');
const { EditorPaneRegistry, EditorPanes } = await import('../../../../browser/editor.js');
const { SettingsSearchQuery } = await import('../../browser/settingsSearch.js');
await import('../../browser/preferencesActions.js');
const { createSettingsLayout, settingsRootNodes, SettingsCategories, SettingsLayout } = await import('../../browser/settingsLayout.js');
const { TOCTreeModel } = await import('../../browser/tocTree.js');
const { SettingsEditorId } = await import('../../browser/settingsEditor.js');
const { ILocalTranscriptionService, LocalTranscriptionModelState } = await import('../../../../../platform/localTranscription/common/localTranscription.js');
const { NullLocalTranscriptionService } = await import('../../../../services/localTranscription/browser/localTranscriptionService.js');
const { ModelSettingsContent } = await import('../../../chat/browser/modelSettingsContent.js');
const { LocalTranscriptionModelControls } = await import('../../../localTranscription/browser/localTranscriptionModelControls.js');
const { SettingsTree } = await import('../../browser/settingsTree.js');
const { SettingsTreeModel } = await import('../../browser/settingsTreeModels.js');
const { PreferencesService } = await import('../../../../services/preferences/browser/preferencesService.js');
const { BrowserEditorService } = await import('../../../../services/editor/browser/browserEditorService.js');
const { ILocalizationService: LocalizationServiceId } = await import('../../../../services/localization/common/localizationService.js');
const { createSettingWidget: instantiateSettingWidget } = await import('../../browser/settingsWidgets.js');
const { DefaultSettings, SettingsEditorModel } = await import('../../../../services/preferences/common/settingsModels.js');
const { WorkbenchConfigurationService } = await import('../../../../services/configuration/browser/configurationService.js');
const { builtinLanguagePackCatalogs } = await import('../../../../services/localization/common/localizationCatalogs.js');
const { ILanguagePackService: LanguagePackServiceId } = await import('../../../../../platform/languagePacks/common/languagePacksService.js');
const { ILocaleService, LocalizationConfiguration } = await import('../../../../services/localization/common/locale.js');
const { WorkbenchLocaleService } = await import('../../../../services/localization/browser/localeService.js');
const { WorkbenchLocalizationService } = await import('../../../../services/localization/browser/workbenchLocalizationService.js');
const { StartupEditorConfigurationKey } = await import('../../../welcomeGettingStarted/browser/startupPage.js');
await import('../../../welcomeGettingStarted/browser/gettingStarted.contribution.js');
await import('../../../../browser/workbench.contribution.js');
await import('../../../../electron-browser/desktop.contribution.js');
await import('../../../externalUriOpener/common/externalUriOpener.contribution.js');

const localizationService: ILocalizationService = {
	whenReady: Promise.resolve(),
	translate: (_bundle, _key, fallback) => fallback,
};

test('Sandbox diagnostics render Chinese readiness and preserve backend reasons as text', async () => {
	const { AgentCapabilitiesSettings } = await import('../../browser/agentCapabilitiesSettings.js');
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	const root = h(browserEnvironment.window.document, 'div');
	using panel = new AgentCapabilitiesSettings(root, {
		isAvailable: true,
		read: async () => ({
			toolSets: [], tools: [], localProcessSandboxConfigured: true, sandboxBackends: ['mxc'], directoryGrantsReadable: false,
			sandboxDiagnostics: [{ backend: 'mxc', network: 'managed', readiness: { type: 'unsupported', reason: '<script>diagnostic</script>' } }]
		}),
	}, { onDidChangeConnectionState: Event.None } as IAppServerRemoteAgentService,
		{ onDidChangePermissions: Event.None } as IDirPermissionsService, {
		whenReady: Promise.resolve(), translate: (bundle, key, fallback) => chinese.bundles[bundle]?.[key] ?? fallback,
	});
	panel.setView('sandbox');
	await nextTurn();
	assert.match(root.textContent ?? '', /mxc · 受管网络 · 不支持此策略: <script>diagnostic<\/script>/);
	assert.match(root.textContent ?? '', /只读进程准备检查/);
	assert.equal(root.querySelector('script'), null);
});

test('DefaultSettings projects only Configuration Registry metadata', () => {
	const registry = new ConfigurationRegistry();
	const visible = registry.registerConfiguration({
		key: 'editor.test.enabled',
		defaultValue: true,
		parse: value => {
			if (typeof value !== 'boolean') throw new TypeError('Expected a boolean');
			return value;
		},
		setting: {
			valueType: 'boolean',
			title: 'Test setting',
			description: 'A registered test setting.',
		},
	});
	registry.registerConfiguration({
		key: 'internal.test.state',
		defaultValue: 'hidden',
		parse: value => String(value),
	});
	registry.registerConfiguration({
		key: 'editor.test.patterns',
		defaultValue: { '*.source': '${capture}.output' },
		parse: value => value as Record<string, string>,
		setting: {
			valueType: 'stringMap',
			title: 'Test patterns',
			description: 'Maps parent patterns to child patterns.',
			keyLabel: 'Parent',
			valueLabel: 'Children',
			addLabel: 'Add',
			removeLabel: 'Remove',
			incompleteMessage: 'Complete both fields.',
			duplicateMessage: 'Duplicate parent.',
		},
	});

	const defaults = new DefaultSettings(registry);
	assert.deepEqual(defaults.all.map(setting => setting.id), ['editor.test.enabled', 'editor.test.patterns']);
	assert.equal(defaults.get(visible).valueType, 'boolean');
	assert.equal(defaults.get('editor.test.patterns').valueType, 'stringMap');
});

test('URL rule suggestions follow extension registration without changing saved IDs', async () => {
	using resources = new DisposableStore();
	const { updateContributedOpeners } = await import('../../../externalUriOpener/common/configuration.js');
	const configuration = resources.add(new WorkbenchConfigurationService());
	await configuration.updateValue('workbench.externalUriOpeners', { '*': 'extension:test:viewer' });
	const root = h(browserEnvironment.window.document, 'div');
	browserEnvironment.window.document.body.replaceChildren(root);
	resources.add(toDisposable(() => { updateContributedOpeners([], []); root.remove(); }));
	const contextView = resources.add(new BrowserContextViewService(root));
	const widget = resources.add(createSettingWidget(resources, root, new DefaultSettings().get('workbench.externalUriOpeners'), {
		configurationService: configuration,
		contextViewProvider: contextView,
		clipboardService: {
			readText: async () => '', writeText: async () => { },
			triggerPaste: () => undefined,
			read: async () => [],
			readFindText: async () => '',
			writeFindText: async () => { },
			readImage: async () => new Uint8Array(),
			readResources: async () => ({ resources: [], operation: 'copy' }),
			writeResources: async () => { }, hasResources: async () => false,
		},
		contextMenuProvider: { showContextMenu() { } },
		onStatus: () => { },
	}));
	root.append(widget.domNode);
	const opener = widget.domNode.querySelector<HTMLInputElement>('[data-pattern-part="value"]')!;
	opener.focus();
	assert.equal(root.querySelectorAll('[role="option"]').length, 0);
	updateContributedOpeners(['extension:test:viewer'], ['Test website viewer']);
	opener.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.equal(root.querySelector('[role="option"]')?.textContent, 'extension:test:viewerTest website viewer');
	opener.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }));
	assert.equal(root.querySelector('[role="option"]')?.getAttribute('aria-selected'), 'true');
	updateContributedOpeners([], []);
	opener.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.equal(opener.getAttribute('aria-expanded'), 'false');
	assert.equal(opener.value, 'extension:test:viewer');
	assert.deepEqual(configuration.getValue('workbench.externalUriOpeners'), { '*': 'extension:test:viewer' });
});

test('Configured markers follow explicit local user overrides and expose one accessible row description', async () => {
	using resources = new DisposableStore();
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: 'status.flag', defaultValue: true, parse: value => value as boolean, scope: ConfigurationScope.LANGUAGE_OVERRIDABLE, setting: { valueType: 'boolean', title: 'Flag', description: '' } });
	registry.registerConfiguration({ key: 'status.object', defaultValue: {}, parse: value => value as Record<string, unknown>, setting: { valueType: 'stringMap', title: 'Object', description: '', structuredValues: true, keyLabel: 'Key', valueLabel: 'Value', addLabel: 'Add', removeLabel: 'Remove', incompleteMessage: 'Incomplete', duplicateMessage: 'Duplicate' } });
	const configuration = resources.add(new WorkbenchConfigurationService({ registry }));
	const root = h(browserEnvironment.window.document, 'div');
	browserEnvironment.window.document.body.replaceChildren(root);
	resources.add(toDisposable(() => root.remove()));
	const contextView = resources.add(new BrowserContextViewService(root));
	const widgets = new DefaultSettings(registry).all.map(setting => {
		const widget = resources.add(createSettingWidget(resources, root, setting, {
			configurationService: configuration, contextViewProvider: contextView, contextMenuProvider: { showContextMenu() { } },
			clipboardService: {
				triggerPaste: () => undefined,
				read: async () => [],
				readText: async () => '', writeText: async () => { }, readFindText: async () => '',
				writeFindText: async () => { },
				readImage: async () => new Uint8Array(), readResources: async () => ({ resources: [], operation: 'copy' }), writeResources: async () => { }, hasResources: async () => false
			},
			onStatus: () => { },
		}));
		root.append(widget.domNode);
		return widget;
	});
	const assertStatus = (configured: boolean): void => {
		for (const widget of widgets) {
			const indicator = widget.domNode.querySelector<HTMLElement>('.ash-settings-configured-description')!;
			const marker = widget.domNode.querySelector<HTMLElement>('.ash-settings-configured-marker')!;
			assert.equal(widget.domNode.classList.contains('is-configured'), configured);
			assert.equal(marker.hidden, !configured);
			assert.equal(marker.getAttribute('aria-hidden'), 'true');
			assert.equal(marker.hasAttribute('tabindex'), false);
			assert.equal(widget.domNode.getAttribute('role'), 'group');
			assert.equal(widget.domNode.getAttribute('aria-describedby'), configured ? indicator.id : null);
			assert.equal(indicator.textContent, 'Configured in local user settings.');
			assert.equal(indicator.hidden, !configured);
			assert.equal(widget.domNode.querySelector('input')?.hasAttribute('aria-describedby') ?? false, false, 'controls do not repeat the row status');
		}
	};
	assertStatus(false);
	await configuration.write('{ "status.flag": true, "status.object": {} }', 0);
	assertStatus(true);
	assert.notEqual(widgets[0]!.domNode.getAttribute('aria-describedby'), widgets[1]!.domNode.getAttribute('aria-describedby'));
	await configuration.write('{ "[typescript]": { "status.flag": false } }', 1);
	assertStatus(false);
});

test('Copy Setting as JSON reads the latest local user values and preserves falsy and structured values', async () => {
	using resources = new DisposableStore();
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({
		key: 'copy.boolean', defaultValue: true, parse: value => value as boolean, scope: ConfigurationScope.LANGUAGE_OVERRIDABLE,
		setting: { valueType: 'boolean', title: 'Boolean', description: '' },
	});
	registry.registerConfiguration({
		key: 'copy.number', defaultValue: 1, parse: value => value as number,
		setting: { valueType: 'number', title: 'Number', description: '', minimum: 0, maximum: 10 },
	});
	registry.registerConfiguration({
		key: 'copy.text', defaultValue: 'Default', parse: value => value as string,
		setting: { valueType: 'text', title: 'Text', description: '', placeholder: '' },
	});
	registry.registerConfiguration({
		key: 'copy.structured', defaultValue: {}, parse: value => value as Record<string, unknown>,
		setting: { valueType: 'stringMap', title: 'Object', description: '', structuredValues: true, keyLabel: 'Key', valueLabel: 'Value', addLabel: 'Add', removeLabel: 'Remove', incompleteMessage: 'Incomplete', duplicateMessage: 'Duplicate' },
	});
	const configuration = resources.add(new WorkbenchConfigurationService({ registry }));
	const root = h(browserEnvironment.window.document, 'div');
	browserEnvironment.window.document.body.replaceChildren(root);
	resources.add(toDisposable(() => root.remove()));
	const contextView = resources.add(new BrowserContextViewService(root));
	let actions: readonly IAction[] = [];
	const copied: string[] = [];
	const errors: string[] = [];
	const widgets = new Map<string, import('../../browser/settingsWidgets.js').SettingWidget>();
	for (const setting of new DefaultSettings(registry).all) {
		const widget = resources.add(createSettingWidget(resources, root, setting, {
			configurationService: configuration, contextViewProvider: contextView,
			contextMenuProvider: { showContextMenu: delegate => { actions = delegate.getActions(); delegate.onHide?.(false); } },
			clipboardService: {
				triggerPaste: () => undefined,
				read: async () => [],
				readText: async () => '', writeText: async value => { copied.push(value); }, readFindText: async () => '',
				writeFindText: async () => { },
				readImage: async () => new Uint8Array(),
				readResources: async () => ({ resources: [], operation: 'copy' }), writeResources: async () => { }, hasResources: async () => false,
			},
			onStatus: (message, isError) => { if (isError) errors.push(message); },
		}));
		root.append(widget.domNode);
		widgets.set(setting.id, widget);
	}
	const copy = async (key: string): Promise<void> => {
		widgets.get(key)!.domNode.querySelector<HTMLButtonElement>('.ash-setting-item-actions-trigger')!.click();
		await actions.find(action => action.id === 'settings.copySettingAsJSON')!.run();
	};
	await copy('copy.boolean');
	// A menu can stay open while another window saves a new value.
	await configuration.write('{ "copy.boolean": false, "copy.number": 0, "copy.text": "", "[typescript]": { "copy.boolean": true } }', 0);
	await actions.find(action => action.id === 'settings.copySettingAsJSON')!.run();
	await copy('copy.number');
	await copy('copy.text');
	await copy('copy.structured');
	const structured = { 'quoted"key': ['back\\slash', 'line\nbreak', '中文', false, 0, null], nested: { empty: '' } };
	await configuration.updateValue('copy.structured', structured);
	await copy('copy.structured');
	await configuration.updateValue('copy.text', 'quote" and back\\slash\n中文');
	await copy('copy.text');
	assert.deepEqual(copied.map(fragment => JSON.parse(`{${fragment}}`)), [
		{ 'copy.boolean': true }, { 'copy.boolean': false }, { 'copy.number': 0 }, { 'copy.text': '' },
		{ 'copy.structured': {} }, { 'copy.structured': structured }, { 'copy.text': 'quote" and back\\slash\n中文' },
	]);
	assert.equal(copied[5], `"copy.structured": ${JSON.stringify(structured, null, 2)}`);
	assert.deepEqual(errors, []);
});

test('Copy Setting as JSON uses the current window default and reports clipboard failures in Chinese', async () => {
	using resources = new DisposableStore();
	const { ConfigurationService } = await import('../../../../../sessions/services/configuration/browser/configurationService.js');
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({
		key: 'copy.window', defaultValue: true, parse: value => value as boolean, agentsWindow: { default: false },
		setting: { valueType: 'boolean', title: 'Window default', description: '' },
	});
	const configuration = resources.add(new ConfigurationService({ registry }));
	const root = h(browserEnvironment.window.document, 'div');
	browserEnvironment.window.document.body.replaceChildren(root);
	resources.add(toDisposable(() => root.remove()));
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	resources.add(toDisposable(resetNlsResolver));
	const contextView = resources.add(new BrowserContextViewService(root));
	let actions: readonly IAction[] = [];
	let copied = '';
	let fail = false;
	const reported = new DeferredPromise<{ message: string; isError: boolean; }>();
	const widget = resources.add(createSettingWidget(resources, root, new DefaultSettings(registry).get('copy.window'), {
		configurationService: configuration, contextViewProvider: contextView,
		contextMenuProvider: { showContextMenu: delegate => { actions = delegate.getActions(); delegate.onHide?.(false); } },
		clipboardService: {
			triggerPaste: () => undefined,
			read: async () => [],
			readText: async () => '', writeText: async value => { if (fail) throw undefined; copied = value; }, readFindText: async () => '',
			writeFindText: async () => { },
			readImage: async () => new Uint8Array(),
			readResources: async () => ({ resources: [], operation: 'copy' }), writeResources: async () => { }, hasResources: async () => false,
		},
		onStatus: (message, isError) => { void reported.complete({ message, isError }); },
	}));
	root.append(widget.domNode);
	widget.domNode.querySelector<HTMLButtonElement>('.ash-setting-item-actions-trigger')!.click();
	const action = actions.find(action => action.id === 'settings.copySettingAsJSON')!;
	assert.equal(action.label, '复制设置为 JSON');
	await action.run();
	assert.equal(copied, '"copy.window": false');
	fail = true;
	await action.run();
	assert.deepEqual(await reported.p, { message: '无法执行设置操作。', isError: true });
	assert.equal((await configuration.read()).source, '{}\n');
	assert.equal(widget.domNode.querySelector<HTMLElement>('.ash-settings-configured-marker')!.hidden, true, 'the Sessions default does not count as a user override');
	await configuration.updateValue('copy.window', false);
	assert.equal(widget.domNode.querySelector('.ash-settings-configured-description')!.textContent, '已在本地用户设置中配置。');
	await configuration.updateValue('copy.window', undefined);
	assert.equal(widget.domNode.querySelector<HTMLElement>('.ash-settings-configured-marker')!.hidden, true);
});

test('Chinese setting actions, search filters and pending saves expose translated labels', async () => {
	using resources = new DisposableStore();
	const { SettingsSearchWidget } = await import('../../browser/settingsWidgets.js');
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	resources.add(toDisposable(resetNlsResolver));
	const root = h(browserEnvironment.window.document, 'div');
	browserEnvironment.window.document.body.replaceChildren(root);
	resources.add(toDisposable(() => root.remove()));
	const configuration = resources.add(new WorkbenchConfigurationService());
	const contextView = resources.add(new BrowserContextViewService(root));
	let actions: readonly IAction[] = [];
	const contextMenuProvider = {
		showContextMenu: (delegate: import('../../../../../base/browser/contextmenu.js').IContextMenuDelegate) => {
			actions = delegate.getActions();
			delegate.onHide?.(false);
		},
	};
	const pending = new DeferredPromise<void>();
	let current = 1;
	let status = '';
	const registered = configurationRegistry.getConfiguration('editor.fontSize') as IRegisteredConfiguration<number> | undefined;
	assert.ok(registered);
	const widget = resources.add(createSettingWidget(resources, root, {
		id: registered.key, title: '字号', description: '', valueType: 'number', configuration: registered, minimum: 1, maximum: 10,
		binding: {
			id: registered.key, defaultValue: 1, getValue: () => current,
			updateValue: async value => { await pending.p; current = value; },
			resetValue: async () => { current = 1; },
		},
	}, {
		configurationService: configuration, contextViewProvider: contextView, contextMenuProvider,
		clipboardService: {
			triggerPaste: () => undefined,
			read: async () => [],
			readText: async () => '', writeText: async () => { }, readFindText: async () => '',
			writeFindText: async () => { },
			readImage: async () => new Uint8Array(),
			readResources: async () => ({ resources: [], operation: 'copy' }),
			writeResources: async () => { }, hasResources: async () => false,
		},
		onStatus: message => { status = message; },
	}));
	root.append(widget.domNode);
	assert.equal(widget.domNode.querySelector<HTMLElement>('.ash-settings-configured-marker')!.hidden, true, 'domain bindings do not expose local user configuration markers');
	const more = widget.domNode.querySelector<HTMLButtonElement>('.ash-setting-item-actions-trigger')!;
	assert.equal(more.getAttribute('aria-label'), '字号 的更多操作');
	more.click();
	assert.deepEqual(actions.map(action => [action.label, action.enabled]), [['重置设置', false], ['复制设置 ID', true]]);
	const input = widget.domNode.querySelector<HTMLInputElement>('input')!;
	input.value = '2';
	input.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
	const indicator = widget.domNode.querySelector<HTMLElement>('.ash-settings-indicators')!;
	assert.deepEqual([indicator.hidden, indicator.textContent, indicator.getAttribute('aria-label'), input.disabled], [false, '正在保存…', '正在保存设置', true]);
	await pending.complete();
	await nextTurn();
	assert.deepEqual([indicator.hidden, indicator.textContent, indicator.getAttribute('aria-label'), input.disabled], [true, '', '', false]);
	assert.equal(widget.domNode.classList.contains('is-configured'), false);
	more.click();
	await actions.find(action => action.id === 'settings.resetSetting')!.run();
	assert.equal(input.value, '1');
	input.value = '11';
	input.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
	assert.equal(status, '字号 必须介于 1 和 10 之间。');

	const search = resources.add(new SettingsSearchWidget(root, { ariaControls: 'settings-results', contextMenuProvider, localizationService }));
	const filter = search.domNode.querySelector<HTMLButtonElement>('.ash-settings-search-filter')!;
	assert.equal(filter.getAttribute('aria-label'), '筛选设置');
	search.value = '@id:editor.fontSize';
	filter.click();
	assert.deepEqual(actions.filter(action => action.id !== Separator.ID).map(action => action.label), ['已修改', '设置 ID…', '清除筛选条件']);
	search.value = 'font @MODIFIED @id:editor.fontSize';
	filter.click();
	await actions.find(action => action.id === 'settings.search.modified')!.run();
	assert.equal(search.value, 'font @id:editor.fontSize @modified');
	assert.equal(browserEnvironment.window.document.activeElement, search.domNode.querySelector('input'));
	await actions.find(action => action.id === 'settings.search.clearFilters')!.run();
	assert.equal(search.value, 'font');
});

test('Activity Bar badges expose a translated profile setting with strict boolean validation', () => {
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		const defaults = new DefaultSettings();
		const setting = defaults.get(WorkbenchConfiguration.activityBarBadges);
		assert.equal(setting.title, '活动栏徽章');
		assert.equal(setting.description, '在活动栏图标上显示徽章。关闭后会保留每个图标的“显示徽章”或“隐藏徽章”选择。');
		assert.equal(setting.valueType, 'boolean');
		assert.equal(findSettingCategory(createSettingsLayout(defaults.all), setting.id), 'layout');
		const definition = configurationRegistry.getConfiguration(setting.id)!;
		assert.equal(definition.defaultValue, true);
		assert.equal(definition.scope, ConfigurationScope.APPLICATION);
		assert.deepEqual(definition.schema, { type: 'boolean' });
		assert.equal(definition.parse(false), false);
		assert.equal(definition.serialize(false), false);
		assert.throws(() => definition.parse('false'), /活动栏徽章必须为 true 或 false/);
	} finally {
		resetNlsResolver();
	}
});

test('empty-editor tips expose translated settings metadata', () => {
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		const defaults = new DefaultSettings();
		const tips = defaults.get('workbench.tips.enabled');
		assert.equal(tips.title, '空编辑器提示');
		assert.equal(tips.description, '没有打开编辑器时显示命令快捷键提示。');
	} finally {
		resetNlsResolver();
	}
});

test('file opening preferences have a translated group and correctly typed controls', () => {
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		const defaults = new DefaultSettings();
		const group = createSettingsLayout(defaults.all).find(category => category.id === 'editor-opening')?.groups.find(group => group.id === 'file-opening');
		assert.equal(group?.title, '文件打开');
		assert.deepEqual(group?.settings.map(setting => ({ id: setting.id, title: setting.title, valueType: setting.valueType })), [
			{ id: 'workbench.editor.openErrorDialog', title: '文件打开错误弹窗', valueType: 'boolean' },
			{ id: 'workbench.editor.defaultBinaryEditor', title: '默认二进制编辑器', valueType: 'select' },
			{ id: 'workbench.editorLargeFileConfirmation', title: '大文件打开确认（MiB）', valueType: 'number' },
		]);
		const binary = defaults.get('workbench.editor.defaultBinaryEditor');
		assert.equal(binary.valueType === 'select' && binary.options[0]?.label, '默认');
		assert.match(defaults.get('workbench.editor.openErrorDialog').description, /自动恢复文件时不显示错误弹窗/);
		assert.throws(() => configurationRegistry.getConfiguration('workbench.editor.openErrorDialog')?.parse('false'), /文件打开错误弹窗必须为 true 或 false/);
	} finally {
		resetNlsResolver();
	}
});

test('font preferences show translated labels and the actual platform defaults', () => {
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		const defaults = new DefaultSettings();
		const fonts = createSettingsLayout(defaults.all).find(category => category.id === 'editor-fonts')!;
		assert.equal(fonts.groups[0]?.title, '字体与排版');
		assert.deepEqual(fonts.groups.flatMap(group => group.settings.map(setting => ({ id: setting.id, title: setting.title, type: setting.valueType }))), [
			{ id: 'editor.fontFamily', title: '字体', type: 'text' },
			{ id: 'editor.fontSize', title: '字号', type: 'number' },
			{ id: 'editor.lineHeight', title: '行高', type: 'number' },
			{ id: 'editor.fontLigatures', title: '字体连字', type: 'boolean' },
		]);
		const family = defaults.get('editor.fontFamily');
		assert.equal(family.valueType === 'text' && family.placeholder, '系统默认');
		assert.ok(family.description.includes(EDITOR_FONT_DEFAULTS.fontFamily));
		assert.ok(defaults.get('editor.fontSize').description.includes(String(EDITOR_FONT_DEFAULTS.fontSize)));
		const input = createSettingsLayout(defaults.all).find(category => category.id === 'chat-input')!;
		assert.equal(input.groups[0]?.title, '消息输入');
		assert.deepEqual(input.groups.flatMap(group => group.settings.map(setting => [setting.id, setting.title, setting.configuration.defaultValue])), [
			['chat.input.fontFamily', '字体', ''],
			['chat.input.fontSize', '字号', 13],
			['chat.input.lineHeight', '行高', 20],
		]);
		const inputFamily = defaults.get('chat.input.fontFamily');
		assert.equal(inputFamily.valueType === 'text' && inputFamily.placeholder, '系统默认');
		const blocks = createSettingsLayout(defaults.all).find(category => category.id === 'chat-code-blocks')!;
		assert.equal(blocks.groups[0]?.title, '代码块');
		assert.deepEqual(blocks.groups.flatMap(group => group.settings.map(setting => [setting.id, setting.title, setting.configuration.defaultValue])), [
			['chat.editor.fontFamily', '字体', ''],
			['chat.editor.fontSize', '字号', 0],
			['chat.editor.lineHeight', '行高', 0],
			['chat.editor.wordWrap', '自动换行', 'off'],
		]);
		const blocksFamily = defaults.get('chat.editor.fontFamily');
		assert.equal(blocksFamily.valueType === 'text' && blocksFamily.placeholder, '跟随编辑器');
	} finally {
		resetNlsResolver();
	}
});

test('settingsLayout is the single projection from registered settings to categories', () => {
	const defaults = new DefaultSettings();
	const layout = createSettingsLayout(defaults.all);
	const model = new SettingsEditorModel(defaults.all);

	assert.deepEqual(SettingsCategories.map(category => category.id), [
		'general',
		'github',
		'network',
		'appearance',
		'layout',
		'startup',
		'editor-fonts',
		'editor-display',
		'editor-editing',
		'editor-suggestions',
		'editor-language',
		'editor-search',
		'editor-diff',
		'editor-opening',
		'editor-files',
		'explorer',
		'search',
		'source-control',
		'browser',
		'voice-input',
		'chat-input',
		'chat-code-blocks',
		'agents',
		'teams',
		'agent-defaults',
		'models',
		'rules',
		'skills',
		'tools',
		'sandbox',
		'execution-trace',
		'hooks',
	]);
	assert.deepEqual(model.settings.map(setting => setting.id), defaults.all.map(setting => setting.id));
	assert.equal(findSettingCategory(layout, AccessibilityConfiguration.underlineLinks), 'general');
	assert.equal(findSettingCategory(layout, LocalizationConfiguration.locale), 'general');
	assert.equal(findSettingCategory(layout, 'workbench.externalUriOpeners'), 'browser');
	assert.equal(defaults.get('workbench.externalUriOpeners').valueType, 'stringMap');
	assert.equal(findSettingCategory(layout, HoverConfiguration.delay), 'general');
	assert.equal(findSettingCategory(layout, SashConfiguration.size), 'general');
	assert.equal(findSettingCategory(layout, DictationConfiguration.backend), 'voice-input');
	assert.equal(findSettingCategory(layout, DictationConfiguration.localModel), 'voice-input');
	assert.equal(findSettingCategory(layout, 'chat.defaultModel'), 'models');
	assert.equal(findSettingCategory(layout, 'chat.editing.autoAcceptDelay'), 'agent-defaults');
	assert.equal(defaults.get('chat.editing.autoAcceptDelay').valueType, 'number');
	assert.equal(findSettingCategory(layout, WorkbenchConfiguration.colorTheme), 'appearance');
	assert.equal(findSettingCategory(layout, 'workbench.tips.enabled'), 'appearance');
	assert.equal(defaults.get('workbench.tips.enabled').valueType, 'boolean');
	assert.equal(configurationRegistry.getConfiguration('workbench.tips.enabled')?.defaultValue, true);
	assert.equal(findSettingCategory(layout, WorkbenchConfiguration.layoutStyle), 'layout');
	assert.equal(findSettingCategory(layout, StartupEditorConfigurationKey), 'startup');
	assert.equal(findSettingCategory(layout, 'window.restoreWindows'), 'startup');
	assert.equal(findSettingCategory(layout, 'window.newWindowDimensions'), 'startup');
	assert.equal(findSettingCategory(layout, 'window.restoreFullscreen'), 'startup');
	assert.equal(findSettingCategory(layout, 'workbench.editor.restoreEditors'), 'startup');
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN');
	assert.equal(chinese?.bundles['ash.settings']?.['categories.startup.label'], '启动');
	assert.equal(chinese?.bundles.ash?.['settings.workbench.startup.group.label'], '启动时的编辑器');
	assert.equal(chinese?.bundles.ash?.['window.restoreWindows.all'], '全部窗口');
	assert.equal(chinese?.bundles.ash?.['window.newWindowDimensions.title'], '新窗口尺寸');
	assert.equal(chinese?.bundles.ash?.['window.restoreFullscreen.title'], '恢复全屏');
	assert.equal(chinese?.bundles.ash?.['workbench.editor.restoreEditors.title'], '恢复编辑器');
	assert.equal(chinese?.bundles.ash?.['workbench.tips.enabled.title'], '空编辑器提示');
	assert.equal(chinese?.bundles.ash?.['settings.dictation.group'], '语音输入');
	assert.equal(defaults.all.some(setting => Object.values(SessionsConfiguration).includes(setting.id)), false);
	assert.equal(findSettingCategory(layout, WorkbenchConfiguration.activityBarLocation), 'layout');
	const iconThemeSetting = defaults.get(WorkbenchConfiguration.iconTheme);
	assert.equal(iconThemeSetting.valueType, 'select');
	if (iconThemeSetting.valueType === 'select') {
		assert.equal(iconThemeSetting.options.some(option => option.value === iconThemeSetting.configuration.defaultValue), true);
	}
	assert.equal(findSettingCategory(layout, EditorSelectionConfiguration.defaultNewDocumentEditor), 'editor-opening');
	assert.equal(findSettingCategory(layout, 'breadcrumbs.filePath'), 'editor-display');
	assert.equal(findSettingCategory(layout, 'breadcrumbs.symbolPath'), 'editor-display');
	assert.equal(findSettingCategory(layout, 'workbench.editorLargeFileConfirmation'), 'editor-opening');
	assert.equal(findSettingCategory(layout, CodeEditorConfiguration.fontFamily), 'editor-fonts');
	assert.equal(findSettingCategory(layout, CodeEditorConfiguration.renderWhitespace), 'editor-display');
	assert.equal(findSettingCategory(layout, CodeEditorConfiguration.renderControlCharacters), 'editor-display');
	assert.equal(findSettingCategory(layout, ContentSearchConfiguration.maxResults), 'search');
	assert.equal(findSettingCategory(layout, 'scm.diffDecorationsIgnoreTrimWhitespace'), 'source-control');
	assert.equal(findSettingCategory(layout, DictationConfiguration.backend), 'voice-input');
	assert.equal(findSettingCategory(layout, DictationConfiguration.cloudProvider), 'voice-input');
	assert.equal(findSettingCategory(layout, DictationConfiguration.localModel), 'voice-input');
	assert.equal(defaults.all.some(setting => setting.id === GitConfiguration.autofetch), false);
	assert.equal(configurationRegistry.getConfiguration(GitConfiguration.autofetch)?.defaultValue, false);
	assert.equal(configurationRegistry.getConfiguration(GitConfiguration.autofetchPeriod)?.defaultValue, 180);
	assert.equal(defaults.all.every(setting => ['boolean', 'number', 'select', 'text', 'stringMap'].includes(setting.valueType)), true);
	const themeSetting = defaults.get(WorkbenchConfiguration.colorTheme);
	assert.equal(themeSetting.valueType, 'select');
	if (themeSetting.valueType === 'select') {
		using contributedTheme = WorkbenchThemesRegistry.registerColorTheme({
			...darkColorTheme,
			id: 'test-preferences-dynamic-theme',
			label: 'Dynamic test theme',
		});
		assert.equal(themeSetting.options.some(option => option.value === 'test-preferences-dynamic-theme'), true);
	}
	const layoutStyleSetting = defaults.get(WorkbenchConfiguration.layoutStyle);
	assert.equal(layoutStyleSetting.valueType, 'select');
	if (layoutStyleSetting.valueType === 'select') {
		assert.deepEqual(layoutStyleSetting.options, [
			{ value: 'modern', label: 'Modern' },
			{ value: 'flat', label: 'Flat' },
		]);
	}
	assert.throws(() => configurationRegistry.getConfiguration(SessionsConfiguration.layoutStyle)?.parse('other'), /Unknown Sessions layout style/);

	model.dispose();
});

test('SettingsLayout validates stable configuration identities', () => {
	const fontFamily = new DefaultSettings().get(CodeEditorConfiguration.fontFamily);
	const layout = new SettingsLayout('editor', [{
		id: 'typography',
		title: 'Typography',
		description: 'Editor typography.',
		settings: [fontFamily],
	}]);

	assert.equal(layout.nodes[0]?.element.id, 'editor.group.typography');
	assert.equal(layout.nodes[0]?.children?.[0]?.element.id, CodeEditorConfiguration.fontFamily);
	assert.deepEqual(layout.nodes[0]?.children?.[0]?.element.keywords, [CodeEditorConfiguration.fontFamily]);
	assert.throws(() => new SettingsLayout('editor', [{
		id: 'typography',
		title: 'Typography',
		description: '',
		settings: [fontFamily, fontFamily],
	}]), /Duplicate Settings setting ID/);
	assert.throws(() => new SettingsLayout('', []), /TOC ID must not be empty/);
	assert.throws(() => new SettingsLayout('editor', [{
		id: 'typography',
		title: 'Typography',
		description: '',
		settings: [{ ...fontFamily, id: 'editor.font\0Family' }],
	}]), /must not contain control characters/);
});

test('Settings search normalizes pasted setting syntax and matches complete metadata terms', () => {
	const query = new SettingsSearchQuery('  "Editor.Font: Family"  ');

	assert.equal(query.text, 'editor.font family');
	assert.equal(query.matches({
		title: 'Font family',
		description: 'Configure the editor font.',
		keywords: ['editor.fontFamily'],
	}), true);
	assert.equal(query.matches({
		title: 'Font size',
		description: 'Configure the editor font size.',
	}), false);
});

test('Settings ordinary search matches IDs and combines them with metadata words', () => {
	const metadata = { id: 'editor.fontFamily', title: 'Font family', description: 'Editor typography.' };
	assert.deepEqual(['editor.fontFamily', 'EDITOR.FONT', 'editor.font typography', 'font missing'].map(query => new SettingsSearchQuery(query).matches(metadata)), [true, true, true, false]);
	assert.equal(new SettingsSearchQuery('typography').matches({ title: 'Font family', description: 'Editor typography.' }), true);
});

test('Settings search composes setting ID and text filters', () => {
	const query = new SettingsSearchQuery('@id:editor.font* editor');

	assert.equal(query.matches({ id: 'editor.fontFamily', title: 'Font family', description: 'Editor typography.' }), true);
	assert.equal(query.matches({ id: 'editor.fontSize', title: 'Font size', description: 'Editor typography.' }), true);
	assert.equal(query.matches({ id: 'workbench.fontFamily', title: 'Font family', description: 'Workbench typography.' }), false);
});

test('Settings search recognizes modified filters without treating them as text', () => {
	for (const value of ['@modified font', 'font @MODIFIED', 'font @modified @id:editor.font*']) {
		const query = new SettingsSearchQuery(value);
		assert.equal(query.text, 'font');
		assert.equal(query.isEmpty, false);
		assert.equal(query.matches({ id: 'editor.fontFamily', title: 'Font family', description: '' }), true);
		assert.notEqual(query.key, new SettingsSearchQuery(value.replace(/@modified/giu, '')).key);
	}
	assert.equal(new SettingsSearchQuery('@modified').text, '');
	assert.equal(new SettingsSearchQuery('@modified').isEmpty, false);
	assert.equal(new SettingsSearchQuery('@modifiedExtra').text, '@modifiedextra');
});

test('Settings search matches complete setting IDs without selecting prefixed IDs', () => {
	const query = new SettingsSearchQuery('@id:EDITOR.fontSize');
	const metadata = { title: 'Font size', description: 'Editor typography.' };

	assert.equal(query.matches({ ...metadata, id: 'editor.fontSize' }), true);
	assert.equal(query.matches({ ...metadata, id: 'chat.editor.fontSize' }), false);
	assert.equal(query.matches({ ...metadata, id: 'editor.fontSizeExtra' }), false);
	assert.equal(query.matches(metadata), false);
});

test('Modified Settings derives membership from accepted local overrides through reset, failure and reload', async () => {
	using resources = new DisposableStore();
	const registry = new ConfigurationRegistry();
	for (const [key, defaultValue] of [['modified.boolean', true], ['modified.number', 1], ['modified.text', 'Default'], ['modified.default', true], ['modified.language', true]] as const) {
		registry.registerConfiguration({ key, defaultValue, parse: value => value, scope: ConfigurationScope.LANGUAGE_OVERRIDABLE });
	}
	let snapshot = { revision: 0, document: { version: 1 as const, source: '{}\n' } };
	const pending = new DeferredPromise<void>();
	let blockWrites = false;
	const api: import('../../../../../platform/configuration/common/configurationIpc.js').IConfigurationApi = {
		read: async () => snapshot,
		onDidChange: () => ({ dispose() { } }),
		update: async request => {
			if (blockWrites) await pending.p;
			assert.equal(request.expectedRevision, snapshot.revision);
			snapshot = { revision: snapshot.revision + 1, document: request.document };
			return snapshot;
		},
	};
	const configuration = resources.add(new WorkbenchConfigurationService({ registry, api, initialSnapshot: snapshot }));
	const tree = resources.add(new SettingsTreeModel<string>(id => registry.getConfiguration(id) !== undefined && configuration.inspect(id).userLocalValue !== undefined));
	tree.setChildren([...registry.getConfigurations(), 'service.status'].map(id => ({ element: { kind: 'item', id, title: 'Preference', description: '', value: id } })));
	tree.setQuery('@modified');
	resources.add(configuration.onDidChangeConfiguration(() => tree.refilter()));
	const visible = () => tree.visibleItems.map(item => item.id);
	assert.deepEqual(visible(), []);
	await configuration.write('{ "modified.boolean": false, "modified.number": 0, "modified.text": "", "modified.default": true, "[typescript]": { "modified.language": false } }', 0);
	const configured = ['modified.boolean', 'modified.number', 'modified.text', 'modified.default'];
	assert.deepEqual(visible(), configured, 'presence includes explicit defaults and falsy values, without language-only or service state');
	tree.setQuery('preference @modified @id:modified.text');
	assert.deepEqual(visible(), ['modified.text']);
	tree.setQuery('@modified');
	blockWrites = true;
	const failedReset = configuration.updateValue('modified.default', undefined);
	const failure = assert.rejects(failedReset, /blocked save/);
	await Promise.resolve();
	assert.deepEqual(visible(), configured, 'pending writes do not change membership');
	await pending.error(new Error('blocked save'));
	await failure;
	assert.deepEqual(visible(), configured, 'failed writes retain the accepted state');
	blockWrites = false;
	await configuration.updateValue('modified.default', undefined);
	assert.deepEqual(visible(), configured.slice(0, -1));
	using restored = new WorkbenchConfigurationService({ registry, api });
	await restored.reloadConfiguration();
	assert.deepEqual([...registry.getConfigurations()].filter(id => restored.inspect(id).userLocalValue !== undefined), configured.slice(0, -1));
});

test('Settings table of contents follows modified result counts through reset', async () => {
	using configuration = new WorkbenchConfigurationService();
	using tree = new SettingsTreeModel<ISetting | SettingsContentItem>(id => configurationRegistry.getConfiguration(id) !== undefined && configuration.inspect(id).userLocalValue !== undefined);
	tree.setChildren(settingsRootNodes(createSettingsLayout(new DefaultSettings().all)));
	using listener = configuration.onDidChangeConfiguration(() => tree.refilter());
	const toc = new TOCTreeModel(tree);
	const categories = () => toc.children.flatMap(node => node.children ?? [node]).map(node => node.element.id);
	tree.setQuery('@modified');
	assert.deepEqual(categories(), []);
	assert.equal(tree.countVisibleItems(), 0);
	const fontDefault = configuration.inspect(CodeEditorConfiguration.fontSize).defaultValue;
	await configuration.write(JSON.stringify({ [CodeEditorConfiguration.fontSize]: fontDefault }), 0);
	assert.deepEqual(categories(), ['editor-fonts']);
	assert.equal(tree.countVisibleItems(), 1);
	tree.setQuery('@modified font');
	assert.deepEqual(categories(), ['editor-fonts']);
	await configuration.updateValue(CodeEditorConfiguration.fontSize, undefined);
	assert.deepEqual(categories(), []);
	assert.equal(tree.countVisibleItems(), 0);
	tree.setQuery('');
	assert.ok(categories().includes('editor-fonts'), 'clearing the query restores the browsing directory');
});

test('Models Settings keeps loading API connections when the model catalog changes', async () => {
	using disposables = new DisposableStore();
	const ownerDocument = browserEnvironment.window.document;
	ownerDocument.body.replaceChildren();
	const root = h(ownerDocument, 'div');
	ownerDocument.body.append(root);
	const configuration = disposables.add(new WorkbenchConfigurationService());
	const contextView = disposables.add(new BrowserContextViewService(root));
	const changed = disposables.add(new Emitter<void>());
	const model = { provider: 'openai', model: 'gpt-test' };
	let catalog = [{ model, displayName: 'GPT Test' }];
	let resolveProviders!: (providers: readonly { connection: string; provider: string; displayName: string; apiKeyPolicy: 'required'; apiKeyConfigured: boolean; }[]) => void;
	const providers = new Promise<readonly { connection: string; provider: string; displayName: string; apiKeyPolicy: 'required'; apiKeyConfigured: boolean; }[]>(resolve => { resolveProviders = resolve; });
	const chat = {
		onDidChangeModels: changed.event,
		listModelCatalog: async () => catalog,
		listModelProviders: () => providers,
		setModelPreferences: async () => { },
		listCustomModelProviders: async () => [],
		isModelVisible: () => true,
	} as unknown as IChatService;
	const services = disposables.add(new InstantiationService());
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(ILocalTranscriptionService, disposables.add(new NullLocalTranscriptionService()));
	services.registerInstance(ConfigurationServiceId, configuration);
	services.registerInstance(ChatServiceId, chat);
	services.registerInstance(INotificationService, disposables.add(new NotificationService()));
	services.registerInstance(ILanguageModelsService, chat as unknown as ILanguageModelsService);
	services.registerInstance(IExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
	services.registerInstance(IContextViewService, disposables.add(new BrowserContextViewService(root)));
	services.registerInstance(IAccessibleViewService, { show: () => true, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } });
	const panel = disposables.add(services.createInstance(ModelSettingsContent, root));
	const modelTree = disposables.add(new SettingsTreeModel<SettingsContentItem>());
	disposables.add(new SettingsTree(root, {
		model: modelTree, rootClassName: 'ash-models-settings', groupClassName: 'ash-settings-content-group', groupDescriptionClassName: 'ash-settings-group-description', itemsClassName: 'ash-settings-list', renderItem: item => item.value.domNode,
	}));
	disposables.add(panel.onDidChange(() => modelTree.setChildren(panel.getNodes())));
	panel.setVisible(true);
	modelTree.setNavigationTarget('models.catalog');
	await nextTurn();
	assert.equal(root.querySelector('.ash-models-settings-model-copy > span')?.textContent, 'GPT Test');
	const retainedModel = root.querySelector('.ash-models-settings-model-row');
	modelTree.setNavigationTarget(undefined);
	catalog = [{ model, displayName: 'GPT Test Updated' }];
	changed.fire();
	resolveProviders([{ connection: 'openai', provider: 'openai', displayName: 'OpenAI API', apiKeyPolicy: 'required', apiKeyConfigured: false }]);
	await nextTurn();
	assert.equal(root.querySelector('.ash-models-settings-api-row h5')?.textContent, 'OpenAI API');
	assert.equal(root.querySelector('.ash-models-settings-model-row'), retainedModel);
	assert.equal(root.querySelector('.ash-models-settings-model-copy > span')?.textContent, 'GPT Test Updated');
});

test('Models Settings orders enabled models by catalog position and restores disabled positions', async () => {
	using resources = new DisposableStore();
	const root = h(browserEnvironment.window.document, 'div');
	const catalog = [
		{ model: { provider: 'first', model: 'newest' }, displayName: 'First newest', longContext: null },
		{ model: { provider: 'first', model: 'older' }, displayName: 'First older', longContext: null },
		{ model: { provider: 'second', model: 'newest' }, displayName: 'Second', longContext: null },
		{ model: { provider: 'third', model: 'newest' }, displayName: 'Third', longContext: null },
	];
	const enabled = new Set<string>();
	const changed = resources.add(new Emitter<void>());
	const models: ILanguageModelsService = {
		readApprovalReviewModel: async () => ({ type: 'automatic' }),
		setApprovalReviewModel: async () => { },
		setModelPreferences: async () => { },
		onDidChangeModels: changed.event,
		listModels: async () => catalog.filter(entry => enabled.has(entry.displayName)),
		getDefaultNewChatModel: () => undefined,
		rememberSelectedModel() { },
		listModelCatalog: async () => catalog,
		listCustomModelProviders: async () => [],
		saveCustomModelProvider: async () => { },
		testProviderModel: async () => ({ type: 'passed' }),
		listModelProviders: async () => [],
		setModelProviderApiKey: async () => { },
		removeModelProviderApiKey: async () => { },
		listAdvisorModels: async () => [],
		refreshModels: async () => catalog,
		isModelVisible: model => catalog.some(entry => entry.model.provider === model.provider && entry.model.model === model.model && enabled.has(entry.displayName)),
		setModelVisible: async (model, visible) => {
			const entry = catalog.find(entry => entry.model.provider === model.provider && entry.model.model === model.model)!;
			if (visible) { enabled.add(entry.displayName); } else { enabled.delete(entry.displayName); }
			changed.fire();
		},
		discoverProviderModels: async () => catalog,
	};
	const services = resources.add(new InstantiationService());
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(ILanguageModelsService, models);
	services.registerInstance(IExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
	services.registerInstance(ConfigurationServiceId, resources.add(new WorkbenchConfigurationService()));
	services.registerInstance(INotificationService, resources.add(new NotificationService()));
	services.registerInstance(IAccessibleViewService, { show: () => true, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } });
	const content = resources.add(services.createInstance(ModelSettingsContent, root));
	const loaded = new DeferredPromise<void>();
	resources.add(content.onDidChange(() => {
		if (content.getNodes()[0].children?.some(node => node.element.id === 'models.catalog.first/newest')) { void loaded.complete(); }
	}));
	content.setVisible(true);
	await loaded.p;
	const names = (query?: InstanceType<typeof SettingsSearchQuery>): string[] => content.getNodes(query)[0].children!.filter(node => node.element.id.startsWith('models.catalog.') && node.element.id !== 'models.catalog.expand').map(node => node.element.title);
	assert.deepEqual(names(), ['First newest', 'Second', 'Third']);
	// Enable in reverse order so activation order cannot masquerade as catalog order.
	await models.setModelVisible(catalog[3].model, true);
	await models.setModelVisible(catalog[2].model, true);
	assert.deepEqual(names(), ['Second', 'Third', 'First newest']);
	await models.setModelVisible(catalog[2].model, false);
	assert.deepEqual(names(), ['Third', 'First newest', 'Second']);
	await models.setModelVisible(catalog[3].model, false);
	assert.deepEqual(names(), ['First newest', 'Second', 'Third']);
	await models.setModelVisible(catalog[1].model, true);
	const group = content.getNodes()[0].element;
	assert.ok(group.kind === 'group');
	const search = group.titleDomNode!.querySelector<HTMLInputElement>('input')!;
	search.value = 'first';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.deepEqual(names(), ['First older', 'First newest']);
	await models.setModelVisible(catalog[1].model, false);
	assert.deepEqual(names(), ['First newest', 'First older']);
	search.value = '';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.deepEqual(names(new SettingsSearchQuery('older')), ['First newest', 'First older', 'Second', 'Third']);
});

test('Settings tree preserves item identity while filtering and updating', () => {
	using disposables = new DisposableStore();
	const ownerDocument = browserEnvironment.window.document;
	ownerDocument.body.replaceChildren();
	const model = disposables.add(new SettingsTreeModel<string>());
	model.setChildren([{
		element: { kind: 'group', id: 'appearance.colors', title: 'Colors', description: 'Choose the active color scheme.' },
		children: [
			{ element: { kind: 'item', id: 'appearance.colors.theme', title: 'Theme', description: 'Choose a theme.', value: 'Theme' } },
			{ element: { kind: 'item', id: 'appearance.colors.font', title: 'Font family', description: 'Choose a UI font.', value: 'Font' } },
		],
	}]);
	const disposedItems: string[] = [];
	const renderer = disposables.add(new SettingsTree(ownerDocument.body, {
		model,
		rootClassName: 'test-settings-tree',
		groupClassName: 'test-settings-group',
		groupDescriptionClassName: 'test-settings-group-description',
		itemsClassName: 'test-settings-items',
		renderItem: item => {
			const element = h(ownerDocument, 'article');
			element.textContent = item.value;
			return element;
		},
		updateItem: (item, element) => { element.textContent = item.value; },
		disposeItem: item => disposedItems.push(item.id),
	}));

	const themeElement = renderer.getItemElement('appearance.colors.theme');
	assert.ok(themeElement);
	model.setQuery('font family');
	assert.deepEqual(model.visibleItems.map(item => item.id), ['appearance.colors.font']);
	model.setQuery('');
	assert.equal(renderer.getItemElement('appearance.colors.theme'), themeElement);
	model.setNodeChildren('appearance.colors', [{
		element: { kind: 'item', id: 'appearance.colors.theme', title: 'Theme', description: 'Choose a theme.', value: 'Updated Theme' },
	}]);
	assert.equal(themeElement.textContent, 'Updated Theme');
	assert.deepEqual(disposedItems, ['appearance.colors.font']);
	assert.throws(() => model.setChildren([
		{ element: { kind: 'item', id: 'duplicate', title: 'One', description: '', value: 'one' } },
		{ element: { kind: 'item', id: 'duplicate', title: 'Two', description: '', value: 'two' } },
	]), /Duplicate tree node ID/);
});

test('SettingsEditor opens directly and updates registry-backed settings', async () => {
	using disposables = new DisposableStore();
	const ownerDocument = browserEnvironment.window.document;
	ownerDocument.body.replaceChildren();
	const root = h(ownerDocument, 'div');
	const trigger = h(ownerDocument, 'button');
	trigger.textContent = 'Open Settings';
	root.append(trigger);
	ownerDocument.body.append(root);
	trigger.focus();

	const copied: string[] = [];
	let menuActions: readonly IAction[] = [];
	let hideMenu: ((didCancel: boolean) => void) | undefined;
	const clipboardService: IClipboardService = {
		readText: async () => '',
		triggerPaste: () => undefined,
		read: async () => [],
		readFindText: async () => '',
		writeFindText: async () => { },
		readImage: async () => new Uint8Array(),
		readResources: async () => ({ resources: [], operation: 'copy' }),
		writeResources: async () => { },
		hasResources: async () => false,
		writeText: value => {
			copied.push(value);
			return Promise.resolve();
		},
	};
	const contextMenuProvider: ContextMenuService = {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu: options => {
			menuActions = options.getActions?.() ?? [];
			hideMenu = 'onHide' in options ? options.onHide : undefined;
		},
		hideContextMenu() { },
	};
	const configuration = disposables.add(new WorkbenchConfigurationService());
	const languagePacksChanged = disposables.add(new Emitter<void>());
	const availableLocales: LanguagePackInfo[] = builtinLanguagePackCatalogs.map(catalog => ({ ...catalog, source: 'builtin' }));
	const languagePacks: ILanguagePackService = {
		onDidChange: languagePacksChanged.event,
		whenReady: Promise.resolve(),
		catalogs: [...builtinLanguagePackCatalogs, { ...builtinLanguagePackCatalogs[0], locale: "fr", languageName: "French", localizedLanguageName: "Français" }],
		availableLocales,
		installedPackages: [],
		search: async () => [],
		install: async () => { },
		refresh: async () => { },
	};
	const locale = disposables.add(createTestLocaleService(configuration, languagePacks));
	await locale.whenReady;
	const workbenchLocalization = disposables.add(new WorkbenchLocalizationService());
	disposables.add(toDisposable(() => resetNlsResolver()));
	const autoFetchChanged = disposables.add(new Emitter<void>());
	let autoFetch: false | true | 'all' = false;
	let autoFetchPeriod = 180;
	const gitService = {
		onDidChangeAutoFetch: autoFetchChanged.event,
		get autoFetch() { return autoFetch; },
		get autoFetchPeriod() { return autoFetchPeriod; },
		setAutoFetch: async (value: false | true | 'all') => { autoFetch = value; autoFetchChanged.fire(); },
		setAutoFetchPeriod: async (value: number) => { autoFetchPeriod = value; autoFetchChanged.fire(); },
	} as IGitService;
	const model = { provider: 'openai', model: 'gpt-test' };
	const modelsChanged = disposables.add(new Emitter<void>());
	let modelVisible = true;
	const modelWrites: boolean[] = [];
	const savedKeys: string[] = [];
	const advisorModel = { provider: 'openai', model: 'gpt-6.1-sol' };
	const otherAdvisorModel = { provider: 'meta', model: 'muse-spark-1.3' };
	const hiddenAdvisors = new Set<string>();
	let advisor: import('../../../../services/chat/common/chatService.js').AdvisorConfig | null = { model: advisorModel, enabled: true, maxCalls: 5, maxOutputTokens: 4096, reasoningEffort: 'high' };
	const advisorWrites: (typeof advisor | null)[] = [];
	let rejectAdvisorSave = false;
	const chatService = {
		onDidChangeModels: modelsChanged.event,
		listAdvisorModels: async () => [{ model: advisorModel, displayName: 'GPT-6.1 Sol' }, { model: otherAdvisorModel, displayName: 'Muse Spark 1.3', supportedReasoningEfforts: [{ effort: 'high' }] }, { model, displayName: 'GPT Test' }],
		readAdvisorDefault: async () => advisor,
		saveAdvisorDefault: async (next: typeof advisor) => {
			if (rejectAdvisorSave) { throw new Error('Preference write failed'); }
			advisor = next;
			advisorWrites.push(next);
		},
		listModelCatalog: async () => [{ model, displayName: 'GPT Test' }],
		setModelPreferences: async () => { },
		listCustomModelProviders: async () => [],
		listModelProviders: async () => [{ connection: 'openai', provider: 'openai', displayName: 'OpenAI API', apiKeyPolicy: 'required', apiKeyConfigured: savedKeys.length > 0 }],
		isModelVisible: (entry: typeof model) => entry.model === model.model ? modelVisible : !hiddenAdvisors.has(entry.model),
		setModelVisible: async (_model: typeof model, visible: boolean) => {
			modelWrites.push(visible);
			modelVisible = visible;
			modelsChanged.fire();
		},
		setModelProviderApiKey: async (_connection: string, key: string) => { savedKeys.push(key); },
		refreshModels: async () => [{ model, displayName: 'GPT Test' }],
	} as unknown as IChatService;
	const contextView = disposables.add(new BrowserContextViewService(root));
	const services = new InstantiationService();
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(INotificationService, disposables.add(new NotificationService()));
	services.registerInstance(IDictationService, undefined);
	services.registerInstance(IChatSpeechToTextService, disposables.add(services.createInstance(ChatSpeechToTextService)));
	const skillsChanged = disposables.add(new Emitter<void>());
	let skillEnabled = true;
	const skillScopes: (string | undefined)[] = [];
	const skillMutations: unknown[][] = [];
	const skillId = { source: 'directory:skill-source:test', name: 'review' };
	services.registerInstance(IAppServerSkillApi, {
		onDidChangeSkills: skillsChanged.event,
		readInstructions: async () => { throw new Error("No Skill body in this test fixture"); },
		list: async () => ({ generation: 0, skills: [] }),
		read: async sessionId => { skillScopes.push(sessionId); return { revision: 7, catalog: { generation: 1, skills: [{ id: skillId, description: 'Review changes', contentDigest: 'sha256:review', enabled: skillEnabled, compatible: true }] }, diagnostics: [] }; },
		setEnabled: async (...args) => { skillMutations.push(args); skillEnabled = args[1]; },
	});
	services.registerInstance(IMarketplaceService, { onDidChangeInstalled: Event.None } as IMarketplaceService);
	services.registerInstance(ILanguageServerService, { read: async () => ({ revision: 0, configurations: {}, servers: [] }), configure: async () => { }, removeConfiguration: async () => { } });
	services.registerInstance(ICodeEditorService, { getActiveCodeEditor: () => null } as ICodeEditorService);
	services.registerInstance(IDialogService, disposables.add(new DialogService()));
	services.registerInstance(ClipboardServiceId, clipboardService);
	services.registerInstance(ConfigurationServiceId, configuration);
	services.registerInstance(IContextMenuService, contextMenuProvider);
	services.registerInstance(IContextViewService, contextView);
	services.registerInstance(LocalizationServiceId, workbenchLocalization);
	services.registerInstance(GitServiceId, gitService);
	services.registerInstance(ChatServiceId, chatService);
	services.registerInstance(ILanguageModelsService, chatService as unknown as ILanguageModelsService);
	services.registerInstance(IExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
	services.registerInstance(ILocalTranscriptionService, disposables.add(new NullLocalTranscriptionService()));
	const descriptor = EditorPanes.getEditorPanes().find(candidate => candidate.id === SettingsEditorId);
	assert.ok(descriptor);
	assert.throws(() => descriptor.create({ instantiationService: services }), /Unknown service: localeService/);
	services.registerInstance(ILocaleService, locale);
	assert.throws(() => descriptor.create({ instantiationService: services }), /Unknown service: languagePackService/);
	services.registerInstance(LanguagePackServiceId, languagePacks);
	assert.throws(() => descriptor.create({ instantiationService: services }), /Unknown service: agentCapabilitiesService/);
	let capabilityReads = 0;
	services.registerInstance(IAgentCapabilitiesService, {
		isAvailable: true,
		read: async () => {
			capabilityReads++;
			return {
				toolSets: [], tools: [{ name: 'read_file', description: 'Read a file.', source: 'local', sourceDetails: ['ash-app-server'], exposure: 'direct', authority: 'directoryRead' }],
				localProcessSandboxConfigured: true,
				sandboxBackends: ['mxc'],
				sandboxDiagnostics: [{ backend: 'mxc', network: 'managed', readiness: { type: 'unsupported', reason: '<script>diagnostic</script>' } }],
				directoryGrantsReadable: true,
			};
		},
	});
	assert.throws(() => descriptor.create({ instantiationService: services }), /Unknown service: appServerRemoteAgentService/);
	const connectionChanged = disposables.add(new Emitter<RemoteConnectionState>());
	const connectionIdentityChanged = disposables.add(new Emitter<RemoteAgentConnection>());
	let connectionIdentity: RemoteAgentConnection = { kind: 'local', generation: 1 };
	services.registerInstance(ITraceSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, configured: null, recording: { type: 'disabled' } }), configure: async () => { } });
	services.registerInstance(IFileDialogService, { showOpenDialog: async () => undefined, showSaveDialog: async () => undefined, pickFileToSave: async () => undefined, showSaveConfirm: async () => 2 });
	services.registerInstance(RemoteAgentServiceId, {
		onDidChangeConnectionState: connectionChanged.event,
		onDidChangeConnection: connectionIdentityChanged.event,
		connectionState: 'connected',
		get connection() { return connectionIdentity; },
		reconnect: async () => ({ kind: 'alreadyConnected' }),
		rollbackRuntime: async () => ({ kind: 'cancelled' }),
	});
	services.registerInstance(DirPermissionsServiceId, {
		onDidChangePermissions: Event.None,
		list: async () => ({ revision: 1, entries: [{ dir: 'dir-1', path: '/workspace', permissions: ['readFiles'] }] }),
	} as unknown as IDirPermissionsService);
	let searchSnapshot: import('../../../../../platform/search/common/search.js').ContentSearchConfiguration = { revision: 4, engine: 'tgrep' };
	let rejectSearchSave = false;
	let nextSearchRead: Promise<typeof searchSnapshot> | undefined;
	const searchWrites: { engine: string; expectedRevision: number; }[] = [];
	services.registerInstance(IContentSearchConfigurationService, {
		read: async () => {
			const pending = nextSearchRead;
			nextSearchRead = undefined;
			return pending ?? searchSnapshot;
		},
		configure: async (engine, expectedRevision) => {
			searchWrites.push({ engine, expectedRevision });
			if (rejectSearchSave) { throw new Error('Revision conflict'); }
			searchSnapshot = { engine, revision: expectedRevision + 1 };
		},
	});
	services.registerInstance(INetworkDiagnosticsService, {
		read: async () => ({ revision: 0, httpMode: 'http2', targets: [] }),
		configureHttp: async () => { },
		run: async () => ({ network: { revision: 0, httpMode: 'http2', targets: [] }, checks: [] }),
	});
	let hookReads = 0;
	let hooksFailure = false;
	let openUserToml = 0;
	let sources: readonly HookSource[] = [{
		namespace: 'user', configPath: '/profile/config.toml', hooks: [{
			id: 'user:hook:check', event: 'preToolUse', enabled: false, toolNames: ['shell-command'], program: '/program with spaces', args: ['two words', '"quote"'],
		}]
	}];
	const hooksChanged = disposables.add(new Emitter<void>());
	let nextHooksRead: Promise<readonly HookSource[]> | undefined;
	const hooksService: IHooksService = {
		onDidChange: hooksChanged.event,
		userConfigurationEditor: async () => { openUserToml++; },
		read: async sessionId => {
			hookReads++;
			assert.equal(sessionId, 'session-hooks');
			if (hooksFailure) throw new Error('Invalid TOML');
			const pending = nextHooksRead;
			nextHooksRead = undefined;
			return pending ?? sources;
		},
	};
	const prompts: string[] = [];
	services.registerInstance(IChatSessionNavigationService, {
		getActiveConversation: () => ({ sessionId: 'session-hooks', threadId: 'thread-hooks' }),
		getConversations: () => [], captureActiveDraft: async () => undefined, openConversation: async () => { },
		appendToActiveDraft: text => { prompts.push(text); },
	});
	services.registerInstance(IAccessibleViewService, { show: () => true, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } });
	const hooksFolder = await mkdtemp(join(tmpdir(), 'ash-settings-hooks-'));
	await using hooksFolderCleanup = { [Symbol.asyncDispose]: async () => { await rm(hooksFolder, { recursive: true, force: true }); } };
	services.registerSingleton(IFileService, () => createTestFileService(disposables.add(new DiskFileSystemProvider([URI.file(hooksFolder)]))));
	const editorPanes = new EditorPaneRegistry();
	disposables.add(editorPanes.registerEditorPane(descriptor));
	const editorServices = disposables.add(createTestEditorServices(undefined, services));
	const editor = disposables.add(editorServices.createInstance(EditorPart, root, { registry: editorPanes }));
	editorServices.registerInstance(IEditorPart, editor);
	editorServices.registerInstance(ICommandService, disposables.add(new CommandService(editorServices)));
	editorServices.registerInstance(IEditorService, disposables.add(new BrowserEditorService(editor)));
	const preferences = disposables.add(new PreferencesService(editorServices.get(IEditorService), editorServices.get(IFileTextModelService), keybindingProfile.files, keybindingProfile.profiles, editorServices));
	services.registerInstance(IPreferencesService, preferences);
	services.registerInstance(IOpenerService, { open: async () => true } as unknown as IOpenerService);
	services.registerInstance(IAccountService, { onDidChangeAccounts: Event.None, onDidCompleteLogin: Event.None, read: async () => ({ revision: 1n, accounts: [] }), startLogin: async () => { throw new Error('Not used'); }, cancelLogin: async () => { }, logout: async () => { } });
	services.registerInstance(IGitHubService, { listAccounts: async () => [] } as unknown as IGitHubService);
	services.registerInstance(IGitHubConnectionService, { isConnecting: false, connect: async () => { }, cancel: async () => { } });
	services.registerInstance(IGitHubReviewModel, disposables.add(services.createInstance(GitHubReviewModel)));
	const missingHooks = disposables.add(await descriptor.create({ instantiationService: editorServices }));
	assert.throws(() => missingHooks.create(h(ownerDocument, 'div')), /Unknown service: hooksService/);
	missingHooks.dispose();
	services.registerInstance(IHooksService, hooksService);

	await preferences.openSettings();
	const host = root.querySelector<HTMLElement>('.ash-modal-editor-host');
	assert.ok(host);
	assert.equal(host.hidden, false);
	assert.equal(root.querySelector('.ash-modal-editor')?.getAttribute('role'), 'dialog');
	assert.deepEqual(
		[...root.querySelectorAll<HTMLElement>('[data-settings-category-id]')].map(element => element.dataset.settingsCategoryId),
		['general', 'github', 'network'],
	);
	const workbenchGroup = root.querySelector<HTMLElement>('[data-settings-group-id="workbench"]');
	assert.ok(workbenchGroup);
	assert.equal(workbenchGroup.closest('.ash-tree-row')?.getAttribute('aria-expanded'), 'false');
	workbenchGroup.closest<HTMLElement>('.ash-tree-row')?.click();
	assert.deepEqual(
		[...root.querySelectorAll<HTMLElement>('[data-settings-category-id]')].map(element => element.dataset.settingsCategoryId),
		['general', 'github', 'network', 'appearance', 'layout', 'startup'],
	);
	assert.equal(root.querySelector('[data-settings-category-id="general"]')?.closest('.ash-tree-row')?.hasAttribute('aria-expanded'), false);
	assert.equal(root.querySelector('[data-settings-category-id="appearance"]')?.closest('.ash-tree-row')?.hasAttribute('aria-expanded'), false);
	assert.equal(root.querySelector('[data-settings-category-id="layout"]')?.closest('.ash-tree-row')?.hasAttribute('aria-expanded'), false);
	assert.equal(root.querySelector('[data-settings-category-id="startup"]')?.closest('.ash-tree-row')?.hasAttribute('aria-expanded'), false);
	assert.equal(root.querySelector('[data-settings-target-id="appearance.group.theme"]'), null);
	assert.equal(root.querySelector('[data-settings-target-id="layout.group.layout"]'), null);
	assert.equal(root.querySelector('[data-settings-target-id="startup.group.startup-windows"]'), null);
	assert.equal(root.querySelector('[data-settings-target-id="startup.group.startup-editor"]'), null);
	const agentsGroup = root.querySelector<HTMLElement>('[data-settings-group-id="agents"]');
	assert.ok(agentsGroup);
	assert.equal(agentsGroup.textContent, 'Chat');
	assert.equal(agentsGroup.closest('.ash-tree-row')?.getAttribute('aria-expanded'), 'false');
	assert.equal(root.querySelector('[data-settings-category-id="models"]'), null);
	await nextTurn();
	await preferences.openSettings({ section: 'search' });
	const searchEngine = root.querySelector<HTMLElement>('[data-settings-item-id="grep.backend"] [role="combobox"]');
	assert.equal(searchEngine?.textContent, 'tgrep (default)');
	assert.throws(() => configuration.inspect('grep.backend'), /Unknown configuration key/);
	assert.ok(searchEngine);
	const searchRow = root.querySelector<HTMLElement>('[data-settings-item-id="grep.backend"]')!;
	searchEngine.click();
	const searchList = ownerDocument.getElementById(searchEngine.getAttribute('aria-controls')!)!;
	searchList.querySelectorAll<HTMLElement>('[role="option"]')[1].click();
	await nextTurn();
	assert.equal(searchEngine.textContent, 'ripgrep');
	assert.equal(searchRow.querySelector('[role="status"]')?.textContent, 'Search engine saved.');
	assert.deepEqual(searchWrites, [{ engine: 'ripgrep', expectedRevision: 4 }]);
	rejectSearchSave = true;
	searchEngine.click();
	searchList.querySelectorAll<HTMLElement>('[role="option"]')[0].click();
	await nextTurn();
	assert.equal((searchEngine as HTMLButtonElement).disabled, true);
	assert.equal(searchRow.querySelector('[role="status"]')?.textContent, 'Could not save search engine. Refresh the configuration before trying again.');
	rejectSearchSave = false;
	searchRow.querySelector<HTMLButtonElement>('button:not([role="combobox"])')!.click();
	await nextTurn();
	assert.equal(searchEngine.textContent, 'ripgrep');
	assert.equal((searchEngine as HTMLButtonElement).disabled, false);
	const pendingSearch = new DeferredPromise<typeof searchSnapshot>();
	nextSearchRead = pendingSearch.p;
	searchRow.querySelector<HTMLButtonElement>('button:not([role="combobox"])')!.click();
	connectionChanged.fire('disconnected');
	await pendingSearch.complete({ revision: 1, engine: 'tgrep' });
	await nextTurn();
	assert.equal((searchEngine as HTMLButtonElement).disabled, true);
	assert.equal(searchRow.querySelector('[role="status"]')?.textContent, 'App Server is disconnected.');
	connectionChanged.fire('connected');
	await nextTurn();
	assert.equal(searchEngine.textContent, 'ripgrep');
	assert.equal((searchEngine as HTMLButtonElement).disabled, false);
	await preferences.openSettings({ section: 'general' });
	assert.ok(root.querySelector(`[data-settings-item-id="${AccessibilityConfiguration.underlineLinks}"]`));
	assert.ok(root.querySelector(`[data-settings-item-id="${HoverConfiguration.delay}"]`));
	const languageControl = root.querySelector<HTMLElement>('[data-configuration-key="workbench.locale"] [role="combobox"]');
	assert.ok(languageControl);
	assert.equal(languageControl.textContent, 'English');
	availableLocales.push({ locale: 'fr', languageName: 'French', localizedLanguageName: 'Français', source: 'marketplace' });
	languagePacksChanged.fire();
	languageControl.click();
	const languageListId = languageControl.getAttribute('aria-controls')!;
	const languageOptions = [...ownerDocument.getElementById(languageListId)!.querySelectorAll<HTMLElement>('[role="option"]')];
	assert.deepEqual(languageOptions.map(option => option.textContent), ['English', '简体中文', 'Français']);
	languageOptions[2].click();
	await nextTurn();
	assert.equal(configuration.getValue(LocalizationConfiguration.locale), 'fr');
	assert.equal(languageControl.textContent, 'Français');
	availableLocales.pop();
	languagePacksChanged.fire();
	assert.equal(languageControl.textContent, 'fr');
	assert.equal(configuration.getValue(LocalizationConfiguration.locale), 'fr');
	await configuration.updateValue(LocalizationConfiguration.locale, 'zh-CN');
	assert.equal(languageControl.textContent, '简体中文');
	assert.equal(languageControl.getAttribute('aria-label'), 'Interface language');
	root.querySelector<HTMLButtonElement>('[data-settings-item-id="workbench.locale"] .ash-setting-item-actions-trigger')!.click();
	await menuActions.find(action => action.id === 'settings.resetSetting')!.run();
	hideMenu?.(false);
	assert.equal(languageControl.textContent, 'English');
	assert.equal(configuration.inspect(LocalizationConfiguration.locale).userValue, undefined);
	await preferences.openSettings({ section: 'source-control' });
	const autofetchControl = root.querySelector<HTMLElement>(`[data-configuration-key="${GitConfiguration.autofetch}"]`);
	assert.ok(autofetchControl);
	const autofetchButton = autofetchControl.querySelector<HTMLButtonElement>('[role="combobox"]');
	assert.equal(autofetchButton?.getAttribute('aria-label'), 'Auto Fetch');
	const autofetchListId = autofetchButton?.getAttribute('aria-controls');
	assert.ok(autofetchListId);
	autofetchButton?.click();
	ownerDocument.getElementById(autofetchListId)?.querySelectorAll<HTMLElement>('[role="option"]')[1]?.click();
	await nextTurn();
	assert.equal(autoFetch, true);
	autofetchButton?.click();
	ownerDocument.getElementById(autofetchListId)?.querySelectorAll<HTMLElement>('[role="option"]')[2]?.click();
	await nextTurn();
	assert.equal(autoFetch, 'all');

	await preferences.openSettings({ section: 'general' });
	const underline = root.querySelector<HTMLInputElement>(`[data-configuration-key="${AccessibilityConfiguration.underlineLinks}"]`);
	assert.ok(underline);
	assert.equal(underline.getAttribute('role'), 'switch');
	assert.equal(underline.getAttribute('aria-checked'), 'false');
	underline.click();
	await nextTurn();
	assert.equal(configuration.getValue(AccessibilityConfiguration.underlineLinks), true);
	assert.equal(underline.getAttribute('aria-checked'), 'true');
	const underlineIndicator = root.querySelector<HTMLElement>(`[data-settings-item-id="${AccessibilityConfiguration.underlineLinks}"] .ash-settings-indicators`);
	assert.equal(underlineIndicator?.hidden, true);
	assert.equal(underlineIndicator?.textContent, '');

	const hoverDelay = root.querySelector<HTMLInputElement>(`[data-configuration-key="${HoverConfiguration.delay}"]`);
	assert.ok(hoverDelay);
	hoverDelay.value = '750';
	hoverDelay.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
	await nextTurn();
	assert.equal(configuration.getValue(HoverConfiguration.delay), 750);

	root.querySelector<HTMLButtonElement>(`[data-settings-item-id="${HoverConfiguration.delay}"] .ash-setting-item-actions-trigger`)?.click();
	const copyAction = menuActions.find(action => action.id === 'settings.copySettingId');
	const resetAction = menuActions.find(action => action.id === 'settings.resetSetting');
	assert.ok(copyAction);
	assert.ok(resetAction);
	await copyAction.run();
	assert.deepEqual(copied, [HoverConfiguration.delay]);
	await resetAction.run();
	assert.equal(configuration.getValue(HoverConfiguration.delay), configurationRegistry.getConfiguration(HoverConfiguration.delay)?.defaultValue);

	root.querySelector<HTMLElement>('[data-settings-group-id="agents"]')?.closest<HTMLElement>('.ash-tree-row')?.click();
	assert.equal(root.querySelector('[data-tree-id="group.agents"]')?.getAttribute('aria-expanded'), 'true');
	assert.deepEqual(
		['agents', 'teams', 'agent-defaults', 'models', 'rules', 'skills', 'tools', 'sandbox', 'execution-trace', 'hooks']
			.map(categoryId => root.querySelector<HTMLElement>(`[data-settings-category-id="${categoryId}"]`)?.textContent),
		['Agents', 'Teams', 'Defaults', 'Models', 'Rules', 'Skills', 'Tools', 'Sandbox', 'Execution trace', 'Hooks'],
	);
	assert.equal(root.querySelector('[data-tree-id="general"]')?.getAttribute('aria-selected'), 'true');
	root.querySelector<HTMLElement>('[data-settings-category-id="skills"]')?.click();
	await nextTurn();
	assert.deepEqual(skillScopes, ['session-hooks']);
	const skillToggle = root.querySelector<HTMLButtonElement>('.ash-skills > button');
	assert.ok(skillToggle);
	assert.equal(skillToggle.textContent, 'Disable skill');
	skillToggle.click();
	await nextTurn();
	assert.deepEqual(skillMutations, [[skillId, false, 7, 'session-hooks']]);
	assert.equal(skillToggle.textContent, 'Enable skill');
	skillEnabled = true;
	skillsChanged.fire();
	await nextTurn();
	assert.equal(skillToggle.textContent, 'Disable skill');
	root.querySelector<HTMLElement>('[data-settings-category-id="agents"]')?.click();
	await nextTurn();
	assert.equal(root.querySelector('.ash-settings-page h3')?.textContent, 'Agents');
	const advisorSwitch = root.querySelector<HTMLInputElement>('.ash-advisor-settings input[role="switch"]');
	assert.ok(advisorSwitch);
	assert.equal(advisorSwitch.checked, true);
	advisorSwitch.checked = false;
	advisorSwitch.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
	await nextTurn();
	assert.deepEqual(advisorWrites, [{ model: advisorModel, enabled: false, maxCalls: 5, maxOutputTokens: 4096, reasoningEffort: 'high' }]);
	root.querySelector<HTMLElement>('.ash-advisor-settings [aria-haspopup="menu"]')?.click();
	const otherAdvisorOption = [...root.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(option => option.textContent === 'Muse Spark 1.3');
	assert.ok(otherAdvisorOption);
	otherAdvisorOption.click();
	await nextTurn();
	assert.deepEqual(advisorWrites[1], { model: otherAdvisorModel, enabled: true, maxCalls: 5, maxOutputTokens: 4096, reasoningEffort: 'high' });
	rejectAdvisorSave = true;
	advisorSwitch.checked = false;
	advisorSwitch.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
	await nextTurn();
	assert.equal(advisorSwitch.checked, true);
	assert.match(root.querySelector('.ash-advisor-settings [role="status"]')?.textContent ?? '', /Preference write failed/u);
	rejectAdvisorSave = false;
	advisorSwitch.checked = true;
	advisorSwitch.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
	await nextTurn();
	root.querySelector<HTMLElement>('.ash-advisor-settings [aria-haspopup="menu"]')?.click();
	const clearAdvisorOption = [...root.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(option => option.textContent === 'Disable');
	assert.ok(clearAdvisorOption);
	clearAdvisorOption.click();
	await nextTurn();
	assert.deepEqual(advisorWrites[3], { model: otherAdvisorModel, enabled: false, maxCalls: 5, maxOutputTokens: 4096, reasoningEffort: 'high' });
	assert.equal(advisorSwitch.checked, false);
	assert.equal(advisorSwitch.disabled, false);
	advisorSwitch.checked = true;
	advisorSwitch.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
	await nextTurn();
	hiddenAdvisors.add(otherAdvisorModel.model);
	modelsChanged.fire();
	await nextTurn();
	assert.equal(root.querySelector('.ash-advisor-settings [aria-haspopup="menu"]')?.textContent, 'Muse Spark 1.3');
	root.querySelector<HTMLElement>('.ash-advisor-settings [aria-haspopup="menu"]')?.click();
	assert.deepEqual([...root.querySelectorAll('[role="menuitemradio"]')].map(option => option.textContent), ['Disable', 'GPT-6.1 Sol']);
	assert.equal(advisorWrites.length, 5, 'Hiding a model must not change the saved preference');
	assert.ok(root.querySelector('.ash-advisor-settings.ash-settings-card'));
	assert.equal(root.querySelector('.ash-advisor-settings')?.textContent?.includes('Refresh'), false);
	root.querySelector<HTMLElement>('[data-settings-category-id="tools"]')?.click();
	await nextTurn();
	assert.match(root.querySelector('.ash-agent-capabilities-settings')?.textContent ?? '', /read_file/);
	root.querySelector<HTMLElement>('[data-settings-category-id="sandbox"]')?.click();
	await nextTurn();
	assert.match(root.querySelector('.ash-agent-capabilities-settings')?.textContent ?? '', /\/workspace/);
	const sandboxPanel = root.querySelector('.ash-agent-capabilities-settings')!;
	assert.match(sandboxPanel.textContent ?? '', /Policy unsupported/);
	assert.match(sandboxPanel.textContent ?? '', /<script>diagnostic<\/script>/);
	assert.equal(sandboxPanel.querySelector('script'), null);
	root.querySelector<HTMLElement>('[data-settings-category-id="tools"]')?.click();
	await nextTurn();
	assert.equal(capabilityReads, 3);
	connectionChanged.fire('disconnected');
	assert.equal(root.querySelector('.ash-agent-capabilities-status')?.textContent, 'App Server is disconnected.');
	assert.equal(root.querySelector('.ash-agent-capabilities-list'), null);
	connectionChanged.fire('connected');
	await nextTurn();
	assert.equal(capabilityReads, 4);
	assert.match(root.querySelector('.ash-agent-capabilities-settings')?.textContent ?? '', /read_file/);
	root.querySelector<HTMLElement>('[data-settings-category-id="hooks"]')?.click();
	await nextTurn();
	const hooksRoot = root.querySelector<HTMLElement>('.ash-hooks-settings');
	assert.ok(hooksRoot && !hooksRoot.hidden);
	assert.equal(hooksRoot.querySelectorAll('[data-hook-event]').length, 33, hooksRoot.outerHTML);
	assert.equal(hooksRoot.querySelector('[data-hook-event="preToolUse"] > summary')?.textContent, 'PreToolUse · 1 configured');
	assert.equal(root.querySelectorAll('input[type="search"]').length, 1);
	await configuration.updateValue(LocalizationConfiguration.locale, 'zh-CN');
	assert.equal(hooksRoot.querySelector('[data-hook-action="edit-scope"]')?.textContent, 'Edit TOML');
	await configuration.updateValue(LocalizationConfiguration.locale, 'en');
	assert.match(hooksRoot.querySelector('[data-hook-id="user:hook:check"]')?.textContent ?? '', /Disabled.*Source file.*\/profile\/config.toml.*two words/s);
	const hookSearch = root.querySelector<HTMLInputElement>('.ash-settings-search input');
	assert.ok(hookSearch);
	hookSearch.value = 'two words';
	hookSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.deepEqual([...hooksRoot.querySelectorAll<HTMLElement>('.ash-hooks-event')].filter(row => !row.hidden).map(row => row.dataset.hookEvent), ['preToolUse']);
	hooksRoot.querySelector<HTMLElement>('summary')?.focus();
	const contentProvider = AccessibleViewRegistry.getImplementations().find(provider => provider.name.startsWith('hooks-settings-') && provider.type === AccessibleViewType.View)?.getProvider(editorServices);
	assert.ok(contentProvider);
	assert.match(contentProvider.provideContent(), /user:hook:check/);
	contentProvider.dispose();
	hooksRoot.querySelector<HTMLButtonElement>('[data-hook-action="edit-scope"]')?.click();
	await nextTurn();
	assert.equal(openUserToml, 1);
	hookSearch.value = '';
	hookSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	sources = [{ namespace: 'user', configPath: '/profile/config.toml', hooks: [] }];
	hooksChanged.fire();
	await nextTurn();
	assert.equal(hookReads, 2);
	assert.equal(hooksRoot.querySelectorAll('.ash-hooks-declaration').length, 0);
	const pendingHooks = new DeferredPromise<readonly HookSource[]>();
	nextHooksRead = pendingHooks.p;
	hooksChanged.fire();
	root.querySelector<HTMLElement>('[data-settings-category-id="models"]')?.click();
	await pendingHooks.complete([{ namespace: 'user', configPath: '/stale/config.toml', hooks: [] }]);
	await nextTurn();
	assert.equal(hooksRoot.querySelector<HTMLButtonElement>('[data-hook-action="edit-scope"]')?.title, '/profile/config.toml');
	root.querySelector<HTMLElement>('[data-settings-category-id="hooks"]')?.click();
	await nextTurn();
	assert.equal(hookReads, 4);
	assert.doesNotMatch(hooksRoot.textContent ?? '', /\/stale\/config.toml/);
	hooksFailure = true;
	hooksChanged.fire();
	await nextTurn();
	assert.match(hooksRoot.querySelector('[role="status"]')?.textContent ?? '', /Invalid TOML/);
	const userTomlButton = hooksRoot.querySelector<HTMLButtonElement>('[data-hook-action="edit-scope"]');
	assert.ok(userTomlButton && !userTomlButton.disabled);
	userTomlButton.click();
	await nextTurn();
	assert.equal(openUserToml, 2);
	hooksFailure = false;
	connectionIdentity = { kind: 'ssh', host: 'test-server', authority: 'ssh+test-server', generation: 2 };
	connectionIdentityChanged.fire(connectionIdentity);
	await nextTurn();
	assert.equal(userTomlButton.disabled, true);
	connectionIdentity = { kind: 'local', generation: 3 };
	connectionIdentityChanged.fire(connectionIdentity);
	await nextTurn();
	assert.equal(userTomlButton.disabled, false);

	hookSearch.value = '';
	hookSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	hooksRoot.querySelector<HTMLButtonElement>('[data-hook-action="ask-scope"]')?.click();
	await nextTurn();
	assert.equal(host.hidden, true);
	assert.match(prompts[0] ?? '', /\/profile\/config.toml.*namespace \(user\)/);
	await preferences.openSettings();
	await preferences.openSettings({ section: 'dictation' });
	assert.equal(root.querySelector('[data-settings-container]')?.getAttribute('data-active-settings-category'), 'voice-input');
	assert.equal(root.querySelector('[data-tree-id="voice-input"]')?.getAttribute('aria-selected'), 'true');
	assert.equal(root.querySelector('[data-settings-category-id="dictation"]'), null);
	assert.equal(root.querySelector('[data-settings-target-id]'), null);
	assert.equal(root.querySelector('[data-settings-tree-group-id="dictation"] .ash-settings-tree-group-title')?.textContent, 'Voice input');
	await configuration.updateValue(LocalizationConfiguration.locale, 'zh-CN');
	assert.equal(root.querySelector('[data-settings-tree-group-id="dictation"] .ash-settings-tree-group-title')?.textContent, 'Voice input');
	const dictationSearch = root.querySelector<HTMLInputElement>('.ash-settings-search input')!;
	dictationSearch.value = 'dictation';
	dictationSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.ok(root.querySelector('[role="grid"][aria-label="Local dictation models"]'));
	assert.ok(root.querySelector('[data-settings-category-id="voice-input"]'));
	dictationSearch.value = '';
	dictationSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	await configuration.updateValue(LocalizationConfiguration.locale, 'en');
	assert.equal(root.querySelector('[data-configuration-key="dictation.localModel"]'), null);
	assert.ok(root.querySelector('[role="grid"][aria-label="Local dictation models"]'));
	root.querySelector<HTMLElement>('[data-settings-group-id="agents"]')?.click();
	root.querySelector<HTMLElement>('[data-settings-category-id="models"]')?.click();
	await nextTurn();
	assert.equal(root.querySelector('[data-settings-container]')?.getAttribute('data-active-settings-category'), 'models');
	assert.equal(root.querySelector('[data-configuration-key="dictation.localModel"]'), null);
	const modelSwitch = root.querySelector<HTMLInputElement>('.ash-models-settings-model-row input[role="switch"]');
	assert.ok(modelSwitch);
	assert.equal(modelSwitch.getAttribute('aria-label'), 'Show GPT Test in model picker');
	modelSwitch.click();
	await nextTurn();
	assert.deepEqual(modelWrites, [false]);
	assert.equal(modelSwitch.getAttribute('aria-checked'), 'false');
	const modelSearch = root.querySelector<HTMLInputElement>('.ash-settings-search input');
	assert.ok(modelSearch);
	modelSearch.value = 'missing';
	modelSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.equal(root.querySelector('.ash-models-settings-model-row'), null);
	modelSearch.value = '';
	modelSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	const apiInput = root.querySelector<HTMLInputElement>('.ash-models-settings-api-controls input[type="password"]');
	assert.ok(apiInput);
	assert.equal(apiInput.closest('.ash-models-settings-api-controls')?.querySelector('button'), null);
	apiInput.value = 'test-secret';
	apiInput.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	apiInput.dispatchEvent(new browserEnvironment.window.Event('blur'));
	await nextTurn();
	assert.deepEqual(savedKeys, ['test-secret']);
	assert.equal(root.textContent?.includes('test-secret'), false);
	root.querySelector<HTMLElement>('[data-settings-category-id="teams"]')?.click();
	assert.equal(root.querySelector<HTMLElement>('[data-settings-container]')?.dataset.activeSettingsCategory, 'teams');
	assert.equal(root.querySelector('.ash-settings-page h3')?.textContent, 'Teams');
	assert.equal(root.querySelectorAll('.ash-settings-content-tree [data-settings-item-id]').length, 0);
	root.querySelector<HTMLElement>('[data-settings-group-id="agents"]')?.closest<HTMLElement>('.ash-tree-row')?.click();
	assert.equal(root.querySelector('[data-tree-id="group.agents"]')?.getAttribute('aria-selected'), 'true');
	root.querySelector<HTMLElement>('[data-settings-group-id="agents"]')?.closest<HTMLElement>('.ash-tree-row')?.click();
	assert.equal(root.querySelector('[data-tree-id="teams"]')?.getAttribute('aria-selected'), 'true');

	const search = root.querySelector<HTMLInputElement>('.ash-settings-search input');
	assert.ok(search);
	search.value = 'subagent';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.equal(root.querySelector('[data-settings-category-id="agents"]')?.textContent, 'Agents');
	assert.equal(root.querySelector('[data-settings-category-id="teams"]'), null);
	search.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
	assert.equal(search.value, '');
	search.value = 'workbench.colorTheme';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.equal(root.querySelector('[data-settings-category-id="appearance"]')?.textContent, 'Appearance');
	search.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));

	root.querySelector<HTMLElement>('[data-settings-group-id="editor"]')?.click();
	root.querySelector<HTMLElement>('[data-settings-category-id="editor-fonts"]')?.click();
	assert.equal(root.querySelector<HTMLElement>('[data-settings-container]')?.dataset.activeSettingsCategory, 'editor-fonts');
	assert.ok(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontFamily}"]`));
	assert.equal(root.querySelector(`[data-configuration-key="${EditorSelectionConfiguration.defaultNewDocumentEditor}"]`), null);
	assert.equal(root.querySelector('[data-settings-item-id^="models.item."]'), null);
	const fontFamily = root.querySelector<HTMLInputElement>(`[data-configuration-key="${CodeEditorConfiguration.fontFamily}"]`);
	assert.ok(fontFamily);
	fontFamily.value = 'Fira Code';
	fontFamily.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
	await nextTurn();
	assert.equal(configuration.getValue(CodeEditorConfiguration.fontFamily), 'Fira Code');
	search.value = '@modified @id:editor.font*';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.ok(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontFamily}"]`));
	assert.equal(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontSize}"]`), null);
	fontFamily.focus();
	await configuration.updateValue(CodeEditorConfiguration.fontFamily, 'Iosevka');
	assert.equal(ownerDocument.activeElement, fontFamily, 'accepted writes retain focus on rows that still match');
	await configuration.updateValue(CodeEditorConfiguration.fontFamily, undefined);
	assert.equal(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontFamily}"]`), null);
	assert.equal(root.querySelector<HTMLElement>('.ash-settings-page [role="status"]')?.hidden, false);
	await configuration.updateValue(CodeEditorConfiguration.fontFamily, 'Fira Code');
	assert.equal(root.querySelector(`[data-configuration-key="${CodeEditorConfiguration.fontFamily}"]`), fontFamily);
	search.value = '';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	root.querySelector<HTMLButtonElement>('.ash-settings-search-filter')?.click();
	assert.deepEqual(menuActions.filter(action => action.label).map(action => action.label), ['Modified', 'Setting ID…', 'Clear Filters']);
	const idFilter = menuActions.find(action => action.id === 'settings.search.id');
	assert.ok(idFilter);
	await idFilter.run();
	hideMenu?.(false);
	assert.equal(search.value, '@id:');
	search.value = '@id:editor.fontFamily';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.ok(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontFamily}"]`));
	assert.equal(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontSize}"]`), null);
	root.querySelector<HTMLButtonElement>('.ash-settings-search-filter')?.click();
	const clearFilters = menuActions.find(action => action.id === 'settings.search.clearFilters');
	assert.ok(clearFilters);
	assert.equal(clearFilters.enabled, true);
	await clearFilters.run();
	hideMenu?.(false);
	assert.equal(search.value, '');

	search.value = 'font family';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.equal(root.querySelectorAll('.ash-settings-content-tree [data-settings-item-id]').length, 3);
	assert.ok(root.querySelector('[data-settings-item-id="chat.input.fontFamily"]'));
	assert.ok(root.querySelector('[data-settings-item-id="chat.editor.fontFamily"]'));
	assert.ok(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontFamily}"]`));
	assert.equal(root.querySelector(`[data-configuration-key="${CodeEditorConfiguration.fontFamily}"]`), fontFamily);
	search.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }));
	assert.equal(root.querySelector('.ash-settings-navigation-tree')?.contains(ownerDocument.activeElement), true);
	search.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
	assert.equal(search.value, '');
	assert.ok(root.querySelectorAll('.ash-settings-content-tree [data-settings-item-id]').length > 1);
	const commands = editorServices.get(ICommandService);
	await commands.executeCommand('workbench.action.openSettings', 'editor.fontFamily');
	assert.equal(root.querySelector('.ash-settings-search input'), search, 'query opening reuses the search owner');
	assert.equal(search.value, 'editor.fontFamily');
	assert.equal(ownerDocument.activeElement, search);
	assert.deepEqual([...root.querySelectorAll<HTMLElement>('.ash-settings-content-tree [data-settings-item-id]')].map(row => row.dataset.settingsItemId).sort(), ['chat.editor.fontFamily', 'editor.fontFamily']);
	assert.equal(root.querySelector(`[data-configuration-key="${CodeEditorConfiguration.fontFamily}"]`), fontFamily);
	await commands.executeCommand('workbench.action.openSettings', { query: '@id:editor.fontSize' });
	assert.equal(search.value, '@id:editor.fontSize');
	assert.equal(root.querySelectorAll('.ash-settings-content-tree [data-settings-item-id]').length, 1);
	await assert.rejects(commands.executeCommand('workbench.action.openSettings', { query: 'changed', target: 5 }));
	assert.equal(search.value, '@id:editor.fontSize');
	await preferences.openSettings();
	assert.equal(search.value, '@id:editor.fontSize', 'an opening request without query preserves the current filter');
	await commands.executeCommand('workbench.action.openSettings', { query: '' });
	assert.equal(search.value, '');
	assert.equal(ownerDocument.activeElement, search);
	assert.ok(root.querySelectorAll('.ash-settings-content-tree [data-settings-item-id]').length > 1);
	await preferences.openSettings({ section: 'models' });
	assert.equal(root.querySelector<HTMLElement>('[data-settings-container]')?.dataset.activeSettingsCategory, 'models');

	root.querySelector<HTMLButtonElement>('.ash-modal-editor-close')?.click();
	await nextTurn();
	assert.equal(host.hidden, true);
	assert.equal(ownerDocument.activeElement, trigger);
	await configuration.updateValue(CodeEditorConfiguration.fontFamily, 'After close');
	assert.equal(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontFamily}"]`), null);
});

function findSettingCategory(layout: ReturnType<typeof createSettingsLayout>, settingId: string): string | undefined {
	return layout.find(category => category.groups.some(group => group.settings.some(setting => setting.id === settingId)))?.id;
}

async function nextTurn(): Promise<void> {
	await new Promise<void>(resolve => setTimeout(resolve, 0));
}

test('Local model controls share translated snapshots and keep preparation running when hidden', async () => {
	using resources = new DisposableStore();
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	resources.add(toDisposable(resetNlsResolver));
	const configuration = resources.add(new WorkbenchConfigurationService());
	await configuration.updateValue(DictationConfiguration.localModel, 'imported-model');
	const services = resources.add(new InstantiationService());
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(ConfigurationServiceId, configuration);
	const changed = resources.add(new Emitter<void>());
	let modelStatus: ILocalTranscriptionModelStatus | undefined;
	const progress = (status: ILocalTranscriptionModelStatus): void => { modelStatus = status; changed.fire(); };
	let finish!: (state: ModelState.Cancelled) => void;
	let cancellations = 0;
	const imported: unknown[] = [];
	services.registerInstance(ILocalTranscriptionService, {
		isSupported: true,
		getModelStatus: async (model: string) => ({ model, available: false, sizeBytes: 0, status: modelStatus }),
		listModels: async () => [],
		onDidChangeModels: changed.event,
		cancelModel: async () => { cancellations++; progress({ state: LocalTranscriptionModelState.Cancelled }); finish(LocalTranscriptionModelState.Cancelled); },
		importModel: (options: unknown, onProgress: typeof progress) => {
			imported.push(options);
			progress({ state: LocalTranscriptionModelState.Checking });
			return {
				completed: new Promise<ModelState.Cancelled>(resolve => { finish = resolve; }),
				cancel: async () => { cancellations++; progress({ state: LocalTranscriptionModelState.Cancelled }); finish(LocalTranscriptionModelState.Cancelled); },
				dispose() { },
			};
		},
	} as unknown as LocalTranscriptionService);
	const root = h(browserEnvironment.window.document, 'div');
	const controls = resources.add(services.createInstance(LocalTranscriptionModelControls, root));
	controls.setVisible(true);
	await nextTurn();
	const status = root.querySelector<HTMLElement>('[role="status"]')!;
	assert.equal(status.textContent, '模型包尚未安装：imported-model');
	const source = root.querySelector<HTMLInputElement>('input')!;
	assert.equal(source.getAttribute('aria-label'), '已准备好的 Paraformer 模型目录');
	assert.equal(root.querySelector('label')?.htmlFor, source.id);
	source.value = 'C:\\prepared-model';
	source.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')];
	const importButton = buttons.find(button => button.textContent === '导入模型')!;
	assert.equal(importButton.disabled, false);
	importButton.click();
	assert.deepEqual(imported, [{ model: 'imported-model', sourcePath: 'C:\\prepared-model' }]);
	assert.equal(importButton.disabled, true);
	progress({ state: LocalTranscriptionModelState.Downloading, file: 'encoder.onnx', downloadedBytes: 2 * 1024 * 1024 });
	await nextTurn();
	assert.equal(status.textContent, '正在下载 encoder.onnx：2.0 MiB');
	assert.equal(status.getAttribute('aria-atomic'), 'true');
	controls.setVisible(false);
	await nextTurn();
	assert.equal(cancellations, 0);
	controls.setVisible(true);
	await nextTurn();
	assert.equal(root.querySelector<HTMLProgressElement>('progress')?.hasAttribute('value'), false);
	buttons.find(button => button.textContent === '取消')!.click();
	await nextTurn();
	assert.equal(cancellations, 1);
	assert.equal(importButton.disabled, false);
	assert.equal(buttons.find(button => button.textContent === '取消')?.classList.contains('hidden'), true);
});

test('Models Settings collapses by provider and saves keys and custom models on blur', async () => {
	using disposables = new DisposableStore();
	const document = browserEnvironment.window.document;
	document.body.replaceChildren();
	const root = h(document, 'div');
	document.body.append(root);
	const saved: import('../../../../../platform/sessions/common/sessionApi.js').CustomModelProvider[] = [];
	const keys: string[] = [];
	let removed = 0;
	let failed = false;
	let rejectKey = false;
	const model = { provider: 'openai', model: 'newest' };
	const chat = {
		onDidChangeModels: Event.None,
		listModelCatalog: async () => [
			{ model, displayName: 'Newest OpenAI' },
			{ model: { provider: 'openai', model: 'older' }, displayName: 'Older OpenAI' },
			{ model: { provider: 'anthropic', model: 'opus' }, displayName: 'Opus' },
		],
		listModelProviders: async () => ['openai', 'openai-compatible'].map(connection => ({ connection, provider: connection, displayName: connection, apiKeyPolicy: 'required', apiKeyConfigured: true })),
		setModelPreferences: async () => { },
		listCustomModelProviders: async () => [],
		isModelVisible: () => true,
		saveCustomModelProvider: async (provider: typeof saved[number]) => { saved.push(provider); },
		setModelProviderApiKey: async (_id: string, key: string) => { if (rejectKey) throw new Error('Key write rejected'); keys.push(key); },
		removeModelProviderApiKey: async () => { removed++; },
		refreshModels: async () => [],
		testProviderModel: async () => failed ? { type: 'failed', message: 'Endpoint rejected this model' } : { type: 'passed' },
	} as unknown as IChatService;
	const configuration = disposables.add(new WorkbenchConfigurationService());
	const services = disposables.add(new InstantiationService());
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(ChatServiceId, chat);
	services.registerInstance(INotificationService, disposables.add(new NotificationService()));
	services.registerInstance(ILanguageModelsService, chat as unknown as ILanguageModelsService);
	services.registerInstance(IExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
	services.registerInstance(IContextViewService, disposables.add(new BrowserContextViewService(root)));
	services.registerInstance(ConfigurationServiceId, configuration);
	services.registerInstance(IAccessibleViewService, { show: () => true, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } });
	const content = disposables.add(services.createInstance(ModelSettingsContent, root));
	const modelTree = disposables.add(new SettingsTreeModel<SettingsContentItem>());
	disposables.add(new SettingsTree(root, { model: modelTree, rootClassName: 'ash-models-settings', groupClassName: 'ash-settings-content-group', groupDescriptionClassName: 'ash-settings-group-description', itemsClassName: 'ash-settings-list', renderItem: item => item.value.domNode }));
	disposables.add(content.onDidChange(() => modelTree.setChildren([{ element: { kind: 'group', id: 'models', title: 'Models', description: '' }, children: content.getNodes() }])));
	content.setVisible(true);
	await nextTurn();
	assert.deepEqual([...root.querySelectorAll('.ash-models-settings-model-copy')].map(row => row.textContent), ['Newest OpenAI', 'Opus']);
	const expand = root.querySelector<HTMLButtonElement>('.ash-models-settings-expand button')!;
	expand.click();
	assert.equal(root.querySelectorAll('.ash-models-settings-model-row').length, 3);
	assert.equal(expand.getAttribute('aria-expanded'), 'true');
	expand.click();
	assert.equal(root.querySelectorAll('.ash-models-settings-model-row').length, 2);
	assert.equal(content.getNodes(new SettingsSearchQuery('Older')).flatMap(node => node.children ?? []).some(node => node.element.kind === 'item' && node.element.title === 'Older OpenAI'), true);
	const search = root.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
	const searchModels = (value: string): void => {
		search.value = value;
		search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	};
	search.focus();
	searchModels('OPENAI/OLDER');
	assert.deepEqual([...root.querySelectorAll('.ash-models-settings-model-copy')].map(row => row.textContent), ['Older OpenAI']);
	assert.equal(document.activeElement, search);
	assert.equal(root.querySelectorAll('.ash-models-settings-api-row').length, 1);
	searchModels('missing model');
	assert.equal(root.querySelectorAll('.ash-models-settings-model-row').length, 0);
	assert.match(root.textContent ?? '', /No models found/);
	assert.equal(document.activeElement, search);
	searchModels('');
	assert.deepEqual([...root.querySelectorAll('.ash-models-settings-model-copy')].map(row => row.textContent), ['Newest OpenAI', 'Opus']);
	assert.equal(root.querySelectorAll('.ash-models-settings-api-row').length, 1);
	const input = root.querySelector<HTMLInputElement>('.ash-models-settings-api-row input')!;
	const edit = (field: HTMLInputElement, value: string): void => {
		field.value = value;
		field.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
		field.dispatchEvent(new browserEnvironment.window.Event('blur'));
	};
	input.dispatchEvent(new browserEnvironment.window.Event('blur'));
	await nextTurn();
	assert.deepEqual(keys, []);
	assert.equal(removed, 0, 'An untouched masked key must not be removed');
	edit(input, 'new-test-key');
	await nextTurn();
	assert.deepEqual(keys, ['new-test-key']);
	assert.equal(input.value, '••••••••');
	edit(input, '');
	await nextTurn();
	assert.equal(removed, 1);
	rejectKey = true;
	edit(input, 'retry-test-key');
	await nextTurn();
	assert.equal(input.getAttribute('aria-invalid'), 'true');
	assert.equal(input.value, 'retry-test-key');
	rejectKey = false;
	input.dispatchEvent(new browserEnvironment.window.Event('blur'));
	await nextTurn();
	assert.equal(input.value, '••••••••');
	assert.equal(input.hasAttribute('aria-invalid'), false);
	root.querySelector<HTMLButtonElement>('.ash-models-settings-provider-title button')!.click();
	const card = root.querySelector<HTMLElement>('.ash-chat-models-widget')!;
	assert.equal(document.activeElement, card.querySelector('input'));
	edit(card.querySelector<HTMLInputElement>('input[aria-label="Provider name"]')!, 'Gateway');
	edit(card.querySelector<HTMLInputElement>('input[aria-label="Base URL"]')!, 'https://example.test/v1');
	await nextTurn();
	const button = (label: string): HTMLButtonElement => [...card.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent === label)!;
	button('Add model').click();
	const first = card.querySelector<HTMLInputElement>('input[aria-label="Model ID"]')!;
	edit(first, 'first-private-model');
	card.querySelector<HTMLInputElement>('input[role="switch"][aria-label="1M context"]')!.click();
	button('Save model').click();
	await nextTurn();
	button('Add model').click();
	edit(first, 'second-private-model');
	edit(card.querySelector<HTMLInputElement>('input[aria-label="Context window (tokens)"]')!, '128000');
	button('Save model').click();
	await nextTurn();
	assert.deepEqual(saved.at(-1)?.models, [{ id: 'first-private-model', contextWindow: 1_000_000 }, { id: 'second-private-model', contextWindow: 128_000 }]);
	const testButton = button('Test models');
	testButton.click();
	await nextTurn();
	assert.equal(card.querySelector('.ash-chat-models-test-status')?.classList.contains('passed'), true);
	edit(card.querySelector<HTMLInputElement>('input[aria-label="Base URL"]')!, 'https://another.test/v1');
	await nextTurn();
	assert.equal(card.querySelector('.ash-chat-models-test-status')?.classList.contains('passed'), false);
	failed = true;
	testButton.click();
	await nextTurn();
	assert.match(card.textContent ?? '', /Endpoint rejected this model/);
	button('Add model').click();
	first.focus();
	const help = AccessibleViewRegistry.getImplementations().find(provider => provider.name.startsWith('models-settings-'))?.getProvider(services);
	assert.match(help?.provideContent() ?? '', /clear the field to remove a key/);
	help?.dispose();
});

test('Custom provider fields and test states use the Chinese catalog', () => {
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		assert.equal(localize('models.catalog.search', 'Search models'), '搜索模型');
		assert.equal(localize('models.provider.name', 'Provider name'), '供应商名称');
		assert.equal(localize('models.provider.context', '1M context'), '1M 上下文');
		assert.equal(localize('models.provider.passed', 'Model test passed'), '模型测试通过');
		assert.equal(localize('models.discovery.unsupported', 'This endpoint does not provide a model list. Add model IDs manually.'), '此端点不提供模型列表，请手动添加模型 ID。');
		assert.equal(localize('models.provider.contextWindow', 'Context window (tokens)'), '上下文长度（tokens）');
	} finally { resetNlsResolver(); }
});

function createSettingWidget(resources: import('../../../../../base/common/lifecycle.js').DisposableStore, container: HTMLElement, setting: ISetting,
	options: import('../../browser/settingsWidgets.js').SettingWidgetOptions & {
		clipboardService: IClipboardService;
		configurationService: import('../../../../../platform/configuration/common/configuration.js').IConfigurationService;
		contextMenuProvider: import('../../../../../base/browser/contextmenu.js').IContextMenuProvider;
		contextViewProvider: import('../../../../../platform/contextview/browser/contextView.js').IContextViewService;
	}): import('../../browser/settingsWidgets.js').SettingWidget {
	const services = resources.add(new InstantiationService());
	services.registerInstance(ClipboardServiceId, options.clipboardService);
	services.registerInstance(ConfigurationServiceId, options.configurationService);
	services.registerInstance(IContextViewService, options.contextViewProvider);
	services.registerInstance(IContextMenuService, { ...options.contextMenuProvider, onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, hideContextMenu() { } });
	return instantiateSettingWidget(container, setting, { onStatus: options.onStatus, onOpenSettings: options.onOpenSettings }, services);
}

test('Settings widgets require their scoped clipboard registration and clean up when creation fails', async () => {
	using resources = new DisposableStore();
	const root = h(browserEnvironment.window.document, 'div');
	browserEnvironment.window.document.body.append(root);
	resources.add(toDisposable(() => root.remove()));
	const services = resources.add(new InstantiationService());
	const configuration = resources.add(new WorkbenchConfigurationService());
	services.registerInstance(ConfigurationServiceId, configuration);
	services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(root)));
	services.registerInstance(IContextMenuService, { showContextMenu() { }, hideContextMenu() { }, onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None });
	assert.throws(() => instantiateSettingWidget(root, new DefaultSettings().get('editor.lineNumbers'), { onStatus() { } }, services), /clipboardService/);
	assert.equal(root.querySelector('.ash-configuration-setting'), null);
});
