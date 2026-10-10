import { localize } from '../../../../nls.js';
import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { ActionBar } from "../../../../base/browser/ui/actionbar/actionbar.js";
import type { IAction } from "../../../../base/common/actions.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import type { RemoteAgentConnection } from "../../../../platform/remote/common/remoteAgentApi.js";
import { ITunnelService, type RemoteTunnel } from "../../../../platform/tunnel/common/tunnel.js";
import { ViewPane, type IViewPaneOptions, type PartTitleProjection } from "../../../browser/parts/views/viewPane.js";
import { IAppServerRemoteAgentService } from "../../../services/remote/common/appServerRemoteAgentService.js";
import "./media/tunnelView.css";

/** Renders the Electron Main-owned SSH tunnel catalog and forwarding actions. */
export class TunnelPanel extends ViewPane {
	private readonly formElement: HTMLFormElement;
	private readonly portInput: HTMLInputElement;
	private readonly forwardButton: HTMLButtonElement;
	private readonly stopAllButton: HTMLButtonElement;
	private readonly statusElement: HTMLDivElement;
	private readonly listElement: HTMLUListElement;
	private readonly titleActions: ActionBar;
	private readonly tunnels = new Map<string, RemoteTunnel>();
	private readonly closing = new Set<string>();
	private tunnelRevision = 0;
	private readRevision = 0;
	private connectionRevision = 0;
	private opening = false;
	private closingAll = false;
	private error: string | undefined;
	private activeConnectionIdentity: string | undefined;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@ITunnelService private readonly tunnelService: ITunnelService,
		@IAppServerRemoteAgentService private readonly remoteAgentService: IAppServerRemoteAgentService,
	) {
		super(container, options);
		this.activeConnectionIdentity = remoteConnectionIdentity(remoteAgentService.connection);
		this.contentElement.classList.add("ash-remote-ports");
		this.formElement = h(container.ownerDocument, "form");
		this.formElement.className = "ash-remote-ports-form";
		const label = h(container.ownerDocument, "label");
		label.className = "ash-remote-ports-label";
		label.htmlFor = `${options.id}-remote-port`;
		label.textContent = localize({ bundle: 'ash.workbench', key: 'ports.remotePort' }, "Remote port");
		this.portInput = h(container.ownerDocument, "input");
		this.portInput.id = label.htmlFor;
		this.portInput.className = "ash-remote-ports-input";
		this.portInput.type = "number";
		this.portInput.min = "1";
		this.portInput.max = "65535";
		this.portInput.step = "1";
		this.portInput.placeholder = "3000";
		this.portInput.required = true;
		this.titleActions = this._register(new ActionBar(this.headerActionsElement, {
			ariaLabel: localize({ bundle: 'ash.workbench', key: 'ports.actions' }, "Ports actions"),
		}));
		this.titleActions.element.classList.add("ash-toolbar");
		this.forwardButton = h(container.ownerDocument, "button");
		this.forwardButton.className = "ash-remote-ports-forward";
		this.forwardButton.type = "submit";
		this.forwardButton.textContent = localize({ bundle: 'ash.workbench', key: 'ports.forward' }, "Forward Port");
		this.stopAllButton = h(container.ownerDocument, "button");
		this.stopAllButton.className = "ash-remote-ports-stop-all";
		this.stopAllButton.type = "button";
		this.stopAllButton.textContent = localize({ bundle: 'ash.workbench', key: 'ports.stopAll' }, "Stop All");
		this.formElement.append(label, this.portInput, this.forwardButton, this.stopAllButton);
		this.statusElement = h(container.ownerDocument, "div");
		this.statusElement.className = "ash-remote-ports-status";
		this.statusElement.setAttribute("role", "status");
		this.listElement = h(container.ownerDocument, "ul");
		this.listElement.className = "ash-remote-ports-list";
		this.listElement.setAttribute("aria-label", localize({ bundle: 'ash.workbench', key: 'ports.forwarded' }, "Forwarded ports"));
		this.contentElement.append(this.formElement, this.statusElement, this.listElement);

		this._register(addDisposableListener(this.formElement, "submit", event => this.forward(event)));
		this._register(addDisposableListener(this.stopAllButton, "click", () => this.stopAll()));
		this._register(addDisposableListener(this.listElement, "click", event => this.activate(event)));
		this._register(tunnelService.onTunnelOpened(tunnel => this.acceptTunnelChange(tunnel)));
		this._register(tunnelService.onTunnelClosed(address => this.acceptTunnelRemoval(address)));
		this._register(remoteAgentService.onDidChangeConnection(connection => this.acceptConnection(connection)));
		this._register(remoteAgentService.onDidChangeConnectionState(() => this.render()));
		this.render();
		this.refresh();
	}

	override get partTitleProjection(): PartTitleProjection {
		return { actions: this.titleActions.element };
	}

	private forward(event: Event): void {
		event.preventDefault();
		if (!this.canForward() || this.opening) return;
		const remotePort = this.portInput.valueAsNumber;
		if (!Number.isSafeInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
			this.error = localize({ bundle: 'ash.workbench', key: 'ports.invalidPort' }, "Remote port must be an integer from 1 to 65535.");
			this.render();
			return;
		}
		const connectionRevision = this.connectionRevision;
		this.opening = true;
		this.error = undefined;
		this.render();
		void Promise.resolve(this.tunnelService.openTunnel(undefined, "127.0.0.1", remotePort)).then(async tunnel => {
			if (!tunnel || typeof tunnel === "string") {
				throw new Error(tunnel || localize({ bundle: 'ash.workbench', key: 'ports.forwardFailed' }, "Could not forward the remote port."));
			}
			if (!this.isCurrentConnection(connectionRevision)) {
				await tunnel.dispose();
				return;
			}
			this.tunnels.set(tunnelKey(tunnel), tunnel);
			this.portInput.value = "";
		}).catch(error => {
			if (this.isCurrentConnection(connectionRevision)) {
				this.error = errorMessage(error, localize({ bundle: 'ash.workbench', key: 'ports.forwardFailed' }, "Could not forward the remote port."));
			}
		}).finally(() => {
			if (!this.isCurrentConnection(connectionRevision)) return;
			this.opening = false;
			this.render();
		});
	}

	private activate(event: Event): void {
		const target = event.target;
		if (!(target instanceof this.element.ownerDocument.defaultView!.Element)) return;
		const id = target.closest<HTMLButtonElement>(".ash-remote-port-stop")?.dataset.tunnelId;
		if (!id || this.closing.has(id)) return;
		const tunnel = this.tunnels.get(id);
		if (!tunnel) return;
		const connectionRevision = this.connectionRevision;
		this.closing.add(id);
		this.error = undefined;
		this.render();
		void this.tunnelService.closeTunnel(tunnel.tunnelRemoteHost, tunnel.tunnelRemotePort).then(() => {
			if (this.isCurrentConnection(connectionRevision)) this.tunnels.delete(id);
		}, error => {
			if (this.isCurrentConnection(connectionRevision)) {
				this.error = errorMessage(error, localize({ bundle: 'ash.workbench', key: 'ports.stopFailed' }, 'Could not stop the forwarded port.'));
			}
		}).finally(() => {
			if (!this.isCurrentConnection(connectionRevision)) return;
			this.closing.delete(id);
			this.render();
		});
	}

	private stopAll(): void {
		if (this.closingAll || this.tunnels.size === 0 || !this.isRemoteWorkspace()) return;
		const connectionRevision = this.connectionRevision;
		this.closingAll = true;
		this.error = undefined;
		this.render();
		void this.tunnelService.tunnels.then(tunnels => Promise.all(tunnels.map(tunnel => this.tunnelService.closeTunnel(tunnel.tunnelRemoteHost, tunnel.tunnelRemotePort)))).then(() => {
			if (this.isCurrentConnection(connectionRevision)) this.tunnels.clear();
		}, error => {
			if (this.isCurrentConnection(connectionRevision)) {
				this.error = errorMessage(error, localize({ bundle: 'ash.workbench', key: 'ports.stopAllFailed' }, "Could not stop all forwarded ports."));
			}
		}).finally(() => {
			if (!this.isCurrentConnection(connectionRevision)) return;
			this.closingAll = false;
			this.closing.clear();
			this.render();
		});
	}

	private acceptTunnelChange(tunnel: RemoteTunnel): void {
		if (this.isDisposed) return;
		this.tunnelRevision += 1;
		this.tunnels.set(tunnelKey(tunnel), tunnel);
		this.render();
	}

	private acceptTunnelRemoval(address: { host: string; port: number; }): void {
		if (this.isDisposed) return;
		this.tunnelRevision += 1;
		const id = `${address.host}:${address.port}`;
		this.tunnels.delete(id);
		this.closing.delete(id);
		this.render();
	}

	private acceptConnection(connection: RemoteAgentConnection): void {
		if (this.isDisposed) return;
		this.connectionRevision += 1;
		this.opening = false;
		this.closingAll = false;
		this.closing.clear();
		this.error = undefined;
		const connectionIdentity = remoteConnectionIdentity(connection);
		if (connectionIdentity !== this.activeConnectionIdentity) this.tunnels.clear();
		this.activeConnectionIdentity = connectionIdentity;
		this.render();
		if (connection.kind === "ssh") this.refresh();
	}

	private refresh(): void {
		const readRevision = ++this.readRevision;
		const tunnelRevision = this.tunnelRevision;
		const connectionRevision = this.connectionRevision;
		void this.tunnelService.tunnels.then(tunnels => {
			if (!this.isCurrentConnection(connectionRevision) || readRevision !== this.readRevision) return;
			if (tunnelRevision !== this.tunnelRevision) {
				this.refresh();
				return;
			}
			this.tunnels.clear();
			for (const tunnel of tunnels) this.tunnels.set(tunnelKey(tunnel), tunnel);
			this.error = undefined;
			this.render();
		}, error => {
			if (!this.isCurrentConnection(connectionRevision) || readRevision !== this.readRevision) return;
			this.error = errorMessage(error, localize({ bundle: 'ash.workbench', key: 'ports.readFailed' }, "Could not read forwarded ports."));
			this.render();
		});
	}

	private render(): void {
		const remote = this.isRemoteWorkspace();
		const canForward = this.canForward();
		const forwardPortAction: IAction = {
			id: "ash.ports.focusForwardPort",
			label: localize({ bundle: 'ash.workbench', key: 'ports.focusForward' }, "Forward a Port"),
			tooltip: localize({ bundle: 'ash.workbench', key: 'ports.focusForward' }, "Forward a Port"),
			icon: Lxicon.add,
			enabled: canForward && !this.opening,
			checked: undefined,
			run: () => this.portInput.focus(),
		};
		const refreshPortsAction: IAction = {
			id: "ash.ports.refresh",
			label: localize({ bundle: 'ash.workbench', key: 'ports.refresh' }, "Refresh Ports"),
			tooltip: localize({ bundle: 'ash.workbench', key: 'ports.refresh' }, "Refresh Ports"),
			icon: Lxicon.refresh,
			enabled: remote,
			checked: undefined,
			run: () => this.refresh(),
		};
		this.titleActions.updateActions([forwardPortAction, refreshPortsAction]);
		this.portInput.disabled = !canForward || this.opening;
		this.forwardButton.disabled = !canForward || this.opening;
		this.forwardButton.textContent = this.opening
			? localize({ bundle: 'ash.workbench', key: 'ports.forwarding' }, "Forwarding…")
			: localize({ bundle: 'ash.workbench', key: 'ports.forward' }, "Forward Port");
		this.stopAllButton.disabled = !remote || this.tunnels.size === 0 || this.closingAll;
		this.stopAllButton.textContent = this.closingAll
			? localize({ bundle: 'ash.workbench', key: 'ports.stopping' }, "Stopping…")
			: localize({ bundle: 'ash.workbench', key: 'ports.stopAll' }, "Stop All");
		const tunnels = remote ? [...this.tunnels.values()].sort(compareTunnels) : [];
		this.listElement.replaceChildren(...tunnels.map(tunnel => this.renderTunnel(tunnel)));
		this.statusElement.classList.toggle("error", this.error !== undefined && remote);
		this.statusElement.textContent = this.statusText(remote, tunnels.length);
	}

	private renderTunnel(tunnel: RemoteTunnel): HTMLLIElement {
		const item = h(this.element.ownerDocument, "li");
		item.className = `ash-remote-port ${tunnel.state ?? "open"}`;
		item.dataset.tunnelId = tunnelKey(tunnel);
		const endpoints = h(this.element.ownerDocument, "div");
		endpoints.className = "ash-remote-port-endpoints";
		const local = h(this.element.ownerDocument, "code");
		local.className = "ash-remote-port-local";
		local.textContent = tunnel.localAddress;
		const arrow = h(this.element.ownerDocument, "span");
		arrow.className = "ash-remote-port-arrow";
		arrow.setAttribute("aria-hidden", "true");
		arrow.textContent = "→";
		const remote = h(this.element.ownerDocument, "code");
		remote.className = "ash-remote-port-remote";
		remote.textContent = `${tunnel.tunnelRemoteHost}:${tunnel.tunnelRemotePort}`;
		endpoints.append(local, arrow, remote);
		const state = h(this.element.ownerDocument, "span");
		state.className = "ash-remote-port-state";
		state.textContent = tunnelStateLabel(tunnel.state ?? "open");
		const stop = h(this.element.ownerDocument, "button");
		stop.className = "ash-remote-port-stop";
		stop.type = "button";
		stop.dataset.tunnelId = tunnelKey(tunnel);
		stop.disabled = this.closingAll || this.closing.has(tunnelKey(tunnel));
		stop.textContent = this.closing.has(tunnelKey(tunnel))
			? localize({ bundle: 'ash.workbench', key: 'ports.stopping' }, "Stopping…")
			: localize({ bundle: 'ash.workbench', key: 'ports.stop' }, "Stop");
		stop.setAttribute("aria-label", localize({ bundle: 'ash.workbench', key: 'ports.stopLabel' }, 'Stop forwarding remote port {0}', tunnel.tunnelRemotePort));
		item.append(endpoints, state, stop);
		return item;
	}

	private statusText(remote: boolean, tunnelCount: number): string {
		if (!remote) return localize({ bundle: 'ash.workbench', key: 'ports.sshRequired' }, "Forwarded ports are available in an SSH Remote Workspace.");
		if (this.error) return this.error;
		if (this.remoteAgentService.connectionState !== "connected") {
			return tunnelCount === 0
				? localize({ bundle: 'ash.workbench', key: 'ports.waiting' }, "Waiting for the Remote connection.")
				: localize(
					{ bundle: 'ash.workbench', key: 'ports.disconnectedCount' },
					'{0} forwarded ports; the Remote connection is {1}.',
					tunnelCount,
					remoteStateLabel(this.remoteAgentService.connectionState),
				);
		}
		if (tunnelCount === 0) return localize({ bundle: 'ash.workbench', key: 'ports.empty' }, "No forwarded ports.");
		return tunnelCount === 1
			? localize({ bundle: 'ash.workbench', key: 'ports.singleCount' }, '1 forwarded port.')
			: localize({ bundle: 'ash.workbench', key: 'ports.count' }, '{0} forwarded ports.', tunnelCount);
	}

	private isRemoteWorkspace(): boolean {
		return this.remoteAgentService.connection?.kind === "ssh";
	}

	private canForward(): boolean {
		return this.isRemoteWorkspace() && this.remoteAgentService.connectionState === "connected";
	}

	private isCurrentConnection(revision: number): boolean {
		return !this.isDisposed && revision === this.connectionRevision;
	}
}

function compareTunnels(first: RemoteTunnel, second: RemoteTunnel): number {
	return first.tunnelRemotePort - second.tunnelRemotePort || (first.tunnelLocalPort ?? 0) - (second.tunnelLocalPort ?? 0) || first.tunnelRemoteHost.localeCompare(second.tunnelRemoteHost);
}

function remoteConnectionIdentity(connection: RemoteAgentConnection | undefined): string | undefined {
	return connection?.kind === "ssh" ? connection.authority : connection?.kind;
}

function tunnelStateLabel(state: NonNullable<RemoteTunnel["state"]>): string {
	switch (state) {
		case "open": return localize({ bundle: 'ash.workbench', key: 'ports.open' }, "Open");
		case "recovering": return localize({ bundle: 'ash.workbench', key: 'ports.recovering' }, "Recovering");
		case "failed": return localize({ bundle: 'ash.workbench', key: 'ports.failed' }, "Failed");
	}
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function tunnelKey(tunnel: RemoteTunnel): string {
	return `${tunnel.tunnelRemoteHost}:${tunnel.tunnelRemotePort}`;
}

function remoteStateLabel(state: IAppServerRemoteAgentService["connectionState"]): string {
	switch (state) {
		case 'connecting': return localize({ bundle: 'ash.workbench', key: 'ports.connection.connecting' }, 'connecting');
		case 'connected': return localize({ bundle: 'ash.workbench', key: 'ports.connection.connected' }, 'connected');
		case 'disconnecting': return localize({ bundle: 'ash.workbench', key: 'ports.connection.disconnecting' }, 'disconnecting');
		case 'reconnecting': return localize({ bundle: 'ash.workbench', key: 'ports.connection.reconnecting' }, 'reconnecting');
		case 'disconnected': return localize({ bundle: 'ash.workbench', key: 'ports.connection.disconnected' }, 'disconnected');
		default: return localize({ bundle: 'ash.workbench', key: 'ports.connection.starting' }, 'starting');
	}
}
