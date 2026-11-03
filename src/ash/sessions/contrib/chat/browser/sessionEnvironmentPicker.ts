import { ActionWidgetDropdown } from '../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
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
import { Button } from '../../../../base/browser/ui/button/button.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { ISessionProviderScopeService } from '../../../browser/agentHost/sessionProviderScopeService.js';

export class SessionEnvironmentPicker extends Disposable {
	private readonly dropdown: ActionWidgetDropdown;
	private readonly connecting = this._register(new MutableDisposable());
	private readonly host: HTMLElement;
	private readonly button: Button;
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
		@ISessionProviderScopeService private readonly scopes: ISessionProviderScopeService,
	) {
		super();
		this.host = h(container.ownerDocument, 'div', { className: 'ash-sessions-environment' });
		container.prepend(this.host);
		this._register(toDisposable(() => this.host.remove()));
		this.button = this._register(new Button(this.host, {
			...defaultButtonStyles, presentation: 'quiet', size: 'small', label: '',
			title: localize('sessions.environment.tooltip', 'Environment'),
		}));
		this.button.domNode.classList.add('ash-sessions-environment-picker');
		const sandboxStatus = h(container.ownerDocument, 'div');
		sandboxStatus.setAttribute('role', 'status');
		this.dropdown = this._register(new ActionWidgetDropdown(this.host, {
			label: '', ariaLabel: '',
			trigger: { button: this.button, open: () => this.showPicker() },
			onError: error => {
				if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error));
			},
			onShow: () => {
				let current = true;
				const draft = this.draft;
				const providerId = draft?.providerId ?? LOCAL_AGENT_HOST_PROVIDER_ID;
				sandboxStatus.textContent = localize('sessions.environment.sandboxLoading', 'Checking sandbox…');
				void this.readSandboxStatus(providerId).then(status => {
					if (current && draft && this.isCurrent(draft)) sandboxStatus.textContent = status;
				});
				return toDisposable(() => { current = false; });
			},
			listOptions: {
				header: sandboxStatus,
				className: 'ash-sessions-environment-menu ash-action-widget-accent-checks',
				ariaLabel: localize('sessions.environment.menu', 'Run on'),
			},
		}, menus));
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
			this.button.domNode.removeAttribute('aria-busy');
		}
		this.update();
	}

	private update(): void {
		const draft = this.draft;
		const label = this.label(draft?.providerId, draft?.providerId ? this.providers.getProvider(draft.providerId)?.label : undefined);
		this.host.hidden = !draft;
		const icon = draft?.providerId === LOCAL_AGENT_HOST_PROVIDER_ID ? Lxicon.local : Lxicon.remote;
		if (this.button.icon !== icon) {
			this.button.icon = icon;
		}
		if (this.button.label !== label) {
			this.button.label = label;
		}
		this.button.domNode.setAttribute('aria-label', localize('sessions.environment.label', 'Run on: {0}', label));
		this.button.enabled = this.visible && !!draft && !this.model.inputState.aiDisabled && this.model.inputState.phase !== 'submitting';
		if (!this.button.enabled) this.dropdown.hide();
	}

	public showPicker(): void {
		const draft = this.draft;
		if (!draft || !this.button.enabled) { return; }
		this.dropdown.showItems({
			requireIdle: true,
			load: token => this.loadItems(draft, token),
			select: run => run(),
		});
	}

	private async loadItems(draft: IUntitledChatSession, token: CancellationToken): Promise<readonly IActionListItem<() => Promise<unknown>>[]> {
		const [savedResult, wslResult] = await Promise.allSettled([
			this.remoteHosts.isAvailable && this.connections.available ? this.connections.list() : [],
			this.remoteHosts.isAvailable ? this.remoteHosts.listWSLDistros() : [],
		]);
		if (token.isCancellationRequested || !this.isCurrent(draft)) { return []; }
		const saved = savedResult.status === 'fulfilled' ? savedResult.value : [];
		if (savedResult.status === 'rejected' && !isCancellationError(savedResult.reason)) {
			this.notifications.error(savedResult.reason instanceof Error ? savedResult.reason : String(savedResult.reason));
		}
		const providers = this.providers.getProviders();
		const disconnected = saved.filter(target => !this.findSSHProvider(target, providers));
		const distros = wslResult.status === 'fulfilled' ? wslResult.value : [];
		const items: IActionListItem<() => Promise<unknown>>[] = [];
		const providerItem = (provider: ISessionsProvider): IActionListItem<() => Promise<void>> => ({
			kind: ActionListItemKind.Action,
			label: this.label(provider.id, provider.label),
			checked: provider.id === draft.providerId,
			disabled: provider.connectionStatus?.get() === 'disconnected',
			item: () => this.select(draft, provider),
		});
		const local = providers.find(provider => provider.id === LOCAL_AGENT_HOST_PROVIDER_ID);
		const wslProviders = providers.filter(provider => {
			const workspace = provider.currentWorkspace();
			return workspace.type === 'remote' && workspace.authority.startsWith('wsl+');
		});
		items.push({ kind: ActionListItemKind.Header, label: localize('sessions.environment.localGroup', 'Local') });
		if (local) items.push(providerItem(local));
		items.push(...wslProviders.map(providerItem));
		for (const distro of distros) {
			if (wslProviders.some(provider => provider.label === distro)) continue;
			items.push({
				kind: ActionListItemKind.Action, label: localize('sessions.environment.wslDistro', 'WSL: {0}', distro), checked: false,
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
		if (remote.length || disconnected.length || offlineTunnels.length) {
			items.push({ kind: ActionListItemKind.Header, label: localize('sessions.environment.remoteGroup', 'Remote') });
			items.push(...remote.map(provider => ({
				...providerItem(provider),
				badge: provider.connectionStatus?.get() === 'connected' ? localize('sessions.environment.connectedStatus', 'Connected')
					: provider.connectionStatus?.get() === 'connecting' ? localize('sessions.environment.connectingStatus', 'Connecting')
						: provider.connectionStatus?.get() === 'disconnected' ? localize('sessions.environment.disconnectedStatus', 'Disconnected') : undefined,
			})), ...disconnected.map(target => ({
				kind: ActionListItemKind.Action,
				label: target.name,
				badge: localize('sessions.environment.disconnectedStatus', 'Disconnected'),
				detail: target.host,
				checked: false,
				item: () => this.connect(draft, target),
			})));
			items.push(...offlineTunnels.map(endpoint => ({
				kind: ActionListItemKind.Action,
				label: tunnelEnvironmentLabel(endpoint),
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
		}
		if (this.remoteHosts.isAvailable) {
			items.push({ kind: ActionListItemKind.Separator, label: '' }, {
				kind: ActionListItemKind.Action, label: localize('sessions.environment.newRemote', 'New Remote Environment'),
				item: async () => {
					const saved = await this.commands.executeCommand<boolean>('sessions.action.newRemoteEnvironment');
					if (saved && this.isCurrent(draft)) this.showPicker();
				},
			});
		}
		const providerId = draft.providerId ?? LOCAL_AGENT_HOST_PROVIDER_ID;
		items.push({ kind: ActionListItemKind.Separator, label: '' }, {
			kind: ActionListItemKind.Action,
			label: localize('sessions.environment.sandboxSettings', 'Sandbox Settings'),
			item: async () => {
				if (!this.isCurrent(draft) || this.scopes.getScope().providerId !== providerId) return;
				await this.commands.executeCommand('workbench.action.openSettings', { section: 'environment', query: '' });
			},
		});
		return items;
	}

	private async readSandboxStatus(providerId: string): Promise<string> {
		const unavailable = localize('sessions.environment.sandboxUnavailable', 'Sandbox status unavailable');
		try {
			const scope = this.scopes.getProviderScope(providerId);
			scope.assertCurrent();
			const service = scope.services.host.agentCapabilities;
			if (!service.isAvailable) return unavailable;
			const { sandboxPolicy } = await service.read();
			scope.assertCurrent();
			if (!sandboxPolicy) return unavailable;
			const files = {
				readOnly: localize('sessions.environment.sandboxReadOnly', 'Read only'),
				directoryWrite: localize('sessions.environment.sandboxDirectoryWrite', 'Authorized directories writable'),
				fullAccess: localize('sessions.environment.sandboxFullAccess', 'Full file access profile'),
			};
			const network = {
				denied: localize('sessions.environment.sandboxNetworkDenied', 'Network blocked'),
				managed: localize('sessions.environment.sandboxNetworkManaged', 'Network checked by proxy'),
				allowed: localize('sessions.environment.sandboxNetworkAllowed', 'Network allowed'),
			};
			return localize('sessions.environment.sandboxStatus', 'Sandbox: {0} · {1}', files[sandboxPolicy.fileSystem], network[sandboxPolicy.network]);
		} catch {
			return unavailable;
		}
	}

	private isCurrent(draft: IUntitledChatSession): boolean {
		const current = this.draft;
		return !this.isDisposed && this.button.enabled && current?.untitledSessionId === draft.untitledSessionId
			&& current.providerId === draft.providerId;
	}

	private findSSHProvider(target: RemoteConnectionDefinition, providers = this.providers.getProviders()): ISessionsProvider | undefined {
		return providers.find(provider => {
			const workspace = provider.currentWorkspace();
			return workspace.type === 'ssh' && workspace.host === target.host && workspace.root === target.workspace;
		});
	}

	private async select(draft: IUntitledChatSession, provider: ISessionsProvider): Promise<void> {
		if (provider.id === draft.providerId || !this.isCurrent(draft)) return;
		await this.persistDraft();
		if (!this.isCurrent(draft) || this.providers.getProvider(provider.id) !== provider || provider.connectionStatus?.get() === 'disconnected') return;
		this.sessions.setUntitledSessionWorkspace(draft.untitledSessionId, undefined, { providerId: provider.id });
	}

	private async connect(draft: IUntitledChatSession, target: RemoteConnectionDefinition): Promise<void> {
		if (!this.isCurrent(draft)) return;
		const controller = new AbortController();
		const pending = toDisposable(() => controller.abort());
		this.connecting.value = pending;
		this.button.domNode.setAttribute('aria-busy', 'true');
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
				this.button.domNode.removeAttribute('aria-busy');
			}
		}
	}

}
