import { AbstractDisposable, type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";

export interface IpcMainInvokeEventLike {
	readonly sender: {
		readonly mainFrame: unknown;
	};
	readonly senderFrame: {
		readonly url: string;
	} | null;
}

export interface IpcMainLike {
	handle(channel: string, listener: (event: IpcMainInvokeEventLike, params: unknown) => unknown): void;
	removeHandler(channel: string): void;
}

export interface IpcRoute<P, R> {
	readonly channel: string;
	readonly validate: (value: unknown) => P;
	readonly invoke: (params: P) => R | Promise<R>;
}

export interface TrustedIpcTarget {
	readonly webContents: {
		readonly mainFrame: unknown;
	};
	readonly allowedEntryUrls: ReadonlySet<string>;
}

interface RegisteredRoute {
	readonly target: TrustedIpcTarget;
	readonly route: IpcRoute<unknown, unknown>;
}

/**
 * Owns trusted IPC routes shared by multiple Electron renderer windows.
 *
 * A channel has exactly one Electron handler. The handler then selects the
 * registration belonging to its sender before validation and invocation, so
 * each window can expose the same capability through a window-local service.
 */
export class TrustedIpcRouter extends AbstractDisposable {
	private readonly routesByChannel = new Map<string, Set<RegisteredRoute>>();

	constructor(private readonly ipcMain: IpcMainLike) {
		super();
	}

	/** Registers routes for one renderer target and returns its scoped cleanup. */
	register(target: TrustedIpcTarget, routes: readonly IpcRoute<unknown, unknown>[]): IDisposable {
		this.assertNotDisposed();
		const channels = new Set<string>();
		for (const route of routes) {
			if (channels.has(route.channel)) {
				throw new Error(`Duplicate IPC route: ${route.channel}`);
			}
			channels.add(route.channel);
		}

		const registered: RegisteredRoute[] = [];
		try {
			for (const route of routes) {
				let registrations = this.routesByChannel.get(route.channel);
				if (!registrations) {
					registrations = new Set();
					this.routesByChannel.set(route.channel, registrations);
					try {
						this.ipcMain.handle(route.channel, (event, rawParams) =>
							this.invoke(route.channel, event, rawParams)
						);
					} catch (error) {
						this.routesByChannel.delete(route.channel);
						throw error;
					}
				}
				const registration = { target, route };
				registrations.add(registration);
				registered.push(registration);
			}
		} catch (error) {
			this.remove(registered);
			throw error;
		}

		return toDisposable(() => this.remove(registered));
	}

	protected override disposeCore(): void {
		for (const channel of this.routesByChannel.keys()) {
			this.ipcMain.removeHandler(channel);
		}
		this.routesByChannel.clear();
	}

	private invoke(channel: string, event: IpcMainInvokeEventLike, rawParams: unknown): unknown {
		const registrations = this.routesByChannel.get(channel);
		if (!registrations) {
			throw new Error(`IPC route is not registered: ${channel}`);
		}
		const registration = [...registrations].find(({ target }) =>
			target.webContents === event.sender
		);
		if (!registration) {
			throw new Error("Untrusted renderer IPC sender");
		}
		requireTrustedSender(event, registration.target);
		return registration.route.invoke(registration.route.validate(rawParams));
	}

	private remove(registrations: readonly RegisteredRoute[]): void {
		for (const registration of registrations) {
			const routes = this.routesByChannel.get(registration.route.channel);
			if (!routes) continue;
			routes.delete(registration);
			if (routes.size === 0) {
				this.routesByChannel.delete(registration.route.channel);
				this.ipcMain.removeHandler(registration.route.channel);
			}
		}
	}
}

/** Registers finite IPC routes with one shared sender, main-frame, URL, and params gate. */
export function registerTrustedIpcRoutes(ipcMain: IpcMainLike, target: TrustedIpcTarget, routes: readonly IpcRoute<unknown, unknown>[]): IDisposable {
	const router = new TrustedIpcRouter(ipcMain);
	const registration = router.register(target, routes);
	return toDisposable(() => {
		registration.dispose();
		router.dispose();
	});
}

export function requireTrustedSender(event: IpcMainInvokeEventLike, target: TrustedIpcTarget): void {
	if (event.sender !== target.webContents) {
		throw new Error("Untrusted renderer IPC sender");
	}
	if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
		throw new Error("Renderer IPC must originate from the main frame");
	}
	if (!target.allowedEntryUrls.has(normalizeEntryUrl(event.senderFrame.url))) {
		throw new Error("Renderer IPC URL is not allowed");
	}
}

export function normalizeEntryUrl(value: string): string {
	return new URL(value).href;
}
