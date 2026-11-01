import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { autorun, observableSignalFromEvent } from '../../../../base/common/observable.js';
import { IAgentHostConnectionsService } from '../../../../platform/agentHost/common/agentHostConnectionsService.js';
import {
	BrowserViewStorageScope, getBrowserViewSessionNetwork, getBrowserViewSessionAffinity,
	type IBrowserViewNetwork, type IBrowserViewOwner, type IBrowserViewSessionOptions,
} from '../../../../platform/browserView/common/browserView.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService, getWorkspaceRemoteAuthority } from '../../../../platform/workspace/common/workspace.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import type { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import type { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService, type IBrowserViewNetworkResolver, type IBrowserViewNetworkStatus } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import type { ISession, SessionWorkspaceSelection } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { buildAgentHostSessionWorkspace } from '../../../common/agentHostSessionWorkspace.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { resolveBrowserOwnerSession } from './sessionBrowserView.js';

interface BrowserNetworkContext {
	readonly authority: string;
	readonly root?: string;
	readonly affinity?: string;
}

/** Binds browser creation and draft tabs to the canonical Session execution directory. */
export class SessionBrowserNetworkContribution extends Disposable implements IWorkbenchContribution {
	public static readonly ID = 'workbench.contrib.sessionBrowserNetwork';
	private readonly draftTabs = new Map<BrowserEditorInput, string>();
	private readonly tabListeners = this._register(new DisposableMap<BrowserEditorInput>());
	private moves: Promise<void> = Promise.resolve();

	constructor(
		@ISessionsManagementService private readonly management: ISessionsManagementService,
		@ISessionsService private readonly sessions: ISessionsService,
		@ISessionsProvidersService private readonly providers: ISessionsProvidersService,
		@IAgentHostConnectionsService private readonly hosts: IAgentHostConnectionsService,
		@IBrowserViewWorkbenchService private readonly browsers: IBrowserViewWorkbenchService,
		@IEditorPart private readonly editors: IEditorPart,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		const resolver: IBrowserViewNetworkResolver = {
			resolveNetwork: owner => {
				const context = this.context(owner);
				return context === null ? null : this.network(context?.authority, context?.root);
			},
			resolveStorageAffinity: owner => {
				const context = this.context(owner);
				return context ? this.affinity(context) : undefined;
			},
			getNetworkStatus: network => this.status(network),
			onDidChangeNetworkStatus: hosts.onDidChangeConnections,
		};
		this._register(browsers.registerNetworkResolver(resolver));
		this._register(browsers.registerOpenHandler({
			shouldOpenEditor: () => true,
			onWillCreateBrowserView: (owner, _id, replaces) => {
				const selection = sessions.activeSelection;
				if (replaces || owner.type !== 'user' || selection?.kind !== 'untitled') { return undefined; }
				const draftId = selection.session.untitledSessionId;
				return input => {
					if (input) {
						this.track(input, draftId);
						this.scheduleMoves();
					}
				};
			},
		}));
		const catalog = observableSignalFromEvent(this, management.onDidChange);
		this._register(autorun(reader => {
			catalog.read(reader);
			management.materializedSessions.read(reader);
			this.scheduleMoves();
		}));
	}

	private network(authority: string | undefined, root?: string): IBrowserViewNetwork | undefined {
		return authority && authority !== 'local' ? { authority, ...(authority.startsWith('provider') && root ? { root } : {}) } : undefined;
	}

	private affinity(context: BrowserNetworkContext): string | undefined {
		return context.affinity ?? (context.root ? JSON.stringify([context.authority, context.root]) : undefined);
	}

	private context(owner: IBrowserViewOwner): BrowserNetworkContext | null | undefined {
		if (owner.type === 'agent') {
			const session = resolveBrowserOwnerSession(this.management, owner.sessionId);
			return session ? this.sessionContext(session, owner.sessionId) : null;
		}
		const selected = this.sessions.activeSelection;
		return selected?.kind === 'session' ? this.sessionContext(selected.active.session, selected.active.threadId)
			: selected?.kind === 'untitled' ? this.draftContext(selected.session.workspace, selected.session.providerId) : undefined;
	}

	private sessionContext(session: ISession, threadId: string): BrowserNetworkContext {
		const directory = session.chats.find(chat => chat.threadId === threadId)?.workspace ?? session.workspace;
		return directory ? { authority: directory.authorityId, root: directory.root }
			: this.draftContext({ type: 'current' }, session.providerId);
	}

	private draftContext(target: SessionWorkspaceSelection, providerId?: string): BrowserNetworkContext {
		if (target.type === 'current') {
			const provided = providerId ? this.providers.getProvider(providerId)?.currentWorkspace() : undefined;
			if (provided && provided.type !== 'current') { return this.draftContext(provided); }
			const workspace = this.workspace.getWorkspace();
			return { authority: getWorkspaceRemoteAuthority(workspace) ?? 'local', root: workspace.folders[0]?.uri.path };
		}
		if (target.type === 'multiple') {
			const contexts = target.folders.map(folder => this.draftContext(folder.target));
			const authorities = new Set(contexts.map(context => context.authority));
			if (authorities.size !== 1) { throw new Error('BrowserOwnerNetworkUnavailable'); }
			const primary = contexts[0]!;
			// Storage identifies every root, while execution still needs a real directory in the runtime.
			return { authority: primary.authority, root: primary.root, affinity: JSON.stringify([primary.authority, contexts.map(context => context.root).sort()]) };
		}
		const directory = buildAgentHostSessionWorkspace(target)!;
		return { authority: directory.authorityId, root: directory.root };
	}

	private status(network: IBrowserViewNetwork): IBrowserViewNetworkStatus {
		const host = this.hosts.connections.find(info => info.directory?.uri.authority === network.authority);
		const ambient = getWorkspaceRemoteAuthority(this.workspace.getWorkspace()) === network.authority
			? this.hosts.connections.find(info => info.isAmbient) : undefined;
		const connection = host ?? ambient;
		return {
			label: connection?.name ?? network.authority,
			connected: connection?.state === 'ready',
			proxySupported: true,
		};
	}

	private track(input: BrowserEditorInput, draftId: string): void {
		if (this.isDisposed || input.isDisposed || !input.model) { return; }
		this.draftTabs.set(input, draftId);
		this.tabListeners.set(input, input.model.onWillDispose(() => {
			this.draftTabs.delete(input);
			this.tabListeners.deleteAndDispose(input);
		}));
	}

	private scheduleMoves(): void {
		this.moves = this.moves.then(async () => {
			for (const [input, draftId] of [...this.draftTabs]) {
				if (this.isDisposed) { return; }
				const promotion = this.management.materializedSessions.get().get(draftId);
				const session = promotion && this.management.sessions.find(session => session.sessionId === promotion.sessionId);
				const draft = this.management.untitledSessions.find(draft => draft.untitledSessionId === draftId);
				if (!session && !draft) {
					// Discard leaves the page on its current network; promotion may still be hydrating.
					if (!promotion) { this.untrack(input); }
					continue;
				}
				const context = session ? this.sessionContext(session, promotion!.threadId) : this.draftContext(draft!.workspace, draft!.providerId);
				try { await this.move(input, draftId, context); }
				catch (error) { this.log.error('Could not move browser to its Session network', error); }
				if (session) {
					for (const [tab, id] of this.draftTabs) { if (id === draftId) { this.untrack(tab); } }
				}
			}
		}).catch(error => this.log.error('Could not reconcile Session browser networks', error));
	}

	private untrack(input: BrowserEditorInput): void {
		this.draftTabs.delete(input);
		this.tabListeners.deleteAndDispose(input);
	}

	private async move(input: BrowserEditorInput, draftId: string, context: BrowserNetworkContext): Promise<void> {
		const groups = this.editors.groups.filter(group => group.inputs.includes(input));
		if (!groups.length || input.isDisposed) { return; }
		const data = input.serialize();
		const network = this.network(context.authority, context.root);
		const affinity = this.affinity(context);
		const current = data.session;
		if (current.scope === BrowserViewStorageScope.Global || current.scope === BrowserViewStorageScope.Agent) { return; }
		const target: IBrowserViewSessionOptions = current.scope === BrowserViewStorageScope.Workspace
			? { scope: current.scope, ...(network ? { network } : {}), ...(affinity ? { affinity } : {}) }
			: { scope: current.scope, ...(network ? { network } : {}) };
		const currentNetwork = getBrowserViewSessionNetwork(current);
		if (currentNetwork?.authority === network?.authority && currentNetwork?.root === network?.root && getBrowserViewSessionAffinity(current) === getBrowserViewSessionAffinity(target)) { return; }
		const replacement = await this.browsers.replaceBrowserView(input, target);
		if (replacement !== input && !this.isDisposed) {
			this.untrack(input);
			this.track(replacement, draftId);
		}
	}

	protected override disposeCore(): void {
		this.draftTabs.clear();
		super.disposeCore();
	}
}
