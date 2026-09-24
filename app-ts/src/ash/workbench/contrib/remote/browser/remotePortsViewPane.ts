import { toDisposable } from "../../../../base/common/lifecycle.js";
import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { ActionBar } from "../../../../base/browser/ui/actionbar/actionbar.js";
import type { IAction } from "../../../../base/common/actions.js";
import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import type { RemoteAgentConnection } from "../../../../platform/remote/common/remoteAgentApi.js";
import type { IRemoteTunnelService } from "../../../../platform/remote/common/remoteTunnelService.js";
import type { RemoteTunnel } from "../../../../platform/remote/common/remoteTunnelService.js";
import type { RemoteTunnelChange } from "../../../../platform/remote/common/remoteTunnelService.js";
import { ViewPane, type IViewPaneOptions, type PartTitleProjection } from "../../../browser/parts/views/viewPane.js";
import type { IRemoteAgentService } from "../../../services/remote/common/remoteAgentService.js";
import "./media/remotePorts.css";

/** Renderer projection of the Electron Main-owned SSH tunnel catalog. */
export class RemotePortsViewPane extends ViewPane {
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

	constructor(container: HTMLElement, options: IViewPaneOptions, private readonly tunnelService: IRemoteTunnelService, private readonly remoteAgentService: IRemoteAgentService) {
		super(container, options);
		this.activeConnectionIdentity = remoteConnectionIdentity(remoteAgentService.connection);
		this.contentElement.classList.add("ash-remote-ports");
		this.formElement = h(container.ownerDocument, "form");
		this.formElement.className = "ash-remote-ports-form";
		const label = h(container.ownerDocument, "label");
		label.className = "ash-remote-ports-label";
		label.htmlFor = `${options.id}-remote-port`;
		label.textContent = "Remote port";
		this.portInput = h(container.ownerDocument, "input");
		this.portInput.id = label.htmlFor;
		this.portInput.className = "ash-remote-ports-input";
		this.portInput.type = "number";
		this.portInput.min = "1";
		this.portInput.max = "65535";
		this.portInput.step = "1";
		this.portInput.placeholder = "3000";
		this.portInput.required = true;
		this.titleActions = this._register(new ActionBar(this.headerActionsElement, { ariaLabel: "Ports actions" }));
		this.titleActions.element.classList.add("ash-toolbar");
		this.forwardButton = h(container.ownerDocument, "button");
		this.forwardButton.className = "ash-remote-ports-forward";
		this.forwardButton.type = "submit";
		this.forwardButton.textContent = "Forward Port";
		this.stopAllButton = h(container.ownerDocument, "button");
		this.stopAllButton.className = "ash-remote-ports-stop-all";
		this.stopAllButton.type = "button";
		this.stopAllButton.textContent = "Stop All";
		this.formElement.append(label, this.portInput, this.forwardButton, this.stopAllButton);
		this.statusElement = h(container.ownerDocument, "div");
		this.statusElement.className = "ash-remote-ports-status";
		this.statusElement.setAttribute("role", "status");
		this.listElement = h(container.ownerDocument, "ul");
		this.listElement.className = "ash-remote-ports-list";
		this.listElement.setAttribute("aria-label", "Forwarded ports");
		this.contentElement.append(this.formElement, this.statusElement, this.listElement);

		this._register(addDisposableListener(this.formElement, "submit", event => this.forward(event)));
		this._register(addDisposableListener(this.stopAllButton, "click", () => this.stopAll()));
		this._register(addDisposableListener(this.listElement, "click", event => this.activate(event)));
		const tunnelSubscription = tunnelService.onDidChange(change => this.acceptTunnelChange(change));
		this._register(toDisposable(() => tunnelSubscription.dispose()));
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
			this.error = "Remote port must be an integer from 1 to 65535.";
			this.render();
			return;
		}
		const connectionRevision = this.connectionRevision;
		this.opening = true;
		this.error = undefined;
		this.render();
		void this.tunnelService.open({ remotePort }).then(tunnel => {
			if (!this.isCurrentConnection(connectionRevision)) return;
			this.tunnels.set(tunnel.id, tunnel);
			this.portInput.value = "";
		}, error => {
			if (this.isCurrentConnection(connectionRevision)) this.error = errorMessage(error, "Could not forward the remote port.");
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
		const connectionRevision = this.connectionRevision;
		this.closing.add(id);
		this.error = undefined;
		this.render();
		void this.tunnelService.close(id).then(() => {
			if (this.isCurrentConnection(connectionRevision)) this.tunnels.delete(id);
		}, error => {
			if (this.isCurrentConnection(connectionRevision)) this.error = errorMessage(error, "Could not stop the forwarded port.");
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
		void this.tunnelService.closeAll().then(() => {
			if (this.isCurrentConnection(connectionRevision)) this.tunnels.clear();
		}, error => {
			if (this.isCurrentConnection(connectionRevision)) this.error = errorMessage(error, "Could not stop all forwarded ports.");
		}).finally(() => {
			if (!this.isCurrentConnection(connectionRevision)) return;
			this.closingAll = false;
			this.closing.clear();
			this.render();
		});
	}

	private acceptTunnelChange(change: RemoteTunnelChange): void {
		if (this.isDisposed) return;
		this.tunnelRevision += 1;
		if (change.kind === "upsert") this.tunnels.set(change.tunnel.id, change.tunnel);
		else {
			this.tunnels.delete(change.id);
			this.closing.delete(change.id);
		}
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
		void this.tunnelService.list().then(tunnels => {
			if (!this.isCurrentConnection(connectionRevision) || readRevision !== this.readRevision) return;
			if (tunnelRevision !== this.tunnelRevision) {
				this.refresh();
				return;
			}
			this.tunnels.clear();
			for (const tunnel of tunnels) this.tunnels.set(tunnel.id, tunnel);
			this.error = undefined;
			this.render();
		}, error => {
			if (!this.isCurrentConnection(connectionRevision) || readRevision !== this.readRevision) return;
			this.error = errorMessage(error, "Could not read forwarded ports.");
			this.render();
		});
	}

	private render(): void {
		const remote = this.isRemoteWorkspace();
		const canForward = this.canForward();
		const forwardPortAction: IAction = {
			id: "ash.ports.focusForwardPort",
			label: "Forward a Port",
			tooltip: "Forward a Port",
			icon: lxiconsLibrary.add,
			enabled: canForward && !this.opening,
			checked: undefined,
			run: () => this.portInput.focus(),
		};
		const refreshPortsAction: IAction = {
			id: "ash.ports.refresh",
			label: "Refresh Ports",
			tooltip: "Refresh Ports",
			icon: lxiconsLibrary.refresh,
			enabled: remote,
			checked: undefined,
			run: () => this.refresh(),
		};
		this.titleActions.updateActions([forwardPortAction, refreshPortsAction]);
		this.portInput.disabled = !canForward || this.opening;
		this.forwardButton.disabled = !canForward || this.opening;
		this.forwardButton.textContent = this.opening ? "Forwarding…" : "Forward Port";
		this.stopAllButton.disabled = !remote || this.tunnels.size === 0 || this.closingAll;
		this.stopAllButton.textContent = this.closingAll ? "Stopping…" : "Stop All";
		const tunnels = remote ? [...this.tunnels.values()].sort(compareTunnels) : [];
		this.listElement.replaceChildren(...tunnels.map(tunnel => this.renderTunnel(tunnel)));
		this.statusElement.classList.toggle("error", this.error !== undefined && remote);
		this.statusElement.textContent = this.statusText(remote, tunnels.length);
	}

	private renderTunnel(tunnel: RemoteTunnel): HTMLLIElement {
		const item = h(this.element.ownerDocument, "li");
		item.className = `ash-remote-port ${tunnel.state}`;
		item.dataset.tunnelId = tunnel.id;
		const endpoints = h(this.element.ownerDocument, "div");
		endpoints.className = "ash-remote-port-endpoints";
		const local = h(this.element.ownerDocument, "code");
		local.className = "ash-remote-port-local";
		local.textContent = `127.0.0.1:${tunnel.localPort}`;
		const arrow = h(this.element.ownerDocument, "span");
		arrow.className = "ash-remote-port-arrow";
		arrow.setAttribute("aria-hidden", "true");
		arrow.textContent = "→";
		const remote = h(this.element.ownerDocument, "code");
		remote.className = "ash-remote-port-remote";
		remote.textContent = `${tunnel.remoteHost}:${tunnel.remotePort}`;
		endpoints.append(local, arrow, remote);
		const state = h(this.element.ownerDocument, "span");
		state.className = "ash-remote-port-state";
		state.textContent = tunnelStateLabel(tunnel.state);
		const stop = h(this.element.ownerDocument, "button");
		stop.className = "ash-remote-port-stop";
		stop.type = "button";
		stop.dataset.tunnelId = tunnel.id;
		stop.disabled = this.closingAll || this.closing.has(tunnel.id);
		stop.textContent = this.closing.has(tunnel.id) ? "Stopping…" : "Stop";
		stop.setAttribute("aria-label", `Stop forwarding remote port ${tunnel.remotePort}`);
		item.append(endpoints, state, stop);
		return item;
	}

	private statusText(remote: boolean, tunnelCount: number): string {
		if (!remote) return "Forwarded ports are available in an SSH Remote Workspace.";
		if (this.error) return this.error;
		if (this.remoteAgentService.connectionState !== "connected") return tunnelCount === 0 ? "Waiting for the Remote connection." : `${tunnelCount} forwarded ${tunnelCount === 1 ? "port" : "ports"}; the Remote connection is ${this.remoteAgentService.connectionState ?? "starting"}.`;
		if (tunnelCount === 0) return "No forwarded ports.";
		return `${tunnelCount} forwarded ${tunnelCount === 1 ? "port" : "ports"}.`;
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
	return first.remotePort - second.remotePort || first.localPort - second.localPort || first.id.localeCompare(second.id);
}

function remoteConnectionIdentity(connection: RemoteAgentConnection | undefined): string | undefined {
	return connection?.kind === "ssh" ? connection.authority : connection?.kind;
}

function tunnelStateLabel(state: RemoteTunnel["state"]): string {
	switch (state) {
		case "open": return "Open";
		case "recovering": return "Recovering";
		case "failed": return "Failed";
	}
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message.trim() ? error.message : fallback;
}
