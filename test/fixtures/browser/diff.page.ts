import { Orientation } from '../../../src/ash/base/browser/ui/sash/sash.js';
import { registerTestCodeEditorFeatures } from '../codeEditorFeatures.js';
const codeFeatures = registerTestCodeEditorFeatures();
import { LanguageCompletionItemKind } from '../../../src/ash/editor/common/languages.js';
import '../../../src/ash/editor/editor.all.js';
import { ILanguageFeaturesService } from '../../../src/ash/editor/common/services/languageFeatures.js';
import { TestWorkspaceService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { BreadcrumbsSymbolPicker } from '../../../src/ash/workbench/browser/parts/editor/breadcrumbsPicker.js';
import { IFileTextModelService } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';
import { IWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/common/workingCopyService.js';
import { Icon } from '../../../src/ash/base/common/icon.js';
import type { ITextResourceStore } from '../../../src/ash/workbench/services/textmodelResolver/common/textResourceStore.js';
import '../../../src/ash/base/browser/ui/button/button.css';
import '../../../src/ash/base/browser/ui/actionbar/actionbar.css';
import '../../../src/ash/base/browser/ui/toolbar/toolbar.css';
import '../../../src/ash/base/browser/ui/menu/menu.css';
import '../../../src/ash/base/browser/ui/dialog/dialog.css';
import '../../../src/ash/base/browser/ui/inputbox/inputbox.css';
import '../../../src/ash/base/browser/ui/toggle/toggle.css';
import '../../../src/ash/platform/theme/common/sizes/baseSizes.js';
import { TestUriIdentityServices } from '../../../src/ash/platform/uriIdentity/test/common/uriIdentityTestServices.js';
import '../../../src/ash/workbench/contrib/scm/browser/quickDiff.contribution.js';
import { addDisposableListener, h } from '../../../src/ash/base/browser/dom.js';
import { GridView } from '../../../src/ash/base/browser/ui/grid/gridview.js';
import '../../../src/ash/base/browser/ui/grid/gridview.css';
import { CancellationToken, CancellationTokenSource } from '../../../src/ash/base/common/cancellation.js';
import { DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { bindTestColorTheme } from './themeFixture.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { DiffEditorWidget } from '../../../src/ash/editor/browser/widget/diffEditor/diffEditorWidget.js';
import { EmbeddedDiffEditorWidget } from '../../../src/ash/editor/browser/widget/diffEditor/embeddedDiffEditorWidget.js';
import '../../../src/ash/editor/contrib/diffEditorBreadcrumbs/browser/contribution.js';
import { StandaloneServices } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { MultiDiffEditorWidget } from '../../../src/ash/editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.js';
import { DocumentDiffItem, MultiDiffEditorModel } from '../../../src/ash/editor/browser/widget/multiDiffEditor/model.js';
import { DiffModel } from '../../../src/ash/editor/common/diff/diffModel.js';
import { toLineDiff } from '../../../src/ash/editor/common/diff/lineDiff.js';
import { Range } from '../../../src/ash/editor/common/core/range.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { DiffService } from '../../../src/ash/workbench/services/diff/browser/diffService.js';
import { QuickDiffModelService } from '../../../src/ash/workbench/contrib/scm/browser/quickDiffModel.js';
import { QuickDiffService } from '../../../src/ash/workbench/contrib/scm/common/quickDiffService.js';
import { CodeEditorConfiguration } from '../../../src/ash/workbench/contrib/codeEditor/common/editorConfiguration.js';
import { resetNlsResolver, setNlsMessages } from '../../../src/ash/nls.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { Registry } from '../../../src/ash/platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../src/ash/platform/configuration/common/configurationRegistry.js';
import { CommandsRegistry, ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { MenusRegistry, MenuId, IMenuService, registerAction2 } from '../../../src/ash/platform/actions/common/actions.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { EditorPart, IEditorPart, type IEditorPartOptions } from '../../../src/ash/workbench/browser/parts/editor/editorPart.js';
import { EditorPaneRegistry } from '../../../src/ash/workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../src/ash/workbench/browser/parts/editor/editorPane.js';
import { TextDiffEditor } from '../../../src/ash/workbench/browser/parts/editor/textDiffEditor.js';
import { createDiffEditorInput, DIFF_EDITOR_ID, isDiffEditorInput } from '../../../src/ash/workbench/common/editor/diffEditorInput.js';
import { registerDiffEditorCommands } from '../../../src/ash/workbench/browser/parts/editor/diffEditorCommands.js';
import { DiffEditorCommandsService, IDiffEditorCommandsService } from '../../../src/ash/workbench/browser/parts/editor/diffEditorCommandsService.js';
import { BrowserEditorService } from '../../../src/ash/workbench/services/editor/browser/browserEditorService.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import type { DiffEditorSelectionHunkToolbarContext } from '../../../src/ash/editor/browser/widget/diffEditor/features/gutterFeature.js';
import type { IDiffEditorOptions } from '../../../src/ash/editor/common/config/editorOptions.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { BrowserDialogHandler } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.js';
import { DialogHandlerContribution } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.web.contribution.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { BrowserTextModelService } from '../../../src/ash/workbench/services/textmodelResolver/browser/browserTextModelService.js';
import { EditorPanes } from '../../../src/ash/workbench/browser/editor.js';
import { isEditorPaneWithViewState } from '../../../src/ash/workbench/browser/parts/editor/editorWithViewState.js';
import { ICodeEditorService } from '../../../src/ash/editor/browser/services/codeEditorService.js';
import { CodeEditorService } from '../../../src/ash/workbench/services/editor/browser/codeEditorService.js';
import { IEditorPartsService } from '../../../src/ash/workbench/browser/parts/editor/editorParts.js';
import { MultiDiffCollapseAllAction, MultiDiffExpandAllAction, MultiDiffGoToFileAction, MultiDiffToggleCollapseAllAction, MultiDiffToggleCollapseUnchangedRegionsAction } from '../../../src/ash/workbench/contrib/multiDiffEditor/browser/multiDiffEditorActions.js';
import { ContextKeyExpr } from '../../../src/ash/platform/contextkey/common/contextkey.js';
import { EditorOption } from '../../../src/ash/editor/common/config/editorOptions.js';
import type { ExtensionClientOperation, ExtensionClientResult } from '../../../src/ash/workbench/api/common/extHost.protocol.js';
import type { JsonValue } from '../../../src/ash/base/common/jsonValue.js';
import { ITextFileService } from '../../../src/ash/workbench/services/textfile/common/textfiles.js';
import { TextFileContentSource } from '../../../src/ash/workbench/services/textfile/common/textFileService.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';



import gitManifest from '../../../extensions/git/package.json' with { type: 'json' };
import gitEnglish from '../../../extensions/git/package.nls.json' with { type: 'json' };
import gitChinese from '../../../extensions/git/package.nls.zh-CN.json' with { type: 'json' };
import { MainThreadEditorChanges } from '../../../src/ash/workbench/api/browser/mainThreadEditorChanges.js';
import { parseExtensionEditorInput } from '../../../src/ash/workbench/api/browser/mainThreadEditorInput.js';
import { normalizeExtensionHostPayload } from '../../../src/ash/platform/agentHost/browser/extensionHostProtocol.js';
async function invokeRustGit(registrationId: string, operation: string, payload: unknown) { return window.__rustGitRequest('invoke', { registrationId, operation, payload, deadlineUnixMillis: Date.now() + 10000 }); }
async function createGitMultiDiffEditorInput(_fixture: typeof titleGit, scope: string) {
	const value = await invokeRustGit('ash.scm', 'scm', { method: 'multiDiff', providerId: titleGitStatus.repositoryId, resource: `ash-scm://ash.git/${titleGitStatus.repositoryId}?scope=${scope}` });
	return parseExtensionEditorInput(normalizeExtensionHostPayload(value));
}
function wireReplacer(this: Record<string, unknown>, key: string, value: unknown): unknown { return this[key] instanceof URI ? this[key].toString() : value; }
import { MultiDiffEditor } from '../../../src/ash/workbench/contrib/multiDiffEditor/browser/multiDiffEditor.js';
import { SessionChangesEditorInput } from '../../../src/ash/sessions/contrib/changes/browser/sessionChangesEditorInput.js';
import { EditorInputSerializers } from '../../../src/ash/workbench/services/editor/common/editorInputSerializer.js';
import { DeferredPromise } from '../../../src/ash/base/common/async.js';
import { constObservable } from '../../../src/ash/base/common/observable.js';
import { ISessionChangesService } from '../../../src/ash/sessions/contrib/changes/common/sessionChangesService.js';
import { SessionChangesService } from '../../../src/ash/sessions/contrib/changes/browser/sessionChangesService.js';
import { ISessionsService } from '../../../src/ash/sessions/services/sessions/browser/sessionsService.js';
import { IChangesViewService } from '../../../src/ash/sessions/contrib/changes/common/changesViewService.js';
import { ChangesViewService } from '../../../src/ash/sessions/contrib/changes/browser/changesViewService.js';
import { emptyEditorServiceState } from '../../../src/ash/workbench/test/common/testEditorService.js';
import { IResourceLabelService } from '../../../src/ash/workbench/browser/labels.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { QuickInputService } from '../../../src/ash/platform/quickinput/browser/quickInputService.js';
import { BrowserLayoutService, ILayoutService } from '../../../src/ash/platform/layout/browser/layoutService.js';
import { IEditorGroupsService } from '../../../src/ash/workbench/services/editor/common/editorGroupsService.js';
import { IRendererHostService } from '../../../src/ash/platform/renderer/common/rendererHost.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { createDisconnectedRendererApi } from '../../../src/ash/workbench/browser/rendererApi.js';
import { createMultiDiffEditorInput, isMultiDiffEditorInput, matchMultiDiffEditor, MULTI_DIFF_EDITOR_ID } from '../../../src/ash/workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { BrowserWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/browser/browserWorkingCopyService.js';
import { IMultiDiffSourceResolverService, MultiDiffSourceResolverService } from '../../../src/ash/workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js';
import type { IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import { IChatService, type TurnChangeSetSummary } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { ISessionsManagementService } from '../../../src/ash/sessions/services/sessions/common/sessionsManagement.js';
import { CHANGESET_REVIEW_ACTION_ID, SessionChangesEditor } from '../../../src/ash/sessions/contrib/changes/browser/sessionChangesEditor.js';

// Display language is fixed before constructing widgets, as it is at product startup.
if (new URLSearchParams(location.search).get('locale') === 'zh-CN') {
	const catalog = productLanguagePackCatalogs.find(candidate => candidate.locale === 'zh-CN')!;
	setNlsMessages(catalog.locale, catalog.bundles);
}
// Actions capture their translated titles when registered, after language setup.
await import('../../../src/ash/sessions/contrib/changes/browser/changesActions.js');
await import('../../../src/ash/sessions/contrib/changes/browser/changesetReviewActions.js');

await import('../../../src/ash/sessions/contrib/changes/browser/changesActions.js');
await import('../../../src/ash/sessions/contrib/changes/browser/changesetReviewActions.js');

const resources = new DisposableStore();
const uriIdentityServices = resources.add(new TestUriIdentityServices());
const editorServices = StandaloneServices.initialize();
// These comparison fixtures exercise folded files; product defaults are tested separately.
await editorServices.get(IConfigurationService).updateValue('diffEditor.hideUnchangedRegions.enabled', true);
editorServices.registerInstance(IWorkingCopyService, resources.add(uriIdentityServices.createInstance(BrowserWorkingCopyService)));
resources.add(toDisposable(resetNlsResolver));
const symbolProvider = resources.add(editorServices.languageFeaturesService.documentSymbolProvider.register('*', {
	provideDocumentSymbols: request => request.model.getLineCount() < 36 ? [] : [{
		name: 'Shared section',
		kind: 'function',
		range: new Range(5, 1, 36, 2),
		selectionRange: new Range(5, 1, 5, 2),
	}],
}));
const diffOptions = { ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: false };
const service = editorServices.createInstance(DiffService);
const computation = resources.add(service.createComputationService());
const original = resources.add(new TextModel('same\nbefore 😀 after\nlast', { languageConfigurationService: editorServices.languageConfigurationService }));
const modified = resources.add(new TextModel('same\nbefore 🤖 after\nlast', { languageConfigurationService: editorServices.languageConfigurationService }));
const model = resources.add(new DiffModel({ original, modified, diffProvider: computation, diffOptions }));
const secondOriginal = resources.add(new TextModel('one\n'));
const secondModified = resources.add(new TextModel('one'));
const second = resources.add(new DiffModel({ original: secondOriginal, modified: secondModified, diffProvider: computation, diffOptions }));
const single = resources.add(editorServices.createInstance(DiffEditorWidget, { container: document.getElementById('single')!, model }));
let resizeGrid: GridView | undefined;
const resizeLayoutCounts = [0, 0, 0];
const embedded = resources.add(new MutableDisposable<EmbeddedDiffEditorWidget>());
let layoutEventCount = 0;
resources.add(single.modifiedEditor.onDidLayoutChange(() => layoutEventCount++));
const multi = resources.add(editorServices.createInstance(MultiDiffEditorWidget, {
	container: document.getElementById('multi')!,
	model: resources.add(new MultiDiffEditorModel([
		resources.add(new DocumentDiffItem({ id: 'first', label: 'first.ts' }, model)),
		resources.add(new DocumentDiffItem({ id: 'second', label: 'second.ts' }, second)),
	])),
}));
const input = document.getElementById('modified') as HTMLTextAreaElement;
input.value = modified.getText();
resources.add(addDisposableListener(input, 'input', () => modified.setValue(input.value)));

let baselineRequests = 0;
const baselines = resources.add(new QuickDiffService());
resources.add(baselines.addProvider({
	id: 'test', label: 'Index',
	async provideOriginalResource(resource) {
		baselineRequests++;
		return { providerId: 'test', providerLabel: 'Index', label: 'Index', originalResource: resource, revision: 1, text: original.getText() };
	},
}));
const configuration = resources.add(new InMemoryConfigurationService());
const quickDiff = resources.add(new QuickDiffModelService(baselines, service, configuration));
const reference = resources.add(quickDiff.createModelReference(URI.file('/workspace/first.ts'), modified));
let activeManyActions = 0;
const lazyLoads: number[] = [];
let dynamicResources: DisposableStore | undefined;
let dynamicCollection: MultiDiffEditorModel | undefined;
let dynamicSecond: DocumentDiffItem | undefined;
let completeDeferredComparison: (() => void) | undefined;
let compressedEditor: MultiDiffEditorWidget | undefined;
let compressedViewState: unknown;
let lastHunkAction: { text: string; originalStart: number; modifiedStart: number; } | undefined;
let themeBinding: IDisposable | undefined;
const sessionPane = resources.add(new MutableDisposable<SessionChangesEditor>());
const sessionChanges = resources.add(new Emitter<{ sessionId: string; threadId: string; }>());
let sessionServices: ReturnType<typeof editorServices.createChild> | undefined;
let titleEditor: EditorPart | undefined;
let titleConfiguration: InMemoryConfigurationService | undefined;
let titleServices: ReturnType<typeof createTestEditorServices> | undefined;
const titleGitEvents = resources.add(new Emitter<ReturnType<typeof makeTitleGitStatus>>());
let titleGitStatus: ReturnType<typeof makeTitleGitStatus>;
let titleGitDelay = 0;
let titleGitEncoding: 'utf8' | 'utf8bom' = 'utf8';
const inspectedFiles: string[] = [];
const gitGutterCalls: unknown[] = [];
const titleWrites: { resource: string; text: string; encoding?: string; }[] = [];
let titleSaveFailure = false;
let writableTitleInput: import('../../../src/ash/workbench/common/editor.js').IResourceEditorInput | undefined;
const titleGit = {
	onDidChangeRepositoryStatus: titleGitEvents.event,
	status: async () => titleGitStatus,
	changeFile: async (path: string) => {
		const revision = titleGitStatus.revision;
		const delay = titleGitDelay;
		if (delay) await new Promise(resolve => setTimeout(resolve, delay));
		const bom = titleGitEncoding === 'utf8bom' ? '\uFEFF' : '';
		return { original: { kind: 'text', text: `${bom}before\nshared` }, modified: { kind: 'text', text: `${bom}${path} revision ${revision}\nshared` } };
	},
	indexDiff: async (path: string) => {
		const bom = titleGitEncoding === 'utf8bom' ? '\uFEFF' : '';
		return { original: `${bom}before\nshared`, modified: `${bom}${path} revision ${titleGitStatus.revision}\nshared`, hunks: [] };
	},
	editIndex: async (path: string, comparison: string, reviewed: unknown, selection: unknown, repositoryId: string) => {
		gitGutterCalls.push({ path, comparison, reviewed, selection, repositoryId });
		return titleGitStatus;
	},
};
function makeTitleGitStatus(paths: readonly string[], revision: number, repositoryId = 'repo') {
	return {
		repositoryId, streamInstanceId: 'stream', revision, historyRevision: 1, path: '', workspacePath: '/workspace',
		head: { type: 'branch' as const, name: 'main', objectId: 'abc', upstream: undefined },
		changes: paths.map(path => ({
			path, originalPath: undefined, indexStatus: 'unmodified', worktreeStatus: 'modified', conflicted: false,
			submodule: { isSubmodule: false, commitChanged: false, trackedChanges: false, untrackedChanges: false }
		})),
	};
}
let titleTheme: TestThemeService | undefined;
let sessionTheme: TestThemeService | undefined;
let sessionRevision = 1;
let sessionCaptureState: 'sealed' | 'open' = 'sealed';
let sessionAvailability: 'available' | 'empty' | 'failed' = 'available';
let sessionMultipleCaptures = new URL(location.href).searchParams.has('multipleSession');
let sessionInput: SessionChangesEditorInput | undefined;
let sessionCommandsActive = true;
let pendingSessionRead: DeferredPromise<void> | undefined;
let sessionReadStarted = false;
let changeSessionRevisionOnRead = false;
let pendingViewedAction: Promise<unknown> | undefined;
let sessionOpenController: AbortController | undefined;
let sessionOpenState = 'idle';
let supersededSessionRead: DeferredPromise<void> | undefined;
let supersededSessionController: AbortController | undefined;
let pendingViewedState = 'idle';
let closedSessionEditor: { input: ReturnType<typeof EditorInputSerializers.serialize>; state: unknown; } | undefined;
let sessionFileReads = 0;
const sessionOpenedFiles: string[] = [];
const sessionPreparedFiles: unknown[] = [];
let focusedHistoryView: string | undefined;

function createSessionChangesPane(): SessionChangesEditor {
	if (!sessionServices) {
		if (!editorServices.has(IRendererHostService)) { editorServices.registerInstance(IRendererHostService, createDisconnectedRendererApi()); }
		const parentServices = resources.add(createTestEditorServices(undefined, editorServices));
		if (!editorServices.has(IFileService)) { editorServices.registerInstance(IFileService, parentServices.get(IFileService)); }
		sessionServices = resources.add(parentServices.createChild());
		sessionServices.registerInstance(IMultiDiffSourceResolverService, resources.add(new MultiDiffSourceResolverService()));
		sessionTheme = resources.add(new TestThemeService(darkColorTheme));
		sessionServices.registerInstance(IThemeService, sessionTheme);
		resources.add(bindTestColorTheme(sessionTheme, document.getElementById('session-changes')!));
		sessionServices.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'diff-integration', flushInterval: 0 })));
		sessionServices.registerInstance(IDialogService, { confirm: async () => ({ confirmed: false }) } as unknown as IDialogService);
		sessionServices.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
		const sessions = [{ sessionId: 'review', chats: [{ threadId: 'review-thread' }], workspace: { authorityId: 'local', root: '/workspace' } }, { sessionId: 'other', chats: [{ threadId: 'other-thread' }] }];
		sessionServices.registerInstance(ISessionsManagementService, { sessions } as unknown as ISessionsManagementService);
		sessionServices.registerInstance(ISessionsService, { onDidChange: Event.None, activeSelection: { kind: 'session', active: { session: sessions[0], threadId: 'review-thread' } } } as unknown as ISessionsService);
		sessionServices.registerInstance(IEditorService, { ...emptyEditorServiceState, focusActiveEditor() { }, openEditor: async input => { sessionOpenedFiles.push(input.resource.toString()); } } as IEditorService);
		sessionServices.registerInstance(IEditorPart, { get activePane() { return sessionCommandsActive ? sessionPane.value : undefined; } } as IEditorPart);
		sessionServices.registerInstance(IEditorGroupsService, { groups: [] } as unknown as IEditorGroupsService);
		sessionServices.registerSingleton(ISessionChangesService, () => sessionServices!.createInstance(SessionChangesService));
		sessionServices.registerSingleton(IChangesViewService, () => sessionServices!.createInstance(ChangesViewService));
		sessionServices.registerSingleton(ICommandService, () => resources.add(new CommandService(sessionServices!)));
		sessionServices.registerInstance(IQuickInputService, { input: async () => 'Reviewed file' } as unknown as IQuickInputService);
		sessionServices.registerSingleton(IMenuService, () => sessionServices!.createInstance(MenuService));
		const summary: TurnChangeSetSummary = {
			changeSetId: 'review-change', sessionId: 'review', threadId: 'review-thread', turnId: 'review-turn', repositoryId: 'review-repository',
			captureState: 'sealed', messageState: 'unconfigured', commitState: 'idle', committedPaths: [], revision: 1,
			statistics: { files: 8, additions: 8, deletions: 8 }, dependencies: [], externalDependencyPaths: [], warnings: [], conflictPaths: [],
		};
		sessionServices.registerInstance(IChatService, {
			onDidUpdateTurnChanges: sessionChanges.event,
			onDidBecomeReady: Event.None,
			listTurnChanges: async (sessionId: string, threadId: string) => {
				if (sessionAvailability === 'failed') { throw new Error('Unavailable'); }
				if (sessionAvailability === 'empty') { return []; }
				const current = { ...summary, sessionId, threadId, revision: sessionRevision, captureState: sessionCaptureState };
				return sessionMultipleCaptures ? [current, { ...current, changeSetId: 'review-later', turnId: 'later-turn', statistics: { files: 2, additions: 2, deletions: 2 } }] : [current];
			},
			readTurnChange: async (sessionId: string, threadId: string, changeSetId: string) => {
				if (pendingSessionRead) { sessionReadStarted = true; await pendingSessionRead.p; }
				const indexes = changeSetId === 'review-later' ? [0, 8] : Array.from({ length: 8 }, (_, index) => index);
				return {
					summary: { ...summary, sessionId, threadId, changeSetId, revision: sessionRevision, captureState: sessionCaptureState, statistics: { files: indexes.length, additions: indexes.length, deletions: indexes.length } },
					files: indexes.map(index => ({ path: `file-${index}.ts`, kind: 'modified', binary: false, additions: 1, deletions: 1 })),
				};
			},
			readTurnChangeFile: async (_sessionId: string, _threadId: string, _changeSetId: string, path: string) => {
				sessionFileReads++;
				if (changeSessionRevisionOnRead) { sessionRevision++; changeSessionRevisionOnRead = false; }
				return { path, binary: false, truncated: false, before: `before\n${'shared\n'.repeat(30)}`, after: `after\n${'shared\n'.repeat(30)}` };
			},
			prepareTurnCommit: async (_sessionId: string, _threadId: string, selections: unknown, message: string) => {
				sessionPreparedFiles.push({ selections, message });
				return { commitId: 'prepared-file', targetBranch: 'main', message, files: [{ path: 'file-7.ts', kind: 'modified', binary: false, additions: 1, deletions: 1 }], warnings: [] };
			},
			readTurnCommitFile: async () => ({ path: 'file-7.ts', binary: false, truncated: false, before: 'before', after: 'after' }),
		} as unknown as IChatService);
		const models = resources.add(uriIdentityServices.createInstance(BrowserTextModelService, {
			onDidChange: Event.None,
			resolve: async request => ({ resource: request.resource, text: request.bootstrapText ?? '', revision: undefined }),
			save: async () => { throw new Error('Session review is read-only'); },
		} satisfies ITextResourceStore, {}));
		resources.add(EditorPanes.registerEditorPane({
			id: 'integration.sessionMultiDiff', name: 'Session review', canOpen: matchMultiDiffEditor,
			create: () => sessionServices!.createInstance(MultiDiffEditor, {
				modelService: models, createComputationService: () => service.createComputationService(), lineHeight: 0, activeEditorId: SessionChangesEditor.ID,
				fileActions: { menuService: sessionServices!.get(IMenuService), contextMenuProvider: sessionServices!.get(IContextMenuService), contextKeyService: sessionServices!.get(IContextKeyService) },
			}),
		}));
		const badgeContainer = document.createElement('div');
		badgeContainer.id = 'session-changes-label';
		document.getElementById('session-changes')!.append(badgeContainer);
		resources.add(toDisposable(() => badgeContainer.remove()));
		const labels = resources.add(sessionServices.get(IResourceLabelService).createGroup());
		const label = labels.create(badgeContainer);
		const input = new SessionChangesEditorInput(URI.parse('ash-session-changes:/review?thread=review-thread'));
		label.setResource({ resource: input.resource, name: input.label }, { forceLabel: true, extraClasses: input.getLabelExtraClasses(), fileDecorations: { colors: true, badges: true } });
	}
	const pane = sessionServices.createInstance(SessionChangesEditor, {});
	sessionPane.value = pane;
	pane.create(document.getElementById('session-changes')!);
	pane.layout({ width: 800, height: 240 });
	return pane;
}

import '../../../src/ash/editor/contrib/indentation/browser/indentation.js';
import '../../../src/ash/editor/contrib/quickAccess/browser/quickAccessController.js';
import '../../../src/ash/workbench/contrib/codeEditor/browser/quickaccess/gotoLineQuickAccess.js';
import { EditorStatusContribution, ChangeLanguageAction, ChangeEOLAction, ChangeEncodingAction } from '../../../src/ash/workbench/browser/parts/editor/editorStatus.js';

import { StatusbarPart, StatusbarService } from '../../../src/ash/workbench/browser/parts/statusbar/statusbarPart.js';
import { IStatusbarService } from '../../../src/ash/workbench/services/statusbar/browser/statusbar.js';
import { ILanguageService } from '../../../src/ash/editor/common/languages/language.js';
resources.add(registerAction2(ChangeLanguageAction));
resources.add(registerAction2(ChangeEOLAction));
resources.add(registerAction2(ChangeEncodingAction));

const harness = {
	async openTitleComparison(kind: 'diff' | 'history' | 'git' | 'writable' | 'binary' | 'encoding' | 'markdown' | 'paths' = 'diff', gitComparison: 'staged' | 'unstaged' = 'unstaged', encoding: 'utf8' | 'utf8bom' = 'utf8', singleGitFile = false): Promise<void> {
		titleGitEncoding = encoding;
		registerDiffEditorCommands();
		const host = document.createElement('div');
		host.id = 'title-comparison';
		// EditorPart.layout() sizes its inner grid, not its host. Reserve the matching editor height
		// and a separate status bar row so the status bar cannot cover diff gutter actions.
		host.style.cssText = 'position:relative;display:grid;grid-template-rows:300px 32px;width:1000px';
		document.body.prepend(host);
		resources.add(toDisposable(() => host.remove()));
		titleConfiguration = resources.add(new InMemoryConfigurationService());
		const parentServices = resources.add(createTestEditorServices(titleConfiguration));
		if (kind === 'paths' || kind === 'git') {
			(parentServices.get(IWorkspaceContextService) as TestWorkspaceService).updateWorkspace({ id: 'paths', uri: URI.file('/workspace') });
		}
		const services = resources.add(parentServices.createChild());
		titleServices = services;
		if (kind === 'markdown') {
			services.registerInstance(ILanguageFeaturesService, editorServices.languageFeaturesService);
			services.registerInstance(IWorkspaceContextService, resources.add(new TestWorkspaceService({ id: 'markdown', uri: URI.file('/fixture') })));
			resources.add(editorServices.languageFeaturesService.documentSymbolProvider.register('markdown', {
				provideDocumentSymbols: request => [{
					name: 'Cross-machine Desktop acceptance', kind: 'string',
					range: new Range(1, 1, request.model.getLineCount(), request.model.getLineMaxColumn(request.model.getLineCount())),
					selectionRange: new Range(1, 1, 1, request.model.getLineMaxColumn(1)),
				}],
			}));
			await titleConfiguration.updateValue('editor.wordWrap', 'on', { overrideIdentifier: 'markdown' });
		}
		if (kind === 'encoding') {
			services.registerInstance(ITextFileService, {
				onDidChangeFiles: Event.None, onDidSave: Event.None,
				resolve: async request => ({ resource: request.resource, text: 'after\nshared', revision: 'encoding-revision', encoding: 'cp950', source: TextFileContentSource.FileSystem }),
				save: async () => ({ revision: 'encoding-revision' }),
			});
		}
		if (kind === 'git') {
			services.registerInstance(INotificationService, { error: (message: string) => gitGutterCalls.push({ error: message }), info: () => { } } as unknown as INotificationService);
			services.registerInstance(ITextFileService, {
				onDidChangeFiles: Event.None, onDidSave: Event.None,
				resolve: async request => ({ resource: request.resource, text: `src/first.ts revision ${titleGitStatus.revision}\nshared`, revision: 'file-revision', encoding: titleGitEncoding, source: TextFileContentSource.FileSystem }),
				save: async request => { gitGutterCalls.push({ save: request }); return { revision: 'saved' }; },
			});
		}
		services.registerInstance(IEditorPartsService, {
			get activePane() { return titleEditor?.activePane; },
			openEditor: (input, options, target) => titleEditor!.openEditor(input, options, target),
		} as IEditorPartsService);
		services.registerSingleton(ICodeEditorService, () => services.createInstance(CodeEditorService));
		services.registerInstance(ILayoutService, resources.add(new BrowserLayoutService({ root: document.body })));
		// Quick Access providers must capture this fixture's focused diff side,
		// rather than the editors in the inherited standalone service scope.
		services.registerSingleton(IQuickInputService, () => resources.add(services.createInstance(QuickInputService)));
		resources.add(registerAction2(MultiDiffGoToFileAction));
		resources.add(registerAction2(MultiDiffCollapseAllAction));
		resources.add(registerAction2(MultiDiffToggleCollapseAllAction));
		resources.add(registerAction2(MultiDiffExpandAllAction));
		resources.add(registerAction2(MultiDiffToggleCollapseUnchangedRegionsAction));
		resources.add(CommandsRegistry.register('integration.inspectMultiDiffFile', (_accessor, input: unknown) => {
			inspectedFiles.push((input as { resource: URI; }).resource.toString());
		}));
		resources.add(MenusRegistry.appendMenuItem(MenuId.MultiDiffEditorFileToolbar, {
			command: { id: 'integration.inspectMultiDiffFile', title: 'Inspect File' },
			when: ContextKeyExpr.equals('resource', 'file:///workspace/src/first.ts'),
			group: 'navigation', order: 23,
		}));
		services.registerSingleton(ICommandService, () => resources.add(new CommandService(services)));
		services.registerSingleton(IMenuService, () => services.createInstance(MenuService));
		services.registerSingleton(IEditorPart, () => titleEditor!);
		services.registerSingleton(IEditorService, () => resources.add(new BrowserEditorService(titleEditor!)));
		services.registerSingleton(IDiffEditorCommandsService, () => services.createInstance(DiffEditorCommandsService));
		const dialogs = resources.add(new DialogService());
		services.registerInstance(IDialogService, dialogs);
		resources.add(new DialogHandlerContribution(dialogs.model, new BrowserDialogHandler(document.body)));
		registerCodeEditorServices(services);
		resources.add(services.get(ILanguageService).registerLanguage({ id: 'status-language', aliases: ['Status Language'] }));
		services.registerInstance(IMultiDiffSourceResolverService, new MultiDiffSourceResolverService());
		if (kind === 'git') {
			const locale = new URLSearchParams(location.search).get('locale') === 'zh-CN' ? 'zh-CN' : 'en';
			const labels: Record<string, string> = locale === 'zh-CN' ? gitChinese : gitEnglish;
			const editorChanges = new MainThreadEditorChanges(services.get(ICodeEditorService), services.get(IWorkingCopyService), services.get(ITextFileService));
			window.__rustGitClient = async (raw): Promise<ExtensionClientResult> => {
				const operation = raw as ExtensionClientOperation;
				switch (operation.operation) {
					case 'readConfiguration': return { result: 'configuration', value: {} };
					case 'inspectConfiguration': return { result: 'configuration', value: {} };
					case 'scmUpdate': return { result: 'done' };
					case 'backendState': return { result: 'value', value: { connection: 'ready', sequence: 0, generation: titleGitStatus.revision, reset: false, events: [], folders: [{ id: 'workspace', name: 'Workspace', uri: 'file:///workspace' }] } };
					case 'backendRequest': {
						const params = operation.params as Record<string, JsonValue>;
						let value: unknown;
						switch (operation.method) {
							case 'version': value = { installation: { kind: 'available', version: 'git version 2.50.0' } }; break;
							case 'repositories': value = { repositories: [{ id: titleGitStatus.repositoryId, label: 'Workspace', path: '', dirId: 'workspace' }] }; break;
							case 'status': value = { ...titleGitStatus, path: '' }; break;
							case 'catalog': value = { tags: [], stashes: [], remotes: ['origin'], upstreamReadOnly: false, operation: null }; break;
							case 'changeFile': value = await titleGit.changeFile(String(params.path)); break;
							case 'indexDiff': value = await titleGit.indexDiff(String(params.path)); break;
							case 'editIndex': value = { status: await titleGit.editIndex(String(params.path), String(params.comparison), { original: params.expectedOriginal, modified: params.expectedModified, hunks: [] }, params.selection, String(params.repositoryId)) }; break;
							default: throw new Error(`Unexpected Rust Git backend method ${operation.method}`);
						}
						return { result: 'value', value: value as JsonValue };
					}
					case 'editorOperation': {
						const request = operation.payload as Record<string, JsonValue>;
						if (request.method === 'openEditorResources') return { result: 'value', value: [] };
						if (request.method === 'activeEditor') return { result: 'value', value: { input: null } };
						if (request.method === 'output' || request.method === 'setLineAnnotation') return { result: 'value', value: null };
						if (request.method === 'confirm') return { result: 'value', value: await services.get(IDialogService).confirm({ message: String(request.message), primaryButton: typeof request.primaryButton === 'string' ? request.primaryButton : undefined }) as unknown as JsonValue };
						if (request.method === 'dirty') return { result: 'value', value: services.get(IWorkingCopyService).get(URI.parse(String(request.uri))).map(copy => ({ resource: copy.resource.toString(), isDirty: copy.isDirty })) };
						return { result: 'value', value: await editorChanges.handle(operation.payload, new AbortController().signal) as JsonValue };
					}
					case 'showMessage': services.get(INotificationService).error(operation.message); return { result: 'done' };
					default: throw new Error(`Unexpected Rust Git client operation ${operation.operation}`);
				}
			};
			for (const [menuName, entries] of Object.entries(gitManifest.contributes.menus)) {
				if (menuName !== 'diffEditor/hunkToolbar' && menuName !== 'diffEditor/selectionToolbar') continue;
				for (const entry of entries) {
					if (typeof entry.command !== 'string') continue;
					const commandId = entry.command;
					const definition = gitManifest.contributes.commands.find(command => command.command === entry.command)!;
					const title = labels[definition.title.slice(1, -1)] ?? definition.title;
					resources.add(CommandsRegistry.register(entry.command, async (_accessor, raw) => {
						const value = normalizeExtensionHostPayload(JSON.parse(JSON.stringify(raw, wireReplacer)));
						try { await invokeRustGit(commandId, 'execute', { arguments: [value] }); }
						catch (error) { services.get(INotificationService).error(error instanceof Error ? error.message : String(error)); }
					}));
					resources.add(MenusRegistry.appendMenuItem(menuName === 'diffEditor/hunkToolbar' ? MenuId.DiffEditorHunkToolbar : MenuId.DiffEditorSelectionToolbar, {
						command: { id: commandId, title, icon: definition.icon ? Icon.fromId(definition.icon.slice(2, -1)) : undefined },
						group: 'group' in entry ? entry.group : undefined,
						when: ContextKeyExpr.deserialize('when' in entry ? entry.when : undefined),
					}));
				}
			}
			const resolver = services.get(IMultiDiffSourceResolverService);
			resources.add(resolver.registerResolver({
				canHandleUri: resource => resource.scheme === 'ash-scm',
				resolveDiffSource: async resource => {
					// Refresh the requested source, or a staged comparison is replaced with unstaged resources.
					const scope = new URLSearchParams(resource.query).get('scope');
					if (scope !== 'staged' && scope !== 'unstaged' && scope !== 'uncommitted') throw new Error('Invalid Git source scope');
					await invokeRustGit('git.refresh', 'execute', { arguments: [] });
					const input = await createGitMultiDiffEditorInput(titleGit, scope);
					if (!isMultiDiffEditorInput(input)) throw new Error('Expected multi-diff');
					return { resource: input.resource, resources: input.items, source: input.source, label: input.label };
				},
				sourceActions: () => [], primaryRepositoryAction: () => undefined,
			}));
			resources.add(titleGitEvents.event(() => resolver.notifyChanged()));
		}
		const contexts = services.get(IContextKeyService);
		titleTheme = services.get(IThemeService) as TestThemeService;
		resources.add(bindTestColorTheme(services.get(IThemeService), document.documentElement));
		let storedEncoding = 'utf8';
		const store: ITextResourceStore = {
			onDidChange: Event.None,
			resolve: async request => ({ resource: request.resource, text: request.bootstrapText ?? 'after\nshared', revision: kind === 'encoding' ? 'encoding-revision' : undefined, ...(kind === 'encoding' ? { encoding: request.encoding ?? storedEncoding } : request.encoding === undefined ? {} : { encoding: request.encoding }) }),
			save: async request => { if (titleSaveFailure) throw new Error('Save rejected'); titleWrites.push({ resource: request.resource.path, text: request.text, ...(request.encoding === undefined ? {} : { encoding: request.encoding }) }); storedEncoding = request.encoding ?? storedEncoding; return { revision: kind === 'encoding' ? 'encoded-revision' : undefined }; },
		};
		const models = resources.add(uriIdentityServices.createInstance(BrowserTextModelService, store, {}));
		services.registerInstance(IFileTextModelService, models);
		const registry = new EditorPaneRegistry();
		resources.add(registry.registerEditorPane({
			id: DIFF_EDITOR_ID,
			name: 'Diff editor',
			canOpen: input => isDiffEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
			create: () => services.createInstance(TextDiffEditor, store, { modelService: models, createComputationService: () => service.createComputationService() }),
		}));
		resources.add(registry.registerEditorPane({
			id: MULTI_DIFF_EDITOR_ID,
			name: 'Multi-diff editor',
			canOpen: matchMultiDiffEditor,
			create: () => services.createInstance(MultiDiffEditor, {
				modelService: models,
				createComputationService: () => service.createComputationService(),
				editorService: services.get(IEditorService),
				commandService: services.get(ICommandService),
				sourceResolverService: services.get(IMultiDiffSourceResolverService),
				viewsService: {
					focusView: async (viewId: string) => { focusedHistoryView = viewId; return true; },
				} as IViewsService,
				fileActions: { menuService: services.get(IMenuService), contextMenuProvider: services.get(IContextMenuService), contextKeyService: contexts },
			}),
		}));
		titleEditor = resources.add(services.createInstance(EditorPart, host, {
			registry,
			configurationService: titleConfiguration,
			languageFeaturesService: kind === 'markdown' ? editorServices.languageFeaturesService : undefined,
			showBreadcrumbSymbolPicker: (symbols, selected, reveal) => { resources.add(services.createInstance(BreadcrumbsSymbolPicker, symbols, selected, reveal)).show(); },
			contextKeyService: contexts,
			titleActions: { menuService: services.get(IMenuService), contextMenuProvider: services.get(IContextMenuService) },
		} satisfies IEditorPartOptions));
		titleEditor.layout({ width: 1000, height: 300 });
		const statusbar = resources.add(new StatusbarService());
		services.registerInstance(IStatusbarService, statusbar);
		resources.add(services.createInstance(StatusbarPart, host));
		resources.add(services.createInstance(EditorStatusContribution, titleEditor, statusbar));
		if (kind === 'git') {
			titleGitStatus = makeTitleGitStatus(['src/first.ts', 'src/second.ts'], 1);
			if (gitComparison === 'staged') {
				titleGitStatus = { ...titleGitStatus, changes: titleGitStatus.changes.map(change => ({ ...change, indexStatus: 'modified', worktreeStatus: 'unmodified' })) };
			}
			await window.__rustGitRequest('start', { language: new URLSearchParams(location.search).get('locale') ?? 'en', workspaceFolders: [], configurationValues: {}, configurationData: {} });
			await invokeRustGit('ash.scm', 'scm', { method: 'initialize' });
			const input = await createGitMultiDiffEditorInput(titleGit, gitComparison);
			if (singleGitFile) {
				if (!isMultiDiffEditorInput(input)) throw new Error('Expected multi-diff');
				const first = input.items[0]!;
				// Individual working-tree comparisons edit the live file, as Git's open-change command does.
				await titleEditor.openEditor(createDiffEditorInput(first.original, {
					...first.modified, resource: URI.file('/workspace/src/first.ts'), readOnly: false,
				}), { pinned: true });
			} else {
				await titleEditor.openEditor(input, { pinned: true });
			}
			return;
		}
		if (kind === 'paths') {
			const path = 'extensions/language-pack-zh-cn/translations/chat.json';
			await titleEditor.openEditor(createMultiDiffEditorInput(URI.parse('ash-multi-diff:/paths'), [
				{
					label: path, binary: true,
					original: { resource: URI.parse(`snapshot:/${path}?revision=1`), preferredResource: URI.file(`/workspace/${path}`), label: path },
					modified: { resource: URI.parse(`snapshot:/${path}?revision=2`), preferredResource: URI.file(`/workspace/${path}`), label: path },
				},
				{
					label: 'src/renamed folder/包含空格的目录/second.ts', binary: true,
					original: { resource: URI.parse('snapshot:/old?revision=1'), preferredResource: URI.file('/workspace/src/previous folder/包含空格的目录/second.ts') },
					modified: { resource: URI.parse('snapshot:/new?revision=2'), preferredResource: URI.file('/workspace/src/renamed folder/包含空格的目录/second.ts') },
				},
			], 'Path review'), { pinned: true });
			return;
		}
		if (kind === 'writable' || kind === 'binary') {
			writableTitleInput = createMultiDiffEditorInput(URI.parse('ash-multi-diff:/binary-writable'), [
				{ label: 'image.bin', binary: true, original: { resource: URI.parse('snapshot:/image.bin'), readOnly: true }, modified: { resource: URI.file('/workspace/image.bin') } },
				...(kind === 'writable' ? ['first', 'second'].map(name => ({ label: `${name}.ts`, original: { resource: URI.parse(`snapshot:/${name}.ts`), initialText: 'before', readOnly: true }, modified: { resource: URI.file(`/workspace/${name}.ts`), initialText: 'after' } })) : []),
			], 'File review');
			await titleEditor.openEditor(writableTitleInput, { pinned: true });
			return;
		}
		if (kind === 'markdown') {
			const text = '# Cross-machine Desktop acceptance\n\n' + 'Markdown **content** with `inline code` and a [link](https://example.test). '.repeat(8);
			await titleEditor.openEditor(createDiffEditorInput(
				{ resource: URI.parse('git-change:/unstaged/docs/TODO.md?side=original'), preferredResource: URI.file('/fixture/docs/TODO.md'), initialText: text.replace('acceptance', 'verification'), languageId: 'markdown', readOnly: true },
				{ resource: URI.parse('git-change:/unstaged/docs/TODO.md?side=modified'), preferredResource: URI.file('/fixture/docs/TODO.md'), initialText: text, languageId: 'markdown' },
			), { pinned: true });
			return;
		}
		if (kind === 'history') {
			await titleEditor.openEditor(createMultiDiffEditorInput(
				URI.parse('ash-multi-diff:/scm-history/repo_internal/parent/98246c6'),
				[{
					label: 'src/example.ts',
					original: { resource: URI.parse('git-commit:/parent/example.ts'), initialText: 'before\nshared', readOnly: true },
					modified: { resource: URI.parse('git-commit:/98246c6/example.ts'), initialText: 'after\nshared', readOnly: true },
				}],
				'98246c6 · Simplify diff editor update method and improve accessibility',
				{ kind: 'snapshot', repositoryId: 'repo_internal', label: '98246c6' },
			), { pinned: true });
			return;
		}
		await titleEditor.openEditor(createDiffEditorInput(
			{ resource: URI.file('/title/before.ts'), label: 'before.ts', initialText: 'before\nshared ' },
			{ resource: URI.file('/title/after.ts'), label: 'after.ts', initialText: 'after\nshared' },
		), { pinned: true });
	},
	prepareMarkdownEditing(): void {
		const diff = (titleEditor!.activePane as TextDiffEditor).getControl()!;
		resources.add(editorServices.languageFeaturesService.hoverProvider.register('markdown', {
			provideHover: () => ({ range: new Range(1, 3, 1, 9), contents: ['Markdown hover from language provider'] }),
		}));
		resources.add(editorServices.languageFeaturesService.completionProvider.register({
			id: 'markdown-diff-fixture', languageIds: ['markdown'],
			provideCompletions: request => ({
				items: [{ id: 'completed', label: 'completedMarkdown', kind: LanguageCompletionItemKind.Text, range: Range.fromPositions(request.position), insertText: 'completedMarkdown' }],
				isIncomplete: false,
			}),
		}));
		diff.modifiedEditor.getModel()!.setValue('# sample');
		diff.modifiedEditor.setPosition({ lineNumber: 1, column: 9 });
	},
	readMarkdownComparison() {
		const diff = (titleEditor!.activePane as TextDiffEditor).getControl()!;
		return {
			position: diff.modifiedEditor.getPosition(),
			wordWrap: diff.modifiedEditor.getOption(EditorOption.wordWrap),
			wrappingColumns: [diff.originalEditor, diff.modifiedEditor].map(editor => ({ column: editor.getOption(EditorOption.wrappingInfo).wrappingColumn, characterWidth: editor.getOption(EditorOption.fontInfo).typicalHalfwidthCharacterWidth, contentWidth: editor.getLayoutInfo().contentWidth, editorWidth: editor.getLayoutInfo().width, glyphMarginWidth: editor.getLayoutInfo().glyphMarginWidth, decorationsWidth: editor.getLayoutInfo().decorationsWidth })),
			find: !!diff.modifiedEditor.getContribution('editor.contrib.findController'),
			hover: !!diff.modifiedEditor.getContribution('editor.contrib.hover'),
			suggest: !!diff.modifiedEditor.getContribution('editor.contrib.suggestController'),
			originalReadonly: diff.originalEditor.getOption(EditorOption.readOnly),
			modifiedReadonly: diff.modifiedEditor.getOption(EditorOption.readOnly),
			codeLens: [diff.originalEditor, diff.modifiedEditor].map(editor => editor.getOption(EditorOption.codeLens)),
			minimap: [diff.originalEditor, diff.modifiedEditor].map(editor => editor.getOption(EditorOption.minimap).enabled),
			codeLensTitle: Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration(CodeEditorConfiguration.diffCodeLens)?.setting?.title,
		};
	},
	readTitlePersistence(): { dirty: boolean; copies: number; writes: { resource: string; text: string; encoding?: string; }[]; tabs: number; active: string | undefined; } {
		return { dirty: titleEditor!.activeGroup.editors.some(editor => editor.isDirty), copies: titleServices!.get(IWorkingCopyService).getAll().length, writes: [...titleWrites], tabs: titleEditor!.activeGroup.inputs.length, active: titleEditor!.activeInput?.resource.toString() };
	},
	async saveTitleFiles(fail = false): Promise<string | undefined> {
		titleSaveFailure = fail;
		try { await titleServices!.get(IEditorService).saveAll(); return undefined; }
		catch (error) { return (error as Error).message; }
		finally { titleSaveFailure = false; }
	},
	async openOtherTitleFile(): Promise<void> {
		await titleEditor!.openEditor(createDiffEditorInput({ resource: URI.parse('snapshot:/other/before'), initialText: 'old', readOnly: true }, { resource: URI.parse('snapshot:/other/after'), initialText: 'new', readOnly: true }), { pinned: true });
	},
	closeWritableTitle(): Promise<boolean> { return titleEditor!.closeEditor(writableTitleInput!); },
	get gitGutterCalls() { return gitGutterCalls; },
	expireGitGutterSnapshot(): void { titleGitStatus = { ...titleGitStatus, revision: titleGitStatus.revision + 1 }; },
	selectTitleModified(range: [number, number, number, number]): void {
		const editor = titleServices!.get(ICodeEditorService).listDiffEditors().find(candidate => candidate instanceof DiffEditorWidget) as DiffEditorWidget;
		editor.modifiedEditor.setSelection(new Range(...range));
	},
	async updateTitleEditorConfiguration(key: string, value: unknown, languageId?: string): Promise<void> {
		await titleConfiguration!.updateValue(key, value, { overrideIdentifier: languageId });
	},
	updateTitleGit(paths: string[], revision: number, delay = 0, repositoryId = 'repo'): void {
		titleGitDelay = delay;
		titleGitStatus = makeTitleGitStatus(paths, revision, repositoryId);
		titleGitEvents.fire(titleGitStatus);
	},
	readMultiDiffFoundation(): { active: string | undefined; activeCodeEditor: boolean; contents: string[]; fonts: number[]; lines: number[]; inspected: string[]; state: unknown; } {
		const pane = titleEditor?.activePane;
		const service = titleServices!.get(ICodeEditorService);
		const editors = service.listDiffEditors().map(editor => editor.getModifiedEditor());
		return {
			active: pane instanceof MultiDiffEditor ? pane.getActiveDiffItem()?.label : undefined,
			activeCodeEditor: service.getActiveCodeEditor() !== null && pane instanceof MultiDiffEditor && service.getActiveCodeEditor() === pane.getControl()?.getModifiedEditor(),
			contents: editors.map(editor => editor.getModel()!.getValue()),
			fonts: editors.map(editor => editor.getOption(EditorOption.fontInfo).fontSize),
			lines: editors.map(editor => editor.getOption(EditorOption.lineHeight)),
			inspected: [...inspectedFiles],
			state: pane instanceof MultiDiffEditor ? pane.saveViewState() : null,
		};
	},
	setTitleTheme(themeId: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light'): void {
		const themes = { vs: lightColorTheme, 'vs-dark': darkColorTheme, 'hc-black': highContrastDarkColorTheme, 'hc-light': highContrastLightColorTheme };
		titleTheme!.setColorTheme(themes[themeId]);
	},
	resizeTitleComparison(width: number): void { titleEditor!.layout({ width, height: 300 }); },
	focusedHistoryView(): string | undefined { return focusedHistoryView; },
	setTitleComparisonText(originalText: string, modifiedText: string): void {
		const pane = titleEditor!.activePane;
		if (!(pane instanceof TextDiffEditor)) throw new Error('Expected a text diff editor');
		const control = pane.getControl()!;
		control.originalEditor.getModel()!.setValue(originalText);
		control.modifiedEditor.getModel()!.setValue(modifiedText);
	},
	readTitleComparison(): { mode: string | undefined; original: string | undefined; modified: string | undefined; ignoreWhitespace: boolean | undefined; renderWhitespace: string | undefined; changes: number | undefined; } {
		const pane = titleEditor?.activePane;
		const control = pane instanceof TextDiffEditor ? pane.getControl() : undefined;
		return {
			mode: control?.viewMode,
			original: control?.originalEditor.getModel()?.getText(),
			modified: control?.modifiedEditor.getModel()?.getText(),
			ignoreWhitespace: titleConfiguration?.getValue<boolean>('diffEditor.ignoreTrimWhitespace'),
			renderWhitespace: titleConfiguration?.getValue<string>('editor.renderWhitespace'),
			changes: control?.diff?.hunks.length,
		};
	},
	async openSessionChanges(): Promise<void> {
		const pane = createSessionChangesPane();
		pane.setVisible(true);
		sessionInput = new SessionChangesEditorInput(URI.parse('ash-session-changes:/review?thread=review-thread'));
		sessionOpenController = new AbortController();
		await pane.setInput(sessionInput, sessionOpenController.signal);
	},
	cancelCompletedSessionOpen(): void { sessionOpenController!.abort(); },
	beginPendingSessionOpen(): void {
		const pane = createSessionChangesPane();
		pane.setVisible(true);
		pendingSessionRead = new DeferredPromise<void>();
		sessionReadStarted = false;
		sessionOpenController = new AbortController();
		sessionInput = new SessionChangesEditorInput(URI.parse('ash-session-changes:/review?thread=review-thread'));
		sessionOpenState = 'pending';
		void pane.setInput(sessionInput, sessionOpenController.signal).then(() => { sessionOpenState = 'opened'; }, error => { sessionOpenState = error.name === 'CancellationError' ? 'cancelled' : `failed: ${String(error)}`; });
	},
	cancelPendingSessionOpen(): void { sessionOpenController!.abort(); },
	sessionOpenOutcome(): string { return sessionOpenState; },
	sessionFileReadCount(): number { return sessionFileReads; },
	async releasePendingSessionRead(): Promise<void> { await pendingSessionRead!.complete(); pendingSessionRead = undefined; },
	async retryPendingSessionOpen(cancelFirst: boolean): Promise<void> {
		supersededSessionRead = pendingSessionRead;
		pendingSessionRead = undefined;
		supersededSessionController = sessionOpenController;
		if (cancelFirst) { supersededSessionController!.abort(); }
		sessionMultipleCaptures = true;
		sessionInput = new SessionChangesEditorInput(URI.parse('ash-session-changes:/review?thread=review-thread'), { kind: 'id', id: 'review-later' });
		sessionOpenController = new AbortController();
		await sessionPane.value!.setInput(sessionInput, sessionOpenController.signal);
	},
	cancelSupersededSessionOpen(): void { supersededSessionController!.abort(); },
	refreshPendingSessionOpen(): void {
		supersededSessionRead = pendingSessionRead;
		pendingSessionRead = undefined;
		sessionChanges.fire({ sessionId: 'review', threadId: 'review-thread' });
	},
	async releaseSupersededSessionRead(failed: boolean): Promise<void> {
		const pending = supersededSessionRead!;
		supersededSessionRead = undefined;
		if (failed) { await pending.error(new Error('Superseded capture read failed')); }
		else { await pending.complete(); }
	},
	async selectSessionCapture(id: string | undefined, kind: 'id' | 'transient' | 'disabled' | 'noReview' = 'id'): Promise<void> {
		const resource = URI.parse('ash-session:/review?thread=review-thread');
		const changeset = kind === 'id' ? undefined : await sessionServices!.get(ISessionChangesService).resolveChangeset(resource, id!);
		sessionInput = new SessionChangesEditorInput(resource, changeset
			? { kind: 'transient', changeset: { ...changeset, isEnabled: kind === 'disabled' ? constObservable(false) : changeset.isEnabled, capabilities: { review: kind !== 'noReview' } } }
			: { kind: 'id', id });
		await sessionPane.value!.setInput(sessionInput, new AbortController().signal);
	},
	multipleSessionCaptures(): void { sessionMultipleCaptures = true; sessionChanges.fire({ sessionId: 'review', threadId: 'review-thread' }); },
	async reviewSessionOriginalFile(index: number): Promise<void> {
		await sessionServices!.get(ICommandService).executeCommand(CHANGESET_REVIEW_ACTION_ID, URI.parse(`ash-turn-diff:/review-change/file-${index}.ts?session=review&thread=review-thread&revision=${sessionRevision}&side=before`));
	},
	beginDelayedSessionReview(): void {
		pendingSessionRead = new DeferredPromise<void>();
		sessionReadStarted = false;
		pendingViewedState = 'pending';
		pendingViewedAction = this.reviewSessionFile(0).then(() => { pendingViewedState = 'finished'; });
	},
	pendingViewedOutcome(): string { return pendingViewedState; },
	refreshDuringSessionReview(): void {
		supersededSessionRead = pendingSessionRead;
		pendingSessionRead = undefined;
		sessionChanges.fire({ sessionId: 'review', threadId: 'review-thread' });
	},
	setSessionReviewState(index: number, reviewed: boolean): void {
		sessionServices!.get(IChangesViewService).setChangesetFilesReviewState([URI.parse(`ash-turn-diff:/review-change/file-${index}.ts?session=review&thread=review-thread&revision=${sessionRevision}`)], reviewed);
	},
	async finishActiveSessionReview(): Promise<void> {
		const pending = pendingSessionRead!;
		pendingSessionRead = undefined;
		await pending.complete();
		await pendingViewedAction;
		pendingViewedAction = undefined;
	},
	sessionReviewReadStarted(): boolean { return sessionReadStarted; },
	async finishInactiveSessionReview(failed = false, hidden = false): Promise<void> {
		if (hidden) { sessionPane.value!.setVisible(false); }
		else { sessionCommandsActive = false; }
		try {
			if (failed) { await pendingSessionRead!.error(new Error('Delayed Viewed lookup failed')); }
			else { await pendingSessionRead!.complete(); }
			await pendingViewedAction;
		} finally {
			pendingSessionRead = undefined;
			pendingViewedAction = undefined;
			sessionCommandsActive = true;
			if (hidden) { sessionPane.value!.setVisible(true); }
		}
	},
	setSessionChangesVisible(visible: boolean): void { sessionPane.value!.setVisible(visible); },
	refreshSessionChanges(): void { sessionChanges.fire({ sessionId: 'review', threadId: 'review-thread' }); },
	async revealSessionFile(index: number): Promise<void> {
		const changeset = await sessionServices!.get(ISessionChangesService).resolveChangeset(URI.parse('ash-session:/review?thread=review-thread'), 'review-change');
		const change = changeset.changes.get()[index]!;
		sessionPane.value!.restoreViewState({ revealData: { resource: { original: change.originalUri, modified: change.modifiedUri }, range: new Range(15, 1, 15, 2) } });
	},
	async reviewSessionFile(index: number, revision = sessionRevision, canonical = false): Promise<void> {
		const resource = URI.parse(`ash-turn-diff:/review-change/file-${index}.ts?session=review&thread=review-thread&revision=${revision}${canonical ? '' : '&side=after'}`);
		await sessionServices!.get(ICommandService).executeCommand('changeset.review', { resource });
	},
	sessionReviewState(): readonly string[] { return [...sessionServices!.get(IChangesViewService).reviewedFilesObs.get()]; },
	readSessionComparisonState(): { hasControl: boolean; accessibleContent: string; } {
		const pane = sessionPane.value!;
		return { hasControl: pane.getControl() !== undefined, accessibleContent: pane.getAccessibleContent() };
	},
	sessionTheme(name: 'dark' | 'light' | 'contrast'): void { sessionTheme!.setColorTheme(name === 'light' ? lightColorTheme : name === 'contrast' ? highContrastDarkColorTheme : darkColorTheme); },
	advanceSessionRevision(): void { sessionRevision++; sessionChanges.fire({ sessionId: 'review', threadId: 'review-thread' }); },
	changeSessionCaptureDuringRead(): void { changeSessionRevisionOnRead = true; sessionChanges.fire({ sessionId: 'review', threadId: 'review-thread' }); },
	unsealSessionCapture(): void { sessionCaptureState = 'open'; sessionRevision++; sessionChanges.fire({ sessionId: 'review', threadId: 'review-thread' }); },
	setSessionAvailability(availability: 'available' | 'empty' | 'failed'): void {
		sessionAvailability = availability;
		sessionChanges.fire({ sessionId: 'review', threadId: 'review-thread' });
	},
	sessionOpenedFiles(): readonly string[] { return sessionOpenedFiles; },
	sessionPreparedFiles(): readonly unknown[] { return sessionPreparedFiles; },
	rejectInvalidSessionReveal(): boolean {
		try {
			sessionPane.value!.restoreViewState({ revealData: { resource: { original: 'invalid' } } });
			return false;
		} catch (error) {
			return error instanceof TypeError;
		}
	},
	readSessionViewState(): unknown {
		const pane = sessionPane.value!;
		return isEditorPaneWithViewState(pane) ? pane.saveViewState() : null;
	},
	async reopenSessionChanges(): Promise<void> {
		const state = this.readSessionViewState();
		const serialized = JSON.parse(JSON.stringify(EditorInputSerializers.serialize(sessionInput!)));
		sessionPane.clear();
		const pane = createSessionChangesPane();
		sessionInput = EditorInputSerializers.deserialize(serialized) as SessionChangesEditorInput;
		await pane.setInput(sessionInput, new AbortController().signal);
		if (isEditorPaneWithViewState(pane)) pane.restoreViewState(state);
		pane.setVisible(true);
	},
	closeSessionChanges(): void {
		closedSessionEditor = { input: JSON.parse(JSON.stringify(EditorInputSerializers.serialize(sessionInput!))), state: this.readSessionViewState() };
		sessionPane.value!.setVisible(false);
		sessionPane.value!.clearInput();
		sessionPane.clear();
	},
	async reopenClosedSessionChanges(): Promise<void> {
		const pane = createSessionChangesPane();
		sessionInput = EditorInputSerializers.deserialize(closedSessionEditor!.input) as SessionChangesEditorInput;
		await pane.setInput(sessionInput, new AbortController().signal);
		pane.restoreViewState(closedSessionEditor!.state);
		pane.setVisible(true);
	},
	saveSessionWindow(): void {
		window.sessionStorage.setItem('ash.diff.integration.sessionEditor', JSON.stringify({ input: EditorInputSerializers.serialize(sessionInput!), state: this.readSessionViewState() }));
	},
	async switchSessionChanges(): Promise<void> {
		await sessionPane.value!.setInput({ resource: URI.parse('ash-session-changes:/other?thread=other-thread') }, new AbortController().signal);
	},
	activeMultiControl(): string | undefined {
		return multi.getActiveControl()?.modifiedEditor.getModel()?.getText();
	},
	focusMulti(): void { multi.focus(); },
	toggleMultiUnchangedRegions(): void { multi.toggleCollapseUnchangedRegions(); },
	readIndicatorSetting(): { title: string; description: string; } {
		const setting = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration('diffEditor.renderIndicators')!.setting!;
		return { title: setting.title, description: setting.description };
	},
	setTheme(themeId: string): { marker: string; background: string; } {
		themeBinding ??= resources.add(bindTestColorTheme(editorServices.themeService, document.body));
		editorServices.themeService.setTheme(themeId);
		const theme = editorServices.themeService.getColorTheme();
		const cssColor = (id: string) => {
			const value = theme.getColor(id);
			if (!value) return 'rgba(0, 0, 0, 0)';
			const { r, g, b } = value.rgba;
			return `rgb(${r}, ${g}, ${b})`;
		};
		return { marker: cssColor('diffEditor.removedLineMarker'), background: cssColor('diffEditorGutter.removedLineBackground') };
	},
	async setDiffIndicators(enabled: boolean): Promise<void> {
		await editorServices.get(IConfigurationService).updateValue('diffEditor.renderIndicators', enabled);
	},
	setEditorFeatures(options: IDiffEditorOptions): void {
		single.updateOptions(options);
	},
	showEmbeddedComparison(): void {
		embedded.value = editorServices.createInstance(EmbeddedDiffEditorWidget, { container: document.getElementById('many')!, model, readOnly: true }, single.modifiedEditor);
	},
	updateEmbeddedComparison(options: IDiffEditorOptions): void {
		embedded.value!.updateOptions(options);
	},
	closeEmbeddedComparison(): void {
		embedded.clear();
	},
	setGuides(options: Pick<IDiffEditorOptions, 'guides'>): void {
		single.originalEditor.updateOptions(options);
		single.modifiedEditor.updateOptions(options);
	},
	setFontOptions(options: Pick<IDiffEditorOptions, 'fontFamily' | 'fontSize' | 'lineHeight' | 'fontLigatures'>): void {
		single.originalEditor.updateOptions(options);
		single.modifiedEditor.updateOptions(options);
	},
	async setMoves(enabled: boolean): Promise<void> {
		await editorServices.get(IConfigurationService).updateValue('diffEditor.experimental.showMoves', enabled);
		model.updateOptions({ ...diffOptions, computeMoves: enabled });
	},
	registerHunkAction(selection = false): void {
		const command = selection ? 'integration.selectionAction' : 'integration.hunkAction';
		resources.add(CommandsRegistry.register(command, (_accessor, ...args) => {
			const context = args[0] as DiffEditorSelectionHunkToolbarContext;
			lastHunkAction = { text: context.originalWithModifiedChanges, originalStart: context.mapping.original.startLineNumber, modifiedStart: context.mapping.modified.startLineNumber };
		}));
		resources.add(MenusRegistry.appendMenuItem(selection ? MenuId.DiffEditorSelectionToolbar : MenuId.DiffEditorHunkToolbar, {
			command: { id: command, title: selection ? 'Apply selected change' : 'Apply change', icon: Icon.fromId('add') }, group: 'primary',
		}));
	},
	get lastHunkAction() { return lastHunkAction; },
	selectModified(range: [number, number, number, number]): void {
		single.modifiedEditor.setSelection(new Range(...range));
	},
	editModified(range: [number, number, number, number], text: string): void {
		single.modifiedEditor.pushUndoStop();
		single.modifiedEditor.executeEdits('integration', [{ range: new Range(...range), text }]);
		single.modifiedEditor.pushUndoStop();
	},
	exitCompareMove(): void {
		single.exitCompareMove();
	},
	undo(): void { modified.undo(); },
	scrollModified(top: number): void { single.modifiedEditor.setScrollTop(top); },
	get layoutEventCount(): number { return layoutEventCount; },
	setViewMode(renderSideBySide: boolean, useInlineViewWhenSpaceIsLimited: boolean, inlineBreakpoint: number): void {
		single.setViewMode(renderSideBySide, useInlineViewWhenSpaceIsLimited, inlineBreakpoint);
	},
	showManyComparisons(count: number): void {
		const manyResources = resources.add(new DisposableStore());
		manyResources.add(editorServices.createInstance(MultiDiffEditorWidget, {
			container: document.getElementById('many')!,
			model: manyResources.add(new MultiDiffEditorModel(Array.from({ length: count }, (_, index) => manyResources.add(new DocumentDiffItem({ id: `file-${index}`, label: `file-${index}.ts` }, model))))),
			workbenchUIElementFactory: {
				createItemActions: () => {
					activeManyActions++;
					return toDisposable(() => activeManyActions--);
				}
			},
		}));
	},
	showLazyComparisons(count: number): void {
		const lazyResources = resources.add(new DisposableStore());
		lazyResources.add(editorServices.createInstance(MultiDiffEditorWidget, {
			container: document.getElementById('many')!,
			model: lazyResources.add(new MultiDiffEditorModel(Array.from({ length: count }, (_, index) => lazyResources.add(new DocumentDiffItem(
				{ id: `lazy-${index}`, label: `lazy-${index}.ts` },
				async () => {
					lazyLoads.push(index);
					return model;
				},
			))))),
		}));
	},
	get lazyLoads(): readonly number[] {
		return lazyLoads;
	},
	showDynamicComparisons(): void {
		dynamicResources = resources.add(new DisposableStore());
		const firstItem = dynamicResources.add(new DocumentDiffItem({ id: 'dynamic-first', label: 'dynamic-first.ts' }, model));
		dynamicSecond = dynamicResources.add(new DocumentDiffItem({ id: 'dynamic-second', label: 'dynamic-second.ts' }, second));
		dynamicCollection = dynamicResources.add(new MultiDiffEditorModel([firstItem, dynamicSecond]));
		dynamicResources.add(editorServices.createInstance(MultiDiffEditorWidget, {
			container: document.getElementById('many')!,
			model: dynamicCollection,
		}));
	},
	updateDynamicComparisons(): void {
		const third = dynamicResources!.add(new DocumentDiffItem({ id: 'dynamic-third', label: 'dynamic-third.ts' }, model));
		dynamicCollection!.setItems([dynamicSecond!, third]);
	},
	showDeferredComparison(): void {
		const deferredResources = resources.add(new DisposableStore());
		const item = deferredResources.add(new DocumentDiffItem({ id: 'deferred', label: 'deferred.ts' }, () => new Promise(resolve => {
			completeDeferredComparison = () => resolve(model);
		})));
		deferredResources.add(editorServices.createInstance(MultiDiffEditorWidget, {
			container: document.getElementById('many')!,
			model: deferredResources.add(new MultiDiffEditorModel([item])),
		}));
	},
	completeDeferredComparison(): void {
		completeDeferredComparison?.();
	},
	showFailedComparison(): void {
		const failedResources = resources.add(new DisposableStore());
		const item = failedResources.add(new DocumentDiffItem({ id: 'failed', label: 'failed.ts' }, async () => { throw new Error('Unavailable'); }));
		failedResources.add(editorServices.createInstance(MultiDiffEditorWidget, {
			container: document.getElementById('many')!,
			model: failedResources.add(new MultiDiffEditorModel([item])),
		}));
	},
	async showCompressedComparisons(count: number): Promise<void> {
		const compressedResources = resources.add(new DisposableStore());
		const lines = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n');
		const largeOriginal = compressedResources.add(new TextModel(lines));
		const largeModified = compressedResources.add(new TextModel(lines));
		const largeModel = compressedResources.add(new DiffModel({ original: largeOriginal, modified: largeModified, diffProvider: computation, diffOptions }));
		if (largeModel.state.kind !== 'ready') {
			await new Promise<void>((resolve, reject) => {
				const listener = largeModel.onDidChange(state => {
					if (state.kind === 'loading') return;
					listener.dispose();
					if (state.kind === 'error') reject(state.error);
					else resolve();
				});
			});
		}
		compressedEditor = compressedResources.add(editorServices.createInstance(MultiDiffEditorWidget, {
			container: document.getElementById('many')!,
			model: compressedResources.add(new MultiDiffEditorModel(Array.from({ length: count }, (_, index) =>
				compressedResources.add(new DocumentDiffItem({ id: `large-${index}`, label: `large-${index}.ts` }, largeModel))))),
		}));
	},
	get compressedLogicalScrollTop(): number {
		return compressedEditor?.saveViewState().scrollTop ?? 0;
	},
	saveCompressedPosition(): void {
		compressedViewState = compressedEditor!.saveViewState();
	},
	restoreCompressedPosition(): void {
		compressedEditor!.restoreViewState(compressedViewState);
	},
	get activeManyActions(): number {
		return activeManyActions;
	},
	setComparisonText(originalText: string, modifiedText: string): void {
		original.setValue(originalText);
		modified.setValue(modifiedText);
		input.value = modifiedText;
	},
	setHiddenRegions(enabled: boolean): void {
		single.setHideUnchangedRegionsOptions({ enabled, contextLineCount: 1, minimumLineCount: 3, revealLineCount: 2 });
	},
	setMultiHiddenRegions(enabled: boolean): Promise<void> {
		return editorServices.get(IConfigurationService).updateValue('diffEditor.hideUnchangedRegions.enabled', enabled);
	},
	removeSymbolProvider(): void {
		symbolProvider.dispose();
	},
	visibleDiffRanges(): { original: number[][]; modified: number[][]; } {
		const lines = (ranges: readonly Range[]) => ranges.map(range => [range.startLineNumber, range.endLineNumber]);
		return { original: lines(single.originalEditor.getVisibleRanges()), modified: lines(single.modifiedEditor.getVisibleRanges()) };
	},
	setSecondComparisonText(originalText: string, modifiedText: string): void {
		secondOriginal.setValue(originalText);
		secondModified.setValue(modifiedText);
	},
	mountResizeGrid(): void {
		const container = document.getElementById('single')!;
		container.style.width = '900px';
		if (single.wordWrap) { single.toggleWordWrap(); }
		const views = [h(container.ownerDocument, 'div'), single.element, h(container.ownerDocument, 'div')].map((element, index) => ({
			element, minimumWidth: 100, maximumWidth: Infinity, minimumHeight: 0, maximumHeight: Infinity,
			layout: (size: { width: number; height: number; }): void => {
				resizeLayoutCounts[index]!++;
				if (index === 1) { single.layout(size); }
			},
		}));
		resizeGrid = resources.add(new GridView(container, {
			type: 'branch', orientation: Orientation.HORIZONTAL, size: 900,
			children: views.map((view, index) => ({ type: 'leaf', view, size: [180, 440, 280][index]! })),
		}));
		resizeGrid.element.style.width = '900px';
		resizeGrid.element.style.height = '260px';
		resizeGrid.layout(900, 260);
		resizeLayoutCounts.fill(0);
	},
	resizeGridState() {
		return { sizes: [0, 1, 2].map(index => resizeGrid!.getViewSize([index]).width), layouts: [...resizeLayoutCounts] };
	},
	selectModifiedAll(): void {
		single.modifiedEditor.setSelection(Range.fromPositions(modified.positionAt(0), modified.positionAt(modified.getText().length)));
	},
	linePositions(originalLineNumber: number, modifiedLineNumber: number, includeTrailingViewZones = false) {
		return {
			originalTop: single.originalEditor.getTopForLineNumber(originalLineNumber),
			modifiedTop: single.modifiedEditor.getTopForLineNumber(modifiedLineNumber),
			originalBottom: single.originalEditor.getBottomForLineNumber(originalLineNumber, includeTrailingViewZones),
			modifiedBottom: single.modifiedEditor.getBottomForLineNumber(modifiedLineNumber, includeTrailingViewZones),
			originalContentHeight: single.originalEditor.getContentHeight(),
			modifiedContentHeight: single.modifiedEditor.getContentHeight(),
			originalScrollTop: single.originalEditor.getScrollTop(),
			modifiedScrollTop: single.modifiedEditor.getScrollTop(),
		};
	},
	setWrapping(mode: 'off' | 'on' | 'bounded' | 'wordWrapColumn', column: number): void {
		single.setConfiguredWordWrap(mode, column);
	},
	toggleWordWrap(): void {
		single.toggleWordWrap();
	},
	read() {
		return {
			state: model.state.kind,
			version: modified.version,
			resultVersion: model.state.modifiedVersion,
			kinds: Array.from(model.diff?.rows ?? []).map(row => row.kind),
			quickDiffReady: reference.object.state.comparisons[0]?.model.state.kind === 'ready',
			quickDiffChanges: reference.object.state.changes.length,
			baselineRequests,
			activeRow: single.currentChangeRow,
			originalText: original.getText(),
			modifiedText: modified.getText(),
			moves: model.diff?.moves.length,
			accessibleContent: single.getAccessibleContent(),
		};
	},
	readCharacterChanges(side: 'original' | 'modified', multiFile = false): string[] {
		const editor = (multiFile ? multi.getActiveControl() : single)?.[side === 'original' ? 'originalEditor' : 'modifiedEditor'];
		const text = editor?.getModel();
		if (!editor || !text) return [];
		const className = side === 'original' ? 'stanza-diff-inline-removed' : 'stanza-diff-inline-added';
		return Array.from({ length: text.getLineCount() }, (_, index) => editor.getLineDecorations(index + 1) ?? []).flat()
			.filter(decoration => decoration.options.className === className)
			.map(decoration => text.getValueInRange(decoration.range));
	},
	async cancelLargeComparison() {
		const text = Array.from({ length: 20_000 }, (_, index) => String(index)).join('\n');
		using largeOriginal = new TextModel(text);
		using largeModified = new TextModel(text.split('\n').reverse().join('\n'));
		using cancellation = new CancellationTokenSource();
		const running = computation.computeDiff(largeOriginal, largeModified, diffOptions, cancellation.token);
		const outcome = running.then(() => 'completed', error => (error as Error).name);
		await new Promise(resolve => setTimeout(resolve, 50));
		cancellation.cancel();
		using nextOriginal = new TextModel('old');
		using nextModified = new TextModel('new');
		const next = await computation.computeDiff(nextOriginal, nextModified, diffOptions, CancellationToken.None);
		return { outcome: await outcome, kinds: Array.from(toLineDiff(next, 1, 1).rows).map(row => row.kind) };
	},
	async compareLineEndings() {
		using original = new TextModel('first\r\nold\r\nlast');
		using modified = new TextModel('first\nnew\nlast');
		const result = await computation.computeDiff(original, modified, diffOptions, CancellationToken.None);
		return {
			identical: result.identical,
			changedLines: result.changes.map(change => [change.original.startLineNumber, change.modified.startLineNumber]),
			inlineColumns: result.changes[0]?.innerChanges?.map(change => [change.originalRange.startColumn, change.originalRange.endColumn]),
		};
	},
	async showTimedComparison(): Promise<boolean> {
		const timedResources = resources.add(new DisposableStore());
		const text = Array.from({ length: 20_000 }, (_, index) => String(index)).join('\n');
		const timedOriginal = timedResources.add(new TextModel(text));
		const timedModified = timedResources.add(new TextModel(text.split('\n').reverse().join('\n')));
		const timedModel = timedResources.add(new DiffModel({
			original: timedOriginal,
			modified: timedModified,
			diffProvider: computation,
			diffOptions: { ...diffOptions, maxComputationTimeMs: 1 },
		}));
		timedResources.add(editorServices.createInstance(DiffEditorWidget, { container: document.getElementById('timed-single')!, model: timedModel }));
		timedResources.add(editorServices.createInstance(MultiDiffEditorWidget, {
			container: document.getElementById('timed-multi')!,
			model: timedResources.add(new MultiDiffEditorModel([timedResources.add(new DocumentDiffItem({ id: 'timed', label: 'timed.ts' }, timedModel))])),
		}));
		if (timedModel.state.kind !== 'ready') {
			await new Promise<void>((resolve, reject) => {
				const listener = timedModel.onDidChange(state => {
					if (state.kind === 'loading') return;
					listener.dispose();
					if (state.kind === 'error') reject(state.error);
					else resolve();
				});
			});
		}
		return timedModel.state.kind === 'ready' && timedModel.state.quitEarly;
	},
	async setQuickDiffWhitespace(setting: 'false' | 'inherit'): Promise<void> {
		await configuration.updateValue('scm.diffDecorationsIgnoreTrimWhitespace', setting);
	},
	async setDiffWhitespace(ignore: boolean): Promise<void> {
		await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, ignore);
	},
	async setDiffWhitespaceForLanguage(languageId: string, ignore: boolean): Promise<void> {
		await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, ignore, { overrideIdentifier: languageId });
	},
	setModifiedLanguage(languageId: string): void {
		modified.setLanguage(languageId);
	},
	dispose(): void {
		// Panes release retained comparisons before the shared model provider stops.
		sessionPane.clear();
		resources.dispose();
	},
};

declare global {
	interface Window {
		ashDiffIntegration: typeof harness;
	}
}
window.ashDiffIntegration = harness;
if (new URL(location.href).searchParams.has('restoreSession')) {
	const stored = window.sessionStorage.getItem('ash.diff.integration.sessionEditor');
	if (stored) {
		closedSessionEditor = JSON.parse(stored);
		await harness.reopenClosedSessionChanges();
	}
}
window.addEventListener('pagehide', () => { sessionPane.clear(); resources.dispose(); }, { once: true });
