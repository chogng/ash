import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { createBrowserExtensionApi } from '../../../src/ash/platform/extensions/browser/extensionApi.js';
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
import { QuickDiffService } from '../../../src/ash/workbench/contrib/scm/common/quickDiffService.js';
import { MultiDiffSourceResolverService } from '../../../src/ash/workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js';
import type { IDecorationsService } from '../../../src/ash/workbench/services/decorations/common/decorations.js';
import type { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import type { IAppServerApi } from '../../../src/ash/platform/agentHost/common/appServerApi.js';
import { setNlsMessages } from '../../../src/ash/nls.js';

const lifetime = new DisposableStore();
const services = lifetime.add(new InstantiationService());
const workspace = lifetime.add(new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') }));
const configuration = lifetime.add(new InMemoryConfigurationService());
const packages = createBrowserExtensionApi();
let enabled = true;
const catalog = { resources: packages.resources, list: async () => { const value = await packages.list('cached'); return { ...value, extensions: enabled ? value.extensions.filter(value => value.id === 'ash.git') : [] }; } };
const calls: { method: string; params: JsonValue }[] = [];
const errors: string[] = [];
const requests: JsonValue[] = [];
const answers: string[] = [];

let revision = 1;
const status = () => ({ repositoryId: 'root', streamInstanceId: 'stream', revision, historyRevision: 1, path: '', head: { type: 'branch', name: 'main', objectId: 'a'.repeat(40), upstream: null }, changes: [{ path: 'one.ts', originalPath: null, indexStatus: revision > 1 ? 'modified' : 'unmodified', worktreeStatus: revision > 1 ? 'unmodified' : 'modified', conflicted: false }] });
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
 } }, { getConnectionState: async () => 'ready', connectionGeneration: 1 } as IAppServerApi, { subscribe: Event.None }, workspace));
const unavailable = (method: string): never => { throw new Error(`Unexpected remote host request ${method}`); };
const host = lifetime.add(services.createInstance(BrowserExtensionHostApi, catalog, createDisconnectedExtensionHostApi(unavailable)));
const scm = lifetime.add(new SCMService());
const view = lifetime.add(new SCMViewService(scm));
const quickDiff = lifetime.add(new QuickDiffService());
const resolvers = lifetime.add(new MultiDiffSourceResolverService());
const commands = { executeCommand: async (id: string, ...args: unknown[]) => invoke(id, args) } as unknown as ICommandService;
const bridge = lifetime.add(new MainThreadSCM(10_000, error => errors.push(String(error)), host, scm, view, commands, resolvers, quickDiff, { registerDecorationsProvider: () => toDisposable(() => undefined) } as unknown as IDecorationsService));
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
async function disable() { enabled = false; bridge.clear(); bridge.update(await host.reconcile('refresh')); }
declare global { interface Window { gitExtensionIntegration: { activate: typeof activate; invoke: typeof invoke; disable: typeof disable; answer(values: string[]): void; state(): { repositories: { id: string; groups: string[]; paths: string[]; placeholder: string }[]; calls: typeof calls; errors: string[]; requests: JsonValue[] }; stage(): Promise<void>; history(): Promise<unknown>; dispose(): void }; } }
window.gitExtensionIntegration = {
 activate, invoke, disable, answer: values => answers.push(...values),
 state: () => ({ repositories: [...scm.repositories].map(repository => ({ id: repository.id, groups: repository.provider.groups.map(group => group.label), paths: repository.provider.groups.flatMap(group => group.resources.map(resource => resource.path)), placeholder: repository.provider.input.placeholder })), calls, errors, requests }),
 stage: async () => { const repository = scm.getRepository('root')!; await invoke('git.stageAll', [repository]); },
 history: async () => scm.getRepository('root')!.provider.historyProvider!.provideHistoryItems({ limit: 1 }),
 dispose: () => lifetime.dispose(),
};
