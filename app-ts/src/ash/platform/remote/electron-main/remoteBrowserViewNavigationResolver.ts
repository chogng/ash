import { throwIfCancelled } from "../../../base/common/cancellation.js";
import type { BrowserViewNavigation } from "../../browser/common/browserViewNavigation.js";
import { directBrowserViewNavigation } from "../../browser/common/browserViewNavigation.js";
import type { IBrowserViewNavigationResolver } from "../../browser/common/browserViewNavigation.js";
import { normalizeBrowserViewUrl } from "../../browser/common/browserView.js";
import type { IAnyWorkspaceIdentifier } from "../../workspace/common/workspace.js";
import { isRemoteWorkspaceIdentifier } from "../../workspace/common/workspace.js";
import type { IRemoteTunnelService } from "../common/remoteTunnelService.js";
import type { RemoteTunnel } from "../common/remoteTunnelService.js";

export interface RemoteBrowserViewNavigationResolverOptions {
	readonly getWorkspace: () => IAnyWorkspaceIdentifier;
	readonly tunnels: IRemoteTunnelService;
	readonly reportError?: (message: string, error: unknown) => void;
}

/** Maps loopback Browser navigation onto a window-owned SSH tunnel in Remote workspaces. */
export class RemoteBrowserViewNavigationResolver implements IBrowserViewNavigationResolver {
	constructor(private readonly options: RemoteBrowserViewNavigationResolverOptions) {}

	async resolve(value: string, signal: AbortSignal): Promise<BrowserViewNavigation> {
		const requestedUrl = normalizeBrowserViewUrl(value);
		const parsed = new URL(requestedUrl);
		const workspace = this.options.getWorkspace();
		if (!isRemoteWorkspaceIdentifier(workspace) || !isLoopbackWebUrl(parsed)) {
			return directBrowserViewNavigation(requestedUrl);
		}
		throwIfCancelled(signal, "Remote Browser navigation was cancelled");
		const workspaceIdentity = `${workspace.id}\0${workspace.uri.toString()}`;
		const remotePort = parsed.port ? Number(parsed.port) : defaultPort(parsed.protocol);
		const tunnel = await this.options.tunnels.open({ remotePort });
		if (signal.aborted) {
			await this.closeAfterAbandonedResolution(tunnel.id);
			throwIfCancelled(signal, "Remote Browser navigation was cancelled");
		}
		if (!matchesRemoteWorkspace(this.options.getWorkspace, workspaceIdentity)) {
			await this.closeAfterAbandonedResolution(tunnel.id);
			throw new Error("Remote workspace changed while opening the Browser tunnel");
		}
		if (tunnel.remotePort !== remotePort || tunnel.state !== "open") {
			await this.closeAfterAbandonedResolution(tunnel.id);
			throw new Error("Remote Browser tunnel did not open for the requested port");
		}
		try {
			return new RemoteBrowserViewNavigation({
				requestedUrl,
				workspaceIdentity,
				getWorkspace: this.options.getWorkspace,
				tunnel,
				tunnels: this.options.tunnels,
				reportError: this.options.reportError,
			});
		} catch (error) {
			await this.closeAfterAbandonedResolution(tunnel.id);
			throw error;
		}
	}

	private async closeAfterAbandonedResolution(tunnelId: string): Promise<void> {
		try {
			await this.options.tunnels.close(tunnelId);
		} catch (error) {
			this.options.reportError?.("Failed to close an abandoned Remote Browser tunnel", error);
		}
	}
}

interface RemoteBrowserViewNavigationOptions {
	readonly requestedUrl: string;
	readonly workspaceIdentity: string;
	readonly getWorkspace: () => IAnyWorkspaceIdentifier;
	readonly tunnel: RemoteTunnel;
	readonly tunnels: IRemoteTunnelService;
	readonly reportError?: (message: string, error: unknown) => void;
}

class RemoteBrowserViewNavigation implements BrowserViewNavigation {
	readonly requestedUrl: string;
	readonly loadUrl: string;
	private readonly requestedOrigin: string;
	private readonly loadedOrigin: string;
	private readonly loadedHostname: string;
	private readonly tunnelChangeSubscription: { dispose(): void };
	private reusable = true;
	private released = false;

	constructor(private readonly options: RemoteBrowserViewNavigationOptions) {
		this.requestedUrl = options.requestedUrl;
		const requested = new URL(options.requestedUrl);
		this.requestedOrigin = requested.origin;
		this.loadedHostname = requested.hostname === "localhost" ? "localhost" : "127.0.0.1";
		this.loadUrl = replaceAuthority(requested, this.loadedHostname, options.tunnel.localPort);
		this.loadedOrigin = new URL(this.loadUrl).origin;
		this.tunnelChangeSubscription = options.tunnels.onDidChange(change => {
			if (change.kind === "removed" && change.id === options.tunnel.id) this.reusable = false;
			if (change.kind === "upsert" && change.tunnel.id === options.tunnel.id && change.tunnel.state === "failed") this.reusable = false;
		});
	}

	ownsRequestedUrl(value: string): boolean {
		return new URL(normalizeBrowserViewUrl(value)).origin === this.requestedOrigin;
	}

	ownsLoadedUrl(value: string): boolean {
		return new URL(normalizeBrowserViewUrl(value)).origin === this.loadedOrigin;
	}

	loadUrlFor(value: string): string {
		const requested = new URL(normalizeBrowserViewUrl(value));
		if (requested.origin !== this.requestedOrigin) throw new Error("Remote Browser navigation does not own the requested URL");
		return replaceAuthority(requested, this.loadedHostname, this.options.tunnel.localPort);
	}

	requestedUrlFor(value: string): string {
		const loaded = new URL(normalizeBrowserViewUrl(value));
		if (loaded.origin !== this.loadedOrigin) throw new Error("Remote Browser navigation does not own the loaded URL");
		const requested = new URL(this.requestedUrl);
		return replaceAuthority(loaded, requested.hostname, requested.port ? Number(requested.port) : defaultPort(requested.protocol));
	}

	isReusable(): boolean {
		if (!matchesRemoteWorkspace(this.options.getWorkspace, this.options.workspaceIdentity)) this.reusable = false;
		return !this.released && this.reusable;
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		this.reusable = false;
		this.tunnelChangeSubscription.dispose();
		void this.options.tunnels.close(this.options.tunnel.id).catch(error => {
			this.options.reportError?.("Failed to close a Remote Browser tunnel", error);
		});
	}
}

function isLoopbackWebUrl(url: URL): boolean {
	return (url.protocol === "http:" || url.protocol === "https:") && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

function defaultPort(protocol: string): number {
	if (protocol === "http:") return 80;
	if (protocol === "https:") return 443;
	throw new Error(`Unsupported Browser tunnel protocol: ${protocol}`);
}

function replaceAuthority(value: URL, hostname: string, port: number): string {
	const mapped = new URL(value.href);
	mapped.hostname = hostname;
	mapped.port = String(port);
	return mapped.href;
}

function matchesRemoteWorkspace(getWorkspace: () => IAnyWorkspaceIdentifier, expectedIdentity: string): boolean {
	try {
		const workspace = getWorkspace();
		return isRemoteWorkspaceIdentifier(workspace) && `${workspace.id}\0${workspace.uri.toString()}` === expectedIdentity;
	} catch {
		return false;
	}
}
