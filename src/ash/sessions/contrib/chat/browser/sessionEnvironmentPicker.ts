import type { IAgentHostSessionsProvider } from '../../../common/agentHostSessionsProvider.js';
import { trackChatInputPickerFocus } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPickerActionItem.js';
import { ActionWidgetDropdown } from '../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { parseSessionEnvironment } from '../../../services/sessions/common/sessionEnvironment.js';
import { isSessionEnvironmentSelection } from '../../../services/sessions/browser/sessionGridState.js';
import { NewEnvironmentDialog } from './newEnvironmentDialog.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { IAgentConnection } from '../../../../platform/agentHost/common/agentService.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { buildAgentHostSessionWorkspace, selectionFromResource } from '../../../common/agentHostSessionWorkspace.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import type { SessionExecutionTarget, SessionEnvironmentSelection } from '../../../services/sessions/common/session.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { listSavedTunnelEndpoints, tunnelEnvironmentLabel } from '../../../common/savedTunnelEnvironments.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { ActionListItemKind, type IActionListItem } from '../../../../platform/actionWidget/browser/actionList.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IRemoteAgentHostService, isSSHAgentHost, remoteAgentHostRoot, type RemoteAgentHostConnection } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IRemoteConnectionService, type RemoteConnectionDefinition } from '../../../../platform/remote/common/remoteConnectionService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import type { ISessionsProvider } from '../../../services/sessions/common/sessionsProvider.js';
import type { IUntitledChatSession } from '../../../services/sessions/common/session.js';
import { h } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';

export class SessionEnvironmentPicker extends Disposable {
	private readonly newEnvironment = this._register(new MutableDisposable<NewEnvironmentDialog>());
	private readonly dropdown: ActionWidgetDropdown;
	private readonly connecting = this._register(new MutableDisposable());
	private readonly folderAuthorization = this._register(new MutableDisposable());
	private readonly host: HTMLElement;
	private visible = true;

	constructor(
		container: HTMLElement,
		private readonly model: IChatWidgetModel,
		private readonly persistDraft: () => Promise<void>,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@ISessionsProvidersService private readonly providers: ISessionsProvidersService,
		@IActionWidgetService menus: IActionWidgetService,
		@ICommandService private readonly commands: ICommandService,
		@IRemoteAgentHostService private readonly remoteHosts: IRemoteAgentHostService,
		@IRemoteConnectionService private readonly connections: IRemoteConnectionService,
		@INotificationService private readonly notifications: INotificationService,
		@IStorageService private readonly storage: IStorageService,
		@ILayoutService private readonly layout: ILayoutService,
		@IFileDialogService private readonly fileDialogs: IFileDialogService,
		@IWorkspacesService private readonly workspaces: IWorkspacesService,
		@IAgentConnection private readonly localHost: IAgentConnection,
	) {
		super();
		this.host = h(container.ownerDocument, 'div', { className: 'ash-sessions-environment' });
		container.prepend(this.host);
		this._register(toDisposable(() => this.host.remove()));
		this.dropdown = this._register(new ActionWidgetDropdown(this.host, {
			label: '', ariaLabel: '',
			buttonOptions: { presentation: 'quiet', size: 'small', icon: undefined, title: localize('sessions.environment.tooltip', 'Environment') },
			onOpen: () => this.openPicker(),
			tabLeavesPopup: true,
			onError: error => {
				if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error));
			},
			listOptions: {
				className: 'ash-sessions-environment-menu ash-action-widget-accent-checks',
				showFilter: true,
				focusFilterOnOpen: true,
				filterPlaceholder: localize('sessions.environment.search', 'Search environments'),
				ariaLabel: localize('sessions.environment.menu', 'Run on'),
			},
		}, menus));
		this.dropdown.element.classList.add('ash-sessions-environment-picker');
		this._register(trackChatInputPickerFocus(this.host));
		this._register(sessions.onDidChange(() => this.update()));
		this._register(providers.onDidChangeProviders(() => { this.dropdown.hide(); this.update(); }));
		this._register(model.onDidChange(() => this.update()));
		this.update();
	}

	private get draft() {
		return this.sessions.untitledSessions.find(draft => draft.untitledSessionId === this.model.untitledSessionId);
	}

	private label(id: string | undefined, name?: string): string {
		return id === LOCAL_AGENT_HOST_PROVIDER_ID
			? localize('sessions.environment.local', 'This Computer')
			: name ?? localize('sessions.environment.unavailable', 'Host unavailable');
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		if (!visible) {
			this.connecting.clear();
			this.folderAuthorization.clear();
			this.dropdown.element.removeAttribute('aria-busy');
		}
		this.update();
	}

	private update(): void {
		const draft = this.draft;
		const label = draft?.environment?.name ?? this.label(draft?.providerId, draft?.providerId ? this.providers.getProvider(draft.providerId)?.label : undefined);
		this.host.hidden = !draft;
		const icon = draft?.providerId === LOCAL_AGENT_HOST_PROVIDER_ID ? Lxicon.local : Lxicon.remote;
		this.dropdown.setIcon(icon);
		this.dropdown.setLabel(label);
		this.dropdown.element.setAttribute('aria-label', localize('sessions.environment.label', 'Run on: {0}', label));
		this.dropdown.setEnabled(this.visible && !!draft && !this.model.inputState.aiDisabled && this.model.inputState.phase !== 'submitting');
	}

	public showPicker(): void {
		this.dropdown.focus();
		this.openPicker();
	}

	private openPicker(): void {
		const draft = this.draft;
		if (!draft || this.dropdown.element.disabled) { return; }
		let catalog: ReturnType<SessionEnvironmentPicker['loadCatalog']> | undefined;
		const loadCatalog = () => catalog ??= this.loadCatalog();
		const openNewEnvironment = () => this.showNewEnvironment(draft, loadCatalog());
		this.dropdown.showItems({
			requireIdle: true,
			restoreFocusOnSelect: true,
			load: () => this.buildItems(draft, [], [], openNewEnvironment),
			refresh: async (token, publish) => {
				let saved: readonly RemoteConnectionDefinition[] = [];
				let distros: readonly string[] = [];
				const isOpen = () => !token.isCancellationRequested && this.isCurrent(draft);
				const update = () => {
					if (isOpen()) publish(this.buildItems(draft, saved, distros, openNewEnvironment));
				};
				const catalog = loadCatalog();
				await Promise.all([
					catalog.saved.then(targets => {
						saved = targets;
						update();
					}, error => {
						if (isOpen() && !isCancellationError(error)) {
							this.notifications.error(error instanceof Error ? error : String(error));
						}
					}),
					catalog.distros.then(names => {
						distros = names;
						update();
					}),
				]);
			},
			select: run => run(),
		});
	}

	private loadCatalog() {
		return {
			saved: this.remoteHosts.isAvailable && this.connections.available ? this.connections.list() : Promise.resolve([]),
			distros: this.remoteHosts.isAvailable ? this.remoteHosts.listWSLDistros().catch(() => []) : Promise.resolve([]),
		};
	}

	private buildItems(
		draft: IUntitledChatSession,
		saved: readonly RemoteConnectionDefinition[],
		distros: readonly string[],
		openNewEnvironment: () => Promise<void>,
	): readonly IActionListItem<() => Promise<unknown>>[] {
		const providers = this.providers.getProviders();
		const disconnected = saved.filter(target => !this.findSSHProvider(target, providers));
		const items: IActionListItem<() => Promise<unknown>>[] = [];
		const providerItem = (provider: ISessionsProvider): IActionListItem<() => Promise<void>> => ({
			kind: ActionListItemKind.Action,
			id: `provider:${provider.id}`,
			label: this.label(provider.id, provider.label),
			group: { title: '', icon: provider.id === LOCAL_AGENT_HOST_PROVIDER_ID ? Lxicon.local : Lxicon.remote },
			checked: provider.id === draft.providerId && !draft.environment,
			disabled: provider.connectionStatus?.get() === 'disconnected',
			item: () => this.select(draft, provider),
		});
		const local = providers.find(provider => provider.id === LOCAL_AGENT_HOST_PROVIDER_ID);
		const wslProviders = providers.filter(provider => {
			const workspace = provider.currentWorkspace();
			return workspace.type === 'remote' && workspace.authority.startsWith('wsl+');
		});
		if (local) items.push(providerItem(local));
		items.push(...wslProviders.map(providerItem));
		for (const distro of distros) {
			if (wslProviders.some(provider => provider.label === distro)) continue;
			items.push({
				kind: ActionListItemKind.Action, id: `wsl:${distro}`, label: localize('sessions.environment.wslDistro', 'WSL: {0}', distro), checked: false,
				group: { title: '', icon: Lxicon.remote },
				item: async () => {
					const target = await this.commands.executeCommand<RemoteAgentHostConnection | undefined>('sessions.action.connectWSLAgentHost', distro);
					if (!target || !this.isCurrent(draft)) return;
					const authority = remoteAgentHostRoot(target).authority;
					const provider = this.providers.getProviders().find(candidate => {
						const workspace = candidate.currentWorkspace();
						return workspace.type === 'remote' && workspace.authority === authority && workspace.root === target.workspace;
					});
					if (provider) await this.select(draft, provider);
				},
			});
		}
		const savedTunnels = this.remoteHosts.isAvailable ? listSavedTunnelEndpoints(this.storage) : [];
		const tunnelByAuthority = new Map(this.remoteHosts.connections.flatMap(({ connection, host }) =>
			!isSSHAgentHost(connection) && connection.type === 'tunnel' && host
				? [[host.directory.uri.authority, connection.endpoint] as const] : []));
		const tunnelForProvider = (provider: ISessionsProvider): string | undefined => {
			const workspace = provider.currentWorkspace();
			return workspace.type === 'remote' ? tunnelByAuthority.get(workspace.authority) : undefined;
		};
		const remote = providers.filter(provider => {
			if (provider === local || wslProviders.includes(provider)) return false;
			const endpoint = tunnelForProvider(provider);
			return !endpoint || !savedTunnels.includes(endpoint) || provider.connectionStatus?.get() !== 'disconnected';
		});
		const offlineTunnels = savedTunnels.filter(endpoint => !remote.some(provider => tunnelForProvider(provider) === endpoint));
		if (items.length > 0 && (this.remoteHosts.isAvailable || remote.length || disconnected.length || offlineTunnels.length)) {
			items.push({ kind: ActionListItemKind.Separator, label: '' });
		}
		items.push(...remote.map(provider => ({
			...providerItem(provider),
			badge: provider.connectionStatus?.get() === 'connected' ? localize('sessions.environment.connectedStatus', 'Connected')
				: provider.connectionStatus?.get() === 'connecting' ? localize('sessions.environment.connectingStatus', 'Connecting')
					: provider.connectionStatus?.get() === 'disconnected' ? localize('sessions.environment.disconnectedStatus', 'Disconnected') : undefined,
		})), ...disconnected.map(target => ({
			kind: ActionListItemKind.Action,
			id: `ssh:${target.name}`,
			label: target.name,
			group: { title: '', icon: Lxicon.remote },
			badge: localize('sessions.environment.disconnectedStatus', 'Disconnected'),
			detail: target.host,
			checked: false,
			item: () => this.connect(draft, target),
		})));
		items.push(...offlineTunnels.map(endpoint => ({
			kind: ActionListItemKind.Action,
			label: tunnelEnvironmentLabel(endpoint),
			group: { title: '', icon: Lxicon.remote },
			badge: localize('sessions.environment.disconnectedStatus', 'Disconnected'),
			checked: false,
			item: async () => {
				if (!this.isCurrent(draft)) return;
				const authority = await this.commands.executeCommand<string | undefined>('sessions.action.connectTunnelAgentHost', endpoint);
				if (!authority || !this.isCurrent(draft)) return;
				const provider = this.providers.getProviders().find(candidate => {
					const workspace = candidate.currentWorkspace();
					return workspace.type === 'remote' && workspace.authority === authority;
				});
				if (!provider) throw new Error(localize('sessions.environment.connectionUnavailable', 'The connected host is unavailable for this conversation.'));
				await this.select(draft, provider);
			},
		})));
		for (const key of this.storage.keys(StorageScope.PROFILE, StorageTarget.MACHINE)) {
			if (!key.startsWith('sessions.environment.profile.')) continue;
			const saved = readEnvironment(this.storage.get(key, StorageScope.PROFILE));
			if (!saved) continue;
			const provider = this.providers.getProvider(saved.providerId);
			items.push({
				kind: ActionListItemKind.Action, id: key, label: saved.environment.name,
				disabled: !provider || provider.connectionStatus?.get() === 'disconnected',
				checked: draft.environment?.id === saved.environment.id && draft.providerId === saved.providerId,
				item: () => this.applyEnvironment(draft, saved.providerId, saved.environment),
			});
		}
		if (this.remoteHosts.isAvailable) {
			const connect = async (transport: 'ssh' | 'tunnel') => {
				const saved = await this.commands.executeCommand<boolean>('sessions.action.newRemoteEnvironment', transport);
				if (saved && this.isCurrent(draft)) this.showPicker();
			};
			items.push({
				kind: ActionListItemKind.Action, id: 'remote', label: localize('sessions.environment.remote', 'Remote'),
				group: { title: '', icon: Lxicon.remote },
				submenu: [
					{
						kind: ActionListItemKind.Action, label: localize('sessions.environment.ssh', 'SSH'),
						disabled: !this.connections.available, item: () => connect('ssh'),
					},
					{
						kind: ActionListItemKind.Action, label: localize('sessions.environment.tunnel', 'Ash Tunnel'),
						item: () => connect('tunnel'),
					},
				],
			});
		}
		items.push({
			kind: ActionListItemKind.Action, label: localize('sessions.environment.cloud', 'Cloud'),
			group: { title: '', icon: Lxicon.cloud }, disabled: true,
		}, { kind: ActionListItemKind.Separator, label: '' }, {
			kind: ActionListItemKind.Action, id: 'newEnvironment', label: localize('sessions.environment.newEnvironment', 'New Environment'),
			group: { title: '', icon: Lxicon.add },
			item: openNewEnvironment,
		});
		return items;
	}

	private async applyEnvironment(draft: IUntitledChatSession, providerId: string, environment: SessionEnvironmentSelection): Promise<void> {
		if (!this.isCurrent(draft)) return;
		const provider = this.providers.getProvider(providerId) as IAgentHostSessionsProvider | undefined;
		if (!provider || !await this.authorizeFolders(provider, environment.folders) || !this.isCurrent(draft)) return;
		await this.persistDraft();
		if (!this.isCurrent(draft) || this.providers.getProvider(providerId) !== provider) return;
		this.sessions.setUntitledSessionWorkspace(draft.untitledSessionId, environment.folders[0], { providerId, environment });
	}

	private async authorizeFolders(provider: IAgentHostSessionsProvider, folders: readonly SessionExecutionTarget[]): Promise<boolean> {
		if (!provider.authorizeWorkspace) return true;
		const controller = new AbortController();
		const operation = this.folderAuthorization.value = toDisposable(() => controller.abort());
		try {
			for (const target of folders) {
				if (!await provider.authorizeWorkspace(target, controller.signal) || controller.signal.aborted) return false;
			}
			return true;
		} finally {
			if (this.folderAuthorization.value === operation) this.folderAuthorization.clear();
		}
	}

	private async showNewEnvironment(draft: IUntitledChatSession, catalog: ReturnType<SessionEnvironmentPicker['loadCatalog']>): Promise<void> {
		if (this.newEnvironment.value || !this.isCurrent(draft)) return;
		const sourceOf = (provider: ISessionsProvider) => {
			const workspace = provider.currentWorkspace();
			return { providerId: provider.id, source: workspace.type === 'current' || workspace.type === 'multiple' ? undefined : workspace };
		};
		const hosts: { id: string; label: string; group: 'local' | 'remote'; needsWorkspace?: boolean; resolve: (workspace: string) => Promise<ReturnType<typeof sourceOf> | undefined>; }[] = [];
		for (const provider of this.providers.getProviders()) {
			if (provider.connectionStatus?.get() === 'disconnected') continue;
			const workspace = provider.currentWorkspace();
			const isWSL = workspace.type === 'remote' && workspace.authority.startsWith('wsl+');
			hosts.push({
				id: provider.id,
				label: isWSL ? localize('sessions.environment.wslDistro', 'WSL: {0}', provider.label) : this.label(provider.id, provider.label),
				group: isWSL || provider.id === LOCAL_AGENT_HOST_PROVIDER_ID ? 'local' : 'remote',
				resolve: async () => this.providers.getProvider(provider.id) === provider ? sourceOf(provider) : undefined,
			});
		}
		const controller = new AbortController();
		const selected = Math.max(0, hosts.findIndex(host => host.id === draft.providerId));
		const workspace = draft.workspace;
		const initial = hosts[selected]?.id === draft.providerId && workspace.type !== 'current' && workspace.type !== 'multiple' ? workspace : undefined;
		const accepts = (candidate: SessionExecutionTarget, source?: SessionExecutionTarget) =>
			buildAgentHostSessionWorkspace(candidate)?.authorityId === (buildAgentHostSessionWorkspace(source)?.authorityId ?? 'local');
		const dialog = new NewEnvironmentDialog(this.layout.activeContainer, {
			hosts, selected, initial,
			browse: async source => {
				const defaultUri = source && sessionWorkspaceUri(buildAgentHostSessionWorkspace(source)!);
				const resources = await this.fileDialogs.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: true, defaultUri });
				return (resources ?? []).map(selectionFromResource).filter(target => accepts(target, source));
			},
			recent: async source => (await this.workspaces.getRecentlyOpened()).workspaces.flatMap(entry => {
				if (!('folderUri' in entry)) return [];
				try {
					const target = selectionFromResource(entry.folderUri);
					return accepts(target, source) ? [target] : [];
				} catch { return []; }
			}),
			worktrees: async (providerId, target) => await this.providers.getProvider(providerId)?.getWorktrees?.(target, CancellationToken.None) ?? [],
			create: async (name, providerId, folders, variables) => {
				const key = 'sessions.environment.profile.' + createUuid();
				const parsed = parseSessionEnvironment(variables);
				const environment = { id: key, name, folders, hasVariables: 'variables' in parsed && Object.keys(parsed.variables).length > 0 };
				if (environment.hasVariables && 'variables' in parsed) {
					const session = this.localHost.session;
					if (!session.saveEnvironmentProfile) {
						throw new Error(localize('sessions.environment.variablesMissing', 'The saved environment variables are unavailable.'));
					}
					await session.saveEnvironmentProfile(key, parsed.variables);
				}
				this.storage.store(key, JSON.stringify({ providerId, environment }), StorageScope.PROFILE, StorageTarget.MACHINE);
				if (!controller.signal.aborted) await this.applyEnvironment(draft, providerId, environment);
			},
		});
		this.newEnvironment.value = dialog;
		const canUpdate = () => this.newEnvironment.value === dialog && this.isCurrent(draft);
		void catalog.distros.then(distros => {
			if (!canUpdate()) return;
			for (const distro of distros) {
				const label = localize('sessions.environment.wslDistro', 'WSL: {0}', distro);
				if (this.providers.getProviders().some(provider => {
					const workspace = provider.currentWorkspace();
					return workspace.type === 'remote' && workspace.authority.startsWith('wsl+') && provider.label === distro;
				})) continue;
				dialog.appendHost({
					label, group: 'local', needsWorkspace: true,
					resolve: async workspace => {
						const { connection } = await this.remoteHosts.connect({ type: 'wsl', name: distro, distro, workspace }, controller.signal);
						if (!connection) return;
						const authority = remoteAgentHostRoot(connection).authority;
						const provider = this.providers.getProviders().find(candidate => {
							const workspace = candidate.currentWorkspace();
							return workspace.type === 'remote' && workspace.authority === authority && workspace.root === connection.workspace;
						});
						return provider && sourceOf(provider);
					},
				});
			}
		});
		void catalog.saved.then(saved => {
			if (!canUpdate()) return;
			for (const target of saved) {
				if (this.findSSHProvider(target)) continue;
				dialog.appendHost({
					label: target.name, group: 'remote',
					resolve: async () => {
						await this.remoteHosts.connect(target, controller.signal);
						const provider = this.findSSHProvider(target);
						return provider && sourceOf(provider);
					},
				});
			}
		}, error => {
			if (canUpdate() && !isCancellationError(error)) {
				this.notifications.error(error instanceof Error ? error : String(error));
			}
		});
		try { await dialog.show(); }
		finally {
			controller.abort();
			this.newEnvironment.clear();
			if (!this.isDisposed && this.draft?.untitledSessionId === draft.untitledSessionId) this.dropdown.focus();
		}
	}

	private isCurrent(draft: IUntitledChatSession): boolean {
		const current = this.draft;
		return !this.isDisposed && !this.dropdown.element.disabled && current?.untitledSessionId === draft.untitledSessionId
			&& current.providerId === draft.providerId && current.environment === draft.environment;
	}

	private findSSHProvider(target: RemoteConnectionDefinition, providers = this.providers.getProviders()): ISessionsProvider | undefined {
		return providers.find(provider => {
			const workspace = provider.currentWorkspace();
			return workspace.type === 'ssh' && workspace.host === target.host && workspace.root === target.workspace;
		});
	}

	private async select(draft: IUntitledChatSession, provider: ISessionsProvider): Promise<void> {
		if ((provider.id === draft.providerId && !draft.environment) || !this.isCurrent(draft)) return;
		if (this.providers.getProvider(provider.id) !== provider || provider.connectionStatus?.get() === 'disconnected') return;
		const workspace = provider.currentWorkspace();
		const folders = workspace.type === 'current' ? [] : workspace.type === 'multiple' ? workspace.folders.map(folder => folder.target) : [workspace];
		if (!await this.authorizeFolders(provider as IAgentHostSessionsProvider, folders) || !this.isCurrent(draft)) return;
		await this.persistDraft();
		if (!this.isCurrent(draft) || this.providers.getProvider(provider.id) !== provider || provider.connectionStatus?.get() === 'disconnected') return;
		this.sessions.setUntitledSessionWorkspace(draft.untitledSessionId, undefined, { providerId: provider.id, clearEnvironment: true });
	}

	private async connect(draft: IUntitledChatSession, target: RemoteConnectionDefinition): Promise<void> {
		if (!this.isCurrent(draft)) return;
		const controller = new AbortController();
		const pending = toDisposable(() => controller.abort());
		this.connecting.value = pending;
		this.dropdown.element.setAttribute('aria-busy', 'true');
		try {
			await this.remoteHosts.connect(target, controller.signal);
			if (controller.signal.aborted || !this.isCurrent(draft)) return;
			const provider = this.findSSHProvider(target);
			if (!provider) throw new Error(localize('sessions.environment.connectionUnavailable', 'The connected host is unavailable for this conversation.'));
			await this.select(draft, provider);
		} catch (error) {
			if (!controller.signal.aborted && !isCancellationError(error)) throw error;
		} finally {
			if (this.connecting.value === pending) {
				this.connecting.clear();
				this.dropdown.element.removeAttribute('aria-busy');
			}
		}
	}

}


function readEnvironment(raw: string | undefined): { providerId: string; environment: SessionEnvironmentSelection; } | undefined {
	if (!raw) return;
	try {
		const entry = JSON.parse(raw);
		if (typeof entry?.providerId !== 'string' || !isSessionEnvironmentSelection(entry.environment)) return;
		return { providerId: entry.providerId, environment: entry.environment };
	} catch { return; }
}
