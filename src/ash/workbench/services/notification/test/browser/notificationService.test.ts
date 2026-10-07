import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { NotificationSeverity } from "../../../../../platform/notification/common/notification.js";
import { Lxicon } from "../../../../../base/common/lxicons.js";
import { NotificationsCenter } from "../../../../browser/parts/notifications/notificationsCenter.js";
import { StatusbarAlignment, StatusbarService } from "../../../statusbar/browser/statusbar.js";
import { NotificationService } from "../../common/notificationService.js";

test("notifications share history across toast and center", async () => {
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
		root.querySelector<HTMLButtonElement>(".ash-notification-close")!.click();
		assert.equal(root.querySelectorAll(".ash-notification").length, 0);
		assert.deepEqual(service.getNotifications().map(item => item.id), [handle.item.id]);
		center.show();
		assert.equal(root.querySelectorAll(".ash-notifications-row").length, 1);
		assert.equal(root.querySelector(".ash-notifications-row .ash-notification-message")?.textContent, "Workspace needs attention");
		root.querySelector<HTMLButtonElement>(".ash-notifications-clear")!.click();
		assert.deepEqual(removed, [handle.item.id]);
		assert.equal(service.getNotifications().length, 0);
		assert.equal(toggle.hidden, true);
		assert.equal(root.querySelector(".ash-notifications-empty")?.textContent, "No notifications");
		center.hide();
		assert.equal(root.querySelector<HTMLElement>(".ash-notifications-center")?.hidden, true);
		service.info("Another notification");
		assert.equal(toggle.hidden, false);
		toggle.click();
		assert.equal(root.querySelector<HTMLElement>(".ash-notifications-center")?.hidden, false);
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
