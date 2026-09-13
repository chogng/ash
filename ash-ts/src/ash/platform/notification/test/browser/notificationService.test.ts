import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { BrowserNotificationService } from "../../../../platform/notification/browser/notificationService.js";
import { NotificationSeverity } from "../../../../platform/notification/common/notification.js";

test("browser notification service renders actions and closes notifications", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	let actionRuns = 0;
	try {
		using service = new BrowserNotificationService(browser.window.document.body);
		const removed: number[] = [];
		service.onDidRemove(item => removed.push(item.id));
		const handle = service.notify({
			severity: NotificationSeverity.Warning,
			message: "Workspace needs attention",
			source: "fixture",
			actions: [{ id: "open", label: "Open", run: () => { actionRuns += 1; } }],
		});

		assert.equal(service.getNotifications().length, 1);
		assert.equal(browser.window.document.querySelectorAll(".ash-notification").length, 1);
		assert.equal(browser.window.document.querySelector(".ash-notification-message")?.textContent, "Workspace needs attention");
		(browser.window.document.querySelector<HTMLButtonElement>(".ash-notification-action")!).click();
		await Promise.resolve();
		assert.equal(actionRuns, 1);

		(browser.window.document.querySelector<HTMLButtonElement>(".ash-notification-close")!).click();
		assert.equal(handle.close(), undefined);
		assert.deepEqual(removed, [handle.item.id]);
		assert.equal(service.getNotifications().length, 0);
	} finally {
		browser.window.close();
	}
});
