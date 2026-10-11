import '../../../src/ash/workbench/browser/parts/editor/editor.contribution.js';
import { MenuId, MenusRegistry } from '../../../src/ash/platform/actions/common/actions.js';
import { ContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { setIconResolver } from '../../../src/ash/base/browser/ui/lxicons/lxicon.js';
import { getIconDefinition } from '../../../src/ash/platform/theme/common/iconRegistry.js';
import '../../../src/ash/editor/browser/widget/diffEditor/registrations.contribution.js';
import { GlobalExtensionEnablementService } from '../../../src/ash/platform/extensionManagement/common/extensionEnablementService.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { ExtensionResourceLoaderService } from '../../../src/ash/platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { BrowserTextModelService } from '../../../src/ash/workbench/services/textmodelResolver/browser/browserTextModelService.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { DiffModel } from '../../../src/ash/editor/common/diff/diffModel.js';
import { DiffEditorWidget } from '../../../src/ash/editor/browser/widget/diffEditor/diffEditorWidget.js';
import { DiffService } from '../../../src/ash/workbench/services/diff/browser/diffService.js';
import type { TextModelReference } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';
import type { IDecorationsProvider } from '../../../src/ash/workbench/services/decorations/common/decorations.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { createBrowserExtensionApi, withEnabledBuiltInExtensions } from '../../../src/ash/platform/extensions/browser/extensionApi.js';
import { WebWorkerExtensionHost as BrowserExtensionHostApi } from '../../../src/ash/workbench/services/extensions/browser/webWorkerExtensionHost.js';
import { createDisconnectedExtensionHostApi } from '../../../src/ash/platform/agentHost/browser/extensionHostApi.js';
import { createExtensionHostInitialization } from '../../../src/ash/workbench/services/extensions/common/extensionHostProtocol.js';
import { type ExtensionClientSource, type JsonValue } from '../../../src/ash/platform/agentHost/common/extensionHostApi.js';
import { type ExtensionClientOperation, type ExtensionClientResult } from '../../../src/ash/workbench/api/common/extHost.protocol.js';
import { WorkspaceContextService } from '../../../src/ash/workbench/services/workspaces/browser/workspaceContextService.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { MainThreadSCM } from '../../../src/ash/workbench/api/browser/mainThreadSCM.js';
import { MainThreadExtensionBackend } from '../../../src/ash/workbench/api/browser/mainThreadExtensionBackend.js';
import { SCMService } from '../../../src/ash/workbench/contrib/scm/common/scmService.js';
import { SCMViewService } from '../../../src/ash/workbench/contrib/scm/browser/scmViewService.js';
import { ISCMService, ISCMViewService } from '../../../src/ash/workbench/contrib/scm/common/scm.js';
import { ScmViewPane } from '../../../src/ash/workbench/contrib/scm/browser/scmViewPane.js';
import { Pane, PaneView } from '../../../src/ash/base/browser/ui/splitview/paneview.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import '../../../src/ash/base/browser/ui/splitview/splitview.css';
import '../../../src/ash/workbench/contrib/scm/browser/media/scm.css';
import { QuickDiffService } from '../../../src/ash/workbench/contrib/scm/common/quickDiffService.js';
import { MultiDiffSourceResolverService } from '../../../src/ash/workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js';
import type { IDecorationsService } from '../../../src/ash/workbench/services/decorations/common/decorations.js';
import type { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import type { IAppServerApi } from '../../../src/ash/platform/agentHost/common/appServerApi.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { ILanguagePackService } from '../../../src/ash/platform/languagePacks/common/languagePacksService.js';
import { IExtensionApi } from '../../../src/ash/platform/extensions/common/extensionApi.js';
import { createEmptyTestLanguagePacks } from '../../../src/ash/workbench/services/localization/test/common/localizationTestUtils.js';

const lifetime = new DisposableStore();
const services = lifetime.add(new InstantiationService());
const workspace = lifetime.add(new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') }));
const configuration = lifetime.add(new InMemoryConfigurationService());
const packages = createBrowserExtensionApi();
const storage = lifetime.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'git-extension', profileId: 'git-extension-test', flushInterval: 0 }));
const enablement = lifetime.add(new GlobalExtensionEnablementService(storage));
let includeGeneric = false;
const genericProvider = {
	id: 'snapshots', providerId: 'snapshots', label: 'Snapshots', rootUri: 'file:///snapshots', selected: false,
	groups: [{ id: 'changes', label: 'Snapshots', resources: [{ id: 'one', sourceUri: 'file:///snapshots/one.ts', path: 'one.ts', decorations: { badge: 'M', tooltip: 'Changed snapshot', kind: 'modified' }, openLabel: 'Open snapshot', actions: [] }], actions: [] }],
	input: { value: '', enabled: true, canAccept: true, placeholder: 'Snapshot message', buttonLabel: 'Record', buttonTooltip: 'Record snapshot' }, inputRevision: 0,
	statusBarCommands: [], activeRepositoryName: null, statusMessage: '', isBusy: false, historyRevision: 0, hasHistory: false, hasMerge: false,
	multiDiff: { resourcePrefix: 'ash-scm://test.snapshots/changes', sourceActions: [], repositoryActions: [] },
};
const genericSource = new TextEncoder().encode(`
 let calls = 0;
 export async function activate() { return [{ kind: 'sourceControl', registrationId: 'scm', revision: 1, providers: [${JSON.stringify(genericProvider)}] }]; }
 export async function invoke(_id, payload) {
  if (payload.method === 'quickDiff') return { originalResource: 'snapshot:/one.ts', text: 'before\\n', revision: 1 };
  if (payload.method === 'multiDiff') return { kind: 'multiDiff', resource: 'ash-scm://test.snapshots/changes', label: 'Snapshots', items: [{ label: 'one.ts', original: { resource: 'snapshot:/one.ts', initialText: 'before' }, modified: { resource: 'file:///snapshots/one.ts', initialText: 'after' } }] };
  if (payload.method === 'refresh') return ++calls;
  if (payload.method === 'acceptInput') return { result: 'recorded', value: '' };
  return null;
 }
 export function deactivate() {}
`);
const catalog = withEnabledBuiltInExtensions({
	resources: new ExtensionResourceLoaderService(request => request.extensionId === 'test.snapshots' ? Promise.resolve(genericSource) : packages.resources.readExtensionResourceBytes(request)),
	list: async () => {
		const value = await packages.list('cached');
		const git = value.extensions.find(extension => extension.id === 'ash.git')!;
		return { ...value, extensions: [git, ...(includeGeneric ? [{ ...git, id: 'test.snapshots', manifestJson: JSON.stringify({ browser: './main.js' }) }] : [])] };
	},
}, enablement);
services.registerInstance(ILanguagePackService, createEmptyTestLanguagePacks());
services.registerInstance(IExtensionApi, catalog);
const calls: { method: string; params: JsonValue; }[] = [];
const errors: string[] = [];
const requests: JsonValue[] = [];
const answers: string[] = [];

let revision = 1;
let clean = false;
const status = () => ({ repositoryId: 'root', streamInstanceId: 'stream', revision, historyRevision: 1, path: '', head: { type: 'branch', name: 'main', objectId: 'a'.repeat(40), upstream: null }, changes: clean ? [] : [{ path: 'one.ts', originalPath: null, indexStatus: revision > 1 ? 'modified' : 'unmodified', worktreeStatus: revision > 1 ? 'unmodified' : 'modified', conflicted: false }] });
const backend = lifetime.add(new MainThreadExtensionBackend(catalog, {
	request: async (method, params): Promise<JsonValue> => {
		calls.push({ method, params });
		switch (method) {
			case 'config/read': return { revision: 1, gitConfigured: true, git: { autofetch: 'off', autofetchPeriod: 180 } };
			case 'git/repositories': return { repositories: [{ id: 'root', label: 'workspace', path: '' }] };
			case 'git/status': return status();
			case 'git/branch/create': case 'git/branch/list': return { branches: [] };
			case 'git/graph': return { commits: [{ objectId: 'a'.repeat(40), parentObjectIds: [], timestampSeconds: 1, subject: 'First commit' }], references: [], remotes: [], hasMore: false, nextCursor: null };
			case 'git/init': return { repositories: [{ id: 'root', label: 'workspace', path: '' }] };
			case 'git/clone': return { repositoryPath: '/downloads/clone' };
			case 'git/stage': revision++; return { status: status() };
			case 'git/changeFile': return { original: 'old', modified: 'new', binary: false };
			case 'git/checkIgnore': return { ignored: [] };
			default: throw new Error(`Unexpected domain request ${method}`);
		}
	}
}, { getConnectionState: async () => 'ready', connectionGeneration: 1 } as IAppServerApi, { subscribe: Event.None }, workspace));
const unavailable = (method: string): never => { throw new Error(`Unexpected remote host request ${method}`); };
const host = lifetime.add(services.createInstance(BrowserExtensionHostApi, catalog, createDisconnectedExtensionHostApi(unavailable)));
const scm = lifetime.add(new SCMService());
const view = lifetime.add(new SCMViewService(scm));
const quickDiff = lifetime.add(new QuickDiffService());
const resolvers = lifetime.add(new MultiDiffSourceResolverService());
const commands = { executeCommand: async (id: string, ...args: unknown[]) => invoke(id, args) } as unknown as ICommandService;
const decorationProviders = new Set<IDecorationsProvider>();
const bridge = lifetime.add(new MainThreadSCM(10_000, error => errors.push(String(error)), host, scm, view, commands, resolvers, quickDiff, { registerDecorationsProvider: (provider: IDecorationsProvider) => { decorationProviders.add(provider); return toDisposable(() => { decorationProviders.delete(provider); }); } } as unknown as IDecorationsService));
const hostChanges = host.onDidChange(() => { void host.list().then(snapshot => bridge.update(snapshot)); });
lifetime.add(toDisposable(() => hostChanges.dispose()));
const clientHandler = host.registerClientHandler(async (raw, signal, source): Promise<ExtensionClientResult> => {
	const operation = raw as ExtensionClientOperation;
	switch (operation.operation) {
		case 'readInitialization': return { result: 'initialization', initialization: createExtensionHostInitialization(workspace, configuration) };
		case 'backendRequest': return { result: 'value', value: await backend.handle(source, operation.capability, operation.method, operation.params, 0, signal) };
		case 'backendState': return { result: 'value', value: await backend.handle(source, operation.capability, undefined, {}, operation.after, signal) };
		case 'editorOperation': {
			requests.push(operation.payload);
			const request = operation.payload as { method: string; };
			if (request.method === 'hostFacts') return { result: 'value', value: { canClone: true, canOpenWorkspace: true } };
			if (request.method === 'input') return { result: 'value', value: answers.shift() ?? null };
			if (request.method === 'pickFolder') return { result: 'value', value: '/downloads' };
			if (request.method === 'openWorkspace') return { result: 'value', value: null };
			if (request.method === 'dirty') return { result: 'value', value: [] };
			if (request.method === 'confirm') return { result: 'value', value: { confirmed: true } };
			if (request.method === 'output') return { result: 'value', value: null };
			if (request.method === 'open') return { result: 'value', value: null };
			throw new Error(`Unexpected editor request ${request.method}`);
		}
		case 'scmUpdate': bridge.set(source, operation.registrationId, operation.revision, operation.providers); return { result: 'done' };
		case 'showQuickPick': return { result: 'selection', index: 0 };
		case 'showMessage': errors.push(operation.message); return { result: 'done' };
		default: throw new Error(`Unexpected public SDK request ${operation.operation}`);
	}
});
lifetime.add(toDisposable(() => clientHandler.dispose()));
async function activate(language = 'en') {
	setNlsMessages(language, {});
	const snapshot = await host.reconcile('refresh'); bridge.update(snapshot);
	return snapshot.extensions.map(value => ({ lifecycle: value.lifecycle, failure: value.failure, registrations: value.registrations.map(value => value.kind) }));
}
async function invoke(id: string, args: unknown[] = []) {
	const runtime = (await host.list()).extensions.find(value => value.id === 'ash.git')!;
	const registration = runtime.registrations.find(value => value.kind === 'command' && value.command === id);
	if (!registration) throw new Error(`Missing Git extension command ${id}`);
	const source: ExtensionClientSource = { extensionId: runtime.id, incarnation: runtime.incarnation!, activationGeneration: runtime.activationGeneration };
	const payload = await bridge.prepareCommandArguments(runtime.id, args);
	return host.invoke({ ...source, registrationId: registration.registrationId, operation: 'execute', payload: { arguments: payload }, deadlineUnixMillis: Date.now() + 10_000 }, new AbortController().signal);
}
let retiredGit: Awaited<ReturnType<typeof host.list>>['extensions'][number] | undefined;
async function disable() { retiredGit = (await host.list()).extensions.find(runtime => runtime.id === 'ash.git'); await enablement.disableExtension({ id: 'ash.git' }); await host.reconcile('restartFailed'); }
async function enable() { await enablement.enableExtension({ id: 'ash.git' }); await host.reconcile('restartFailed'); }
declare global { interface Window { gitExtensionIntegration: { activate: typeof activate; invoke: typeof invoke; disable: typeof disable; answer(values: string[]): void; state(): { repositories: { id: string; groups: string[]; paths: string[]; placeholder: string; }[]; calls: typeof calls; errors: string[]; requests: JsonValue[]; }; stage(): Promise<void>; history(): Promise<unknown>; dispose(): void; }; } }
window.gitExtensionIntegration = {
	activate, invoke, disable, answer: values => answers.push(...values),
	state: () => ({ repositories: [...scm.repositories].map(repository => ({ id: repository.id, groups: repository.provider.groups.map(group => group.label), paths: repository.provider.groups.flatMap(group => group.resources.map(resource => resource.path)), placeholder: repository.provider.input.placeholder })), calls, errors, requests }),
	stage: async () => { const repository = scm.getRepository('root')!; await invoke('git.stageAll', [repository]); },
	history: async () => scm.getRepository('root')!.provider.historyProvider!.provideHistoryItems({ limit: 1 }),
	dispose: () => lifetime.dispose(),
};

function mountChangesPane(): void {
	const host = document.createElement('div');
	host.id = 'scm-pane';
	host.style.cssText = 'width:320px;height:480px';
	document.body.append(host);
	lifetime.add(toDisposable(() => host.remove()));
	const ui = lifetime.add(createTestEditorServices());
	registerCodeEditorServices(ui);
	lifetime.add(bindColorTheme(ui.get(IThemeService), host));
	ui.registerInstance(ISCMService, scm);
	ui.registerInstance(ISCMViewService, view);
	const panes = lifetime.add(new PaneView(host));
	const changes = lifetime.add(ui.createInstance(ScmViewPane, host, { id: 'fixture.changes', title: 'Changes' }));
	panes.addPane(changes, 424);
	panes.addPane(lifetime.add(new Pane(host, { id: 'fixture.review', title: 'Agent Review', collapsed: true })), 28);
	panes.addPane(lifetime.add(new Pane(host, { id: 'fixture.graph', title: 'Graph', collapsed: true })), 28);
	panes.layout(480, 320);
	changes.setVisible(true);
}

const gitScmPaneIntegration = {
	mount: mountChangesPane,
	setClean: async (value: boolean) => { clean = value; revision++; await invoke('git.refresh', [scm.getRepository('root')!]); },
};
window.gitScmPaneIntegration = gitScmPaneIntegration;
declare global { interface Window { gitScmPaneIntegration: typeof gitScmPaneIntegration; } }

let reference: TextModelReference | undefined;
let editor: DiffEditorWidget | undefined;
let comparison: DiffModel | undefined;
let savedText = 'before\n';
async function openEditor(): Promise<void> {
	const editorServices = lifetime.add(createTestEditorServices());
	registerCodeEditorServices(editorServices);
	setIconResolver(document, icon => getIconDefinition(icon));
	const models = lifetime.add(editorServices.createInstance(BrowserTextModelService, {
		onDidChange: Event.None,
		resolve: async (request: { resource: URI; }) => ({ resource: request.resource, text: savedText, revision: '1' }),
		save: async (request: { text: string; }) => { savedText = request.text; return { revision: '2' }; },
	}, {}));
	reference = lifetime.add(await models.acquire({ resource: URI.file('/snapshots/one.ts') }, new AbortController().signal));
	const original = lifetime.add(new TextModel('before\n'));
	const computation = lifetime.add(editorServices.createInstance(DiffService).createComputationService());
	comparison = lifetime.add(new DiffModel({ original, modified: reference.model, diffProvider: computation, diffOptions: { ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: false } }));
	editor = lifetime.add(editorServices.createInstance(DiffEditorWidget, { container: document.getElementById('editor')!, model: comparison }));
	editor.layout({ width: 900, height: 400 });
	editor.modifiedEditor.focus();
}
const isolation = {
	openSideVisible: (scheme: string) => {
		const item = MenusRegistry.getMenuItems(MenuId.EditorTitle).find(item => 'command' in item && item.command.id === 'workbench.action.compareEditor.openSide');
		using context = new ContextKeyService(); context.setContext('activeEditor', 'stanza.editor.diff'); context.setContext('resourceScheme', scheme);
		return !!item && context.contextMatchesRules(item.when);
	},
	addGeneric: () => { includeGeneric = true; }, enable, openEditor,
	runtimes: async () => (await host.list()).extensions.map(extension => ({ id: extension.id, incarnation: extension.incarnation, lifecycle: extension.lifecycle, commands: extension.registrations.flatMap(registration => registration.kind === 'command' ? [registration.command] : []) })),
	retiredRequest: async () => {
		const previous = retiredGit!;
		const registration = previous.registrations.find(value => value.kind === 'command' && value.command === 'git.refresh')!;
		const source = { extensionId: previous.id, activationGeneration: previous.activationGeneration, incarnation: previous.incarnation! };
		const count = calls.length;
		let invocationError = '', backendError = '';
		try { await host.invoke({ ...source, registrationId: registration.registrationId, operation: 'execute', payload: { arguments: [] }, deadlineUnixMillis: Date.now() + 10_000 }, new AbortController().signal); } catch (error) { invocationError = String(error); }
		try { await backend.handle(source, 'git.repository', 'status', { repositoryId: 'root' }, 0, new AbortController().signal); } catch (error) { backendError = String(error); }
		return { invocationError, backendError, backendCalls: calls.length - count };
	},
	providerState: () => ({ draft: scm.getRepository('snapshots')?.provider.input.value, quickDiff: quickDiff.providers.map(provider => provider.id), decorations: decorationProviders.size }),
	exerciseProvider: async () => {
		const provider = scm.getRepository('snapshots')!.provider;
		provider.input.value = 'retained draft'; await provider.refresh();
		const original = await quickDiff.getQuickDiffs(URI.file('/snapshots/one.ts'), new AbortController().signal);
		const multi = await resolvers.resolve(URI.parse('ash-scm://test.snapshots/changes'));
		return { originals: original.map(value => value.providerId), multi: multi?.resources.map(value => value.label) };
	},
	accept: async () => scm.getRepository('snapshots')!.provider.input.accept(),
	editorState: () => ({ text: reference?.model.getValue(), dirty: reference?.isDirty, savedText, diff: comparison?.state.kind, rows: comparison?.state.kind === 'ready' ? comparison.state.diff.rows.length : 0 }),
	undo: () => reference!.model.undo(), redo: () => reference!.model.redo(),
	save: async () => reference!.save(new AbortController().signal),
};
declare global { interface Window { gitExtensionIsolation: typeof isolation; } }
window.gitExtensionIsolation = isolation;
