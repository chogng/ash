import { ViewsRegistry } from '../../../src/ash/workbench/common/views.js';
import { BrowserProgressService } from '../../../src/ash/platform/progress/browser/progressService.js';
import { RustGitHostFixture } from './rustGitHostFixture.js';
import '../../../src/ash/workbench/browser/parts/editor/editor.contribution.js';
import { MenuId, MenusRegistry } from '../../../src/ash/platform/actions/common/actions.js';
import { ContextKeyService, IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
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
import { Event, Emitter } from '../../../src/ash/base/common/event.js';
import { DeferredPromise } from '../../../src/ash/base/common/async.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { withEnabledBuiltInExtensions } from '../../../src/ash/platform/extensions/browser/extensionApi.js';
import { createBuiltinExtensionFixture } from './builtinExtensionsFixture.js';
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
import { ScmStatusContribution } from '../../../src/ash/workbench/contrib/scm/browser/activity.js';
import { IStatusbarService, StatusbarService, StatusbarAlignment } from '../../../src/ash/workbench/services/statusbar/browser/statusbar.js';
import { StatusbarEntryItem } from '../../../src/ash/workbench/browser/parts/statusbar/statusbarItem.js';
import { ScmViewPane } from '../../../src/ash/workbench/contrib/scm/browser/scmViewPane.js';
import { Pane, PaneView } from '../../../src/ash/base/browser/ui/splitview/paneview.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import '../../../src/ash/base/browser/ui/splitview/splitview.css';
import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/workbench/browser/media/style.css';
import '../../../src/ash/workbench/contrib/scm/browser/media/scm.css';
import { QuickDiffService } from '../../../src/ash/workbench/contrib/scm/common/quickDiffService.js';
import { MultiDiffSourceResolverService } from '../../../src/ash/workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js';
import type { IDecorationsService } from '../../../src/ash/workbench/services/decorations/common/decorations.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { IServerEventApi, type IAppServerApi } from '../../../src/ash/platform/agentHost/common/appServerApi.js';
import type { ServerNotification } from '../../../.build/protocol/typescript/index.js';
import { ConfigurationRegistry } from '../../../src/ash/platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { BrowserClipboardService } from '../../../src/ash/platform/clipboard/browser/clipboardService.js';
import { IContextMenuService, IContextViewService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { ILogService } from '../../../src/ash/platform/log/common/log.js';
import { DefaultSettings } from '../../../src/ash/workbench/services/preferences/common/settingsModels.js';
import { parseExtensionManifest } from '../../../src/ash/workbench/services/extensions/common/extensionManifest.js';
import { ExtensionSettingBinding } from '../../../src/ash/workbench/contrib/preferences/browser/extensionSettingBinding.js';
import { SettingsRenderer } from '../../../src/ash/workbench/contrib/preferences/browser/settingsRenderers.js';
import type { IAction } from '../../../src/ash/base/common/actions.js';
import gitManifest from '../../../extensions/git/package.json' with { type: 'json' };
import gitEnglishMessages from '../../../extensions/git/package.nls.json' with { type: 'json' };
import gitChineseMessages from '../../../extensions/git/package.nls.zh-CN.json' with { type: 'json' };
import settingsChineseMessages from '../../../extensions/language-pack-zh-cn/translations/settings.json' with { type: 'json' };
import { localize, setNlsMessages } from '../../../src/ash/nls.js';
import scmChineseMessages from '../../../extensions/language-pack-zh-cn/translations/scm.json' with { type: 'json' };
import { CommandsRegistry } from '../../../src/ash/platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../src/ash/platform/contextkey/common/contextkey.js';
import { CancellationToken } from '../../../src/ash/base/common/cancellation.js';
import { normalizeExtensionHostPayload } from '../../../src/ash/platform/agentHost/browser/extensionHostProtocol.js';
import { ILanguagePackService } from '../../../src/ash/platform/languagePacks/common/languagePacks.js';
import { IExtensionApi } from '../../../src/ash/platform/extensions/common/extensionApi.js';
import { createEmptyTestLanguagePacks } from '../../../src/ash/workbench/services/localization/test/common/localizationTestUtils.js';

const chineseMessages: Record<string, Record<string, string>> = {};
for (const source of [scmChineseMessages, settingsChineseMessages]) {
	for (const [bundle, messages] of Object.entries(source)) {
		chineseMessages[bundle] = { ...chineseMessages[bundle], ...messages };
	}
}

const lifetime = new DisposableStore();
const services = lifetime.add(new InstantiationService());
const workspace = lifetime.add(new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') }));
const gitConfigurationRegistry = new ConfigurationRegistry();
gitConfigurationRegistry.updateConfigurations({ add: [...parseExtensionManifest(JSON.stringify(gitManifest), { id: 'ash.git', name: 'git', publisher: 'ash', version: '0.1.0' }).contributes.configuration], remove: [] });
const configuration = lifetime.add(new InMemoryConfigurationService(gitConfigurationRegistry));
const packages = createBuiltinExtensionFixture();
const storage = lifetime.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'git-extension', profileId: 'git-extension-test', flushInterval: 0 }));
const enablement = lifetime.add(new GlobalExtensionEnablementService(storage));
let includeGeneric = false;
let includeGit = true;
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
  if (payload.method === 'burst') return Promise.all(Array.from({ length: 64 }, (_, index) => globalThis.__ashBackgroundRequest(JSON.stringify({ operation: 'editorOperation', payload: { method: 'output', index } })).then(JSON.parse)));
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
		return { ...value, extensions: [...(includeGit ? [git] : []), ...(includeGeneric ? [{ ...git, id: 'test.snapshots', manifestJson: JSON.stringify({ browser: './main.js' }) }] : [])] };
	},
}, enablement);
services.registerInstance(ILanguagePackService, createEmptyTestLanguagePacks());
services.registerInstance(IExtensionApi, catalog);
const calls: { method: string; params: JsonValue; }[] = [];
const errors: string[] = [];
const requests: JsonValue[] = [];
const answers: string[] = [];

const configurationEvents = lifetime.add(new Emitter<ServerNotification>());
let configurationRevision = 1;
let sharedGit = { autofetch: 'off', autofetchPeriod: 180, rebaseWhenSync: false };
let failSettingsWrite = false;
let revision = 1;
let clean = false;
let includeUntracked = false;
let upstream: { name: string; ahead: number; behind: number; } | null = null;
let pullGate: DeferredPromise<void> | undefined;
let pullFailure = false;
let startupStateGate: DeferredPromise<void> | undefined;
let startupDiscoveryGate: DeferredPromise<void> | undefined;
let startupStatusGate: DeferredPromise<void> | undefined;
let startupStateReads = 0;
const status = () => ({ repositoryId: 'root', streamInstanceId: 'stream', revision, historyRevision: 1, path: '', head: { type: 'branch', name: 'main', objectId: 'a'.repeat(40), upstream }, changes: clean ? [] : [{ path: 'one.ts', originalPath: null, indexStatus: revision > 1 ? 'modified' : 'unmodified', worktreeStatus: revision > 1 ? 'unmodified' : 'modified', conflicted: false, submodule: { isSubmodule: false, commitChanged: false, trackedChanges: false, untrackedChanges: false } }, ...(includeUntracked ? [{ path: 'new.ts', originalPath: null, indexStatus: 'unmodified', worktreeStatus: 'untracked', conflicted: false, submodule: { isSubmodule: false, commitChanged: false, trackedChanges: false, untrackedChanges: false } }] : [])] });
const backend = lifetime.add(new MainThreadExtensionBackend(catalog, {
	request: async (method, params): Promise<JsonValue> => {
		calls.push({ method, params });
		switch (method) {
			case 'config/read': return { revision: configurationRevision, gitConfigured: true, git: { ...sharedGit } };
			case 'config/update': {
				const update = params as { expectedRevision: number; git: typeof sharedGit; };
				if (failSettingsWrite || update.expectedRevision !== configurationRevision) throw new Error('Settings save rejected');
				sharedGit = { ...update.git };
				configurationRevision++;
				configurationEvents.fire({ method: 'config/changed', params: { revision: configurationRevision, generation: configurationRevision } });
				return { revision: configurationRevision, disposition: 'applied' };
			}
			case 'git/repositories':
				await startupDiscoveryGate?.p;
				return { repositories: [{ id: 'root', label: 'workspace', path: '' }] };
			case 'git/version': return { installation: { kind: 'available', version: 'git version 2.50.0', major: 2, minor: 50, patch: 0 }, windows: false };
			case 'git/pullPreflight': return { upstreamRewritten: false };
			case 'git/status': await startupStatusGate?.p; return status();
			case 'git/catalog': return { tags: [], stashes: [], remotes: ['origin'], upstreamRemote: upstream ? 'origin' : null, operation: null };
			case 'git/transport': {
				const transport = params as { operation: { kind: string; mode?: string; }; transport: unknown; };
				const kind = transport.operation.kind;
				// Record the stable domain operation as well as the cancellable transport boundary.
				calls.push({ method: `git/${kind}`, params: { repositoryId: (params as Record<string, JsonValue>).repositoryId, transport: transport.transport, ...(transport.operation.mode ? { mode: transport.operation.mode } : {}) } as JsonValue });
				if (kind === 'pull') { await pullGate?.p; if (pullFailure) throw new Error('Pull rejected'); if (upstream) upstream = { ...upstream, behind: 0 }; }
				if (kind === 'push' && upstream) upstream = { ...upstream, ahead: 0 };
				revision++;
				return { status: status() };
			}
			case 'git/pull':
				await pullGate?.p;
				if (pullFailure) throw new Error('Pull rejected');
				if (upstream) upstream = { ...upstream, behind: 0 };
				revision++;
				return { status: status() };
			case 'git/push':
				if (upstream) upstream = { ...upstream, ahead: 0 };
				revision++;
				return { status: status() };
			case 'git/fetch': return { status: status() };
			case 'git/commit':
				clean = true;
				revision++;
				return { status: status(), objectId: 'c'.repeat(40) };
			case 'git/command': {
				const command = (params as { command: { kind: string; }; }).command;
				if (command.kind === 'stash') return { status: status(), outcome: 'completed', operation: null };
				if (command.kind !== 'publishBranch') throw new Error(`Unexpected Git command ${command.kind}`);
				upstream = { name: 'origin/main', ahead: 0, behind: 0 };
				revision++;
				return { status: status(), outcome: 'completed', operation: null };
			}

			case 'git/branch/create': return { branches: [] };
			case 'git/branch/list': return { branches: [{ name: 'main', objectId: 'a'.repeat(40), current: true, upstream: null, checkedOutElsewhere: false }, { name: 'occupied', objectId: 'a'.repeat(40), current: false, upstream: 'origin/occupied', checkedOutElsewhere: true }] };
			case 'git/history/refs': return { status: status(), graphRevision: 1, references: [{ name: 'main', objectId: 'a'.repeat(40), kind: 'localBranch', current: true }, { name: 'occupied', objectId: 'a'.repeat(40), kind: 'localBranch', current: false }], branches: [{ name: 'main', current: true, upstream: null, checkedOutElsewhere: false }, { name: 'occupied', current: false, upstream: 'origin/occupied', checkedOutElsewhere: true }], remotes: [] };
			case 'git/graph': return { commits: [{ objectId: 'a'.repeat(40), parentObjectIds: [], timestampSeconds: 1, subject: 'First commit' }], references: [], remotes: [], hasMore: false, nextCursor: null };
			case 'git/init': return { repositories: [{ id: 'root', label: 'workspace', path: '' }] };
			case 'git/clone': return { repositoryPath: '/downloads/clone' };
			case 'git/stage': revision++; return { status: status() };
			case 'git/changeFile': return { original: 'old', modified: 'new', binary: false };
			case 'git/checkIgnore': return { ignored: [] };
			default: throw new Error(`Unexpected domain request ${method}`);
		}
	}
}, { getConnectionState: async () => 'ready', getSlashCommands: async () => [], onConnectionState: () => ({ dispose() { } }), connectionGeneration: 1 } satisfies IAppServerApi, { subscribe: listener => configurationEvents.event(listener) }, workspace, configuration, lifetime.add(new BrowserProgressService(document.body))));
const unavailable = (method: string): never => { throw new Error(`Unexpected remote host request ${method}`); };
const workerCatalog = { ...catalog, list: async () => { const snapshot = await catalog.list('cached'); return { ...snapshot, extensions: snapshot.extensions.filter(extension => extension.id !== 'ash.git') }; } };
const genericHost = lifetime.add(services.createInstance(BrowserExtensionHostApi, workerCatalog, createDisconnectedExtensionHostApi(unavailable)));
const host = lifetime.add(new RustGitHostFixture(catalog, genericHost, () => createExtensionHostInitialization(workspace, configuration)));
const scm = lifetime.add(new SCMService());
const view = lifetime.add(new SCMViewService(scm));
const quickDiff = lifetime.add(new QuickDiffService());
const resolvers = lifetime.add(new MultiDiffSourceResolverService());
const commands = { executeCommand: async (id: string, ...args: unknown[]) => invoke(id, args) } as unknown as ICommandService;
const decorationProviders = new Set<IDecorationsProvider>();
const scmContexts = lifetime.add(new ContextKeyService());
services.registerInstance(IContextKeyService, scmContexts);
const bridge = lifetime.add(new MainThreadSCM(10_000, error => errors.push(String(error)), CommandsRegistry, host, scm, view, commands, resolvers, quickDiff, { registerDecorationsProvider: (provider: IDecorationsProvider) => { decorationProviders.add(provider); return toDisposable(() => { decorationProviders.delete(provider); }); } } as unknown as IDecorationsService, scmContexts));
const hostChanges = host.onDidChange(() => { void host.list().then(snapshot => bridge.update(snapshot)); });
lifetime.add(toDisposable(() => hostChanges.dispose()));
let scmUpdateGate: DeferredPromise<void> | undefined;
let waitingSCMUpdates = 0;
let outputGate: DeferredPromise<void> | undefined;
let waitingOutputs = 0;
const clientHandler = host.registerClientHandler(async (raw, signal, source): Promise<ExtensionClientResult> => {
	const operation = raw as ExtensionClientOperation;
	switch (operation.operation) {
		case 'inspectConfiguration': return { result: 'configuration', value: configuration.inspect(operation.section) as unknown as JsonValue };
		case 'readConfiguration': return { result: 'configuration', value: configuration.getValue(operation.section) as JsonValue ?? null };
		case 'resetConfiguration': await configuration.updateValue(operation.section, undefined); return { result: 'done' };
		case 'updateConfiguration': await configuration.updateValue(operation.section, operation.value); return { result: 'done' };
		case 'readInitialization': return { result: 'initialization', initialization: createExtensionHostInitialization(workspace, configuration) };
		case 'backendRequest': return { result: 'value', value: await backend.handle(source, operation.capability, operation.method, operation.params, 0, signal, operation.progress) };
		case 'backendState':
			startupStateReads++;
			await startupStateGate?.p;
			signal.throwIfAborted();
			return { result: 'value', value: await backend.handle(source, operation.capability, undefined, {}, operation.after, signal) };
		case 'editorOperation': {
			requests.push(operation.payload);
			const request = operation.payload as { method: string; uri?: string; text?: string; };
			if (request.method === 'hostFacts') return { result: 'value', value: { canClone: true, canOpenWorkspace: true } };
			if (request.method === 'input') return { result: 'value', value: answers.shift() ?? null };
			if (request.method === 'pickFolder') return { result: 'value', value: '/downloads' };
			if (request.method === 'openWorkspace') return { result: 'value', value: null };
			if (request.method === 'openEditorResources') return { result: 'value', value: [] };
			if (request.method === 'activeEditor') return { result: 'value', value: { input: null, selection: null, version: null, contents: null } };
			if (request.method === 'setLineAnnotation') return { result: 'value', value: null };
			if (request.method === 'readEditorDocument') return { result: 'value', value: commitDocuments.has(request.uri as string) ? { text: commitDocuments.get(request.uri as string)!, dirty: true } : null };
			if (request.method === 'openEditorDocument') { commitDocuments.set(request.uri as string, request.text!); return { result: 'value', value: null }; }
			if (request.method === 'closeEditorDocument') { commitDocuments.delete(request.uri as string); return { result: 'value', value: null }; }
			if (request.method === 'prepareRepositoryOperation') return { result: 'value', value: true };
			if (request.method === 'closeRelatedDiffs') return { result: 'value', value: null };
			if (request.method === 'dirty') return { result: 'value', value: [] };
			if (request.method === 'confirm') return { result: 'value', value: { confirmed: true } };
			if (request.method === 'output') {
				if (outputGate) { waitingOutputs++; await outputGate.p; }
				return { result: 'value', value: null };
			}
			if (request.method === 'open') return { result: 'value', value: null };
			throw new Error(`Unexpected editor request ${request.method}`);
		}
		case 'scmUpdate': {
			if (scmUpdateGate) {
				++waitingSCMUpdates;
				await scmUpdateGate.p;
				signal.throwIfAborted();
			}
			bridge.set(source, operation.registrationId, operation.revision, operation.providers);
			return { result: 'done' };
		}
		case 'executeCommand': {
			const result = await invoke(operation.command, operation.arguments);
			return { result: 'command', hasValue: result !== undefined, value: result ?? null };
		}
		case 'showQuickPick': requests.push(operation as unknown as JsonValue); return { result: 'selection', index: 0 };
		case 'showMessage': if (operation.severity === 'error') errors.push(operation.message); return { result: 'done' };
		default: throw new Error(`Unexpected public SDK request ${operation.operation}`);
	}
});
lifetime.add(toDisposable(() => clientHandler.dispose()));
async function activate(language = 'en') {
	setNlsMessages(language, language === 'zh-CN' ? chineseMessages : {});
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
const commitDocuments = new Map<string, string>();
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

let presentationRevision = 0;
const presentationIntegration = {
	async update(key: string, value: JsonValue | undefined) {
		await configuration.updateValue(key, value);
	},
	async addUntracked() { includeUntracked = true; revision++; await invoke('git.refresh'); },
	async commit(message: string, command?: string) {
		const provider = scm.getRepository('root')!.provider;
		provider.input.value = message;
		if (command) await invoke(command, [scm.getRepository('root')!]);
		else await provider.input.accept();
	},
	editCommitDocument(message: string) { for (const key of commitDocuments.keys()) commitDocuments.set(key, message); },
	draft(message: string) { scm.getRepository('root')!.provider.input.value = message; },
	presentation() {
		const provider = scm.getRepository('root')!.provider;
		return {
			count: provider.count, inputVisible: provider.input.visible, buttonVisible: provider.input.buttonVisible,
			validation: provider.input.validationMessage, statusCommands: provider.statusBarCommands.map(command => command.id)
		};
	},
	actions: () => scm.getRepository('root')?.provider.groups.flatMap(group => group.resources.flatMap(resource => resource.actions.map(action => action.id))),
	async decoration() { return [...decorationProviders][0]!.provideDecorations(URI.file('/workspace/one.ts'), CancellationToken.None); },
	async open() { await scm.getRepository('root')!.provider.groups[0]!.resources[0]!.open({}, false); },
};
declare global { interface Window { gitPresentationIntegration: typeof presentationIntegration; } }
window.gitPresentationIntegration = presentationIntegration;

const startupIntegration = {
	failInitialization: (count: number) => { host.initializationFailures = count; },
	mountWelcome: (locale: 'en' | 'zh-cn') => {
		scmContexts.setContext('workspaceFolderCount', 1);
		scmContexts.setContext('appServerAvailable', true);
		const messages = locale === 'zh-cn' ? gitChineseMessages : gitEnglishMessages;
		for (const entry of gitManifest.contributes.viewsWelcome) {
			lifetime.add(ViewsRegistry.registerViewWelcomeContent(entry.view, {
				content: entry.contents.replace(/%([^%]+)%/g, (_, key) => (messages as Record<string, string>)[key] ?? key),
				when: ContextKeyExpr.deserialize(entry.when),
			}));
		}
		mountChangesPane('ash.gitView');
	},
	hold: () => { startupStateGate = new DeferredPromise<void>(); startupDiscoveryGate = new DeferredPromise<void>(); startupStatusGate = new DeferredPromise<void>(); },
	releaseState: () => { const gate = startupStateGate; startupStateGate = undefined; void gate?.complete(); },
	releaseDiscovery: () => { const gate = startupDiscoveryGate; startupDiscoveryGate = undefined; void gate?.complete(); },
	releaseStatus: () => { const gate = startupStatusGate; startupStatusGate = undefined; void gate?.complete(); },
	stateReads: () => startupStateReads,
	discoveryReads: () => calls.filter(call => call.method === 'git/repositories').length,
	statusReads: () => calls.filter(call => call.method === 'git/status').length,
	refresh: async () => {
		const before = (await host.list()).extensions.find(runtime => runtime.id === 'ash.git')!;
		const repository = scm.getRepository('root');
		await host.reconcile('refresh');
		const after = (await host.list()).extensions.find(runtime => runtime.id === 'ash.git')!;
		return { generationPreserved: before.activationGeneration === after.activationGeneration, providerPreserved: repository === scm.getRepository('root') };
	},
};
declare global { interface Window { gitStartupIntegration: typeof startupIntegration; } }
window.gitStartupIntegration = startupIntegration;

const statusbar = lifetime.add(new StatusbarService());
const statusItems = new Map<string, StatusbarEntryItem>();
const statusHost = document.createElement('div');
statusHost.id = 'git-statusbar';
document.body.append(statusHost);
lifetime.add(toDisposable(() => statusHost.remove()));
services.registerInstance(ISCMViewService, view);
services.registerInstance(IStatusbarService, statusbar);
lifetime.add(services.createInstance(ScmStatusContribution));
lifetime.add(statusbar.onDidChangeEntries(() => {
	for (const { id, entry } of statusbar.getEntries(StatusbarAlignment.Left)) {
		const item = statusItems.get(id);
		if (item) item.update(entry);
		else statusItems.set(id, lifetime.add(new StatusbarEntryItem(statusHost, id, entry)));
	}
}));
const statusbarIntegration = {
	configure(tracking: boolean, failPull = false) {
		upstream = tracking ? { name: 'origin/main', ahead: 2, behind: 3 } : null;
		pullGate = new DeferredPromise<void>();
		pullFailure = failPull;
	},
	release: async () => { await pullGate?.complete(); pullGate = undefined; },
	commandLabels: async () => (await host.list()).extensions.find(extension => extension.id === 'ash.git')!.registrations.flatMap(registration => registration.kind === 'command' ? [{ id: registration.command, title: registration.title }] : []),
};
declare global { interface Window { gitStatusbarIntegration: typeof statusbarIntegration; } }
window.gitStatusbarIntegration = statusbarIntegration;

let settingsMenuActions: readonly IAction[] = [];
const gitSettingsIntegration = {
	mount(language = 'en') {
		const localized = language === 'zh-CN' ? gitChineseMessages : gitEnglishMessages;
		const manifest = JSON.stringify(gitManifest, (_key, value) => typeof value === 'string'
			? value.replace(/%([^%]+)%/g, (match, key) => (localized as Record<string, string>)[key] ?? match) : value);
		const registry = new ConfigurationRegistry();
		registry.updateConfigurations({ add: [...parseExtensionManifest(manifest, { id: 'ash.git', name: 'git', publisher: 'ash', version: '0.1.0' }).contributes.configuration], remove: [] });
		const descriptor = new DefaultSettings(registry).get('git.rebaseWhenSync');
		const ui = lifetime.add(new InstantiationService());
		for (const id of ['git.readSettings', 'git.updateRebaseWhenSync']) {
			lifetime.add(CommandsRegistry.register(id, (_accessor, ...args) => invoke(id, [...args])));
		}
		ui.registerInstance(ICommandService, commands);
		ui.registerInstance(IServerEventApi, { subscribe: listener => configurationEvents.event(listener) });
		ui.registerInstance(ILogService, { trace() { }, debug() { }, info() { }, warn() { }, error: (message, ...args) => { errors.push(`${message}: ${args.join(' ')}`); } } satisfies ILogService);
		ui.registerInstance(IConfigurationService, configuration);
		ui.registerInstance(IContextViewService, lifetime.add(new BrowserContextViewService(document.body)));
		ui.registerInstance(IContextMenuService, { showContextMenu: options => { settingsMenuActions = options.getActions?.() ?? []; } } as IContextMenuService);
		ui.registerInstance(IClipboardService, lifetime.add(new BrowserClipboardService(navigator.clipboard)));
		const container = document.createElement('div');
		container.id = 'git-settings';
		container.style.width = '620px';
		document.body.append(container);
		lifetime.add(toDisposable(() => container.remove()));
		lifetime.add(bindColorTheme(new TestThemeService(lightColorTheme), container));
		const binding = lifetime.add(ui.createInstance(ExtensionSettingBinding, descriptor.configuration));
		const renderer = lifetime.add(ui.createInstance(SettingsRenderer, container, { onStatus: (message: string, isError: boolean) => { if (isError) errors.push(message); } }));
		container.append(renderer.render({ ...descriptor, binding } as typeof descriptor));
	},
	profile: () => ({ ...sharedGit }),
	rejectWrites: () => { failSettingsWrite = true; },
	externalChange(value: boolean) {
		sharedGit.rebaseWhenSync = value;
		configurationRevision++;
		configurationEvents.fire({ method: 'config/changed', params: { revision: configurationRevision, generation: configurationRevision } });
	},
	reset: async () => { await settingsMenuActions.find(action => action.id === 'settings.resetSetting')!.run(); },
};
declare global { interface Window { gitSettingsIntegration: typeof gitSettingsIntegration; } }
window.gitSettingsIntegration = gitSettingsIntegration;

let scmPaneTheme: TestThemeService | undefined;
let scmPaneLayout: { readonly host: HTMLElement; readonly panes: PaneView; } | undefined;
function mountChangesPane(viewId = 'fixture.changes'): void {
	const host = document.createElement('div');
	host.id = 'scm-pane';
	host.style.cssText = 'width:320px;height:480px';
	document.body.append(host);
	lifetime.add(toDisposable(() => host.remove()));
	const ui = lifetime.add(createTestEditorServices(undefined, viewId === 'ash.gitView' ? services : undefined));
	registerCodeEditorServices(ui);
	scmPaneTheme = ui.get(IThemeService) as TestThemeService;
	lifetime.add(bindColorTheme(ui.get(IThemeService), host));
	ui.registerInstance(ISCMService, scm);
	ui.registerInstance(ISCMViewService, view);
	const panes = lifetime.add(new PaneView(host));
	scmPaneLayout = { host, panes };
	const changes = lifetime.add(ui.createInstance(ScmViewPane, host, { id: viewId, title: 'Changes' }));
	panes.addPane(changes, 424);
	panes.addPane(lifetime.add(new Pane(host, { id: 'fixture.review', title: 'Agent Review', collapsed: true })), 28);
	panes.addPane(lifetime.add(new Pane(host, { id: 'fixture.graph', title: 'Graph', collapsed: true })), 28);
	panes.layout(480, 320);
	changes.setVisible(true);
}

let generation: { readonly done: DeferredPromise<void>; readonly token: CancellationToken; readonly rootUri: URI; readonly groups: readonly { readonly resourceGroupId: string; readonly resources: readonly URI[]; }[]; } | undefined;
let generationCount = 0;
const gitScmPaneIntegration = {
	mount: mountChangesPane,
	setClean: async (value: boolean) => { clean = value; revision++; await invoke('git.refresh', [scm.getRepository('root')!]); },
	configureGenerator: () => {
		lifetime.add(CommandsRegistry.register('test.scm.generateCommitMessage', async (_accessor, rootUri, groups, token) => {
			const done = new DeferredPromise<void>();
			generation = { done, rootUri: rootUri as URI, groups: groups as NonNullable<typeof generation>['groups'], token: token as CancellationToken };
			generationCount++;
			await done.p;
		}));
		lifetime.add(MenusRegistry.appendMenuItem(MenuId.SCMInputBox, {
			command: { id: 'test.scm.generateCommitMessage', title: localize('scm.input.generate', 'Generate commit message') },
			when: ContextKeyExpr.equals('scmProvider', 'git'),
		}));
		lifetime.add(toDisposable(() => { void generation?.done.complete(undefined); }));
	},
	generationState: () => ({ count: generationCount, cancelled: generation?.token.isCancellationRequested, rootUri: generation?.rootUri.toString(), groups: generation?.groups.map(group => ({ id: group.resourceGroupId, resources: group.resources.map(resource => resource.toString()) })) }),
	finishGeneration: () => { void generation?.done.complete(undefined); },
	selectRepository: (id: string) => view.selectRepository(id),
	draft: () => view.activeRepository?.provider.input.value,
	setTheme: (theme: 'dark' | 'light' | 'hcDark' | 'hcLight') => scmPaneTheme!.setColorTheme({ dark: darkColorTheme, light: lightColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme }[theme]),
	setWidth: (width: number) => { scmPaneLayout!.host.style.width = `${width}px`; scmPaneLayout!.panes.layout(480, width); },
};
window.gitScmPaneIntegration = gitScmPaneIntegration;
declare global { interface Window { gitScmPaneIntegration: typeof gitScmPaneIntegration; } }

declare global {
	interface Window {
		gitSCMTransportIntegration: { hold(): void; release(): void; waiting(): number; burst(): Promise<unknown>; holdOutputs(): void; releaseOutputs(): void; waitingOutputs(): number; };
	}
}
window.gitSCMTransportIntegration = {
	hold: () => { scmUpdateGate = new DeferredPromise<void>(); },
	release: () => { const gate = scmUpdateGate; scmUpdateGate = undefined; void gate?.complete(undefined); },
	waiting: () => waitingSCMUpdates,
	holdOutputs: () => { outputGate = new DeferredPromise<void>(); waitingOutputs = 0; },
	releaseOutputs: () => { const gate = outputGate; outputGate = undefined; void gate?.complete(undefined); },
	waitingOutputs: () => waitingOutputs,
	burst: async () => {
		includeGeneric = true;
		includeGit = false;
		const snapshot = await host.reconcile('refresh');
		const runtime = snapshot.extensions.find(value => value.id === 'test.snapshots')!;
		return host.invoke({ extensionId: runtime.id, incarnation: runtime.incarnation!, activationGeneration: runtime.activationGeneration, registrationId: 'scm', operation: 'scm', payload: { method: 'burst' }, deadlineUnixMillis: Date.now() + 10_000 }, new AbortController().signal);
	},
};

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
