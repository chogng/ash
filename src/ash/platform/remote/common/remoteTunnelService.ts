import type { DisposableHandle } from "../../ipc/common/ipc.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export const REMOTE_TUNNEL_OPEN_CHANNEL = "ash:remote:tunnel:open";
export const REMOTE_TUNNEL_RETAIN_CHANNEL = "ash:remote:tunnel:retain";
export const REMOTE_TUNNEL_RELEASE_CHANNEL = "ash:remote:tunnel:release";
export const REMOTE_TUNNEL_LIST_CHANNEL = "ash:remote:tunnel:list";
export const REMOTE_TUNNEL_CLOSE_CHANNEL = "ash:remote:tunnel:close";
export const REMOTE_TUNNEL_CLOSE_ALL_CHANNEL = "ash:remote:tunnel:closeAll";
export const REMOTE_TUNNEL_CHANGED_CHANNEL = "ash:remote:tunnel:changed";

/** A request for one loopback-only forward to a service on the SSH host. */
export interface RemoteTunnelOpenRequest {
	readonly remotePort: number;
}

/** Public identity of a host-owned SSH tunnel. */
export interface RemoteTunnel {
	readonly id: string;
	readonly localPort: number;
	readonly remoteHost: "127.0.0.1";
	readonly remotePort: number;
	readonly state: "open" | "recovering" | "failed";
}

/** State change emitted when a tunnel opens, recovers, fails, or is removed. */
export type RemoteTunnelChange =
	| { readonly kind: "upsert"; readonly tunnel: RemoteTunnel; }
	| { readonly kind: "removed"; readonly id: string; };

/** Transport-neutral contract for host-owned Remote tunnel lifecycle. */
export interface IRemoteTunnelService {
	list(): Promise<readonly RemoteTunnel[]>;
	/** Acquires one reference, sharing both established and pending forwards for the endpoint. */
	open(request: RemoteTunnelOpenRequest): Promise<RemoteTunnel>;
	/** Acquires an existing identity without creating a replacement after Stop. */
	retain(id: string): Promise<RemoteTunnel | undefined>;
	/** Closes the forward only when its final acquired reference is released. */
	release(id: string): Promise<void>;
	/** Explicit Stop closes the endpoint regardless of outstanding references. */
	close(id: string): Promise<void>;
	/** Also cancels startup requests that have not published an endpoint yet. */
	closeAll(): Promise<void>;
	onDidChange(listener: (change: RemoteTunnelChange) => void): DisposableHandle;
}

export const IRemoteTunnelService = createServiceIdentifier<IRemoteTunnelService>("remoteTunnelService");

/** Empty tunnel boundary installed by hosts that cannot own an SSH process. */
export const UnavailableRemoteTunnelService: IRemoteTunnelService = Object.freeze({
	list: () => Promise.resolve([]),
	open: () => Promise.reject(new Error("Remote tunnels require a native product host")),
	retain: () => Promise.resolve(undefined),
	release: () => Promise.resolve(),
	close: () => Promise.resolve(),
	closeAll: () => Promise.resolve(),
	onDidChange: () => ({ dispose() { } }),
});
