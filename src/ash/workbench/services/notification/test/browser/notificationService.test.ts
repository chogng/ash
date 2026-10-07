import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { INotificationService, NotificationSeverity, type NotificationAction } from "../../../../../platform/notification/common/notification.js";
import type { IAction, IRunEvent } from "../../../../../base/common/actions.js";
import { CancellationError } from "../../../../../base/common/errors.js";
import { Lxicon } from "../../../../../base/common/lxicons.js";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { addDisposableListener } from "../../../../../base/browser/dom.js";
import { InstantiationService } from "../../../../../platform/instantiation/common/instantiationService.js";
import { IThemeService } from "../../../../../platform/theme/common/themeService.js";
import { TestThemeService } from "../../../../../platform/theme/test/common/testThemeService.js";
import { darkColorTheme } from "../../../../../platform/theme/common/colorTheme.js";
import { IStorageService } from "../../../../../platform/storage/common/storage.js";
import { BrowserStorageService } from "../../../storage/browser/storageService.js";
import { registerTestComponentServices } from "../../../../test/common/testEditorServices.js";
import { StatusbarPart } from "../../../../browser/parts/statusbar/statusbarPart.js";
import { INotificationsCenter, NotificationsCenter } from "../../../../browser/parts/notifications/notificationsCenter.js";
import { NotificationActionRunner } from "../../../../browser/parts/notifications/notificationsCommands.js";
import { CommandService } from "../../../commands/common/commandService.js";
import { StatusbarAlignment, StatusbarService } from "../../../statusbar/browser/statusbar.js";
import { NotificationService } from "../../common/notificationService.js";

test("clearing a toast removes only its shared record from the notification center", async () => {
	const browser = new JSDOM("<!doctype html><body><main></main></body>");
	try {
		using service = new NotificationService();
		using runner = createNotificationActionRunner(service);
		const root = browser.window.document.querySelector<HTMLElement>("main")!;
		using center = new NotificationsCenter(root, root, service, runner);
		const toggle = root.querySelector<HTMLButtonElement>(".ash-notifications-toggle")!;
		assert.equal(toggle.textContent, "Notifications");
		assert.equal(toggle.hidden, true);
		let actionRuns = 0;
		const removed: number[] = [];
		service.onDidRemove(item => removed.push(item.id));
		const handle = service.notify({ severity: NotificationSeverity.Warning, message: "Workspace needs attention", source: "fixture", actions: [{ id: "open", label: "Open", run: () => { actionRuns++; } }] });
		assert.equal(toggle.hidden, false);
		assert.equal(root.querySelectorAll(".ash-notification").length, 1);
		const completed = new Promise<void>(resolve => runner.onDidRun(() => resolve()));
		root.querySelector<HTMLButtonElement>(".ash-notification-action")!.click();
		await completed;
		assert.equal(actionRuns, 1);
		const retained = service.info("Keep this notification");
		root.querySelector<HTMLButtonElement>(".ash-notification-close")!.click();
		handle.close(); handle.close();
		assert.equal(root.querySelectorAll(".ash-notification").length, 1);
		assert.deepEqual(service.getNotifications().map(item => item.id), [retained.item.id]);
		assert.deepEqual(removed, [handle.item.id]);
		center.show();
		assert.equal(root.querySelectorAll(".ash-notifications-row").length, 1);
		assert.equal(root.querySelector(".ash-notifications-row .ash-notification-message")?.textContent, "Keep this notification");
		root.querySelector<HTMLButtonElement>(".ash-notifications-clear")!.click();
		assert.deepEqual(removed, [handle.item.id, retained.item.id]);
		assert.equal(service.getNotifications().length, 0);
		assert.equal(toggle.hidden, true);
		assert.equal(root.querySelector<HTMLElement>(".ash-notifications-center")?.hidden, true);
		center.show();
		assert.equal(root.querySelector(".ash-notifications-empty")?.textContent, "No notifications");
		center.hide();
		assert.equal(root.querySelector<HTMLElement>(".ash-notifications-center")?.hidden, true);
		service.info("Another notification");
		assert.equal(toggle.hidden, false);
		toggle.click();
		assert.equal(root.querySelector<HTMLElement>(".ash-notifications-center")?.hidden, false);
	} finally { browser.window.close(); }
});

test("clearing focused toasts moves to adjacent actions and returns to the previous control", () => {
	const browser = new JSDOM("<!doctype html><body><button id='origin'>Origin</button></body>");
	try {
		using service = new NotificationService();
		using runner = createNotificationActionRunner(service);
		const document = browser.window.document;
		using center = new NotificationsCenter(document.body, document.body, service, runner);
		const handles = [service.info("First"), service.info("Second"), service.info("Third")];
		const close = (index: number) => document.querySelector<HTMLButtonElement>(`[data-notification-close="${handles[index].item.id}"]`)!;
		const origin = document.querySelector<HTMLButtonElement>("#origin")!;
		origin.focus();
		close(1).focus();
		close(1).click();
		assert.equal(document.activeElement, close(2));
		close(2).click();
		assert.equal(document.activeElement, close(0));
		close(0).click();
		assert.equal(document.activeElement, origin);
		assert.deepEqual(service.getNotifications(), []);
	} finally { browser.window.close(); }
});

test("toasts cap at three while history retains every notification", () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	try {
		using service = new NotificationService();
		using runner = createNotificationActionRunner(service);
		using center = new NotificationsCenter(browser.window.document.body, browser.window.document.body, service, runner);
		for (let index = 0; index < 4; index++) service.info(`Message ${index}`);
		assert.equal(browser.window.document.querySelectorAll(".ash-notification").length, 3);
		assert.equal(service.getNotifications().length, 4);
		center.show();
		assert.equal(browser.window.document.querySelectorAll(".ash-notifications-row").length, 4);
		center.hide();
		assert.equal(browser.window.document.querySelectorAll(".ash-notification").length, 0);
		assert.equal(service.getNotifications().length, 4);
	} finally { browser.window.close(); }
});

test("notification handle removes its record once", () => {
	using service = new NotificationService();
	let removals = 0;
	service.onDidRemove(() => removals++);
	const handle = service.info("Saved");
	handle.close(); handle.close();
	assert.equal(removals, 1);
	assert.equal(service.getNotifications().length, 0);
});

test("status bell reflects retained notification history", () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	try {
		using service = new NotificationService();
		using runner = createNotificationActionRunner(service);
		using statusbar = new StatusbarService();
		using center = new NotificationsCenter(browser.window.document.body, browser.window.document.body, service, runner, statusbar);
		const bell = () => statusbar.getEntries(StatusbarAlignment.Right).find(item => item.id === "ash.status.notifications")?.entry.icon;
		assert.equal(bell(), Lxicon.bell);
		const handle = service.info("Saved");
		assert.equal(bell(), Lxicon.bellDot);
		handle.close();
		assert.equal(bell(), Lxicon.bell);
	} finally { browser.window.close(); }
});

test("removing center rows keeps remaining records open and restores focus after the last keyboard removal", () => {
	using fixture = new NotificationsFixture();
	const { document, service, center, panel, origin } = fixture;
	const first = service.info("First");
	const second = service.info("Second");
	origin.focus();
	center.show();
	const row = (id: number) => panel.querySelector<HTMLElement>(`[data-notification-id="${id}"]`)!;
	row(second.item.id).focus();
	row(second.item.id).dispatchEvent(new document.defaultView!.KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
	assert.equal(panel.hidden, false);
	assert.deepEqual(service.getNotifications().map(item => item.id), [first.item.id]);
	assert.equal(document.activeElement, row(first.item.id));
	row(first.item.id).dispatchEvent(new document.defaultView!.KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
	assert.equal(panel.hidden, true);
	assert.equal(document.activeElement, origin);
	assert.deepEqual(service.getNotifications(), []);
	first.close(); second.close(); center.hide();
	assert.equal(document.activeElement, origin);
});

for (const focusOutside of [false, true]) {
	test(`programmatic final removal ${focusOutside ? "preserves outside focus" : "restores center focus"}`, () => {
		using fixture = new NotificationsFixture();
		const { document, service, center, panel, origin, outside } = fixture;
		const handle = service.info("Task completed");
		origin.focus();
		center.show();
		panel.querySelector<HTMLButtonElement>("[data-notification-remove]")!.focus();
		if (focusOutside) outside.focus();
		handle.close();
		assert.equal(panel.hidden, true);
		assert.equal(document.activeElement, focusOutside ? outside : origin);
		outside.focus();
		handle.close(); center.hide();
		assert.equal(document.activeElement, outside);
	});
}

for (const useCommand of [false, true]) {
	test(`Clear All ${useCommand ? "command" : "toolbar"} closes the center and removes each existing record once`, async () => {
		using fixture = new NotificationsFixture();
		const { document, service, center, panel, origin } = fixture;
		using services = new InstantiationService();
		services.registerInstance(INotificationsCenter, center);
		using commands = new CommandService(services);
		const handles = [service.info("First"), service.info("Second")];
		const removed: number[] = [];
		using listener = service.onDidRemove(item => removed.push(item.id));
		origin.focus();
		center.show();
		const clear = panel.querySelector<HTMLButtonElement>(".ash-notifications-clear")!;
		clear.focus();
		if (useCommand) await commands.executeCommand("notifications.clearAll"); else clear.click();
		assert.equal(panel.hidden, true);
		assert.equal(document.activeElement, origin);
		assert.deepEqual(removed, handles.map(handle => handle.item.id));
		assert.deepEqual(service.getNotifications(), []);
		if (useCommand) await commands.executeCommand("notifications.clearAll"); else clear.click();
		assert.deepEqual(removed, handles.map(handle => handle.item.id));
		assert.equal(document.activeElement, origin);
	});
}

test("an explicitly opened empty center stays open when a new notification arrives", () => {
	using fixture = new NotificationsFixture();
	const { document, service, center, panel, origin } = fixture;
	origin.focus();
	center.show(); center.show();
	assert.equal(panel.hidden, false);
	assert.equal(panel.querySelector(".ash-notifications-empty")?.textContent, "No notifications");
	assert.equal(panel.querySelector<HTMLButtonElement>(".ash-notifications-clear")?.disabled, true);
	const handle = service.info("Arrived while open");
	assert.equal(panel.hidden, false);
	assert.equal(panel.querySelector("[data-notification-id]")?.getAttribute("data-notification-id"), String(handle.item.id));
	assert.equal(document.querySelectorAll(".ash-notification").length, 0);
	assert.equal(document.activeElement, panel);
	center.hide();
	assert.equal(document.activeElement, origin);
	assert.deepEqual(service.getNotifications().map(item => item.id), [handle.item.id]);
});

for (const addOnFocus of [false, true]) {
	test(`Clear All keeps notifications added during ${addOnFocus ? "focus restoration" : "removal callbacks"} and a reopened center`, () => {
		using fixture = new NotificationsFixture();
		const { document, service, center, panel, origin } = fixture;
		const handles = [service.info("First"), service.info("Second")];
		origin.focus();
		center.show();
		let added = false;
		const addNotification = () => {
			if (added) return;
			added = true;
			service.info("Arrived during clear");
			center.show();
		};
		using listener = addOnFocus ? addDisposableListener(origin, "focus", addNotification) : service.onDidRemove(addNotification);
		center.clearAll();
		assert.deepEqual(service.getNotifications().map(item => item.message), ["Arrived during clear"]);
		assert.equal(panel.hidden, false);
		assert.equal(document.activeElement, panel);
		assert.equal(panel.querySelectorAll("[data-notification-id]").length, 1);
		for (const handle of handles) handle.close();
		assert.equal(panel.hidden, false);
		center.hide();
		assert.equal(document.activeElement, origin);
	});
}

test("a removed focus origin does not prevent final center removal", () => {
	using fixture = new NotificationsFixture();
	const { document, service, center, panel, origin } = fixture;
	const handle = service.info("Finished");
	origin.focus();
	center.show();
	origin.remove();
	assert.doesNotThrow(() => handle.close());
	assert.equal(panel.hidden, true);
	assert.notEqual(document.activeElement, origin);
});

test("a removed toast focus origin does not prevent clearing the last toast in its own document", () => {
	using fixture = new NotificationsFixture();
	const { document, service, origin } = fixture;
	service.info("Finished");
	origin.focus();
	const remove = document.querySelector<HTMLButtonElement>("[data-notification-close]")!;
	remove.focus();
	origin.remove();
	assert.doesNotThrow(() => remove.click());
	assert.deepEqual(service.getNotifications(), []);
	assert.notEqual(document.activeElement, origin);
});

test("hiding can restore focus into a callback that reopens an empty center", async () => {
	using fixture = new NotificationsFixture();
	const { document, center, panel, origin } = fixture;
	origin.focus();
	center.show();
	using listener = addDisposableListener(origin, "focus", () => center.show());
	center.hide();
	await Promise.resolve();
	assert.equal(panel.hidden, false);
	assert.equal(document.activeElement, panel);
	assert.equal(panel.querySelector(".ash-notifications-empty")?.textContent, "No notifications");
});

for (const clearAll of [false, true]) {
	test(`${clearAll ? "Clear All" : "final removal"} retains restored focus through the real status bell render`, () => {
		using statusbar = new StatusbarService();
		using fixture = new NotificationsFixture(statusbar);
		const { document, service, center, panel } = fixture;
		using services = new InstantiationService();
		services.registerSingleton(IThemeService, () => new TestThemeService(darkColorTheme));
		services.registerSingleton(IStorageService, () => new BrowserStorageService({ ownerWindow: document.defaultView!, workspaceId: "notifications-test", backend: document.defaultView!.localStorage, flushInterval: 0 }));
		registerTestComponentServices(services, document);
		using part = services.createInstance(StatusbarPart, document.body, statusbar);
		document.body.append(part.domNode);
		const origin = part.domNode.querySelector<HTMLElement>('[data-statusbar-item-id="ash.status.notifications"] .ash-statusbar-item-label')!;
		const handle = service.info("Finished");
		if (clearAll) service.info("Also finished");
		origin.focus();
		center.show();
		if (clearAll) center.clearAll(); else handle.close();
		assert.equal(panel.hidden, true);
		assert.deepEqual(service.getNotifications(), []);
		assert.equal(part.domNode.querySelector('[data-statusbar-item-id="ash.status.notifications"] .ash-statusbar-item-label'), origin);
		assert.equal(document.activeElement, origin);
	});
}

test("disposing the center leaves records owned by the service and ignores late entries and events", async () => {
	using fixture = new NotificationsFixture();
	const { document, service, center, panel, origin, outside } = fixture;
	using services = new InstantiationService();
	services.registerInstance(INotificationsCenter, center);
	using commands = new CommandService(services);
	const handle = service.info("Owned by the service");
	origin.focus();
	center.show();
	const clear = panel.querySelector<HTMLButtonElement>(".ash-notifications-clear")!;
	const remove = panel.querySelector<HTMLButtonElement>("[data-notification-remove]")!;
	outside.focus();
	center.dispose(); center.dispose();
	clear.click(); remove.click();
	center.show(); center.hide(); center.toggle(); center.clearAll();
	await commands.executeCommand("notifications.clearAll");
	const late = service.info("Arrived after disposal");
	handle.close();
	assert.equal(panel.isConnected, false);
	assert.equal(document.querySelectorAll(".ash-notifications-center, .ash-notification-host, .ash-notifications-toggle").length, 0);
	assert.equal(document.activeElement, outside);
	assert.deepEqual(service.getNotifications().map(item => item.id), [late.item.id]);
});

class NotificationsFixture extends Disposable {
	readonly document: Document;
	readonly service: NotificationService;
	readonly runner: NotificationActionRunner;
	readonly center: NotificationsCenter;
	readonly panel: HTMLElement;
	readonly origin: HTMLButtonElement;
	readonly outside: HTMLButtonElement;

	constructor(statusbar?: StatusbarService) {
		super();
		const browser = new JSDOM("<!doctype html><body><button id='origin'>Origin</button><button id='outside'>Outside</button></body>", { url: "https://ash.test" });
		this._register(toDisposable(() => browser.window.close()));
		this.document = browser.window.document;
		this.origin = this.document.querySelector<HTMLButtonElement>("#origin")!;
		this.outside = this.document.querySelector<HTMLButtonElement>("#outside")!;
		this.service = this._register(new NotificationService());
		this.runner = this._register(createNotificationActionRunner(this.service));
		this.center = this._register(new NotificationsCenter(this.document.body, this.document.body, this.service, this.runner, statusbar));
		this.panel = this.document.querySelector<HTMLElement>(".ash-notifications-center")!;
	}
}

function createNotificationActionRunner(service: NotificationService): NotificationActionRunner {
	using services = new InstantiationService();
	services.registerInstance(INotificationService, service);
	return services.createInstance(NotificationActionRunner);
}

test("notification actions require the window notification service", () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(NotificationActionRunner), /Unknown service: notificationService/u);
});

for (const asynchronous of [false, true]) {
	for (const failure of [new Error("Action failed"), "Thrown value", undefined]) {
		test(`notification runner reports ${String(failure)} once before completion for ${asynchronous ? "async" : "sync"} actions`, async () => {
			using service = new NotificationService();
			using runner = createNotificationActionRunner(service);
			const context = { value: 9 };
			const order: string[] = [];
			const events: IRunEvent[] = [];
			const action: IAction = {
				id: "failed", label: "Failed", tooltip: "", enabled: true, run(receivedContext) {
					assert.equal(this, action);
					assert.equal(receivedContext, context);
					order.push("run");
					if (asynchronous) return Promise.reject(failure);
					throw failure;
				}
			};
			runner.onWillRun(event => { events.push(event); order.push("will"); });
			service.onDidAdd(() => order.push("error"));
			runner.onDidRun(event => { events.push(event); order.push("did"); });
			await runner.run(action, context);
			assert.deepEqual({ order, events, notifications: service.getNotifications().map(item => ({ severity: item.severity, message: item.message })) }, {
				order: ["will", "run", "error", "did"], events: [{ action, context }, { action, context, error: undefined }],
				notifications: [{ severity: NotificationSeverity.Error, message: failure instanceof Error ? failure.message : failure ?? "Error" }],
			});
		});
	}
	for (const handled of [false, true]) {
		test(`notification runner suppresses ${handled ? "already handled failures" : "cancellation"} from ${asynchronous ? "async" : "sync"} actions`, async () => {
			using service = new NotificationService();
			using runner = createNotificationActionRunner(service);
			let completed = 0;
			runner.onDidRun(event => { assert.equal(event.error, undefined); completed++; });
			const action: IAction = {
				id: "handled", label: "Handled", tooltip: "", enabled: true, run() {
					if (handled) {
						service.error("Producer recovered");
						return asynchronous ? Promise.resolve() : undefined;
					}
					const cancellation = new CancellationError();
					if (asynchronous) return Promise.reject(cancellation);
					throw cancellation;
				}
			};
			await runner.run(action);
			assert.deepEqual({ completed, messages: service.getNotifications().map(item => item.message) }, { completed: 1, messages: handled ? ["Producer recovered"] : [] });
		});
	}
}

test("a disposed notification runner skips new actions", async () => {
	using service = new NotificationService();
	using runner = createNotificationActionRunner(service);
	let calls = 0;
	let events = 0;
	runner.onWillRun(() => events++);
	runner.onDidRun(() => events++);
	runner.dispose();
	await runner.run({ id: "late", label: "Late", tooltip: "", enabled: true, run() { calls++; throw new Error("Late failure"); } });
	assert.deepEqual({ calls, events, notifications: service.getNotifications() }, { calls: 0, events: 0, notifications: [] });
});

test("window disposal suppresses late notification feedback while the producer owns its pending task", async () => {
	using service = new NotificationService();
	using runner = createNotificationActionRunner(service);
	let reject!: (error: Error) => void;
	const completion = new Promise<void>((_resolve, rejectCompletion) => { reject = rejectCompletion; });
	let entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	let completed = 0;
	runner.onDidRun(() => completed++);
	const pending = runner.run({ id: "pending", label: "Pending", tooltip: "", enabled: true, run() { entered(); return completion; } });
	await started;
	runner.dispose();
	reject(new Error("Finished after disposal"));
	await pending;
	assert.deepEqual({ completed, notifications: service.getNotifications() }, { completed: 0, notifications: [] });
});

for (const useCenter of [false, true]) {
	for (const asynchronous of [false, true]) {
		test(`${useCenter ? "center" : "toast"} actions preserve the callback receiver and report ${asynchronous ? "async" : "sync"} failures through the shared model`, async () => {
			using statusbar = new StatusbarService();
			using fixture = new NotificationsFixture(statusbar);
			const { document, service, runner, center } = fixture;
			let calls = 0;
			const action: NotificationAction = {
				id: "failed", label: "Try action", run(...args: unknown[]) {
					assert.equal(this, action);
					assert.deepEqual(args, []);
					calls++;
					const failure = new Error("Visible action failure");
					if (asynchronous) return Promise.reject(failure);
					throw failure;
				}
			};
			const original = service.info("Original notification", [action]);
			if (useCenter) center.show();
			const completed = new Promise<void>(resolve => runner.onDidRun(() => resolve()));
			document.querySelector<HTMLButtonElement>(`${useCenter ? ".ash-notifications-center" : ".ash-notification-host"} .ash-notification-action`)!.click();
			assert.equal(calls, 0);
			await completed;
			assert.deepEqual({ calls, items: service.getNotifications().map(item => ({ severity: item.severity, message: item.message })) }, {
				calls: 1, items: [{ severity: NotificationSeverity.Info, message: "Original notification" }, { severity: NotificationSeverity.Error, message: "Visible action failure" }],
			});
			assert.equal(service.getNotifications()[0], original.item);
			assert.equal(statusbar.getEntries(StatusbarAlignment.Right).find(item => item.id === "ash.status.notifications")?.entry.icon, Lxicon.bellDot);
			if (!useCenter) assert.equal(document.querySelector('[role="alert"] .ash-notification-message')?.textContent, "Visible action failure");
			center.show();
			assert.deepEqual([...fixture.panel.querySelectorAll(".ash-notification-message")].map(element => element.textContent), ["Visible action failure", "Original notification"]);
		});
	}
	test(`${useCenter ? "center" : "toast"} pending action still reports a failure after the producer closes its original record`, async () => {
		using fixture = new NotificationsFixture();
		let reject!: (error: Error) => void;
		const completion = new Promise<void>((_resolve, rejectCompletion) => { reject = rejectCompletion; });
		let entered!: () => void;
		const started = new Promise<void>(resolve => { entered = resolve; });
		const original = fixture.service.info("Pending task", [{ id: "pending", label: "Start", run() { entered(); return completion; } }]);
		if (useCenter) fixture.center.show();
		const completed = new Promise<void>(resolve => fixture.runner.onDidRun(() => resolve()));
		fixture.document.querySelector<HTMLButtonElement>(`${useCenter ? ".ash-notifications-center" : ".ash-notification-host"} .ash-notification-action`)!.click();
		await started;
		original.close();
		reject(new Error("Failure after original removal"));
		await completed;
		assert.deepEqual(fixture.service.getNotifications().map(item => ({ severity: item.severity, message: item.message })), [
			{ severity: NotificationSeverity.Error, message: "Failure after original removal" },
		]);
		assert.equal(fixture.document.querySelector('[role="alert"] .ash-notification-message')?.textContent, "Failure after original removal");
	});
	test(`${useCenter ? "center" : "toast"} successful actions let the producer close its notification without error feedback`, async () => {
		using fixture = new NotificationsFixture();
		let calls = 0;
		const handle = fixture.service.info("Complete task", [{ id: "complete", label: "Complete", async run() { calls++; handle.close(); } }]);
		if (useCenter) fixture.center.show();
		const completed = new Promise<void>(resolve => fixture.runner.onDidRun(() => resolve()));
		fixture.document.querySelector<HTMLButtonElement>(`${useCenter ? ".ash-notifications-center" : ".ash-notification-host"} .ash-notification-action`)!.click();
		await completed;
		assert.deepEqual({ calls, notifications: fixture.service.getNotifications() }, { calls: 1, notifications: [] });
	});
}
