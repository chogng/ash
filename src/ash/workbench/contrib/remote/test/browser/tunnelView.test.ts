import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Emitter, Event } from "../../../../../base/common/event.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import type { RemoteConnectionState } from "../../../../../platform/remote/common/remote.js";
import type { RemoteAgentConnection } from "../../../../../platform/remote/common/remoteAgentApi.js";
import { TunnelPrivacyId, type ITunnelService, type RemoteTunnel } from "../../../../../platform/tunnel/common/tunnel.js";
import type { IAddressProvider } from "../../../../../platform/remote/common/remoteAgentConnection.js";
import type { IAppServerRemoteAgentService } from "../../../../services/remote/common/appServerRemoteAgentService.js";

test("Remote Ports renders tunnel service state changes", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	using tunnels = new TestTunnelService([tunnel("one", 4100, 3000, "open")]);
	const tunnelService = tunnels;
	using remoteAgent = new TestRemoteAgentService({ kind: "ssh", generation: 1, authority: "ssh+work-server", host: "work-server" }, "connected");
	try {
		const { TunnelPanel } = await import("../../browser/tunnelView.js");
		using pane = new TunnelPanel(browser.window.document.body, { id: "ash.ports.test", title: "Ports" }, tunnelService, remoteAgent);
		browser.window.document.body.append(pane.element);
		const titleActions = pane.partTitleProjection?.actions;
		assert.ok(titleActions);
		browser.window.document.body.append(titleActions);
		await waitFor(() => pane.element.querySelectorAll(".ash-remote-port").length === 1);

		const forwardPortAction = titleActions.querySelector<HTMLButtonElement>("[data-action-id='ash.ports.focusForwardPort'] button");
		const refreshPortsAction = titleActions.querySelector<HTMLButtonElement>("[data-action-id='ash.ports.refresh'] button");
		assert.ok(forwardPortAction);
		assert.ok(refreshPortsAction);
		assert.ok(forwardPortAction.querySelector("svg.ash-icon"));
		assert.ok(refreshPortsAction.querySelector("svg.ash-icon"));
		forwardPortAction.click();
		assert.equal(browser.window.document.activeElement, pane.element.querySelector(".ash-remote-ports-input"));

		assert.equal(pane.element.querySelector(".ash-remote-port-local")?.textContent, "127.0.0.1:4100");
		assert.equal(pane.element.querySelector(".ash-remote-port-remote")?.textContent, "127.0.0.1:3000");
		assert.equal(pane.element.querySelector(".ash-remote-port-state")?.textContent, "Open");

		tunnels.upsert(tunnel("one", 4100, 3000, "recovering"));
		assert.equal(pane.element.querySelector(".ash-remote-port")?.classList.contains("recovering"), true);
		assert.equal(pane.element.querySelector(".ash-remote-port-state")?.textContent, "Recovering");
		tunnels.upsert(tunnel("one", 4100, 3000, "failed"));
		assert.equal(pane.element.querySelector(".ash-remote-port-state")?.textContent, "Failed");
		tunnels.remove("one");
		assert.equal(pane.element.querySelectorAll(".ash-remote-port").length, 0);
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

test("Remote Ports forwards and stops ports through the tunnel service", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	using tunnels = new TestTunnelService();
	const tunnelService = tunnels;
	using remoteAgent = new TestRemoteAgentService({ kind: "ssh", generation: 1, authority: "ssh+work-server", host: "work-server" }, "connected");
	try {
		const { TunnelPanel } = await import("../../browser/tunnelView.js");
		using pane = new TunnelPanel(browser.window.document.body, { id: "ash.ports.actions.test", title: "Ports" }, tunnelService, remoteAgent);
		browser.window.document.body.append(pane.element);
		const input = pane.element.querySelector<HTMLInputElement>(".ash-remote-ports-input")!;
		input.value = "3000";
		input.form!.dispatchEvent(new browser.window.Event("submit", { bubbles: true, cancelable: true }));
		await waitFor(() => pane.element.querySelectorAll(".ash-remote-port").length === 1 && input.value === "");

		assert.deepEqual(tunnels.openedPorts, [3000]);
		assert.equal(input.value, "");
		pane.element.querySelector<HTMLButtonElement>(".ash-remote-port-stop")!.click();
		await waitFor(() => pane.element.querySelectorAll(".ash-remote-port").length === 0);
		assert.deepEqual(tunnels.closedIds, ["tunnel-3000"]);

		tunnels.upsert(tunnel("one", 4100, 3001, "open"));
		tunnels.upsert(tunnel("two", 4200, 3002, "open"));
		pane.element.querySelector<HTMLButtonElement>(".ash-remote-ports-stop-all")!.click();
		await waitFor(() => pane.element.querySelectorAll(".ash-remote-port").length === 0);
		assert.deepEqual(tunnels.closedIds, ["tunnel-3000", "one", "two"]);
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

test("Remote Ports enables forwarding only for a connected SSH workspace", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	using tunnels = new TestTunnelService();
	const tunnelService = tunnels;
	using remoteAgent = new TestRemoteAgentService({ kind: "local", generation: 1 }, "connected");
	try {
		const { TunnelPanel } = await import("../../browser/tunnelView.js");
		using pane = new TunnelPanel(browser.window.document.body, { id: "ash.ports.connection.test", title: "Ports" }, tunnelService, remoteAgent);
		browser.window.document.body.append(pane.element);
		assert.equal(pane.element.querySelector<HTMLInputElement>(".ash-remote-ports-input")?.disabled, true);
		assert.match(pane.element.querySelector(".ash-remote-ports-status")?.textContent ?? "", /SSH Remote Workspace/);

		remoteAgent.emitConnection({ kind: "ssh", generation: 2, authority: "ssh+work-server", host: "work-server" });
		remoteAgent.emitState("reconnecting");
		assert.equal(pane.element.querySelector<HTMLInputElement>(".ash-remote-ports-input")?.disabled, true);
		remoteAgent.emitState("connected");
		assert.equal(pane.element.querySelector<HTMLInputElement>(".ash-remote-ports-input")?.disabled, false);
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

test("Remote Ports does not let an initial list overwrite a newer tunnel event", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	let resolveInitialList!: (tunnels: readonly RemoteTunnel[]) => void;
	const initialList = new Promise<readonly RemoteTunnel[]>(resolve => { resolveInitialList = resolve; });
	using tunnels = new TestTunnelService([], initialList);
	const tunnelService = tunnels;
	using remoteAgent = new TestRemoteAgentService({ kind: "ssh", generation: 1, authority: "ssh+work-server", host: "work-server" }, "connected");
	try {
		const { TunnelPanel } = await import("../../browser/tunnelView.js");
		using pane = new TunnelPanel(browser.window.document.body, { id: "ash.ports.race.test", title: "Ports" }, tunnelService, remoteAgent);
		browser.window.document.body.append(pane.element);
		tunnels.upsert(tunnel("new", 4300, 3003, "open"));
		resolveInitialList([]);
		await waitFor(() => pane.element.querySelectorAll(".ash-remote-port").length === 1 && tunnels.listCount >= 2);

		assert.equal(pane.element.querySelector(".ash-remote-port-remote")?.textContent, "127.0.0.1:3003");
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

test("Remote Ports releases an open result from a retired connection generation", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	using tunnels = new TestTunnelService();
	const tunnelService = tunnels;
	using remoteAgent = new TestRemoteAgentService({ kind: "ssh", generation: 1, authority: "ssh+work-server", host: "work-server" }, "connected");
	let finish!: () => void;
	tunnels.pendingOpen = new Promise(resolve => { finish = resolve; });
	try {
		const { TunnelPanel } = await import("../../browser/tunnelView.js");
		using pane = new TunnelPanel(browser.window.document.body, { id: "ash.ports.retired.test", title: "Ports" }, tunnelService, remoteAgent);
		browser.window.document.body.append(pane.element);
		const input = pane.element.querySelector<HTMLInputElement>(".ash-remote-ports-input")!;
		input.value = "3000";
		input.form!.dispatchEvent(new browser.window.Event("submit", { bubbles: true, cancelable: true }));
		await waitFor(() => tunnels.openedPorts.length === 1);
		remoteAgent.emitConnection({ kind: "ssh", generation: 2, authority: "ssh+work-server", host: "work-server" });
		finish();
		await waitFor(() => tunnels.closedIds.length === 1 && pane.element.querySelectorAll(".ash-remote-port").length === 0);
		assert.deepEqual(tunnels.closedIds, ["tunnel-3000"]);
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

interface TestTunnel extends RemoteTunnel {
	readonly id: string;
}

class TestTunnelService extends Disposable implements ITunnelService {
	declare public readonly _serviceBrand: undefined;
	private readonly opened = this._register(new Emitter<RemoteTunnel>());
	private readonly closed = this._register(new Emitter<{ host: string; port: number; }>());
	private readonly entries = new Map<string, TestTunnel>();
	private initialList: Promise<readonly RemoteTunnel[]> | undefined;
	public readonly openedPorts: number[] = [];
	public readonly closedIds: string[] = [];
	public listCount = 0;
	public pendingOpen: Promise<void> | undefined;
	public readonly onDidChange = Event.None;
	public readonly onTunnelOpened = this.opened.event;
	public readonly onTunnelClosed = this.closed.event;

	constructor(initial: readonly TestTunnel[] = [], initialList?: Promise<readonly RemoteTunnel[]>) {
		super();
		for (const entry of initial) {
			this.entries.set(entry.id, entry);
		}
		this.initialList = initialList;
	}

	public get tunnels(): Promise<readonly RemoteTunnel[]> {
		this.listCount += 1;
		const initialList = this.initialList;
		this.initialList = undefined;
		return initialList ?? Promise.resolve([...this.entries.values()]);
	}

	public async openTunnel(_addressProvider: IAddressProvider | undefined, _remoteHost: string | undefined, remotePort: number): Promise<RemoteTunnel> {
		this.openedPorts.push(remotePort);
		await this.pendingOpen;
		const opened = tunnel(`tunnel-${remotePort}`, remotePort + 10_000, remotePort, 'open');
		const handle = { ...opened, dispose: async () => { this.closedIds.push(opened.id); this.remove(opened.id); } };
		this.upsert(handle);
		return handle;
	}

	public async getExistingTunnel(host: string, port: number): Promise<RemoteTunnel | undefined> { return [...this.entries.values()].find(t => t.tunnelRemoteHost === host && t.tunnelRemotePort === port); }
	public async closeAll(): Promise<void> { await Promise.all([...this.entries.values()].map(t => this.closeTunnel(t.tunnelRemoteHost, t.tunnelRemotePort))); }
	public async closeTunnel(remoteHost: string, remotePort: number): Promise<void> {
		const entry = [...this.entries.values()].find(entry => entry.tunnelRemoteHost === remoteHost && entry.tunnelRemotePort === remotePort);
		if (entry) {
			this.closedIds.push(entry.id);
			this.remove(entry.id);
		}
	}

	public upsert(entry: TestTunnel): void {
		this.entries.set(entry.id, entry);
		this.opened.fire(entry);
	}

	public remove(id: string): void {
		const entry = this.entries.get(id);
		this.entries.delete(id);
		if (entry) {
			this.closed.fire({ host: entry.tunnelRemoteHost, port: entry.tunnelRemotePort });
		}
	}
}

class TestRemoteAgentService extends Disposable implements IAppServerRemoteAgentService {
	private readonly stateEmitter = this._register(new Emitter<RemoteConnectionState>());
	private readonly connectionEmitter = this._register(new Emitter<RemoteAgentConnection>());
	readonly onDidChangeConnectionState = this.stateEmitter.event;
	readonly onDidChangeConnection = this.connectionEmitter.event;

	constructor(public connection: RemoteAgentConnection | undefined, public connectionState: RemoteConnectionState | undefined) { super(); }

	async reconnect() { return { kind: "reconnected" } as const; }
	async rollbackRuntime() { return { kind: "rolledBack" } as const; }

	emitConnection(connection: RemoteAgentConnection): void {
		this.connection = connection;
		this.connectionEmitter.fire(connection);
	}

	emitState(state: RemoteConnectionState): void {
		this.connectionState = state;
		this.stateEmitter.fire(state);
	}
}

function tunnel(id: string, localPort: number, remotePort: number, state: RemoteTunnel['state']): TestTunnel {
	return Object.freeze({ id, tunnelLocalPort: localPort, tunnelRemoteHost: '127.0.0.1', tunnelRemotePort: remotePort, localAddress: `127.0.0.1:${localPort}`, privacy: TunnelPrivacyId.ConstantPrivate, state, dispose: async () => { } });
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for Remote Ports view");
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

function installDomGlobals(browser: JSDOM): readonly string[] {
	const globals = {
		window: browser.window,
		document: browser.window.document,
		Node: browser.window.Node,
		Element: browser.window.Element,
		HTMLElement: browser.window.HTMLElement,
		Event: browser.window.Event,
		MouseEvent: browser.window.MouseEvent,
		navigator: browser.window.navigator,
	};
	for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
	return Object.keys(globals);
}
