import { IAgentSessionsService } from '../../chat/browser/agentSessions/agentSessionsService.js';
import type { IAgentSessionsModel } from '../../chat/browser/agentSessions/agentSessionsModel.js';
import { Schemas } from '../../../../base/common/network.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InMemoryFileSystemProvider } from '../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { BrowserContextMenuService } from '../../../../platform/contextview/browser/contextMenuService.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { LogService } from '../../../../platform/log/common/logServiceImpl.js';
import { ConsoleLogSink } from '../../../../platform/log/common/consoleLogSink.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { startWorkbench } from '../../../browser/workbench.js';
import { BrowserTitleService, createBrowserTitlebarPart } from '../../../browser/parts/titlebar/titlebarPart.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { InMemoryWorkingCopyBackupService } from '../../../services/workingCopy/common/workingCopyBackupService.js';
import { BrowserURLService } from '../../../services/url/browser/urlService.js';
import { TERMINAL_VIEW_ID } from '../../terminal/common/terminal.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { createThemePreviewHost, connectThemePreview, openThemePreviewEditors } from './themePreviewHost.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { observableValue } from '../../../../base/common/observable.js';
import { ISCMService, VIEW_PANE_ID } from '../../scm/common/scm.js';
import type { ISCMHistoryItem, ISCMHistoryItemRef, ISCMHistoryProvider } from '../../scm/common/history.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { ChatViewPane, type IChatViewPaneEntry } from '../../chat/browser/widgetHosts/viewPane/chatViewPane.js';
import { ChatWidget, type IChatWidgetModel } from '../../chat/browser/widget/chatWidget.js';
import type { ChatInputState } from '../../chat/browser/widget/input/chatInput.js';
import type { IQuickChatSession } from '../../chat/browser/chat.js';
import { CHAT_VIEW_ID, CHAT_VIEW_CONTAINER_ID } from '../../chat/common/chat.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
import { ViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';

const host = await createThemePreviewHost();
const { resources, root, workspaceFiles, workspaceRoot, samples, storage, api, clipboard, serviceCollection } = host;
const sample = new URLSearchParams(location.search).get('sample');
const diffPreview = sample === 'diff';
const codePreview = sample === 'code';
const scmPreview = sample === 'scm';
const chatPreview = sample === 'chat';
// Preview conversations are fixed samples. Shared actions cannot reach the
// enclosing product's history or submit messages to an app server.
const chatUnavailable = () =>
	new Error(localize('themeEditor.previewChatUnavailable', 'Chat is unavailable in this preview.'));
let createPreviewDraft: (() => void) | undefined;
serviceCollection.set(IChatSessionNavigationService, {
	createNewConversation: () => {
		if (!createPreviewDraft) throw chatUnavailable();
		createPreviewDraft();
	},
	revision: 0,
	getConversations: () => [],
	getActiveConversation: () => undefined,
	captureActiveDraft: async () => undefined,
	appendToActiveDraft: () => {
		throw chatUnavailable();
	},
	openConversation: async () => {
		throw chatUnavailable();
	},
	startVoiceConversation: async () => {
		throw chatUnavailable();
	},
});
// Registration stays behind localization and within this isolated document.
await import('./themePreview.contribution.js');

/** Supplies fixed content to the real Chat frame, transcript and composer. */
class ChatPreviewPane extends ChatViewPane {
	private readonly entries: IChatViewPaneEntry<IChatWidgetModel>[] = [];
	private selected: string | undefined;
	private revision = 0;
	private readonly changed = this._register(new Emitter<void>());

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@ICommandService commandService: ICommandService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configuration: IConfigurationService,
		@INotificationService notifications: INotificationService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IEditorGroupsService editorGroups: IEditorGroupsService,
		@IEditorService editorService: IEditorService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@IOpenerService private readonly opener: IOpenerService,
	) {
		const scope = instantiationService.createChild();
		super(container, options, commandService, layoutService, scope, configuration, notifications, lifecycleService, contextKeyService, editorGroups, editorService);
		this._register(scope);
		const owner = this;
		const model: IAgentSessionsModel = {
			onDidChangeSessions: this.changed.event, state: 'ready', error: undefined,
			get sessions() {
				return owner.entries.map(entry => ({
					id: entry.id, resource: URI.from({ scheme: 'theme-preview', path: `/chat/${entry.id}` }),
					label: entry.label, description: '', kind: 'draft' as const, target: { untitledSessionId: entry.id },
					active: owner.selected === entry.id, isArchived: () => false, isPinned: () => false,
					open: () => owner.activatePane(entry.id),
				}));
			},
			getSession: resource => model.sessions.find(session => session.resource.toString() === resource.toString()),
		};
		scope.registerInstance(IAgentSessionsService, { model, getSession: resource => model.getSession(resource) });
	}

	public initialize(): void {
		const labels = [
			localize('themeEditor.previewChatColors', 'Chat colors'),
			localize('themeEditor.previewChatDraft', 'Sample draft'),
		];
		for (const [index, label] of labels.entries()) {
			const id = `theme-preview-chat-${index}`;
			const model: IChatWidgetModel = {
				onDidChange: Event.None, onDidChangeComposer: Event.None, composerGeneration: 0,
				sessionId: undefined, threadId: undefined, untitledSessionId: id, goal: undefined,
				items: index === 0 ? [
					{ id: 'request', type: 'userMessage', text: localize('themeEditor.previewChatRequest', 'How do the Chat background and tabs fit this theme?'), transient: false },
					{ id: 'response', type: 'agentMessage', text: localize('themeEditor.previewChatResponse', 'In Tabs mode, the conversation shares the selected tab’s editor background. In List mode, it uses the background of its host panel.\n\nTry changing the background, text and input colors. This sample never sends messages.'), transient: false },
				] : [],
				inputState: {
					mode: 'agent', queuedMessages: 0, phase: 'ready', inputBlocked: true,
					canInterrupt: false, approvalMode: 'manual', models: [], isAutomaticModel: false,
					slashCommands: [], skillSelectors: [], canSelectAgent: false,
				} satisfies ChatInputState,
				send: async () => { throw chatUnavailable(); },
				executeServerCommand: async () => { throw chatUnavailable(); },
				interrupt: async () => { throw chatUnavailable(); },
				refreshChanges: async () => { throw chatUnavailable(); },
				selectModel: async () => { throw chatUnavailable(); },
				selectReasoningEffort: async () => { throw chatUnavailable(); },
				selectAutomaticModel: async () => { throw chatUnavailable(); },
				listAgents: async () => [],
				selectAgent: () => { throw chatUnavailable(); },
				selectMode: () => { throw chatUnavailable(); },
				selectApprovalMode: () => { throw chatUnavailable(); },
				resolveInteraction: async () => { throw chatUnavailable(); },
				retryFailedTurn: async () => { throw chatUnavailable(); },
				...Disposable.None,
			};
			const pane = this._register(this.instantiationService.createInstance(ChatWidget,
				this.paneHost, id, model, () => this.activatePane(this.entries[1]!.id),
				this.contextMenuService, this.contextViewService,
				this.commandService, this.accessibleViews, this.notifications, this.opener,
				this.editorService, undefined, undefined, undefined,
			));
			this.entries.push({ id, label, pane });
		}
		this.openedPaneIds = this.entries.map(entry => entry.id);
		this.initializeSessionsControl(() => this.activatePane(this.entries[1]!.id), () => [], () => this.focusInput());
		this.activatePane(this.entries[0]!.id);
		this.updateSessionsLayout();
		createPreviewDraft = () => this.activatePane(this.entries[1]!.id);
	}

	protected override get selectionRevision(): number { return this.revision; }
	protected override saveViewState(): void { }
	protected override ensureConversationForVisibleChat(): void { }
	protected override async restoreEditorPane(id: string): Promise<void> {
		if (!this.entries.some(entry => entry.id === id)) throw chatUnavailable();
		if (!this.openedPaneIds.includes(id)) this.openedPaneIds.push(id);
		this.syncSessions();
	}
	protected override updateSessions() {
		return { entries: this.entries.filter(entry => this.openedPaneIds.includes(entry.id)), activePaneId: this.selected };
	}
	protected override activatePane(id: string): void {
		this.selected = id;
		this.revision += 1;
		if (!this.openedPaneIds.includes(id)) this.openedPaneIds.push(id);
		this.syncSessions();
		this.changed.fire();
	}
	public override async openInNewWindow(): Promise<void> { throw chatUnavailable(); }
	public override createEmbeddedChat(): IQuickChatSession { throw chatUnavailable(); }
}

if (chatPreview) {
	ViewsRegistry.registerStaticViewContainer({
		id: CHAT_VIEW_CONTAINER_ID, title: localize('themeEditor.group.chat', 'Chat'),
		location: ViewContainerLocation.AuxiliaryBar, icon: Lxicon.chat, isDefault: true,
	});
	ViewsRegistry.registerStaticViews(CHAT_VIEW_CONTAINER_ID, [{
		id: CHAT_VIEW_ID, title: localize('themeEditor.group.chat', 'Chat'), canToggleVisibility: false,
		when: ChatContextKeys.enabled.isEqualTo(true), ctorDescriptor: new SyncDescriptor(ChatPreviewPane),
	}]);
}

// Keep the real panel's layout and theme, without constructing terminal services,
// profile discovery, a PTY, xterm, or a command interpreter for a color sample.
class TerminalPreviewPane extends ViewPane {
	constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		this.setHeaderVisible(false);
		const doc = container.ownerDocument;
		this.contentElement.classList.add('ash-theme-preview-terminal');
		const sample = h(doc, 'div', {
			attributes: {
				role: 'region',
				'aria-label': localize('themeEditor.previewOnly', 'Preview only'),
				tabindex: '0',
			},
		});
		sample.append(
			h(
				doc,
				'p',
				{},
				localize('themeEditor.previewTerminalIntro', 'Terminal color preview. Commands are not executed.'),
			),
		);
		for (const bright of [false, true]) {
			const line = h(doc, 'p');
			for (const [index, name] of [
				'Black',
				'Red',
				'Green',
				'Yellow',
				'Blue',
				'Magenta',
				'Cyan',
				'White',
			].entries()) {
				const id = `terminal.ansi${bright ? 'Bright' : ''}${name}`;
				const swatch = h(
					doc,
					'span',
					{ attributes: { 'data-color': id, 'aria-label': id, title: id } },
					`${(bright ? 90 : 30) + index} Aa `,
				);
				swatch.style.color = `var(--ash-${id.replaceAll('.', '-')})`;
				line.append(swatch);
			}
			sample.append(line);
		}
		const prompt = h(doc, 'p', {}, '$ ');
		prompt.append(
			h(
				doc,
				'span',
				{ className: 'ash-theme-preview-terminal-selection' },
				localize('themeEditor.previewOnly', 'Preview only'),
			),
			' ',
			h(
				doc,
				'span',
				{ className: 'ash-theme-preview-terminal-cursor', attributes: { 'aria-hidden': 'true' } },
				'▌',
			),
		);
		sample.append(prompt);
		this.contentElement.append(sample);
	}
}

let services!: IInstantiationService;
serviceCollection.set(
	IFileDialogService,
	host.fileDialogDescriptor(() => services),
);
const workbench = resources.add(
	await startWorkbench({
		productName: 'Ash',
		container: root,
		host: {
			api,
			createWorkingCopyBackupService: (_services, workspaceId) => new InMemoryWorkingCopyBackupService(workspaceId),
		},
		serviceCollection,
		viewConstructors: new Map([[TERMINAL_VIEW_ID, new SyncDescriptor(TerminalPreviewPane)]]),
		extensionHost: api.extensionHost,
		workspace: {
			id: 'theme-preview',
			folders: [{ id: 'theme-preview', name: 'theme-preview', uri: workspaceRoot, index: 0 }],
		},
		workspaceFileSystemProvider: workspaceFiles,
		defaultLayout: {
			parts: {
				sidebar: !diffPreview && !codePreview && !chatPreview,
				panel: !diffPreview && !codePreview && !scmPreview && !chatPreview,
				auxiliarybar: chatPreview,
				agentSidebar: false,
			},
		},
		// Keep the production Parts and editor rendering without starting
		// backend observers, history, account, update or extension contributions.
		contributionIds: [
			...(chatPreview ? ['workbench.contrib.chatSetup', 'workbench.contrib.chatInputEditor'] : []),
			...(scmPreview ? ['workbench.contrib.scmRepositories'] : []),
			'workbench.contrib.layoutActionsContext',
			'workbench.contrib.modernUI',
			'workbench.contrib.sash',
			'workbench.contrib.dynamicEditorConfigurations',
			'workbench.contrib.editorStatus',
			'workbench.contrib.folding',
			'editorAccessibilityHelpContribution',
			'workbench.contrib.accessibilityStatus',
			'workbench.contrib.unfocusedViewDimming',
		],
		initialConfiguration: {
			contents: { workbench: { startupEditor: 'none' } },
			keys: ['workbench.startupEditor'],
			overrides: [],
		},
		// Webviews are not part of the sample. The disconnected host supplies no remote resources.
		environmentService: {
			isBuilt: true,
			webviewExternalEndpoint: 'https://{{uuid}}.invalid',
			argvResource: URI.from({ scheme: Schemas.vscodeUserData, path: '/user/argv.json' }),
		},
		clipboardService: clipboard,
		createStorageService: async () => storage,
		createUserDataFileSystemProvider: async () => new InMemoryFileSystemProvider(),
		createLogService: () => new LogService({ sinks: [new ConsoleLogSink()] }),
		createLifecycleService: host.createLifecycleService,
		createContextMenuService: scope => scope.createInstance(BrowserContextMenuService),
		createTitleService: (container, productName, groups, scope) =>
			scope.createInstance(BrowserTitleService, container, productName, createBrowserTitlebarPart, groups),
		createURLService: scope => {
			host.restrictOpeners(scope);
			return scope.createInstance(BrowserURLService, undefined);
		},
		createWindow: scope => {
			services = scope;
			return Disposable.None;
		},
	}),
);
await workbench.whenRestored;
if (scmPreview) {
	// The real SCM pane owns rendering and interaction; only its repository data
	// is synthetic, scoped to this memory-only preview document.
	const current: ISCMHistoryItemRef = {
		id: 'refs/heads/main', name: 'main', revision: 'preview-merge', category: 'localBranch',
	};
	const remote: ISCMHistoryItemRef = {
		id: 'refs/remotes/origin/main', name: 'origin/main', revision: 'preview-base', category: 'remoteBranch',
	};
	const branches = Array.from({ length: 5 }, (_, index) => `preview-branch-${index + 1}`);
	const history: readonly ISCMHistoryItem[] = [
		{
			id: current.revision!, parentIds: ['preview-main', ...branches],
			subject: localize('themeEditor.scm.merge', 'Merge branches into main'), message: '', references: [current],
		},
		...branches.map((id, index) => ({
			id, parentIds: ['preview-base'],
			subject: localize('themeEditor.scm.branch', 'Branch change {0}', index + 1), message: '',
		})),
		{
			id: 'preview-main', parentIds: ['preview-base'],
			subject: localize('themeEditor.scm.main', 'Local branch change'), message: '',
		},
		{
			id: remote.revision!, parentIds: ['preview-root'],
			subject: localize('themeEditor.scm.pushed', 'Latest pushed change'), message: '', references: [remote],
		},
		{
			id: 'preview-root', parentIds: [],
			subject: localize('themeEditor.scm.root', 'Shared history'), message: '',
		},
	];
	const historyProvider: ISCMHistoryProvider = {
		onDidChange: Event.None,
		historyItemRef: observableValue('themePreview.head', current),
		historyItemRemoteRef: observableValue('themePreview.remote', remote),
		refresh: () => { },
		provideHistoryItemRefs: async () => [current, remote],
		provideHistoryItems: async options =>
			history.slice(options.skip ?? 0, (options.skip ?? 0) + (options.limit ?? history.length)),
		provideHistoryItemChanges: async () => [{
			uri: URI.joinPath(workspaceRoot, 'palette.ts'), path: 'palette.ts', status: 'modified',
		}],
		resolveHistoryItemChangeContents: async () => ({
			parentId: 'preview-base',
			original: { kind: 'text', text: 'export const accent = "Ocean";\n' },
			modified: { kind: 'text', text: 'export const accent = "Forest";\n' },
		}),
		resolveHistoryItemChatContext: async () => undefined,
		resolveHistoryItemChangeRangeChatContext: async () => undefined,
	};
	resources.add(services.get(ISCMService).registerSCMProvider({
		id: 'theme-preview-scm', providerId: 'git', label: 'theme-preview', rootUri: workspaceRoot,
		groups: [], onDidChangeResources: Event.None,
		input: {
			visible: false, value: '', placeholder: '', enabled: false, canAccept: false,
			buttonLabel: '', buttonTooltip: '', accept: async () => undefined,
		},
		activeRepositoryName: 'theme-preview', statusBarCommands: [], statusMessage: '', isBusy: false,
		historyProvider, refresh: async () => { }, activate: async () => { },
	}));
	const views = services.get(IViewsService);
	await views.openView('ash.gitGraph');
	views.closeView(VIEW_PANE_ID);
	views.closeView('ash.gitAgentReview');
	const layout = services.get(IWorkbenchLayoutService);
	layout.resizePart('sidebar', { width: 480, height: layout.getPartSize('sidebar').height });
}
const editorService = services.get(IEditorService);
await openThemePreviewEditors(host, services, diffPreview ? 'diff' : 'code');
if (chatPreview) {
	const view = await services.get(IViewsService).openView<ChatPreviewPane>(CHAT_VIEW_ID);
	view?.initialize();
	const layout = services.get(IWorkbenchLayoutService);
	layout.resizePart('auxiliarybar', { width: 480, height: layout.getPartSize('auxiliarybar').height });
}

const publishContent = connectThemePreview(
	resources,
	services.get(IWorkbenchThemeService),
	services.get(IConfigurationService),
	() => {
		const editors = services.get(ICodeEditorService).listCodeEditors();
		const output = root.querySelector('.ash-theme-preview-terminal')?.textContent ?? '';
		const history = [...root.querySelectorAll<HTMLElement>('.ash-scm-graph-commit')]
			.map(row => row.getAttribute('aria-label') ?? row.innerText).join('\n');
		return (
			editors
				.map(editor => `${editor.getModel()?.uri.path ?? ''}\n${editor.getModel()?.getValue() ?? ''}`)
				.join('\n') +
			'\n' +
			output +
			'\n' + (root.querySelector<HTMLElement>('.ash-chat-view')?.innerText ?? '') +
			'\n' +
			history
		);
	},
);
resources.add(editorService.onDidActiveEditorChange(publishContent));
if (chatPreview) {
	resources.add(addDisposableListener(root, 'click', publishContent));
	resources.add(addDisposableListener(root, 'input', publishContent));
}
const editorListeners = resources.add(new DisposableStore());
const bindEditors = (): void => {
	editorListeners.clear();
	for (const editor of services.get(ICodeEditorService).listCodeEditors()) {
		// Files opened from the sample Explorer or a split share the same fixed-content policy.
		const resource = editor.getModel()?.uri;
		if (resource?.scheme === workspaceRoot.scheme && resource.path.startsWith(workspaceRoot.path + '/')) {
			editor.updateOptions({ readOnly: true });
		}
		editorListeners.add(editor.onDidChangeModelContent(publishContent));
	}
};
resources.add(editorService.onDidVisibleEditorsChange(bindEditors));
bindEditors();
