import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { NotificationSeverity } from "../../../../../platform/notification/common/notification.js";
import { Lxicon } from "../../../../../base/common/lxicons.js";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { addDisposableListener } from "../../../../../base/browser/dom.js";
import { InstantiationService } from "../../../../../platform/instantiation/common/instantiationService.js";
import { INotificationsCenter, NotificationsCenter } from "../../../../browser/parts/notifications/notificationsCenter.js";
import "../../../../browser/parts/notifications/notificationsCommands.js";
import { CommandService } from "../../../commands/common/commandService.js";
import { StatusbarAlignment, StatusbarService } from "../../../statusbar/browser/statusbar.js";
import { NotificationService } from "../../common/notificationService.js";

test("clearing a toast removes only its shared record from the notification center", async () => {
	const browser = new JSDOM("<!doctype html><body><main></main></body>");
	try {
		using service = new NotificationService();
		const root = browser.window.document.querySelector<HTMLElement>("main")!;
		using center = new NotificationsCenter(root, root, service);
		const toggle = root.querySelector<HTMLButtonElement>(".ash-notifications-toggle")!;
		assert.equal(toggle.textContent, "Notifications");
		assert.equal(toggle.hidden, true);
		let actionRuns = 0;
		const removed: number[] = [];
		service.onDidRemove(item => removed.push(item.id));
		const handle = service.notify({ severity: NotificationSeverity.Warning, message: "Workspace needs attention", source: "fixture", actions: [{ id: "open", label: "Open", run: () => { actionRuns++; } }] });
		assert.equal(toggle.hidden, false);
		assert.equal(root.querySelectorAll(".ash-notification").length, 1);
		root.querySelector<HTMLButtonElement>(".ash-notification-action")!.click();
		await Promise.resolve();
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
		const document = browser.window.document;
		using center = new NotificationsCenter(document.body, document.body, service);
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
		using center = new NotificationsCenter(browser.window.document.body, browser.window.document.body, service);
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
		using statusbar = new StatusbarService();
		using center = new NotificationsCenter(browser.window.document.body, browser.window.document.body, service, statusbar);
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
	readonly center: NotificationsCenter;
	readonly panel: HTMLElement;
	readonly origin: HTMLButtonElement;
	readonly outside: HTMLButtonElement;

	constructor() {
		super();
		const browser = new JSDOM("<!doctype html><body><button id='origin'>Origin</button><button id='outside'>Outside</button></body>");
		this._register(toDisposable(() => browser.window.close()));
		this.document = browser.window.document;
		this.origin = this.document.querySelector<HTMLButtonElement>("#origin")!;
		this.outside = this.document.querySelector<HTMLButtonElement>("#outside")!;
		this.service = this._register(new NotificationService());
		this.center = this._register(new NotificationsCenter(this.document.body, this.document.body, this.service));
		this.panel = this.document.querySelector<HTMLElement>(".ash-notifications-center")!;
	}
}
