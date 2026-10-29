import { raceCancellationError } from '../../../../../base/common/async.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { canceled } from '../../../../../base/common/errors.js';
import { extUri } from '../../../../../base/common/resources.js';
import { BrowserContentSearchService } from '../../../../../platform/search/browser/searchService.js';
import type { FileSearchDirectory, IFileSearchService } from '../../../../../platform/search/common/fileSearch.js';
import type { IContentSearchService } from '../../../../../platform/search/common/search.js';
import type { IWorkspace } from '../../../../../platform/workspace/common/workspace.js';
import { sessionWorkspaceUri } from '../../../../common/sessionWorkspace.js';
import { buildAgentHostSessionWorkspace } from '../../../../common/agentHostSessionWorkspace.js';
import { ISessionProviderScopeService, type ISessionProviderScope } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';

/** Search captures the folder's exact host, independent of later navigation and equal backend IDs. */
export class SessionsSearchService implements IFileSearchService, IContentSearchService {
	constructor(
		private readonly defaultProviderId: string,
		private readonly primaryWorkspace: () => IWorkspace,
		@ISessionProviderScopeService private readonly scopes: ISessionProviderScopeService,
		@ISessionsProvidersService private readonly providers: ISessionsProvidersService,
	) { }
	private route(directory: FileSearchDirectory): { scope: ISessionProviderScope; directory: FileSearchDirectory; resolve?: boolean; } {
		let target = directory.target;
		if (target.type === 'workspace' && target.dirId.startsWith('session:')) {
			const [sessionId, path] = target.dirId.slice('session:'.length).split(':').map(decodeURIComponent);
			if (!sessionId || !path) throw canceled();
			target = { type: 'session', sessionId, path };
		}
		if (target.type === 'session') {
			const scope = this.scopes.getScope(target.sessionId);
			return { scope, directory: { ...directory, target: { ...target, sessionId: scope.backendIdentity(target.sessionId) } } };
		}
		const provider = this.providers.getProviders().find(provider => {
			if (provider.id === this.defaultProviderId) return false;
			const workspace = provider.currentWorkspace();
			return (workspace.type === 'ssh' || workspace.type === 'local' || workspace.type === 'provider') && extUri.isEqualOrParent(directory.resource, sessionWorkspaceUri(buildAgentHostSessionWorkspace(workspace)!));
		});
		if (provider) {
			return { scope: this.scopes.getProviderScope(provider.id), directory, resolve: true };
		}
		if (!this.primaryWorkspace().folders.some(folder => extUri.isEqual(folder.uri, directory.resource))) throw canceled();
		return { scope: this.scopes.getProviderScope(this.defaultProviderId), directory };
	}
	private async run<T>(scope: ISessionProviderScope, signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
		scope.assertCurrent();
		using lifetime = new DisposableStore();
		const controller = new AbortController();
		const abort = () => controller.abort();
		if (signal?.aborted) abort();
		signal?.addEventListener('abort', abort, { once: true });
		lifetime.add(toDisposable(() => signal?.removeEventListener('abort', abort)));
		lifetime.add(scope.services.host.fs.onDidChangeConnection(abort));
		lifetime.add(this.scopes.onDidChangeScopes(() => { try { scope.assertCurrent(); } catch { abort(); } }));
		const result = await raceCancellationError(operation(controller.signal), controller.signal);
		scope.assertCurrent();
		return result;
	}
	private async resolveDirectory(routed: ReturnType<SessionsSearchService['route']>, signal: AbortSignal): Promise<FileSearchDirectory> {
		if (!routed.resolve) return routed.directory;
		const directory = await routed.scope.services.host.fs.resolvePath(routed.directory.resource);
		routed.scope.assertCurrent();
		if (signal.aborted || !extUri.isEqual(directory.uri, routed.directory.resource)) throw canceled();
		return { resource: routed.directory.resource, target: directory.target.type === 'environment' ? { type: 'workspace', dirId: directory.target.dirId } : directory.target };
	}
	glob(...[directory, query, signal]: Parameters<IFileSearchService['glob']>): ReturnType<IFileSearchService['glob']> {
		const routed = this.route(directory);
		return this.run(routed.scope, signal, async signal => routed.scope.services.host.fileSearch.glob(await this.resolveDirectory(routed, signal), query, signal));
	}
	fuzzy(...[directory, query, signal]: Parameters<IFileSearchService['fuzzy']>): ReturnType<IFileSearchService['fuzzy']> {
		const routed = this.route(directory);
		return this.run(routed.scope, signal, async signal => routed.scope.services.host.fileSearch.fuzzy(await this.resolveDirectory(routed, signal), query, signal));
	}
	search(...[folder, query, options]: Parameters<IContentSearchService['search']>): ReturnType<IContentSearchService['search']> {
		const routed = this.route({ resource: folder.uri, target: { type: 'workspace', dirId: folder.id } });
		return this.run(routed.scope, options?.signal, async signal => {
			const directory = await this.resolveDirectory(routed, signal);
			const target = directory.target;
			const host = routed.scope.services.host;
			const translate = <T extends { readonly dirId?: string; }>(params: T) => {
				const { dirId: _dirId, ...rest } = params;
				return target.type === 'session' ? { ...rest, sessionDirectory: { sessionId: target.sessionId, path: target.path } } : { ...rest, dirId: target.dirId };
			};
			const search = new BrowserContentSearchService({
				start: params => host.contentSearch.start(translate(params)),
				read: params => host.contentSearch.read(translate(params)),
				cancel: params => host.contentSearch.cancel(translate(params)),
			});
			return search.search(folder, query, { ...options, signal });
		});
	}
}
