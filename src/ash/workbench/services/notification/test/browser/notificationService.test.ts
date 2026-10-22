import assert from "node:assert/strict";
import { suite, test } from "mocha";
import { mock } from 'node:test';
import { JSDOM } from "jsdom";
import { IAccessibilityService } from "../../../../../platform/accessibility/common/accessibility.js";
import { AccessibilityService } from "../../../../../platform/accessibility/browser/accessibilityService.js";
import { INotificationService, NotificationPriority, NotificationsFilter, Severity } from "../../../../../platform/notification/common/notification.js";
import { AccessibleViewRegistry } from "../../../../../platform/accessibility/browser/accessibleViewRegistry.js";
import type { IAction, IRunEvent } from "../../../../../base/common/actions.js";
import { CancellationError } from "../../../../../base/common/errors.js";
import { Lxicon } from "../../../../../base/common/lxicons.js";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { addDisposableListener } from "../../../../../base/browser/dom.js";
import { InstantiationService } from "../../../../../platform/instantiation/common/instantiationService.js";
import { IThemeService } from "../../../../../platform/theme/common/themeService.js";
import { TestThemeService } from "../../../../../platform/theme/test/common/testThemeService.js";
import { darkColorTheme } from "../../../../../platform/theme/common/colorTheme.js";
import { IStorageService, StorageScope, StorageTarget } from "../../../../../platform/storage/common/storage.js";
import { BrowserStorageService } from "../../../storage/browser/storageService.js";
import { registerTestComponentServices } from "../../../../test/common/testEditorServices.js";
import { StatusbarPart } from "../../../../browser/parts/statusbar/statusbarPart.js";
import { INotificationsCenter, NotificationsCenter } from "../../../../browser/parts/notifications/notificationsCenter.js";
import { NotificationActionRunner } from "../../../../browser/parts/notifications/notificationsCommands.js";
import { CommandService } from "../../../commands/common/commandService.js";
import { StatusbarAlignment, StatusbarService } from "../../../statusbar/browser/statusbar.js";
import { TestNotificationService } from '../common/testNotificationService.js';
import { NotificationService } from '../../common/notificationService.js';
import { Event, Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IHostService } from '../../../host/browser/host.js';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { BrowserClipboardService } from '../../../../../platform/clipboard/browser/clipboardService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { BrowserContextMenuService } from '../../../../../platform/contextview/browser/contextMenuService.js';
import { IMenuService, MenuId } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { CopyNotificationMessageAction } from '../../../../browser/parts/notifications/notificationsActions.js';
import type { INativeContextMenuApi, INativeContextMenuRequest, INativeContextMenuResult } from '../../../../../base/parts/contextmenu/common/contextmenu.js';
import { ElectronContextMenuService } from '../../../contextmenu/electron-browser/contextMenuService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ILayoutService, BrowserLayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';

test("clearing a toast removes only its shared record from the notification center", async () => {
	const browser = new JSDOM("<!doctype html><body><main></main></body>");
	try {
		using service = new TestNotificationService();
		using runner = createNotificationActionRunner(service);
		const root = browser.window.document.querySelector<HTMLElement>("main")!;
		using presentation = new NotificationsPresentation(root, root, service, runner);
		const center = presentation.center;
		const toggle = root.querySelector<HTMLButtonElement>(".ash-notifications-toggle")!;
		assert.equal(toggle.textContent, "Notifications");
		assert.equal(toggle.hidden, true);
		let actionRuns = 0;
		const removed: number[] = [];
		service.model.onDidRemove(item => removed.push(item.id));
		const handle = service.notify({ severity: Severity.Warning, message: "Workspace needs attention", source: "fixture", actions: { primary: [{ tooltip: '', enabled: true, id: "open", label: "Open", run: () => { actionRuns++; } }] } });
		const handleItem = service.model.getNotifications().at(-1)!;
		assert.equal(toggle.hidden, false);
		assert.equal(root.querySelectorAll(".ash-notification").length, 1);
		const completed = new Promise<void>(resolve => runner.onDidRun(() => resolve()));
		root.querySelector<HTMLButtonElement>(".ash-notification-action")!.click();
		await completed;
		assert.equal(actionRuns, 1);
		const retained = service.notify({ severity: Severity.Info, message: "Keep this notification" });
		const retainedItem = service.model.getNotifications().at(-1)!;
		root.querySelector<HTMLButtonElement>(".ash-notification-close")!.click();
		handle.close(); handle.close();
		assert.equal(root.querySelectorAll(".ash-notification").length, 1);
		assert.deepEqual(service.model.getNotifications().map(item => item.id), [retainedItem.id]);
		assert.deepEqual(removed, [handleItem.id]);
		center.show();
		assert.equal(root.querySelectorAll(".ash-notifications-row").length, 1);
		assert.equal(root.querySelector(".ash-notifications-row .ash-notification-message")?.textContent, "Keep this notification");
		root.querySelector<HTMLButtonElement>(".ash-notifications-clear")!.click();
		assert.deepEqual(removed, [handleItem.id, retainedItem.id]);
		assert.equal(service.model.getNotifications().length, 0);
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
		using service = new TestNotificationService();
		using runner = createNotificationActionRunner(service);
		const document = browser.window.document;
		using presentation = new NotificationsPresentation(document.body, document.body, service, runner);
		const center = presentation.center;
		const handles = [service.notify({ severity: Severity.Info, message: "First" }), service.notify({ severity: Severity.Info, message: "Second" }), service.notify({ severity: Severity.Info, message: "Third" })];
		const handleItems = service.model.getNotifications();
		const close = (index: number) => document.querySelector<HTMLButtonElement>(`[data-notification-close="${handleItems[index].id}"]`)!;
		const origin = document.querySelector<HTMLButtonElement>("#origin")!;
		origin.focus();
		close(1).focus();
		close(1).click();
		assert.equal(document.activeElement, close(2));
		close(2).click();
		assert.equal(document.activeElement, close(0));
		close(0).click();
		assert.equal(document.activeElement, origin);
		assert.deepEqual(service.model.getNotifications(), []);
	} finally { browser.window.close(); }
});

test("toasts cap at three while history retains every notification", () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	try {
		using service = new TestNotificationService();
		using runner = createNotificationActionRunner(service);
		using presentation = new NotificationsPresentation(browser.window.document.body, browser.window.document.body, service, runner);
		const center = presentation.center;
		for (let index = 0; index < 4; index++) service.info(`Message ${index}`);
		assert.equal(browser.window.document.querySelectorAll(".ash-notification").length, 3);
		assert.equal(service.model.getNotifications().length, 4);
		center.show();
		assert.equal(browser.window.document.querySelectorAll(".ash-notifications-row").length, 4);
		center.hide();
		assert.equal(browser.window.document.querySelectorAll(".ash-notification").length, 0);
		assert.equal(service.model.getNotifications().length, 4);
	} finally { browser.window.close(); }
});

for (const control of ["action", "remove"] as const) {
	for (const change of ["add", "remove"] as const) {
		test(`a retained toast ${control} keeps focus when another record changes by ${change}`, () => {
			using fixture = new NotificationsFixture();
			const { document, service } = fixture;
			const retained = service.notify({
				severity: Severity.Info, message: "Retained", actions: {
					primary: [
						{ tooltip: '', enabled: true, id: "first", label: "Same label", run() { } },
						{ tooltip: '', enabled: true, id: "second", label: "Same label", run() { } },
					]
				}
			});
			const retainedItem = service.model.getNotifications().at(-1)!;
			const other = service.notify({ severity: Severity.Info, message: "Other" });
			const otherItem = service.model.getNotifications().at(-1)!;
			toastControl(document, retainedItem.id, control)!.focus();
			if (change === "add") service.info("Added");
			else other.close();
			assert.equal(document.activeElement, toastControl(document, retainedItem.id, control));
			assert.equal(service.model.getNotifications().includes(retainedItem), true);
		});
	}
	for (const retained of [false, true]) {
		test(`the three-toast limit ${retained ? "preserves retained" : "does not restore evicted"} ${control} focus`, () => {
			using fixture = new NotificationsFixture();
			const { document, service } = fixture;
			const handles = ["First", "Second", "Third"].map(message => service.notify({ severity: Severity.Info, message: message, actions: { primary: [{ tooltip: '', enabled: true, id: "action", label: "Action", run() { } }] } }));
			const handleItems = service.model.getNotifications();
			const focused = handles[retained ? 1 : 0];
			const focusedItem = handleItems[retained ? 1 : 0];
			toastControl(document, focusedItem.id, control)!.focus();
			const last = service.notify({ severity: Severity.Info, message: "Fourth" });
			const lastItem = service.model.getNotifications().at(-1)!;
			assert.equal(document.activeElement, retained ? toastControl(document, focusedItem.id, control) : document.body);
			assert.equal(toastControl(document, handleItems[0].id, "remove"), undefined);
			assert.deepEqual([...document.querySelectorAll<HTMLElement>("[data-notification-close]")].map(element => Number(element.dataset.notificationClose)), [handleItems[1].id, handleItems[2].id, lastItem.id]);
			assert.deepEqual(service.model.getNotifications().map(item => item.id), [...handleItems.map(item => item.id), lastItem.id]);
		});
	}
	test(`closing a focused toast ${control} through its handle does not select a different control`, () => {
		using fixture = new NotificationsFixture();
		const { document, service } = fixture;
		const focused = service.notify({ severity: Severity.Info, message: "Removed", actions: { primary: [{ tooltip: '', enabled: true, id: "action", label: "Action", run() { } }] } });
		const focusedItem = service.model.getNotifications().at(-1)!;
		service.info("Other");
		toastControl(document, focusedItem.id, control)!.focus();
		focused.close();
		assert.equal(document.activeElement, document.body);
		assert.equal(toastControl(document, focusedItem.id, control), undefined);
	});
}

test("toast record changes leave outside focus alone and disposal releases focus ownership", () => {
	using fixture = new NotificationsFixture();
	const { document, service, center, outside } = fixture;
	const first = service.notify({ severity: Severity.Info, message: "First" });
	const firstItem = service.model.getNotifications().at(-1)!;
	outside.focus();
	service.info("Second");
	first.close();
	assert.equal(document.activeElement, outside);
	center.dispose();
	service.info("After disposal");
	service.model.clear();
	assert.equal(document.activeElement, outside);
	assert.equal(document.querySelector(".ash-notification-host"), null);
});

test("activating another toast removal preserves the still-focused action", () => {
	using fixture = new NotificationsFixture();
	const { document, service } = fixture;
	const retained = service.notify({ severity: Severity.Info, message: "Retained", actions: { primary: [{ tooltip: '', enabled: true, id: "action", label: "Action", run() { } }] } });
	const retainedItem = service.model.getNotifications().at(-1)!;
	const other = service.notify({ severity: Severity.Info, message: "Removed" });
	const otherItem = service.model.getNotifications().at(-1)!;
	toastControl(document, retainedItem.id, "action")!.focus();
	toastControl(document, otherItem.id, "remove")!.click();
	assert.equal(document.activeElement, toastControl(document, retainedItem.id, "action"));
});

for (const dispose of [false, true]) {
	test(`toast removal does not steal focus after a reentrant ${dispose ? "disposal" : "center open"}`, () => {
		using fixture = new NotificationsFixture();
		const { document, service, center, outside, panel, origin } = fixture;
		const first = service.notify({ severity: Severity.Info, message: "Removed" });
		const firstItem = service.model.getNotifications().at(-1)!;
		service.info("Retained");
		origin.focus();
		toastControl(document, firstItem.id, "remove")!.focus();
		using listener = service.model.onDidRemove(() => {
			if (dispose) { center.dispose(); outside.focus(); }
			else center.show();
		});
		toastControl(document, firstItem.id, "remove")!.click();
		assert.equal(document.activeElement, dispose ? outside : panel);
		assert.equal(document.querySelectorAll(".ash-notification-host .ash-notification").length, 0);
	});
}

test("a center opened during notification arrival keeps focus and hides every toast", () => {
	using fixture = new NotificationsFixture();
	const { document, service, center, panel } = fixture;
	const retained = service.notify({ severity: Severity.Info, message: "Retained", actions: { primary: [{ tooltip: '', enabled: true, id: "action", label: "Action", run() { } }] } });
	const retainedItem = service.model.getNotifications().at(-1)!;
	toastControl(document, retainedItem.id, "action")!.focus();
	using listener = service.model.onDidAdd(() => center.show());
	service.info("Added");
	assert.equal(document.activeElement, panel);
	assert.equal(document.querySelectorAll(".ash-notification-host .ash-notification").length, 0);
});

function toastControl(document: Document, id: number, control: "action" | "remove"): HTMLButtonElement | undefined {
	const remove = document.querySelector<HTMLButtonElement>(`[data-notification-close="${id}"]`) ?? undefined;
	if (control === "remove") return remove;
	const actions = remove?.closest("article")?.querySelectorAll<HTMLButtonElement>(".ash-notification-action");
	return actions?.item(1) ?? actions?.item(0) ?? undefined;
}

for (const control of ["action", "remove"] as const) {
	test(`toast Escape from a focused ${control} hides the presentation, preserves history, and admits new notifications`, () => {
		using fixture = new NotificationsFixture();
		const { document, service, center, panel, origin } = fixture;
		// jsdom has no layout. Real visibility and keyboard input are covered in smoke tests.
		origin.checkVisibility = () => true;
		let actionRuns = 0;
		const first = service.notify({ severity: Severity.Info, message: "First", actions: { primary: [{ tooltip: '', enabled: true, id: "action", label: "Action", run() { actionRuns++; } }] } });
		const firstItem = service.model.getNotifications().at(-1)!;
		const second = service.notify({ severity: Severity.Info, message: "Second" });
		const secondItem = service.model.getNotifications().at(-1)!;
		let removals = 0;
		using listener = service.model.onDidRemove(() => removals++);
		origin.focus();
		const target = toastControl(document, firstItem.id, control)!;
		target.focus();
		const escape = new document.defaultView!.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		target.dispatchEvent(escape);
		assert.deepEqual({
			toasts: document.querySelectorAll(".ash-notification-host .ash-notification").length,
			history: service.model.getNotifications(), removals, actionRuns,
			controlFocused: document.activeElement === origin, consumed: escape.defaultPrevented,
		}, { toasts: 0, history: [firstItem, secondItem], removals: 0, actionRuns: 0, controlFocused: true, consumed: true });
		const next = service.notify({ severity: Severity.Info, message: "Next" });
		const nextItem = service.model.getNotifications().at(-1)!;
		assert.deepEqual([...document.querySelectorAll<HTMLElement>(".ash-notification-host [data-notification-id]")].map(item => Number(item.dataset.notificationId)), [nextItem.id]);
		center.show();
		assert.deepEqual([...panel.querySelectorAll<HTMLElement>("[data-notification-id]")].map(item => Number(item.dataset.notificationId)), [nextItem.id, secondItem.id, firstItem.id]);
		center.hide();
		assert.equal(document.querySelectorAll(".ash-notification-host .ash-notification").length, 0);
	});

	test(`toast Escape from a focused ${control} leaves consumed, modified, and composing input to its owner`, () => {
		using fixture = new NotificationsFixture();
		const { document, service, origin } = fixture;
		const handle = service.notify({ severity: Severity.Info, message: "Retained", actions: { primary: [{ tooltip: '', enabled: true, id: "action", label: "Action", run() { assert.fail("Escape must not run an action"); } }] } });
		const handleItem = service.model.getNotifications().at(-1)!;
		origin.focus();
		const target = toastControl(document, handleItem.id, control)!;
		target.focus();
		for (const options of [{ key: "Enter" }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { consumed: true }]) {
			const escape = new document.defaultView!.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...options });
			if ("consumed" in options) escape.preventDefault();
			target.dispatchEvent(escape);
			assert.equal(document.activeElement, target);
			assert.equal(document.querySelectorAll(".ash-notification-host .ash-notification").length, 1);
			assert.deepEqual(service.model.getNotifications(), [handleItem]);
			assert.equal(escape.defaultPrevented, "consumed" in options);
		}
	});
}

for (const unavailable of ["removed", "hidden", "hidden ancestor", "inert", "disabled", "aria hidden", "no visible layout"] as const) {
	test(`toast Escape keeps history without restoring a source that is ${unavailable}`, () => {
		using fixture = new NotificationsFixture();
		const { document, service, origin } = fixture;
		origin.checkVisibility = () => unavailable !== "no visible layout";
		const handle = service.notify({ severity: Severity.Info, message: "Retained" });
		const handleItem = service.model.getNotifications().at(-1)!;
		origin.focus();
		const target = toastControl(document, handleItem.id, "remove")!;
		target.focus();
		if (unavailable === "removed") origin.remove();
		if (unavailable === "hidden") origin.hidden = true;
		if (unavailable === "inert") origin.setAttribute("inert", "");
		if (unavailable === "disabled") origin.disabled = true;
		if (unavailable === "aria hidden") origin.setAttribute("aria-hidden", "true");
		if (unavailable === "hidden ancestor") {
			const parent = document.createElement("div");
			document.body.append(parent);
			parent.append(origin);
			parent.hidden = true;
		}
		target.dispatchEvent(new document.defaultView!.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		assert.equal(document.querySelectorAll(".ash-notification-host .ash-notification").length, 0);
		assert.equal(document.activeElement, document.body);
		assert.deepEqual(service.model.getNotifications(), [handleItem]);
	});
}

for (const transition of ["outside", "center", "dispose"] as const) {
	test(`toast Escape does not reclaim focus when ${transition} owns the input before it bubbles`, () => {
		using fixture = new NotificationsFixture();
		const { document, service, center, panel, origin, outside } = fixture;
		origin.checkVisibility = () => true;
		const handle = service.notify({ severity: Severity.Info, message: "Retained" });
		const handleItem = service.model.getNotifications().at(-1)!;
		origin.focus();
		const target = toastControl(document, handleItem.id, "remove")!;
		target.focus();
		using listener = addDisposableListener(target, "keydown", () => {
			if (transition === "center") center.show();
			else { if (transition === "dispose") center.dispose(); outside.focus(); }
		});
		const escape = new document.defaultView!.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		target.dispatchEvent(escape);
		assert.equal(document.activeElement, transition === "center" ? panel : outside);
		assert.equal(escape.defaultPrevented, false);
		assert.deepEqual(service.model.getNotifications(), [handleItem]);
	});

	test(`toast Escape does not reclaim focus when ${transition} takes ownership during DOM removal`, () => {
		using fixture = new NotificationsFixture();
		const { document, service, center, panel, origin, outside } = fixture;
		origin.checkVisibility = () => true;
		const handle = service.notify({ severity: Severity.Info, message: "Retained" });
		const handleItem = service.model.getNotifications().at(-1)!;
		origin.focus();
		const target = toastControl(document, handleItem.id, "remove")!;
		target.focus();
		const toast = target.closest<HTMLElement>("article")!;
		const remove = toast.remove.bind(toast);
		let transitions = 0;
		toast.remove = () => {
			remove(); transitions++;
			if (transition === "center") center.show();
			else { if (transition === "dispose") center.dispose(); outside.focus(); }
		};
		target.dispatchEvent(new document.defaultView!.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		assert.equal(transitions, 1);
		assert.equal(document.activeElement, transition === "center" ? panel : outside);
		assert.equal(document.querySelectorAll(".ash-notification-host .ash-notification").length, 0);
		assert.deepEqual(service.model.getNotifications(), [handleItem]);
	});
}

test("toast Escape applies only to a currently focused toast control", () => {
	using fixture = new NotificationsFixture();
	const { document, service, outside } = fixture;
	const handle = service.notify({ severity: Severity.Info, message: "Retained" });
	const handleItem = service.model.getNotifications().at(-1)!;
	const target = toastControl(document, handleItem.id, "remove")!;
	outside.focus();
	const staleInput = new document.defaultView!.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
	target.dispatchEvent(staleInput);
	const content = target.closest("article")!.querySelector<HTMLElement>(".ash-notification-content")!;
	content.tabIndex = 0;
	content.focus();
	const contentInput = new document.defaultView!.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
	content.dispatchEvent(contentInput);
	assert.deepEqual({ consumed: [staleInput.defaultPrevented, contentInput.defaultPrevented], toasts: document.querySelectorAll(".ash-notification-host .ash-notification").length, history: service.model.getNotifications() }, {
		consumed: [false, true], toasts: 0, history: [handleItem],
	});
});

test("notification accessibility help explains toast Escape and retained history", () => {
	using fixture = new NotificationsFixture();
	using services = new InstantiationService();
	services.registerInstance(INotificationsCenter, fixture.center);
	const implementation = AccessibleViewRegistry.getImplementations().find(item => item.name === "notificationsHelp")!;
	using provider = implementation.getProvider(services)!;
	assert.match(provider.provideContent(), /When a notification toast or one of its actions has focus, press Escape to hide the toasts without removing them from history\./);
	assert.match(provider.provideContent(), /Context Menu key or Shift\+F10, and choose Copy Text to copy its message/);
	assert.match(provider.provideContent(), /Press Escape to close the menu and return to the notification/);
});

test("notification handle removes its record once", () => {
	using service = new TestNotificationService();
	let removals = 0;
	service.model.onDidRemove(() => removals++);
	const handle = service.notify({ severity: Severity.Info, message: "Saved" });
	const handleItem = service.model.getNotifications().at(-1)!;
	handle.close(); handle.close();
	assert.equal(removals, 1);
	assert.equal(service.model.getNotifications().length, 0);
});

test('notification arrivals are announced once even while the center hides toasts', () => {
	using fixture = new NotificationsFixture();
	fixture.service.info('Initial information');
	fixture.center.show();
	fixture.service.warn('Warning while the center is open');
	fixture.service.error('Error while the center is open');
	assert.deepEqual(fixture.presentation.statuses, ['Initial information']);
	assert.deepEqual(fixture.presentation.alerts, ['Warning while the center is open', 'Error while the center is open']);
	assert.equal(fixture.document.querySelectorAll('.ash-notification').length, 0);
	assert.equal(fixture.panel.querySelectorAll('[role="alert"], [role="status"]').length, 0);
	fixture.center.dispose();
	fixture.service.error('After disposal');
	assert.deepEqual(fixture.presentation.alerts, ['Warning while the center is open', 'Error while the center is open']);
});

test("status bell is present at startup and marks notifications read when the center opens", () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	try {
		using service = new TestNotificationService();
		using runner = createNotificationActionRunner(service);
		using statusbar = new StatusbarService();
		using presentation = new NotificationsPresentation(browser.window.document.body, browser.window.document.body, service, runner, statusbar);
		const center = presentation.center;
		const bell = () => statusbar.getEntries(StatusbarAlignment.Right).find(item => item.id === "ash.status.notifications")?.entry.icon;
		assert.equal(bell(), Lxicon.bell);
		const handle = service.notify({ severity: Severity.Info, message: "Saved" });
		const handleItem = service.model.getNotifications().at(-1)!;
		assert.equal(bell(), Lxicon.bellDot);
		center.show();
		assert.equal(bell(), Lxicon.bell);
		center.hide();
		assert.equal(service.model.getNotifications().length, 1);
		assert.equal(bell(), Lxicon.bell);
		const unread = service.notify({ severity: Severity.Info, message: 'Unread' });
		assert.equal(bell(), Lxicon.bellDot);
		handle.close();
		assert.equal(bell(), Lxicon.bellDot);
		unread.close();
		assert.equal(bell(), Lxicon.bell);
	} finally { browser.window.close(); }
});

test("removing center rows keeps remaining records open and restores focus after the last keyboard removal", () => {
	using fixture = new NotificationsFixture();
	const { document, service, center, panel, origin } = fixture;
	const first = service.notify({ severity: Severity.Info, message: "First" });
	const firstItem = service.model.getNotifications().at(-1)!;
	const second = service.notify({ severity: Severity.Info, message: "Second" });
	const secondItem = service.model.getNotifications().at(-1)!;
	origin.focus();
	center.show();
	const row = (id: number) => panel.querySelector<HTMLElement>(`[data-notification-id="${id}"]`)!;
	row(secondItem.id).focus();
	row(secondItem.id).dispatchEvent(new document.defaultView!.KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
	assert.equal(panel.hidden, false);
	assert.deepEqual(service.model.getNotifications().map(item => item.id), [firstItem.id]);
	assert.equal(document.activeElement, row(firstItem.id));
	row(firstItem.id).dispatchEvent(new document.defaultView!.KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
	assert.equal(panel.hidden, true);
	assert.equal(document.activeElement, origin);
	assert.deepEqual(service.model.getNotifications(), []);
	first.close(); second.close(); center.hide();
	assert.equal(document.activeElement, origin);
});

for (const focusOutside of [false, true]) {
	test(`programmatic final removal ${focusOutside ? "preserves outside focus" : "restores center focus"}`, () => {
		using fixture = new NotificationsFixture();
		const { document, service, center, panel, origin, outside } = fixture;
		const handle = service.notify({ severity: Severity.Info, message: "Task completed" });
		const handleItem = service.model.getNotifications().at(-1)!;
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
		const handles = [service.notify({ severity: Severity.Info, message: "First" }), service.notify({ severity: Severity.Info, message: "Second" })];
		const handleItems = service.model.getNotifications();
		const removed: number[] = [];
		using listener = service.model.onDidRemove(item => removed.push(item.id));
		origin.focus();
		center.show();
		const clear = panel.querySelector<HTMLButtonElement>(".ash-notifications-clear")!;
		clear.focus();
		if (useCommand) await commands.executeCommand("notifications.clearAll"); else clear.click();
		assert.equal(panel.hidden, true);
		assert.equal(document.activeElement, origin);
		assert.deepEqual(removed, handleItems.map(item => item.id));
		assert.deepEqual(service.model.getNotifications(), []);
		if (useCommand) await commands.executeCommand("notifications.clearAll"); else clear.click();
		assert.deepEqual(removed, handleItems.map(item => item.id));
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
	const handle = service.notify({ severity: Severity.Info, message: "Arrived while open" });
	const handleItem = service.model.getNotifications().at(-1)!;
	assert.equal(panel.hidden, false);
	assert.equal(panel.querySelector("[data-notification-id]")?.getAttribute("data-notification-id"), String(handleItem.id));
	assert.equal(document.querySelectorAll(".ash-notification").length, 0);
	assert.equal(document.activeElement, panel);
	center.hide();
	assert.equal(document.activeElement, origin);
	assert.deepEqual(service.model.getNotifications().map(item => item.id), [handleItem.id]);
});

for (const addOnFocus of [false, true]) {
	test(`Clear All keeps notifications added during ${addOnFocus ? "focus restoration" : "removal callbacks"} and a reopened center`, () => {
		using fixture = new NotificationsFixture();
		const { document, service, center, panel, origin } = fixture;
		const handles = [service.notify({ severity: Severity.Info, message: "First" }), service.notify({ severity: Severity.Info, message: "Second" })];
		origin.focus();
		center.show();
		let added = false;
		const addNotification = () => {
			if (added) return;
			added = true;
			service.info("Arrived during clear");
			center.show();
		};
		using listener = addOnFocus ? addDisposableListener(origin, "focus", addNotification) : service.model.onDidRemove(addNotification);
		center.clearAll();
		assert.deepEqual(service.model.getNotifications().map(item => item.message), ["Arrived during clear"]);
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
	const handle = service.notify({ severity: Severity.Info, message: "Finished" });
	const handleItem = service.model.getNotifications().at(-1)!;
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
	assert.deepEqual(service.model.getNotifications(), []);
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
		const handle = service.notify({ severity: Severity.Info, message: "Finished" });
		const handleItem = service.model.getNotifications().at(-1)!;
		if (clearAll) service.info("Also finished");
		origin.focus();
		center.show();
		if (clearAll) center.clearAll(); else handle.close();
		assert.equal(panel.hidden, true);
		assert.deepEqual(service.model.getNotifications(), []);
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
	const handle = service.notify({ severity: Severity.Info, message: "Owned by the service" });
	const handleItem = service.model.getNotifications().at(-1)!;
	origin.focus();
	center.show();
	const clear = panel.querySelector<HTMLButtonElement>(".ash-notifications-clear")!;
	const remove = panel.querySelector<HTMLButtonElement>("[data-notification-remove]")!;
	outside.focus();
	center.dispose(); center.dispose();
	clear.click(); remove.click();
	center.show(); center.hide(); center.toggle(); center.clearAll();
	await commands.executeCommand("notifications.clearAll");
	const late = service.notify({ severity: Severity.Info, message: "Arrived after disposal" });
	const lateItem = service.model.getNotifications().at(-1)!;
	handle.close();
	assert.equal(panel.isConnected, false);
	assert.equal(document.querySelectorAll(".ash-notifications-center, .ash-notification-host, .ash-notifications-toggle").length, 0);
	assert.equal(document.activeElement, outside);
	assert.deepEqual(service.model.getNotifications().map(item => item.id), [lateItem.id]);
});

class NotificationsFixture extends Disposable {
	readonly document: Document;
	readonly service: TestNotificationService;
	readonly runner: NotificationActionRunner;
	readonly center: NotificationsCenter;
	readonly panel: HTMLElement;
	readonly origin: HTMLButtonElement;
	readonly outside: HTMLButtonElement;
	readonly presentation: NotificationsPresentation;

	constructor(statusbar?: StatusbarService, systemMenu?: INativeContextMenuApi) {
		super();
		const browser = new JSDOM("<!doctype html><body><button id='origin'>Origin</button><button id='outside'>Outside</button></body>", { url: "https://ash.test" });
		this._register(toDisposable(() => browser.window.close()));
		this.document = browser.window.document;
		this.origin = this.document.querySelector<HTMLButtonElement>("#origin")!;
		this.outside = this.document.querySelector<HTMLButtonElement>("#outside")!;
		this.service = this._register(new TestNotificationService());
		this.runner = this._register(createNotificationActionRunner(this.service));
		this.presentation = this._register(new NotificationsPresentation(this.document.body, this.document.body, this.service, this.runner, statusbar, systemMenu));
		this.center = this.presentation.center;
		this.panel = this.document.querySelector<HTMLElement>(".ash-notifications-center")!;
	}
}

/** Real window services with only the external clipboard and optional host popup controlled. */
class NotificationsPresentation extends Disposable {
	readonly services: InstantiationService;
	readonly views: BrowserContextViewService;
	readonly menus: IContextMenuService;
	readonly center: NotificationsCenter;
	readonly writes: string[] = [];
	readonly alerts: string[] = [];
	readonly statuses: string[] = [];
	private readonly hostFocusChanges = this._register(new Emitter<boolean>());
	private hostFocused = true;
	setHostFocus(focused: boolean): void { this.hostFocused = focused; this.hostFocusChanges.fire(focused); }
	writeText = async (text: string): Promise<void> => { this.writes.push(text); };

	constructor(root: HTMLElement, toastContainer: HTMLElement, service: TestNotificationService, runner: NotificationActionRunner, statusbar?: StatusbarService, systemMenu?: INativeContextMenuApi) {
		super();
		const window = root.ownerDocument.defaultView!;
		// Focus tests use immediate frames; the pending-toast suite drives cancellation explicitly.
		window.requestAnimationFrame = callback => { callback(0); return 0; };
		window.cancelAnimationFrame = () => { };
		// jsdom lacks layout and scrolling; context-view focus restoration requires a painted anchor.
		Object.defineProperty(window.Element.prototype, 'scrollTo', { configurable: true, value: () => { } });
		Object.defineProperty(window.Element.prototype, 'getClientRects', { configurable: true, value: () => [new window.DOMRect(0, 0, 100, 20)] });
		this.services = this._register(new InstantiationService());
		this.services.registerInstance(INotificationService, service);
		const presentation = this;
		this.services.registerInstance(IHostService, {
			get hasFocus() { return presentation.hostFocused; }, onDidChangeFocus: this.hostFocusChanges.event,
			openWindow: async () => { throw new Error('Unexpected window open'); },
			restart: async () => { throw new Error('Unexpected restart'); }, reload: async () => { throw new Error('Unexpected reload'); },
			getScreenshot: async () => undefined,
		});
		this.services.registerInstance(IContextKeyService, this._register(new ContextKeyService()));
		const accessibility = this._register(new AccessibilityService({ root, contextKeyService: this.services.get(IContextKeyService), configurationService: this._register(new InMemoryConfigurationService(new ConfigurationRegistry())) }));
		accessibility.alert = message => this.alerts.push(message);
		accessibility.status = message => this.statuses.push(message);
		this.services.registerInstance(IAccessibilityService, accessibility);
		this.services.registerInstance(IClipboardService, this._register(new BrowserClipboardService({ writeText: text => this.writeText(text) } as Clipboard)));
		this.services.registerInstance(ICommandService, this._register(new CommandService(this.services)));
		this.services.registerInstance(IMenuService, this.services.createInstance(MenuService));
		this.views = this._register(new BrowserContextViewService(root));
		this.services.registerInstance(IContextViewService, this.views);
		this.services.registerInstance(IKeybindingService, {
			inChordMode: false, onDidUpdateKeybindings: Event.None,
			getKeybindings: () => [],
			enableKeybindingHoldMode: () => undefined, registerSchemaContribution: () => Disposable.None,
			resolveKeybinding() { throw new Error('No binding in this fixture'); },
			resolveUserBinding: () => undefined, lookupKeybindings: () => [], lookupKeybinding: () => undefined,
		});
		const registry = new ConfigurationRegistry();
		registry.registerConfiguration({ key: 'workbench.notifications.position', defaultValue: 'bottom-right', parse: value => value });
		registry.registerConfiguration({ key: 'workbench.notifications.showInTitleBar', defaultValue: true, parse: value => value });
		if (systemMenu) {
			registry.registerConfiguration({ key: 'window.menuStyle', defaultValue: 'system', parse: value => value });
			// Linux and Windows require a system title bar to use the Electron popup API.
			registry.registerConfiguration({ key: 'window.titleBarStyle', defaultValue: 'system', parse: value => value });
		}
		this.services.registerInstance(IConfigurationService, this._register(new InMemoryConfigurationService(registry)));
		this.services.registerInstance(ILayoutService, this._register(new BrowserLayoutService({ root })));
		this.menus = this._register(systemMenu ? this.services.createInstance(ElectronContextMenuService, systemMenu) : this.services.createInstance(BrowserContextMenuService));
		this.services.registerInstance(IContextMenuService, this.menus);
		this.center = this._register(this.services.createInstance(NotificationsCenter, root, service.model, toastContainer, runner, statusbar, undefined));
		this.services.registerInstance(INotificationsCenter, this.center);
	}
}

function createNotificationActionRunner(service: TestNotificationService): NotificationActionRunner {
	using services = new InstantiationService();
	services.registerInstance(INotificationService, service);
	return services.createInstance(NotificationActionRunner);
}

function openCopyMenu(fixture: NotificationsFixture, id: number, input: 'mouse' | 'ContextMenu' | 'Shift+F10' = 'ContextMenu'): HTMLElement {
	const { document, center, panel } = fixture;
	center.show();
	const row = panel.querySelector<HTMLElement>(`[data-notification-id="${id}"]`)!;
	row.focus();
	const event = input === 'mouse'
		? new document.defaultView!.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 25, clientY: 40 })
		: new document.defaultView!.KeyboardEvent('keydown', { key: input === 'ContextMenu' ? 'ContextMenu' : 'F10', shiftKey: input === 'Shift+F10', bubbles: true, cancelable: true });
	row.dispatchEvent(event);
	assert.equal(event.defaultPrevented, true);
	return row;
}

test('notification copying requires the clipboard registration and the center requires its window services', () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(CopyNotificationMessageAction, CopyNotificationMessageAction.ID, CopyNotificationMessageAction.LABEL), /Unknown service: clipboardService/);
	using fixture = new NotificationsFixture();
	assert.throws(() => services.createInstance(NotificationsCenter, fixture.document.body, fixture.service.model, fixture.document.body, fixture.runner, undefined, undefined), /Unknown service: contextKeyService/);
	using incomplete = new InstantiationService();
	incomplete.registerInstance(INotificationService, fixture.service);
	incomplete.registerInstance(IContextKeyService, fixture.presentation.services.get(IContextKeyService));
	assert.throws(() => incomplete.createInstance(NotificationsCenter, fixture.document.body, fixture.service.model, fixture.document.body, fixture.runner, undefined, undefined), /Unknown service: contextMenuService/);
});

for (const input of ['mouse', 'ContextMenu', 'Shift+F10'] as const) {
	test(`notification ${input} copies the raw message without source, actions, or presentation text`, async () => {
		using fixture = new NotificationsFixture();
		const message = 'First line\n[链接](https://example.test) <b>literal</b>\n第二行\t🙂';
		const handle = fixture.service.notify({ severity: Severity.Warning, message, source: 'Excluded source', actions: { primary: [{ tooltip: '', enabled: true, id: 'primary', label: 'Excluded action', run() { } }] } });
		const handleItem = fixture.service.model.getNotifications().at(-1)!;
		const copied = promiseWithResolvers<void>();
		fixture.presentation.writeText = async value => { fixture.presentation.writes.push(value); copied.resolve(); };
		const row = openCopyMenu(fixture, handleItem.id, input);
		const menuItem = fixture.document.querySelector<HTMLElement>('[role="menuitem"]')!;
		assert.equal(menuItem.textContent, 'Copy Text');
		menuItem.click();
		await copied.promise;
		assert.deepEqual({ writes: fixture.presentation.writes, history: fixture.service.model.getNotifications(), centerHidden: fixture.panel.hidden, focused: fixture.document.activeElement }, {
			writes: [message], history: [handleItem], centerHidden: false, focused: row,
		});
	});
}

test('Escape dismisses only the copy menu, returns to its row, and then closes the center', () => {
	using fixture = new NotificationsFixture();
	const handle = fixture.service.notify({ severity: Severity.Info, message: 'Retained after cancel' });
	const handleItem = fixture.service.model.getNotifications().at(-1)!;
	fixture.origin.focus();
	const row = openCopyMenu(fixture, handleItem.id);
	fixture.document.activeElement!.dispatchEvent(new fixture.document.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	assert.deepEqual({ menu: fixture.document.querySelector('[role="menu"]'), centerHidden: fixture.panel.hidden, focused: fixture.document.activeElement, writes: fixture.presentation.writes, history: fixture.service.model.getNotifications() }, {
		menu: null, centerHidden: false, focused: row, writes: [], history: [handleItem],
	});
	row.dispatchEvent(new fixture.document.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	assert.equal(fixture.panel.hidden, true);
	assert.equal(fixture.document.activeElement, fixture.origin);
});

for (const change of ['add', 'remove', 'hide', 'clear', 'dispose'] as const) {
	test(`center ${change} invalidates its browser copy menu and prevents an old menu item from writing`, async () => {
		using fixture = new NotificationsFixture();
		const handle = fixture.service.notify({ severity: Severity.Info, message: 'Original' });
		const handleItem = fixture.service.model.getNotifications().at(-1)!;
		openCopyMenu(fixture, handleItem.id);
		const menuItem = fixture.document.querySelector<HTMLElement>('[role="menuitem"]')!;
		if (change === 'add') fixture.service.info('Next');
		else if (change === 'remove') handle.close();
		else if (change === 'hide') fixture.center.hide();
		else if (change === 'clear') fixture.center.clearAll();
		else fixture.center.dispose();
		menuItem.click();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual({ menu: fixture.document.querySelector('[role="menu"]'), writes: fixture.presentation.writes }, { menu: null, writes: [] });
	});
}

test('a replaced notification menu cannot close another owner menu when the center renders or hides', () => {
	using fixture = new NotificationsFixture();
	const handle = fixture.service.notify({ severity: Severity.Info, message: 'Original' });
	const handleItem = fixture.service.model.getNotifications().at(-1)!;
	openCopyMenu(fixture, handleItem.id);
	fixture.presentation.menus.showContextMenu({ getAnchor: () => fixture.outside, getActions: () => [{ id: 'other', label: 'Other menu', tooltip: '', enabled: true, run() { } }] });
	fixture.service.info('Rerender');
	fixture.center.hide();
	assert.deepEqual({ label: fixture.document.querySelector('[role="menuitem"]')?.textContent, writes: fixture.presentation.writes }, { label: 'Other menu', writes: [] });
});

test('copy menu cancellation preserves focus owned by a different dialog', () => {
	using fixture = new NotificationsFixture();
	const handle = fixture.service.notify({ severity: Severity.Info, message: 'Original' });
	const handleItem = fixture.service.model.getNotifications().at(-1)!;
	openCopyMenu(fixture, handleItem.id);
	const dialog = fixture.document.createElement('section');
	dialog.setAttribute('role', 'dialog');
	dialog.tabIndex = 0;
	fixture.document.body.append(dialog);
	dialog.focus();
	fixture.service.info('Rerender');
	assert.equal(fixture.document.activeElement, dialog);
	assert.equal(fixture.document.querySelector('[role="menu"]'), null);
});

test('window-scoped notification menus and clipboard targets remain independent', async () => {
	using first = new NotificationsFixture();
	using second = new NotificationsFixture();
	const firstItem = first.service.notify({ severity: Severity.Info, message: 'First window' });
	const firstItemItem = first.service.model.getNotifications().at(-1)!;
	const secondItem = second.service.notify({ severity: Severity.Info, message: 'Second window' });
	const secondItemItem = second.service.model.getNotifications().at(-1)!;
	openCopyMenu(first, firstItemItem.id);
	openCopyMenu(second, secondItemItem.id);
	first.center.clearAll();
	second.document.querySelector<HTMLElement>('[role="menuitem"]')!.click();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual({ first: first.presentation.writes, second: second.presentation.writes, history: second.service.model.getNotifications() }, { first: [], second: ['Second window'], history: [secondItemItem] });
});

test('menu selection keeps an in-flight clipboard failure observable once after the center hides', async () => {
	using fixture = new NotificationsFixture();
	const handle = fixture.service.notify({ severity: Severity.Info, message: 'Original' });
	const handleItem = fixture.service.model.getNotifications().at(-1)!;
	const started = promiseWithResolvers<void>();
	const write = promiseWithResolvers<void>();
	const reported = promiseWithResolvers<void>();
	fixture.presentation.writeText = async value => { fixture.presentation.writes.push(value); started.resolve(); await write.promise; };
	fixture.service.model.onDidAdd(item => { if (item.severity === Severity.Error) reported.resolve(); });
	openCopyMenu(fixture, handleItem.id);
	fixture.document.querySelector<HTMLElement>('[role="menuitem"]')!.click();
	await started.promise;
	fixture.center.hide();
	handle.close();
	write.reject(new Error('Clipboard permission denied'));
	await reported.promise;
	assert.deepEqual({ writes: fixture.presentation.writes, messages: fixture.service.model.getNotifications().map(item => item.message) }, { writes: ['Original'], messages: ['Clipboard permission denied'] });
});

test('window menu disposal suppresses late clipboard failure feedback without canceling the write', async () => {
	using fixture = new NotificationsFixture();
	const handle = fixture.service.notify({ severity: Severity.Info, message: 'Original' });
	const handleItem = fixture.service.model.getNotifications().at(-1)!;
	const started = promiseWithResolvers<void>();
	const write = promiseWithResolvers<void>();
	fixture.presentation.writeText = async value => { fixture.presentation.writes.push(value); started.resolve(); await write.promise; };
	openCopyMenu(fixture, handleItem.id);
	fixture.document.querySelector<HTMLElement>('[role="menuitem"]')!.click();
	await started.promise;
	fixture.presentation.dispose();
	write.reject(new Error('Late clipboard failure'));
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual({ writes: fixture.presentation.writes, history: fixture.service.model.getNotifications() }, { writes: ['Original'], history: [handleItem] });
});

for (const change of ['add', 'remove', 'hide', 'clear', 'dispose'] as const) {
	test(`center ${change} cancels its system popup and ignores its delayed selection`, async () => {
		const popup = promiseWithResolvers<INativeContextMenuResult>();
		const requests: INativeContextMenuRequest[] = [];
		let closed = 0;
		using fixture = new NotificationsFixture(undefined, { popup: request => { requests.push(request); return popup.promise; }, async close() { closed++; } });
		const handle = fixture.service.notify({ severity: Severity.Info, message: 'Original' });
		const handleItem = fixture.service.model.getNotifications().at(-1)!;
		openCopyMenu(fixture, handleItem.id);
		if (change === 'add') fixture.service.info('Next');
		else if (change === 'remove') handle.close();
		else if (change === 'hide') fixture.center.hide();
		else if (change === 'clear') fixture.center.clearAll();
		else fixture.center.dispose();
		await new Promise<void>(resolve => setImmediate(resolve));
		const action = requests[0].items[0];
		assert.ok(action.type === 'action');
		popup.resolve({ selectedId: action.id });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual({ closed, label: action.label, writes: fixture.presentation.writes }, { closed: 1, label: 'Copy Text', writes: [] });
	});
}

test('system selection copies through the same action and reports a clipboard denial once', async () => {
	const popup = promiseWithResolvers<INativeContextMenuResult>();
	const request = promiseWithResolvers<INativeContextMenuRequest>();
	using fixture = new NotificationsFixture(undefined, { popup: value => { request.resolve(value); return popup.promise; }, async close() { } });
	const handle = fixture.service.notify({ severity: Severity.Info, message: 'System message\n第二行' });
	const handleItem = fixture.service.model.getNotifications().at(-1)!;
	const reported = promiseWithResolvers<void>();
	fixture.presentation.writeText = async value => { fixture.presentation.writes.push(value); throw new Error('System clipboard denied'); };
	fixture.service.model.onDidAdd(item => { if (item.severity === Severity.Error) reported.resolve(); });
	openCopyMenu(fixture, handleItem.id);
	const action = (await request.promise).items[0];
	assert.ok(action.type === 'action');
	popup.resolve({ selectedId: action.id });
	await reported.promise;
	assert.deepEqual({ writes: fixture.presentation.writes, messages: fixture.service.model.getNotifications().map(item => item.message) }, { writes: ['System message\n第二行'], messages: ['System message\n第二行', 'System clipboard denied'] });
});

test('system Copy Text releases its presentation before starting the selected write without canceling it', async () => {
	const popup = promiseWithResolvers<INativeContextMenuResult>();
	let request: INativeContextMenuRequest | undefined;
	let closeRequests = 0;
	using fixture = new NotificationsFixture(undefined, { popup: value => { request = value; return popup.promise; }, async close() { closeRequests++; } });
	const handle = fixture.service.notify({ severity: Severity.Info, message: 'Selected system message\n第二行' });
	const handleItem = fixture.service.model.getNotifications().at(-1)!;
	const order: string[] = [];
	const write = promiseWithResolvers<void>();
	using hidden = fixture.presentation.menus.onDidHideContextMenu(() => order.push('hide'));
	fixture.presentation.writeText = async value => { order.push('write'); fixture.presentation.writes.push(value); await write.promise; };
	openCopyMenu(fixture, handleItem.id);
	const selected = request!.items[0];
	assert.ok(selected.type === 'action');
	popup.resolve({ selectedId: selected.id });
	try {
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual({ order, writes: fixture.presentation.writes, closeRequests }, { order: ['hide', 'write'], writes: ['Selected system message\n第二行'], closeRequests: 0 });
		fixture.center.hide();
		assert.deepEqual({ writes: fixture.presentation.writes, closeRequests, messages: fixture.service.model.getNotifications().map(item => item.message) }, { writes: ['Selected system message\n第二行'], closeRequests: 0, messages: ['Selected system message\n第二行'] });
	} finally { write.resolve(); }
});

test('notification center creation retains startup history and the three-toast limit', () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	try {
		using service = new TestNotificationService();
		for (const message of ['First', 'Second', 'Third', 'Fourth']) service.info(message);
		using runner = createNotificationActionRunner(service);
		using presentation = new NotificationsPresentation(browser.window.document.body, browser.window.document.body, service, runner);
		assert.equal(browser.window.document.querySelectorAll('.ash-notification').length, 3);
		presentation.center.show();
		assert.equal(browser.window.document.querySelectorAll('.ash-notifications-row').length, 4);
	} finally { browser.window.close(); }
});

test("notification actions require the window notification service", () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(NotificationActionRunner), /Unknown service: notificationService/u);
});

for (const asynchronous of [false, true]) {
	for (const failure of [new Error("Action failed"), "Thrown value", undefined]) {
		test(`notification runner reports ${String(failure)} once before completion for ${asynchronous ? "async" : "sync"} actions`, async () => {
			using service = new TestNotificationService();
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
			service.model.onDidAdd(() => order.push("error"));
			runner.onDidRun(event => { events.push(event); order.push("did"); });
			await runner.run(action, context);
			assert.deepEqual({ order, events, notifications: service.model.getNotifications().map(item => ({ severity: item.severity, message: item.message })) }, {
				order: ["will", "run", "error", "did"], events: [{ action, context }, { action, context, error: undefined }],
				notifications: [{ severity: Severity.Error, message: failure instanceof Error ? failure.message : failure ?? "Error" }],
			});
		});
	}
	for (const handled of [false, true]) {
		test(`notification runner suppresses ${handled ? "already handled failures" : "cancellation"} from ${asynchronous ? "async" : "sync"} actions`, async () => {
			using service = new TestNotificationService();
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
			assert.deepEqual({ completed, messages: service.model.getNotifications().map(item => item.message) }, { completed: 1, messages: handled ? ["Producer recovered"] : [] });
		});
	}
}

test("a disposed notification runner skips new actions", async () => {
	using service = new TestNotificationService();
	using runner = createNotificationActionRunner(service);
	let calls = 0;
	let events = 0;
	runner.onWillRun(() => events++);
	runner.onDidRun(() => events++);
	runner.dispose();
	await runner.run({ id: "late", label: "Late", tooltip: "", enabled: true, run() { calls++; throw new Error("Late failure"); } });
	assert.deepEqual({ calls, events, notifications: service.model.getNotifications() }, { calls: 0, events: 0, notifications: [] });
});

test("window disposal suppresses late notification feedback while the producer owns its pending task", async () => {
	using service = new TestNotificationService();
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
	assert.deepEqual({ completed, notifications: service.model.getNotifications() }, { completed: 0, notifications: [] });
});

for (const useCenter of [false, true]) {
	for (const asynchronous of [false, true]) {
		test(`${useCenter ? "center" : "toast"} actions preserve the callback receiver and report ${asynchronous ? "async" : "sync"} failures through the shared model`, async () => {
			using statusbar = new StatusbarService();
			using fixture = new NotificationsFixture(statusbar);
			const { document, service, runner, center } = fixture;
			let calls = 0;
			const action: IAction = {
				tooltip: '',
				enabled: true,
				id: "failed", label: "Try action", run(...args: unknown[]) {
					assert.equal(this, action);
					assert.deepEqual(args, []);
					calls++;
					const failure = new Error("Visible action failure");
					if (asynchronous) return Promise.reject(failure);
					throw failure;
				}
			};
			const original = service.notify({ severity: Severity.Info, message: "Original notification", actions: { primary: [action] } });
			const originalItem = service.model.getNotifications().at(-1)!;
			if (useCenter) center.show();
			const completed = new Promise<void>(resolve => runner.onDidRun(() => resolve()));
			document.querySelector<HTMLButtonElement>(`${useCenter ? ".ash-notifications-center" : ".ash-notification-host"} .ash-notification-action`)!.click();
			assert.equal(calls, 0);
			await completed;
			assert.deepEqual({ calls, items: service.model.getNotifications().map(item => ({ severity: item.severity, message: item.message })) }, {
				calls: 1, items: [{ severity: Severity.Info, message: "Original notification" }, { severity: Severity.Error, message: "Visible action failure" }],
			});
			assert.equal(service.model.getNotifications()[0], originalItem);
			assert.equal(statusbar.getEntries(StatusbarAlignment.Right).find(item => item.id === "ash.status.notifications")?.entry.icon, useCenter ? Lxicon.bell : Lxicon.bellDot);
			if (!useCenter) assert.equal(document.querySelector('.ash-notification-error .ash-notification-message')?.textContent, "Visible action failure");
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
		const original = fixture.service.notify({ severity: Severity.Info, message: "Pending task", actions: { primary: [{ tooltip: '', enabled: true, id: "pending", label: "Start", run() { entered(); return completion; } }] } });
		const originalItem = fixture.service.model.getNotifications().at(-1)!;
		if (useCenter) fixture.center.show();
		const completed = new Promise<void>(resolve => fixture.runner.onDidRun(() => resolve()));
		fixture.document.querySelector<HTMLButtonElement>(`${useCenter ? ".ash-notifications-center" : ".ash-notification-host"} .ash-notification-action`)!.click();
		await started;
		original.close();
		reject(new Error("Failure after original removal"));
		await completed;
		assert.deepEqual(fixture.service.model.getNotifications().map(item => ({ severity: item.severity, message: item.message })), [
			{ severity: Severity.Error, message: "Failure after original removal" },
		]);
		assert.equal(fixture.document.querySelector('.ash-notification-error .ash-notification-message')?.textContent, "Failure after original removal");
	});
	test(`${useCenter ? "center" : "toast"} successful actions let the producer close its notification without error feedback`, async () => {
		using fixture = new NotificationsFixture();
		let calls = 0;
		const handle = fixture.service.notify({ severity: Severity.Info, message: "Complete task", actions: { primary: [{ tooltip: '', enabled: true, id: "complete", label: "Complete", async run() { calls++; handle.close(); } }] } });
		const handleItem = fixture.service.model.getNotifications().at(-1)!;
		if (useCenter) fixture.center.show();
		const completed = new Promise<void>(resolve => fixture.runner.onDidRun(() => resolve()));
		fixture.document.querySelector<HTMLButtonElement>(`${useCenter ? ".ash-notifications-center" : ".ash-notification-host"} .ash-notification-action`)!.click();
		await completed;
		assert.deepEqual({ calls, notifications: fixture.service.model.getNotifications() }, { calls: 1, notifications: [] });
	});
}


test("progress updates retain the notification row and its focused action", () => {
	using fixture = new NotificationsFixture();
	const handle = fixture.service.notify({ severity: Severity.Info, message: "Indexing", progress: { infinite: true }, actions: { primary: [{ tooltip: '', enabled: true, id: 'cancel', label: 'Cancel', run() { } }] } });
	const handleItem = fixture.service.model.getNotifications().at(-1)!;
	const button = fixture.document.querySelector<HTMLButtonElement>('.ash-notification-action')!;
	button.focus();
	let closed = 0;
	using closeListener = handle.onDidClose(() => { closed++; });
	handle.updateMessage("Indexing files");
	handle.progress.total(3);
	handle.progress.worked(1);
	assert.equal(fixture.document.querySelector('.ash-notification-message')?.textContent, "Indexing files");
	const progress = fixture.document.querySelector<HTMLProgressElement>('progress')!;
	assert.equal(progress.hidden, false);
	assert.equal(progress.value, 1 / 3);
	assert.equal(progress.getAttribute('aria-label'), "Indexing files");
	assert.equal(fixture.document.activeElement, button);
	assert.equal(fixture.document.querySelector('.ash-notification-action'), button);
	assert.equal(fixture.service.model.get(handleItem.id)?.message, "Indexing files");
	fixture.center.show();
	assert.equal(fixture.panel.querySelector('.ash-notification-message')?.textContent, "Indexing files");
	handle.close();
	handle.close();
	handle.updateMessage("Late update");
	assert.equal(closed, 1);
	assert.deepEqual(fixture.service.model.getNotifications(), []);
});

test("silent progress is retained in the center without a toast or arrival announcement", () => {
	using fixture = new NotificationsFixture();
	const handle = fixture.service.notify({ severity: Severity.Info, message: "Loading workspace", priority: NotificationPriority.SILENT, progress: { infinite: true } });
	const handleItem = fixture.service.model.getNotifications().at(-1)!;
	assert.equal(fixture.document.querySelector('.ash-notification'), null);
	assert.deepEqual(fixture.presentation.statuses, []);
	assert.equal(fixture.service.model.getNotifications().length, 1);
	fixture.center.show();
	assert.equal(fixture.panel.querySelector('.ash-notification-message')?.textContent, handleItem.message);
});

test('standard notification shortcuts accept errors and arrays without exposing history to producers', () => {
	using service = new TestNotificationService();
	assert.equal(service.info(['First', new Error('Second')]), undefined);
	assert.equal(service.warn(new Error('Warning')), undefined);
	assert.equal(service.error(['Failure']), undefined);
	assert.deepEqual(service.model.getNotifications().map(({ severity, message }) => ({ severity, message })), [
		{ severity: Severity.Info, message: 'First' },
		{ severity: Severity.Info, message: 'Second' },
		{ severity: Severity.Warning, message: 'Warning' },
		{ severity: Severity.Error, message: 'Failure' },
	]);
});

test('a producer handle updates severity, message and actions on the existing row', async () => {
	using fixture = new NotificationsFixture();
	const handle = fixture.service.notify({ severity: Severity.Info, message: 'Starting', source: { id: 'fixture', label: 'Fixture' } });
	const row = fixture.document.querySelector<HTMLElement>('.ash-notification')!;
	handle.updateSeverity(Severity.Error);
	handle.updateMessage(new Error('Failed'));
	let runs = 0;
	handle.updateActions({ primary: [{ id: 'retry', label: 'Retry', tooltip: 'Retry task', enabled: false, run() { runs++; } }] });
	assert.equal(fixture.document.querySelector('.ash-notification'), row);
	assert.equal(row.dataset.severity, 'error');
	assert.equal(row.querySelector('.ash-notification-severity')?.getAttribute('aria-label'), 'Error');
	assert.equal(row.querySelector('.ash-notification-message')?.textContent, 'Failed');
	assert.equal(row.querySelector('.ash-notification-source')?.textContent, 'Source: Fixture');
	const disabled = row.querySelector<HTMLButtonElement>('.ash-notification-action')!;
	assert.equal(disabled.disabled, true);
	disabled.click();
	assert.equal(runs, 0);
	handle.updateActions({ primary: [{ id: 'retry', label: 'Retry', tooltip: '', enabled: true, run() { runs++; } }] });
	row.querySelector<HTMLButtonElement>('.ash-notification-action')!.click();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(runs, 1);
	handle.updateActions();
	assert.equal(row.querySelector('.ash-notification-action'), null);
});

test('producer visibility follows presentation changes and close remains observable after removal during arrival', () => {
	using service = new TestNotificationService();
	const handle = service.notify({ severity: Severity.Info, message: 'Visible later' });
	const item = service.model.getNotifications()[0]!;
	const visibility: boolean[] = [];
	using listener = handle.onDidChangeVisibility(visible => visibility.push(visible));
	let closes = 0;
	using closeListener = handle.onDidClose(() => { closes++; });
	assert.equal(handle.visible, false);
	item.updateVisibility(true);
	item.updateVisibility(true);
	assert.equal(handle.visible, true);
	handle.close();
	handle.close();
	item.updateVisibility(true);
	assert.deepEqual(visibility, [true, false]);
	assert.equal(handle.visible, false);
	assert.equal(closes, 1);
	using removeOnArrival = service.model.onDidAdd(item => service.model.remove(item.id));
	const removed = service.notify({ severity: Severity.Info, message: 'Removed on arrival' });
	using lateListener = removed.onDidClose(() => { closes++; });
	assert.equal(closes, 2);
	assert.deepEqual(service.model.getNotifications(), []);
});

test('the accessible notification history observes handle updates through its Workbench model', () => {
	using fixture = new NotificationsFixture();
	const handle = fixture.service.notify({ severity: Severity.Info, message: 'Starting' });
	using services = new InstantiationService();
	services.registerInstance(INotificationsCenter, fixture.center);
	const implementation = AccessibleViewRegistry.getImplementations().find(item => item.name === 'notificationsView')!;
	using provider = implementation.getProvider(services)!;
	assert.equal(provider.provideContent(), 'info: Starting');
	let updates = 0;
	using listener = provider.onDidChangeContent!(() => { updates++; });
	handle.updateSeverity(Severity.Error);
	handle.updateMessage('Failed');
	assert.equal(provider.provideContent(), 'error: Failed');
	assert.equal(updates, 2);
	handle.close();
	assert.equal(provider.provideContent(), 'No notifications');
	assert.equal(updates, 3);
	listener.dispose();
	fixture.service.info('After subscription disposal');
	assert.equal(updates, 3);
});

test('do not disturb commands, header controls, unread icons and silent delivery share one filter', async () => {
	using statusbar = new StatusbarService();
	using fixture = new NotificationsFixture(statusbar);
	const { service, presentation, center, document } = fixture;
	const entry = () => statusbar.getEntries(StatusbarAlignment.Right).find(item => item.id === 'ash.status.notifications')!.entry;
	assert.equal(entry().icon, Lxicon.bell);
	let changes = 0;
	using listener = service.onDidChangeFilter(() => changes++);
	await presentation.services.get(ICommandService).executeCommand('notifications.toggleDoNotDisturbMode');
	assert.equal(service.getFilter(), NotificationsFilter.ERROR);
	assert.equal(entry().icon, Lxicon.bellSlash);
	service.info('Silent information');
	service.warn('Silent warning');
	assert.equal(entry().icon, Lxicon.bellSlashDot);
	assert.equal(document.querySelectorAll('.ash-notification').length, 0);
	assert.deepEqual(presentation.statuses, []);
	assert.deepEqual(presentation.alerts, []);
	service.error('Visible error');
	assert.deepEqual(presentation.alerts, ['Visible error']);
	assert.equal(document.querySelector('.ash-notification-message')?.textContent, 'Visible error');
	center.show();
	assert.equal(entry().icon, Lxicon.bellSlash);
	assert.equal(document.querySelectorAll('.ash-notifications-row').length, 3);
	const toggle = fixture.panel.querySelector<HTMLButtonElement>('[aria-pressed]')!;
	assert.equal(toggle.getAttribute('aria-pressed'), 'true');
	assert.equal(toggle.getAttribute('aria-label'), 'Configure Do Not Disturb...');
	toggle.click();
	[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Disable Do Not Disturb Mode')!.click();
	assert.equal(toggle.getAttribute('aria-pressed'), 'false');
	assert.equal(service.getFilter(), NotificationsFilter.OFF);
	assert.equal(entry().icon, Lxicon.bell);
	center.hide();
	service.info('New visible information');
	assert.equal(entry().icon, Lxicon.bellDot);
	assert.equal(document.querySelector('.ash-notification-message')?.textContent, 'New visible information');
	assert.equal(changes, 2);
	service.setFilter(NotificationsFilter.OFF);
	assert.equal(changes, 2);
	assert.throws(() => service.setFilter(2 as NotificationsFilter), /Unknown notification filter/);
});

test('enabling do not disturb cancels queued toasts without removing their history', () => {
	using fixture = new NotificationsFixture();
	const frames: FrameRequestCallback[] = [];
	fixture.document.defaultView!.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
	fixture.service.info('Queued information');
	assert.equal(fixture.document.querySelectorAll('.ash-notification').length, 0);
	fixture.service.setFilter(NotificationsFilter.ERROR);
	for (const callback of frames) callback(0);
	assert.equal(fixture.document.querySelectorAll('.ash-notification').length, 0);
	assert.equal(fixture.service.model.getNotifications().length, 1);
	fixture.center.show();
	assert.equal(fixture.panel.querySelector('.ash-notification-message')?.textContent, 'Queued information');
});

test('notification filter restores through the production service assembly and follows storage changes', () => {
	const browser = new JSDOM('', { url: 'https://notifications.test' });
	try {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(NotificationService), /Unknown service: storageService/);
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'filter', flushInterval: 0 });
		services.registerInstance(IStorageService, storage);
		using first = services.createInstance(NotificationService);
		first.setFilter(NotificationsFilter.ERROR);
		assert.equal(storage.getBoolean('notifications.doNotDisturbMode', StorageScope.APPLICATION), true);
		assert.ok(storage.keys(StorageScope.APPLICATION, StorageTarget.MACHINE).includes('notifications.doNotDisturbMode'));
		using restored = services.createInstance(NotificationService);
		assert.equal(restored.getFilter(), NotificationsFilter.ERROR);
		restored.setFilter(NotificationsFilter.OFF);
		assert.equal(first.getFilter(), NotificationsFilter.OFF);
		storage.store('notifications.doNotDisturbMode', true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		assert.equal(restored.getFilter(), NotificationsFilter.ERROR);
		first.dispose();
		storage.remove('notifications.doNotDisturbMode', StorageScope.APPLICATION);
		assert.equal(restored.getFilter(), NotificationsFilter.OFF);
		assert.equal(first.getFilter(), NotificationsFilter.ERROR);
	} finally { browser.window.close(); }
});

test('structured sources retain identity, update labels, and independently silence information and warnings', () => {
	using fixture = new NotificationsFixture();
	const first = { id: 'first.extension', label: 'Shared label' };
	const second = { id: 'second.extension', label: 'Shared label' };
	fixture.service.notify({ source: first, severity: Severity.Info, message: 'First arrival' });
	fixture.service.notify({ source: second, severity: Severity.Info, message: 'Second arrival' });
	fixture.service.setFilter({ ...first, filter: NotificationsFilter.ERROR });
	assert.equal(fixture.document.querySelectorAll('.ash-notification').length, 1);
	assert.equal(fixture.document.querySelector('.ash-notification-message')?.textContent, 'Second arrival');
	fixture.service.notify({ source: { ...first, label: 'Renamed' }, severity: Severity.Warning, message: 'Silent warning' });
	fixture.service.notify({ source: first, severity: Severity.Error, message: 'Visible error' });
	assert.equal(fixture.service.model.getNotifications()[0]?.sourceId, first.id);
	assert.equal(fixture.service.getFilter(first), NotificationsFilter.ERROR);
	assert.equal(fixture.service.getFilter(second), NotificationsFilter.OFF);
	assert.deepEqual(fixture.service.getFilters().map(source => source.id), [first.id, second.id]);
	assert.equal(fixture.document.querySelectorAll('.ash-notification').length, 2);
	assert.equal(fixture.service.model.getNotifications().length, 4);
	const snapshot = fixture.service.getFilters();
	(snapshot[0] as { label: string; }).label = 'Changed by caller';
	assert.equal(fixture.service.getFilters()[0]?.label, first.label);
	fixture.service.removeFilter(first.id);
	assert.equal(fixture.service.getFilter(first), NotificationsFilter.OFF);
	assert.deepEqual(fixture.service.getFilters().map(source => source.id), [second.id]);
	assert.throws(() => fixture.service.notify({ source: { id: '', label: 'Missing identity' }, severity: Severity.Info, message: 'Invalid' }), /source ID/);
});

test('source filters persist, synchronize, and recover from malformed storage without hiding errors', () => {
	const browser = new JSDOM('', { url: 'https://sources.test' });
	try {
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'sources', flushInterval: 0 });
		using first = new NotificationService(storage);
		const source = { id: 'fixture', label: 'Fixture', filter: NotificationsFilter.ERROR };
		first.setFilter(source);
		using restored = new NotificationService(storage);
		assert.deepEqual(restored.getFilters(), [source]);
		restored.notify({ source: { id: 'fixture', label: 'New label' }, severity: Severity.Info, message: 'Silent' });
		assert.equal(first.getFilters()[0]?.label, 'New label');
		assert.equal(restored.model.getNotifications()[0]?.priority, NotificationPriority.SILENT);
		restored.notify({ source, severity: Severity.Error, message: 'Error still visible' });
		assert.notEqual(restored.model.getNotifications()[1]?.priority, NotificationPriority.SILENT);
		first.removeFilter(source.id);
		assert.deepEqual(restored.getFilters(), []);
		for (const invalid of ['{', '{}', '[{"id":"fixture","label":"Fixture","filter":42}]']) {
			storage.store('notifications.perSourceDoNotDisturbMode', invalid, StorageScope.APPLICATION, StorageTarget.MACHINE);
			using recovered = new NotificationService(storage);
			assert.deepEqual(recovered.getFilters(), []);
		}
	} finally { browser.window.close(); }
});

test('queued source toasts are cancelled selectively and row menus can re-enable the source', () => {
	using fixture = new NotificationsFixture();
	const frames: FrameRequestCallback[] = [];
	fixture.document.defaultView!.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
	const source = { id: 'fixture', label: 'Fixture' };
	fixture.service.notify({ source, severity: Severity.Info, message: 'Queued' });
	fixture.service.error('Queued error');
	fixture.service.setFilter({ ...source, filter: NotificationsFilter.ERROR });
	for (const callback of frames) callback(0);
	assert.equal(fixture.document.querySelectorAll('.ash-notification').length, 1);
	fixture.center.show();
	const row = fixture.panel.querySelector<HTMLElement>('[data-notification-id="1"]')!;
	row.querySelector<HTMLButtonElement>('[aria-label="More Actions"]')!.click();
	const enable = [...fixture.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Turn On All Notifications'))!;
	assert.ok(enable);
	enable.click();
	assert.equal(fixture.service.getFilter(source), NotificationsFilter.OFF);
});

test('running notifications survive Delete and Clear All until progress completes', () => {
	using fixture = new NotificationsFixture();
	const handle = fixture.service.notify({ severity: Severity.Info, message: 'Indexing', progress: { infinite: true } });
	fixture.service.info('Finished');
	fixture.center.show();
	const row = fixture.panel.querySelector<HTMLElement>('[data-notification-id="1"]')!;
	assert.equal(row.querySelector('[data-notification-remove]'), null);
	row.focus();
	row.dispatchEvent(new fixture.document.defaultView!.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
	assert.equal(fixture.service.model.getNotifications().length, 2);
	fixture.center.clearAll();
	assert.equal(fixture.service.model.getNotifications().length, 1);
	fixture.center.show();
	assert.equal(fixture.panel.querySelector<HTMLButtonElement>('.ash-notifications-clear')!.disabled, true);
	handle.progress.done();
	assert.equal(fixture.panel.querySelectorAll('[data-notification-remove]').length, 1);
	assert.equal(fixture.panel.querySelector<HTMLButtonElement>('.ash-notifications-clear')!.disabled, false);
	fixture.center.clearAll();
	assert.equal(fixture.service.model.getNotifications().length, 0);
});

test('read but hidden progress keeps the bell marked and clears when the task completes', () => {
	using statusbar = new StatusbarService();
	using fixture = new NotificationsFixture(statusbar);
	const handle = fixture.service.notify({ severity: Severity.Info, message: 'Working', progress: { infinite: true } });
	fixture.center.show();
	fixture.center.hide();
	const entry = () => statusbar.getEntries(StatusbarAlignment.Right).find(item => item.id === 'ash.status.notifications')!.entry;
	assert.equal(entry().icon, Lxicon.bellDot);
	assert.equal(entry().tooltip, 'No New Notifications (1 in progress)');
	handle.progress.done();
	assert.equal(entry().icon, Lxicon.bell);
});

test('position settings move the sole bell and expose the title-bar action', async () => {
	using statusbar = new StatusbarService();
	using fixture = new NotificationsFixture(statusbar);
	const commands = fixture.presentation.services.get(ICommandService);
	await commands.executeCommand('workbench.action.setNotificationsPosition.bottomLeft');
	assert.equal(statusbar.getEntries(StatusbarAlignment.Left).filter(item => item.id === 'ash.status.notifications').length, 1);
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right).length, 0);
	assert.equal(fixture.panel.dataset.position, 'bottom-left');
	await commands.executeCommand('workbench.action.setNotificationsPosition.topRight');
	assert.equal(statusbar.getEntries(StatusbarAlignment.Left).length, 0);
	const titleActions = fixture.presentation.services.get(IMenuService).getMenuActions(MenuId.TitleBar).flatMap(([, actions]) => actions);
	assert.ok(titleActions.some(action => action.id === 'notifications.toggleList'));
	await titleActions.find(action => action.id === 'notifications.toggleList')!.run();
	assert.equal(fixture.panel.hidden, false);
});

test('status messages honor delay, replacement and handle disposal without entering history', () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		using statusbar = new StatusbarService();
		using fixture = new NotificationsFixture(statusbar);
		const messages = () => statusbar.getEntries(StatusbarAlignment.Left).filter(item => item.id === 'status.message');
		const first = fixture.service.status('Waiting', { showAfter: 10, hideAfter: 30 });
		mock.timers.tick(9);
		assert.equal(messages().length, 0);
		mock.timers.tick(1);
		assert.equal(messages()[0]?.entry.text, 'Waiting');
		const second = fixture.service.status('Current');
		first.close();
		mock.timers.tick(0);
		assert.equal(messages()[0]?.entry.text, 'Current');
		mock.timers.tick(30);
		assert.equal(messages()[0]?.entry.text, 'Current');
		second.close();
		assert.equal(messages().length, 0);
		fixture.service.status('Expires before appearing', { showAfter: 20, hideAfter: 10 });
		mock.timers.tick(30);
		assert.equal(messages().length, 0);
		assert.equal(fixture.service.model.getNotifications().length, 0);
		assert.throws(() => fixture.service.status('Invalid', { showAfter: -1 }), /delay/);
	} finally { mock.timers.reset(); }
});

test('urgent notifications bypass global and source mute while explicit silent errors stay silent', () => {
	using fixture = new NotificationsFixture();
	const source = { id: 'fixture', label: 'Fixture' };
	fixture.service.setFilter({ ...source, filter: NotificationsFilter.ERROR });
	fixture.service.setFilter(NotificationsFilter.ERROR);
	fixture.service.notify({ severity: Severity.Warning, message: 'Urgent warning', priority: NotificationPriority.URGENT, source });
	fixture.service.notify({ severity: Severity.Error, message: 'Explicitly silent error', priority: NotificationPriority.SILENT, source });
	assert.equal(fixture.document.querySelectorAll('.ash-notification').length, 1);
	assert.equal(fixture.document.querySelector('.ash-notification-message')?.textContent, 'Urgent warning');
	assert.equal(fixture.service.model.getNotifications().length, 2);
});

test('empty progress options do not block removal and active progress updates the accessible view', () => {
	using fixture = new NotificationsFixture();
	const handle = fixture.service.notify({ severity: Severity.Info, message: 'Working', progress: {} });
	fixture.center.show();
	assert.equal(fixture.panel.querySelectorAll('[data-notification-remove]').length, 1);
	using provider = AccessibleViewRegistry.getImplementations().find(item => item.name === 'notificationsView')!.getProvider(fixture.presentation.services)!;
	assert.equal(provider.provideContent(), 'info: Working');
	handle.progress.infinite();
	assert.equal(fixture.panel.querySelectorAll('[data-notification-remove]').length, 0);
	assert.match(provider.provideContent(), /In progress/);
	handle.progress.total(4);
	handle.progress.worked(1);
	assert.match(provider.provideContent(), /25% complete/);
	handle.progress.done();
	assert.equal(provider.provideContent(), 'info: Working');
});

suite('notification review regressions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('message updates are announced once while silent, progress-only and closed updates remain quiet', () => {
		using fixture = new NotificationsFixture();
		const handle = fixture.service.notify({ severity: Severity.Info, message: 'Original' });
		handle.updateMessage('Updated'); handle.updateMessage('Updated');
		handle.progress.infinite(); handle.progress.done();
		assert.deepEqual(fixture.presentation.statuses, ['Original', 'Updated']);
		handle.updateSeverity(Severity.Error); handle.updateMessage('Failed');
		assert.deepEqual(fixture.presentation.alerts, ['Failed']);
		handle.close(); handle.updateMessage('Closed');
		const silent = fixture.service.notify({ severity: Severity.Info, message: 'Silent', priority: NotificationPriority.SILENT });
		silent.updateMessage('Silent update');
		assert.deepEqual(fixture.presentation.statuses, ['Original', 'Updated']);
		assert.deepEqual(fixture.presentation.alerts, ['Failed']);
	});

	test('status zero timeout stays visible until its standard close handle is called', () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			using statusbar = new StatusbarService();
			using fixture = new NotificationsFixture(statusbar);
			const first = fixture.service.status('Same text', { hideAfter: 0 });
			mock.timers.tick(10000);
			assert.equal(statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text, 'Same text');
			const next = fixture.service.status('Same text');
			first.close();
			mock.timers.tick(1);
			assert.equal(statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text, 'Same text');
			next.close(); next.close();
			assert.equal(statusbar.getEntries(StatusbarAlignment.Left).length, 0);
		} finally { mock.timers.reset(); }
	});

	test('changing progress total preserves already completed work', () => {
		using service = new TestNotificationService();
		const handle = service.notify({ severity: Severity.Info, message: 'Index', progress: { total: 4, worked: 2 } });
		let updates = 0;
		using listener = service.model.getNotifications()[0]!.onDidChange(() => updates++);
		handle.progress.total(8);
		assert.deepEqual(service.model.getNotifications()[0]?.progress, { total: 8, worked: 2 });
		handle.progress.worked(1);
		handle.progress.total(8);
		assert.deepEqual(service.model.getNotifications()[0]?.progress, { total: 8, worked: 3 });
		assert.equal(updates, 2);
	});

	test('Clear All rechecks progress started during focus restoration', () => {
		using fixture = new NotificationsFixture();
		const handle = fixture.service.notify({ severity: Severity.Info, message: 'About to start' });
		fixture.origin.focus();
		fixture.center.show();
		using listener = addDisposableListener(fixture.origin, 'focus', () => handle.progress.infinite());
		fixture.center.clearAll();
		assert.equal(fixture.service.model.getNotifications().length, 1);
		assert.equal(fixture.service.model.getNotifications()[0]?.hasActiveProgress, true);
	});

	test('center leaves modified, composing and previously consumed Escape to its owner', () => {
		using fixture = new NotificationsFixture();
		fixture.center.show();
		for (const options of [{ altKey: true }, { ctrlKey: true }, { shiftKey: true }, { metaKey: true }, { isComposing: true }]) {
			const event = new fixture.document.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...options });
			fixture.panel.dispatchEvent(event);
			assert.equal(fixture.panel.hidden, false);
			assert.equal(event.defaultPrevented, false);
		}
		const event = new fixture.document.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		event.preventDefault();
		fixture.panel.dispatchEvent(event);
		assert.equal(fixture.panel.hidden, false);
	});

	test('ordinary toast timeouts depend on severity and retain every history record', () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			using fixture = new NotificationsFixture();
			fixture.service.info('Information'); fixture.service.warn('Warning'); fixture.service.error('Error');
			const count = () => fixture.document.querySelectorAll('.ash-notification').length;
			mock.timers.tick(9999); assert.equal(count(), 3);
			mock.timers.tick(1); assert.equal(count(), 2);
			mock.timers.tick(2000); assert.equal(count(), 1);
			mock.timers.tick(3000); assert.equal(count(), 0);
			assert.equal(fixture.service.model.getNotifications().length, 3);
			assert.equal(fixture.service.model.getNotifications().every(item => !item.visible), true);
		} finally { mock.timers.reset(); }
	});

	test('progress and actionable errors remain until their sticky condition ends', () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			using fixture = new NotificationsFixture();
			const progress = fixture.service.notify({ severity: Severity.Info, message: 'Working', progress: { infinite: true } });
			const error = fixture.service.notify({ severity: Severity.Error, message: 'Needs a decision', actions: { primary: [{ id: 'retry', label: 'Retry', tooltip: '', enabled: true, run() { } }] } });
			fixture.service.notify({ severity: Severity.Info, message: 'Pinned', sticky: true });
			mock.timers.tick(30000);
			assert.equal(fixture.document.querySelectorAll('.ash-notification').length, 3);
			progress.progress.done(); error.updateActions();
			mock.timers.tick(15000);
			assert.equal(fixture.document.querySelectorAll('.ash-notification').length, 1);
			assert.equal(fixture.document.querySelector('.ash-notification-message')?.textContent, 'Pinned');
			assert.equal(fixture.service.model.getNotifications().length, 3);
		} finally { mock.timers.reset(); }
	});

	test('hover, keyboard focus and returning window focus protect the reading interval', () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			using fixture = new NotificationsFixture();
			fixture.service.info('Read me');
			const node = fixture.document.querySelector<HTMLElement>('.ash-notification')!;
			node.dispatchEvent(new fixture.document.defaultView!.MouseEvent('mouseenter'));
			mock.timers.tick(10000); assert.equal(node.isConnected, true);
			node.dispatchEvent(new fixture.document.defaultView!.MouseEvent('mouseleave'));
			node.focus(); mock.timers.tick(10000); assert.equal(node.isConnected, true);
			fixture.outside.focus(); fixture.presentation.setHostFocus(false);
			mock.timers.tick(10000); assert.equal(node.isConnected, true);
			fixture.presentation.setHostFocus(true);
			mock.timers.tick(9999); assert.equal(node.isConnected, true);
			mock.timers.tick(1); assert.equal(node.isConnected, false);
		} finally { mock.timers.reset(); }
	});

	test('disposing a presentation releases its pending focus wait and timeout', () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			using fixture = new NotificationsFixture();
			fixture.presentation.setHostFocus(false);
			fixture.service.info('Read after focusing');
			mock.timers.tick(10000);
			fixture.center.dispose();
			fixture.presentation.setHostFocus(true);
			mock.timers.tick(30000);
			assert.equal(fixture.document.querySelectorAll('.ash-notification').length, 0);
			assert.equal(fixture.service.model.getNotifications().length, 1);
		} finally { mock.timers.reset(); }
	});
});
