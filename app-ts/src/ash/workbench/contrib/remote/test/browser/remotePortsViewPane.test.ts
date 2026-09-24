import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Emitter } from "../../../../../base/common/event.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import type { RemoteConnectionState } from "../../../../../platform/remote/common/remote.js";
import type { RemoteAgentConnection } from "../../../../../platform/remote/common/remoteAgentApi.js";
import type { IRemoteTunnelService } from "../../../../../platform/remote/common/remoteTunnelService.js";
import type { RemoteTunnel } from "../../../../../platform/remote/common/remoteTunnelService.js";
import type { RemoteTunnelChange } from "../../../../../platform/remote/common/remoteTunnelService.js";
import type { IRemoteAgentService } from "../../../../services/remote/common/remoteAgentService.js";

test("Remote Ports renders Main-owned tunnel state changes", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	using tunnels = new TestRemoteTunnelService([tunnel("one", 4100, 3000, "open")]);
	using remoteAgent = new TestRemoteAgentService({ kind: "ssh", generation: 1, authority: "ssh+work-server", host: "work-server" }, "connected");
	try {
		const { RemotePortsViewPane } = await import("../../browser/remotePortsViewPane.js");
		using pane = new RemotePortsViewPane(browser.window.document.body, { id: "ash.ports.test", title: "Ports" }, tunnels, remoteAgent);
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
	using tunnels = new TestRemoteTunnelService();
	using remoteAgent = new TestRemoteAgentService({ kind: "ssh", generation: 1, authority: "ssh+work-server", host: "work-server" }, "connected");
	try {
		const { RemotePortsViewPane } = await import("../../browser/remotePortsViewPane.js");
		using pane = new RemotePortsViewPane(browser.window.document.body, { id: "ash.ports.actions.test", title: "Ports" }, tunnels, remoteAgent);
		browser.window.document.body.append(pane.element);
		const input = pane.element.querySelector<HTMLInputElement>(".ash-remote-ports-input")!;
		input.value = "3000";
		input.form!.dispatchEvent(new browser.window.Event("submit", { bubbles: true, cancelable: true }));
		await waitFor(() => pane.element.querySelectorAll(".ash-remote-port").length === 1);

		assert.deepEqual(tunnels.openedPorts, [3000]);
		assert.equal(input.value, "");
		pane.element.querySelector<HTMLButtonElement>(".ash-remote-port-stop")!.click();
		await waitFor(() => pane.element.querySelectorAll(".ash-remote-port").length === 0);
		assert.deepEqual(tunnels.closedIds, ["tunnel-3000"]);

		tunnels.upsert(tunnel("one", 4100, 3001, "open"));
		tunnels.upsert(tunnel("two", 4200, 3002, "open"));
		pane.element.querySelector<HTMLButtonElement>(".ash-remote-ports-stop-all")!.click();
		await waitFor(() => pane.element.querySelectorAll(".ash-remote-port").length === 0);
		assert.equal(tunnels.closeAllCount, 1);
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

test("Remote Ports enables forwarding only for a connected SSH workspace", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	using tunnels = new TestRemoteTunnelService();
	using remoteAgent = new TestRemoteAgentService({ kind: "local", generation: 1 }, "connected");
	try {
		const { RemotePortsViewPane } = await import("../../browser/remotePortsViewPane.js");
		using pane = new RemotePortsViewPane(browser.window.document.body, { id: "ash.ports.connection.test", title: "Ports" }, tunnels, remoteAgent);
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
	using tunnels = new TestRemoteTunnelService([], initialList);
	using remoteAgent = new TestRemoteAgentService({ kind: "ssh", generation: 1, authority: "ssh+work-server", host: "work-server" }, "connected");
	try {
		const { RemotePortsViewPane } = await import("../../browser/remotePortsViewPane.js");
		using pane = new RemotePortsViewPane(browser.window.document.body, { id: "ash.ports.race.test", title: "Ports" }, tunnels, remoteAgent);
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

class TestRemoteTunnelService extends Disposable implements IRemoteTunnelService {
	private readonly changeEmitter = this._register(new Emitter<RemoteTunnelChange>());
	private readonly tunnels = new Map<string, RemoteTunnel>();
	private initialList: Promise<readonly RemoteTunnel[]> | undefined;
	readonly openedPorts: number[] = [];
	readonly closedIds: string[] = [];
	closeAllCount = 0;
	listCount = 0;
	readonly onDidChange = this.changeEmitter.event;

	constructor(initial: readonly RemoteTunnel[] = [], initialList?: Promise<readonly RemoteTunnel[]>) {
		super();
		for (const entry of initial) this.tunnels.set(entry.id, entry);
		this.initialList = initialList;
	}

	list(): Promise<readonly RemoteTunnel[]> {
		this.listCount += 1;
		const initialList = this.initialList;
		this.initialList = undefined;
		return initialList ?? Promise.resolve(Object.freeze([...this.tunnels.values()]));
	}

	async open(request: { readonly remotePort: number }): Promise<RemoteTunnel> {
		this.openedPorts.push(request.remotePort);
		const opened = tunnel(`tunnel-${request.remotePort}`, request.remotePort + 10_000, request.remotePort, "open");
		this.upsert(opened);
		return opened;
	}

	async close(id: string): Promise<void> {
		this.closedIds.push(id);
		this.remove(id);
	}

	async closeAll(): Promise<void> {
		this.closeAllCount += 1;
		for (const id of [...this.tunnels.keys()]) this.remove(id);
	}

	upsert(entry: RemoteTunnel): void {
		this.tunnels.set(entry.id, entry);
		this.changeEmitter.fire({ kind: "upsert", tunnel: entry });
	}

	remove(id: string): void {
		this.tunnels.delete(id);
		this.changeEmitter.fire({ kind: "removed", id });
	}
}

class TestRemoteAgentService extends Disposable implements IRemoteAgentService {
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

function tunnel(id: string, localPort: number, remotePort: number, state: RemoteTunnel["state"]): RemoteTunnel {
	return Object.freeze({ id, localPort, remoteHost: "127.0.0.1", remotePort, state });
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
