import { strict as assert } from "node:assert";
import { test } from "mocha";
import { registerTrustedIpcRoutes, TrustedIpcRouter, type IpcMainInvokeEventLike, type IpcMainLike, type IpcRoute } from "../../../../platform/ipc/electron-main/trustedIpcRouter.js";

class FakeIpcMain implements IpcMainLike {
	readonly handlers = new Map<
		string,
		(event: IpcMainInvokeEventLike, params: unknown) => unknown
	>();

	handle(
		channel: string,
		listener: (event: IpcMainInvokeEventLike, params: unknown) => unknown,
	): void {
		this.handlers.set(channel, listener);
	}

	removeHandler(channel: string): void {
		this.handlers.delete(channel);
	}
}

function target(url = "file:///app-rs/workbench.html") {
	const mainFrame = { url };
	const webContents = { mainFrame };
	return {
		mainFrame,
		webContents,
		event: { sender: webContents, senderFrame: mainFrame },
	};
}

test("trusted IPC router enforces webContents, main frame, exact URL, and params", async () => {
	const ipcMain = new FakeIpcMain();
	const trusted = target();
	let calls = 0;
	const routes: readonly IpcRoute<unknown, unknown>[] = [
		{
			channel: "test:invoke",
			validate(value) {
				if (value !== "valid") throw new Error("invalid params");
				return value;
			},
			invoke() {
				calls += 1;
				return "ok";
			},
		},
	];
	const dispose = registerTrustedIpcRoutes(
		ipcMain,
		{
			webContents: trusted.webContents,
			allowedEntryUrls: new Set(["file:///app-rs/workbench.html"]),
		},
		routes,
	);
	const invoke = ipcMain.handlers.get("test:invoke")!;

	assert.equal(await invoke(trusted.event, "valid"), "ok");
	assert.throws(
		() =>
			invoke(
				{ sender: { mainFrame: trusted.mainFrame }, senderFrame: trusted.mainFrame },
				"valid",
			),
		/Untrusted renderer/,
	);
	assert.throws(
		() =>
			invoke(
				{
					sender: trusted.webContents,
					senderFrame: { url: "file:///app-rs/workbench.html" },
				},
				"valid",
			),
		/main frame/,
	);
	trusted.mainFrame.url = "file:///app-rs/other.html";
	assert.throws(() => invoke(trusted.event, "valid"), /URL is not allowed/);
	trusted.mainFrame.url = "file:///app-rs/workbench.html";
	assert.throws(() => invoke(trusted.event, "invalid"), /invalid params/);
	assert.equal(calls, 1);

	dispose.dispose();
	assert.equal(ipcMain.handlers.size, 0);
});

test("trusted IPC router selects a route per trusted renderer window", async () => {
	const ipcMain = new FakeIpcMain();
	const router = new TrustedIpcRouter(ipcMain);
	const workbench = target("file:///app-rs/workbench.html");
	const sessions = target("file:///app-rs/sessions.html");
	const workbenchRegistration = router.register({
		webContents: workbench.webContents,
		allowedEntryUrls: new Set(["file:///app-rs/workbench.html"]),
	}, [{
		channel: "test:shared",
		validate: (value) => value,
		invoke: () => "workbench",
	}]);
	const sessionsRegistration = router.register({
		webContents: sessions.webContents,
		allowedEntryUrls: new Set(["file:///app-rs/sessions.html"]),
	}, [{
		channel: "test:shared",
		validate: (value) => value,
		invoke: () => "sessions",
	}]);
	const invoke = ipcMain.handlers.get("test:shared")!;

	assert.equal(await invoke(workbench.event, undefined), "workbench");
	assert.equal(await invoke(sessions.event, undefined), "sessions");
	assert.throws(
		() => invoke(target().event, undefined),
		/Untrusted renderer/,
	);

	sessionsRegistration.dispose();
	assert.equal(ipcMain.handlers.has("test:shared"), true);
	assert.equal(await invoke(workbench.event, undefined), "workbench");
	workbenchRegistration.dispose();
	assert.equal(ipcMain.handlers.has("test:shared"), false);
	router.dispose();
});

test("trusted IPC router rejects duplicate route registrations", () => {
	const ipcMain = new FakeIpcMain();
	const trusted = target();
	const route: IpcRoute<unknown, unknown> = {
		channel: "duplicate",
		validate: (value) => value,
		invoke: () => undefined,
	};

	assert.throws(
		() =>
			registerTrustedIpcRoutes(
				ipcMain,
				{
					webContents: trusted.webContents,
					allowedEntryUrls: new Set(["file:///app-rs/workbench.html"]),
				},
				[route, route],
			),
		/Duplicate IPC route/,
	);
	assert.equal(ipcMain.handlers.size, 0);
});
