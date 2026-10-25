import { Range } from '../../../../../../editor/common/core/range.js';
import { ILanguageFeaturesService } from '../../../../../../editor/common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../../../../editor/common/services/languageFeaturesService.js';
import { IWorkingCopyService } from '../../../../../services/workingCopy/common/workingCopyService.js';
import { KeyCode } from '../../../../../../base/common/keyCodes.js';
import { Keybinding, logicalKey, physicalKey, resolveKeybinding } from '../../../../../../base/common/keybindings.js';
import { OperatingSystem } from '../../../../../../base/common/platform.js';
import { KeybindingsRegistry, KeybindingSource } from '../../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { inQuickInputContext } from '../../../../../../platform/quickinput/browser/quickInput.js';
import { addDisposableListener } from '../../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ICodeEditorService } from '../../../../../../editor/browser/services/codeEditorService.js';
import { formatNlsMessage, setNlsResolver } from '../../../../../../nls.js';
import { Action2, IMenuService, registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../../platform/actions/common/menuService.js';
import { CommandsRegistry, ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IAccountService } from '../../../../../../platform/accounts/common/accountService.js';
import { GitHubError, GitHubErrorCode, IGitHubService } from '../../../../../../platform/github/common/githubService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../../../../test/fixtures/browser/notificationFixture.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { GitHubReviewModel, IGitHubReviewModel } from '../../../../github/browser/githubReviewModel.js';
import { URI } from '../../../../../../base/common/uri.js';
import { posix } from '../../../../../../base/common/path.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IPathService } from '../../../../../../platform/path/common/pathService.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IHistoryService } from '../../../../../services/history/common/history.js';
import { IEditorGroupsService } from '../../../../../services/editor/common/editorGroupsService.js';
import { ISearchService } from '../../../../../services/search/common/search.js';
import { IFileSearchService } from '../../../../../../platform/search/common/fileSearch.js';
import { BrowserFileSearchService } from '../../../../../../platform/search/browser/browserFileSearchService.js';
import { AgentHostFileSearchProvider } from '../../../../../services/agentHost/common/agentHostFileSearchProvider.js';
import { TestWorkspaceService } from '../../../../../services/configuration/test/common/testServices.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import type { IUserFriendlyKeybinding } from '../../../../../../platform/keybinding/common/keybinding.js';
import { Event } from '../../../../../../base/common/event.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { IEditorPartsService } from '../../../../../browser/parts/editor/editorParts.js';
import { CommandService } from '../../../../../services/commands/common/commandService.js';
import { DialogService } from '../../../../../services/dialogs/common/dialogService.js';
import { CodeEditorService } from '../../../../../services/editor/browser/codeEditorService.js';
import { productLanguagePackCatalogs } from '../../../../../services/localization/common/localizationCatalogs.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import type { EditorOpenOptions } from '../../../../../services/editor/common/editorService.js';
import type { IResourceEditorInput } from '../../../../../common/editor.js';
import type { IEditorPart as EditorPartContract } from '../../../../../browser/parts/editor/editorPart.js';
import { BrowserStorageService } from '../../../../../services/storage/browser/storageService.js';
import { IPreferencesService } from '../../../../../services/preferences/common/preferences.js';
import '../../../../../browser/media/style.css';
import '../../../../../../base/browser/ui/inputbox/inputbox.css';

declare global {
	interface Window {
		ashQuickAccessIntegration: {
			align(alignment: 'top' | 'center'): void;
			showAnchored(): void;
			showInput(): void;
			setNavigationBinding(mode: 'default' | 'rebound' | 'blocked'): void;
			setHistoryLength(value: number): Promise<void>;
			setSearchPatterns(include: string, exclude: string): Promise<void>;
			writeShortcutBindings(bindings: readonly IUserFriendlyKeybinding[]): Promise<void>;
			show(value: string, scoped?: boolean): void;
			setSignedIn(value: boolean): void;
			holdNextRequest(): void;
			releaseRequest(): void;
			requests: { kind: string; query?: string; page: number; }[];
			keybindingRequests: { textual: boolean; query?: string; pickerVisible: boolean; }[];
			executions: readonly string[];
		};
	}
}

const parameters = new URLSearchParams(location.search);
if (parameters.get('locale') === 'zh-CN') {
	const catalog = productLanguagePackCatalogs.find(value => value.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, values) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, values));
}
await import('../../../browser/quickAccess.contribution.js');
await import('../../../../search/browser/searchQuickAccess.contribution.js');
await import('../../../../github/browser/github.contribution.js');
const resources = new DisposableStore();
const services = resources.add(new InstantiationService());
const configuration = resources.add(new InMemoryConfigurationService());
services.registerInstance(IConfigurationService, configuration);
services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'quick-access', flushInterval: 0 })));
services.registerInstance(IEditorPartsService, { activePane: undefined } as unknown as IEditorPartsService);
services.registerSingleton(ICodeEditorService, () => services.createInstance(CodeEditorService));
services.registerInstance(IDialogService, resources.add(new DialogService()));
const shortcutOS = parameters.get('os') === 'windows' ? OperatingSystem.Windows : parameters.get('os') === 'linux' ? OperatingSystem.Linux : OperatingSystem.Macintosh;
let writeShortcutBindings: ((bindings: readonly IUserFriendlyKeybinding[]) => Promise<void>) | undefined;
const commandBindings = new Map([
	['test.quickAccess.AlphaFormat', resolveKeybinding(Keybinding.single(logicalKey('p', { primaryKey: true, shiftKey: true })), shortcutOS)],
	['test.quickAccess.Format', resolveKeybinding(Keybinding.chord(logicalKey('k', { primaryKey: true }), logicalKey('Enter', { primaryKey: true })), shortcutOS)],
	['test.quickAccess.ZuluFormat', resolveKeybinding(Keybinding.single(physicalKey('F1')), shortcutOS)],
]);
services.registerInstance(IKeybindingService, {
	lookupKeybinding: (command: string) => commandBindings.get(command),
	resolveKeybinding: (binding: Keybinding) => resolveKeybinding(binding, shortcutOS),
	getKeybindings: () => [],
	onDidUpdateKeybindings: Event.None,
} as unknown as IKeybindingService);
const contexts = resources.add(new ContextKeyService());
const commands = resources.add(new CommandService(services));
services.registerInstance(ICommandService, commands);
services.registerInstance(INotificationService, resources.add(new TestNotificationService()));
if (!parameters.has('shortcuts')) {
	services.registerInstance(IEditorService, {
		openEditor: async input => { document.querySelector('output')!.textContent = input.resource.toString(); },
	} as IEditorService);
}
services.registerInstance(IPathService, { getPath: async () => posix } as unknown as IPathService);
services.registerInstance(IHistoryService, { getHistory: () => [{ resource: URI.file('/workspace/Fix.ts') }] } as unknown as IHistoryService);
services.registerInstance(IEditorGroupsService, { groups: [] } as unknown as IEditorGroupsService);
if (parameters.has('fileSearch')) {
	const files = resources.add(new FileService());
	const storage = resources.add(new InMemoryFileSystemProvider());
	resources.add(files.registerProvider('file', storage));
	await files.createDirectory(URI.file('/workspace/src'));
	for (const path of ['needle.ts', 'src/needle_skip.ts', 'src/long_needle.ts', 'src/long_needle.md']) {
		await files.writeFile({ resource: URI.file(`/workspace/${path}`), content: 'fixture' }, { create: true, overwrite: false });
	}
	services.registerInstance(IFileService, files);
	services.registerInstance(IWorkspaceContextService, resources.add(new TestWorkspaceService({ id: 'quick-access', folders: [{ id: 'folder', uri: URI.file('/workspace'), name: 'repo', index: 0 }] })));
	services.registerInstance(IFileSearchService, services.createInstance(BrowserFileSearchService));
	const provider = resources.add(services.createInstance(AgentHostFileSearchProvider));
	services.registerInstance(ISearchService, { fileSearch: provider.fileSearch.bind(provider), textSearch: async () => { throw new Error('Filename fixture must not search contents'); } });
} else {
	services.registerInstance(IFileService, { hasProvider: () => true } as unknown as IFileService);
	services.registerInstance(IWorkspaceContextService, {
		getWorkspace: () => ({ id: 'quick-access', folders: [{ uri: URI.file('/workspace'), name: 'repo', index: 0 }] }),
	} as unknown as IWorkspaceContextService);
	services.registerInstance(ISearchService, { fileSearch: async () => ({ results: [], limitHit: false }) } as unknown as ISearchService);
}
let signedIn = true;
let holdNext = false;
let releaseHeld: (() => void) | undefined;
const requests: { kind: string; query?: string; page: number; }[] = [];
const accounts = () => signedIn ? [{ id: 'alice', host: 'github.com', login: 'Alice', status: 'ready' as const, credentialRevision: 1n }] : [];
services.registerInstance(IAccountService, { onDidChangeAccounts: Event.None } as IAccountService);
const languageFeatures = resources.add(new LanguageFeaturesService());
services.registerInstance(ILanguageFeaturesService, languageFeatures);
services.registerInstance(IWorkingCopyService, { get: () => [] } as unknown as IWorkingCopyService);
resources.add(languageFeatures.workspaceSymbolProvider.register('*', {
	provideWorkspaceSymbols: async query => {
		requests.push({ kind: 'symbols', query, page: 1 });
		if (holdNext) {
			holdNext = false;
			await new Promise<void>(resolve => { releaseHeld = resolve; });
		}
		return [{ name: `${query}Symbol`, kind: 'function', resource: URI.file('/workspace/symbol.ts'), range: new Range(2, 1, 2, 4) }];
	},
}));
const github: Partial<IGitHubService> = {
	listAccounts: async () => accounts(),
	listIssues: async (_repository, _state, query, page) => {
		requests.push({ kind: 'issues', query, page });
		return { items: query && !'fix issue #9'.includes(query.toLowerCase()) ? [] : [{ number: 9, title: 'Fix issue', url: 'https://github.com/team/repo/issues/9', updatedAt: 'now', state: 'open', labels: [], assignees: [] }], nextPage: null, notice: '' };
	},
	listPullRequests: async (_repository, _state, page) => {
		requests.push({ kind: 'prs', page });
		if (holdNext) {
			holdNext = false;
			await new Promise<void>(resolve => { releaseHeld = resolve; });
		}
		if (!signedIn) throw new GitHubError(GitHubErrorCode.AuthenticationRequired);
		return { items: [{ number: page === 1 ? 7 : 8, title: page === 1 ? 'Fix rendering' : 'Add navigation', body: '', url: 'https://github.com/team/repo/pull/7', state: 'open', draft: false, mergedAt: null, mergeable: null, headCommit: 'a'.repeat(40), headBranch: 'feature', headRepository: 'team/repo', baseBranch: 'main', autoMerge: false }], nextPage: page === 1 ? 2 : null };
	},
};
services.registerInstance(IGitHubService, github as IGitHubService);
services.registerSingleton(IGitHubReviewModel, () => services.createInstance(GitHubReviewModel));
resources.add(CommandsRegistry.register('git.getRepositoryContexts', () => [{
	id: 'workspace', label: 'repo', path: '/workspace', root: 'file:///workspace',
	head: { type: 'branch', name: 'main', objectId: 'a'.repeat(40) },
	remotes: [{ name: 'origin', identity: { provider: 'github', host: 'github.com', owner: 'team', repository: 'repo' } }],
}]));
services.registerInstance(IMenuService, new MenuService(commands, contexts));
const quickInput = resources.add(new TestQuickInputService({ instantiationService: services, container: document.body, contextKeyService: contexts }));
services.registerInstance(IQuickInputService, quickInput);
const keybindingRequests: { textual: boolean; query?: string; pickerVisible: boolean; }[] = [];
let shortcutPreferences: IPreferencesService | undefined;
services.registerInstance(IPreferencesService, {
	openSettings: async () => { throw new Error('Unexpected settings request'); },
	openUserSettings: async () => { throw new Error('Unexpected user settings request'); },
	openGlobalKeybindingSettings: async (textual, options) => {
		keybindingRequests.push({ textual, query: options?.query, pickerVisible: quickInput.currentQuickInput !== undefined });
		await shortcutPreferences?.openGlobalKeybindingSettings(textual, options);
	},
});
// Editor commands register additional palette entries and styles. Load them only for this scenario.
if (parameters.get('reopen') === '1') {
	const { EditorPaneRegistry } = await import('../../../../../browser/editor.js');
	const { REOPEN_WITH_COMMAND_ID } = await import('../../../../../browser/parts/editor/editorCommands.js');
	const { EditorPaneMatch } = await import('../../../../../browser/parts/editor/editorPane.js');
	const { IEditorPart } = await import('../../../../../browser/parts/editor/editorPart.js');
	const editorRegistry = resources.add(new EditorPaneRegistry());
	for (const [id, name] of [['test.text', 'Text Editor'], ['test.other', 'Other Editor']] as const) {
		resources.add(editorRegistry.registerEditorPane({
			id, name,
			canOpen: () => EditorPaneMatch.Optional,
			create: () => { throw new Error('The picker fixture does not create editor panes'); },
		}));
	}
	const reopenInput = { resource: URI.file('/workspace/main.ts') };
	const reopenGroup = {
		id: 'reopen', inputs: [reopenInput], activeInput: reopenInput,
		openEditor: async (_input: unknown, options: EditorOpenOptions) => {
			document.querySelector('output')!.textContent = JSON.stringify(options);
		},
	};
	services.registerInstance(IEditorPart, {
		groups: [reopenGroup], activeGroup: reopenGroup,
		getEditorPaneChoices: (input: IResourceEditorInput | undefined) => input ? editorRegistry.getEditorPanesForInput(input) : [],
	} as unknown as EditorPartContract);
	const reopen = document.createElement('button');
	reopen.textContent = 'Reopen editor';
	document.body.insertBefore(reopen, document.querySelector('output'));
	resources.add(addDisposableListener(reopen, 'click', () => {
		document.querySelector('output')!.textContent = '';
		void commands.executeCommand(REOPEN_WITH_COMMAND_ID).then(() => {
			if (!document.querySelector('output')!.textContent) document.querySelector('output')!.textContent = 'cancelled';
		});
	}));
}
const quickAccess = quickInput.quickAccess;
const theme = parameters.get('theme') === 'hc' ? highContrastDarkColorTheme : parameters.get('theme') === 'dark' ? darkColorTheme : lightColorTheme;
resources.add(bindTestColorTheme(resources.add(new TestThemeService(theme)), document.body));
if (parameters.has('shortcuts')) {
	await import('../../../../../../base/browser/ui/styles.css');
	if (parameters.has('shortcutRows')) {
		for (let index = 0; index < 160; index++) {
			resources.add(CommandsRegistry.register(`test.shortcutTable.row${String(index).padStart(3, '0')}`, () => undefined));
		}
	}
	if (parameters.has('shortcutToolbar')) {
		for (const [name, priority] of [['ZuluEarly', 30], ['AlphaLate', 10], ['YankeeLatest', 30]] as const) {
			const command = `test.shortcutToolbar.${name}`;
			resources.add(CommandsRegistry.register(command, () => { executions.push(name); }));
			resources.add(KeybindingsRegistry.registerKeybindingRule({
				command, priority, source: KeybindingSource.Workbench,
				keybinding: Keybinding.single(logicalKey('9', { ctrlKey: true, altKey: true })),
			}));
		}
	}
	resources.add(KeybindingsRegistry.registerKeybindingRule({
		command: 'test.quickAccess.AlphaFormat',
		keybinding: Keybinding.single(logicalKey('p', { primaryKey: true, shiftKey: true })),
		source: KeybindingSource.Builtin,
	}));
	const { createTestEditorServices, createTestFileService, createTestTextFileService } = await import('../../../../../test/common/testEditorServices.js');
	const { InMemoryFileSystemProvider } = await import('../../../../../../platform/files/common/inMemoryFilesystemProvider.js');
	const { EditorPart } = await import('../../../../../browser/parts/editor/editorPart.js');
	const { EditorPaneRegistry } = await import('../../../../../browser/editor.js');
	const { EditorPaneMatch } = await import('../../../../../browser/parts/editor/editorPane.js');
	const { BrowserEditorService } = await import('../../../../../services/editor/browser/browserEditorService.js');
	const { KeybindingsEditor } = await import('../../../../preferences/browser/keybindingsEditor.js');
	const { isKeybindingsEditorInput } = await import('../../../../../services/preferences/browser/keybindingsEditorInput.js');
	const { PreferencesService } = await import('../../../../../services/preferences/browser/preferencesService.js');
	const { IContextKeyService } = await import('../../../../../../platform/contextkey/browser/contextKeyService.js');
	const { IKeyboardLayoutService } = await import('../../../../../../platform/keyboardLayout/common/keyboardLayout.js');
	const { BrowserKeyboardLayoutService } = await import('../../../../../services/keybinding/browser/keyboardLayoutService.js');
	const { WorkbenchKeybindingService } = await import('../../../../../services/keybinding/browser/keybindingService.js');
	const { BrowserContextMenuService } = await import('../../../../../../platform/contextview/browser/contextMenuService.js');
	const { BrowserContextViewService } = await import('../../../../../../platform/contextview/browser/contextViewService.js');
	const { BrowserTextModelService } = await import('../../../../../services/textmodelResolver/browser/browserTextModelService.js');
	const { IFileTextModelService } = await import('../../../../../services/textmodelResolver/common/textModelResourceService.js');
	const { getBrowserTextResourceStore } = await import('../../../../codeEditor/browser/browserTextResourceStore.js');
	const { IUriIdentityService } = await import('../../../../../../platform/uriIdentity/common/uriIdentity.js');
	const { UriIdentityService } = await import('../../../../../../platform/uriIdentity/common/uriIdentityService.js');
	const { IKeybindingEditingService, KeybindingsEditingService } = await import('../../../../../services/keybinding/common/keybindingEditing.js');
	const { IUserDataProfileService } = await import('../../../../../services/userDataProfile/common/userDataProfile.js');
	const { UserDataProfileService } = await import('../../../../../services/userDataProfile/browser/userDataProfileService.js');
	const { BrowserWorkingCopyService } = await import('../../../../../services/workingCopy/browser/browserWorkingCopyService.js');
	const { Schemas } = await import('../../../../../../base/common/network.js');
	const scope = resources.add(services.createChild());
	scope.registerInstance(IFileService, resources.add(createTestFileService(resources.add(new InMemoryFileSystemProvider()), [Schemas.vscodeUserData])));
	scope.registerInstance(IContextKeyService, contexts);
	scope.registerSingleton(IUriIdentityService, () => scope.createInstance(UriIdentityService));
	scope.registerInstance(IUserDataProfileService, new UserDataProfileService());
	scope.registerSingleton(IWorkingCopyService, () => scope.createInstance(BrowserWorkingCopyService));
	const layout = resources.add(new BrowserKeyboardLayoutService({ navigator, operatingSystem: shortcutOS }));
	scope.registerInstance(IKeyboardLayoutService, layout);
	await scope.get(IFileService).createDirectory(URI.from({ scheme: Schemas.vscodeUserData, path: '/user' }));
	await scope.get(IFileService).createFile(scope.get(IUserDataProfileService).currentProfile.keybindingsResource, 'ignore');
	const keybindings = resources.add(scope.createInstance(WorkbenchKeybindingService, {
		ownerDocument: document, commandService: commands, contextKeyService: contexts, keyboardLayoutService: layout,
	}));
	scope.registerInstance(IKeybindingService, keybindings);
	await keybindings.initialize();
	writeShortcutBindings = async bindings => {
		await scope.get(IFileService).writeFile({ resource: scope.get(IUserDataProfileService).currentProfile.keybindingsResource, content: JSON.stringify(bindings) });
		await keybindings.initialize();
	};
	const textFiles = resources.add(createTestTextFileService(scope.get(IFileService)));
	const resourceStore = getBrowserTextResourceStore(textFiles);
	scope.registerInstance(IFileTextModelService, resources.add(scope.createInstance(BrowserTextModelService, resourceStore, {})));
	const editorServices = resources.add(createTestEditorServices(configuration, scope));
	editorServices.registerSingleton(IKeybindingEditingService, () => editorServices.createInstance(KeybindingsEditingService));
	const registry = new EditorPaneRegistry();
	resources.add(registry.registerEditorPane({
		id: KeybindingsEditor.ID, name: 'Keyboard Shortcuts',
		canOpen: input => isKeybindingsEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: () => editorServices.createInstance(KeybindingsEditor),
	}));
	const container = document.createElement('main');
	container.style.cssText = 'position:absolute;inset:48px 0 0';
	document.body.append(container);
	const menus = services.get(IMenuService);
	// Keep title menus in the modal's focus scope, as the product host does.
	const views = resources.add(new BrowserContextViewService(container));
	const contextMenus = resources.add(new BrowserContextMenuService(menus, contexts, keybindings, views, services.get(INotificationService)));
	const editor = resources.add(editorServices.createInstance(EditorPart, container, {
		registry, contextKeyService: contexts, keybindingService: keybindings, keyboardLayoutService: layout,
		titleActions: { menuService: menus, contextMenuProvider: contextMenus },
	}));
	editor.layout({ width: innerWidth, height: innerHeight - 48 });
	const editorService = resources.add(new BrowserEditorService(editor));
	editorServices.registerInstance(IEditorService, editorService);
	services.registerInstance(IEditorService, editorService);
	shortcutPreferences = resources.add(editorServices.createInstance(PreferencesService));
	await import('../../../../preferences/browser/preferencesActions.js');
}
const executions: string[] = [];
if (parameters.has('scrollRows')) {
	for (let index = 0; index < 60; index++) {
		const id = `test.quickAccess.scroll${index}`;
		const title = index < 58 ? `Scroll row ${String(index).padStart(2, '0')}` : `Narrow scroll result ${index}`;
		commandBindings.set(id, resolveKeybinding(Keybinding.single(physicalKey('F1')), shortcutOS));
		resources.add(registerAction2(class extends Action2 {
			constructor() { super({ id, title, f1: true }); }
			public override run(): void { executions.push(title); }
		}));
	}
}
for (const label of ['Alpha Format', 'Zulu Format', 'Format', 'Unbound command']) {
	resources.add(registerAction2(class extends Action2 {
		constructor() { super({ id: `test.quickAccess.${label.replaceAll(' ', '')}`, title: label, f1: true }); }
		public override run(): void {
			executions.push(label);
			document.querySelector('output')!.textContent = executions.join(', ');
		}
	}));
}
resources.add(addDisposableListener(document.querySelector('#open')!, 'click', () => quickAccess.show('>')));
resources.add(addDisposableListener(document.querySelector('#files')!, 'click', () => {
	const picker = quickInput.createQuickPick();
	picker.placeholder = 'Search files';
	picker.items = [
		{ type: 'separator', label: 'Recently opened' },
		...Array.from({ length: 60 }, (_, index) => ({
			label: `file-${index}.ts`,
			description: '/workspace/src/a-long-directory-name/another-long-directory-name/browser',
			detail: index === 0 && !parameters.has('singleLineRows') ? 'Additional information about this file' : undefined,
		})),
	];
	picker.onDidAccept(() => {
		const item = picker.selectedItems[0];
		if (!item) return;

		document.querySelector('output')!.textContent = item.label;
		picker.hide();

	});
	picker.onDidHide(() => picker.dispose());
	picker.show();
}));
const navigationBinding = resources.add(new MutableDisposable<DisposableStore>());
window.ashQuickAccessIntegration = {
	align: alignment => quickInput.setAlignment(alignment),
	showAnchored: () => {
		const picker = quickInput.createQuickPick();
		picker.anchor = document.querySelector('#files')!;
		picker.items = [{ label: 'Anchored result' }];
		picker.onDidHide(() => picker.dispose());
		picker.show();
	},
	showInput: () => { void quickInput.input({ title: 'Test prompt' }); },
	writeShortcutBindings: async bindings => {
		if (!writeShortcutBindings) throw new Error('Shortcut fixture is not enabled');
		await writeShortcutBindings(bindings);
	},
	setNavigationBinding: mode => {
		navigationBinding.clear();
		if (mode === 'default') return;
		const bindings = new DisposableStore();
		navigationBinding.value = bindings;
		bindings.add(KeybindingsRegistry.registerKeybindingBlocker({ keybinding: KeyCode.DownArrow, when: inQuickInputContext.isEqualTo(true), source: KeybindingSource.User }));
		if (mode === 'rebound') bindings.add(KeybindingsRegistry.registerKeybindingRule({ command: 'quickInput.next', keybinding: KeyCode.F8, when: inQuickInputContext.isEqualTo(true), source: KeybindingSource.User }));
	},
	setHistoryLength: value => configuration.updateValue('workbench.commandPalette.history', value),
	setSearchPatterns: async (include, exclude) => {
		await configuration.updateValue('search.includePatterns', include);
		await configuration.updateValue('search.excludePatterns', exclude);
	},
	show: (value, scoped) => quickAccess.show(value, scoped ? { enabledProviderPrefixes: ['>'] } : undefined),
	setSignedIn: value => { signedIn = value; },
	holdNextRequest: () => { holdNext = true; },
	releaseRequest: () => { releaseHeld?.(); releaseHeld = undefined; },
	requests,
	keybindingRequests,
	executions,
};
for (const trigger of document.querySelectorAll<HTMLButtonElement>('#open, #files')) trigger.disabled = false;
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
