import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { INotificationService, NotificationSeverity, type NotificationAction } from "../../../../../platform/notification/common/notification.js";
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
import { IStorageService } from "../../../../../platform/storage/common/storage.js";
import { BrowserStorageService } from "../../../storage/browser/storageService.js";
import { registerTestComponentServices } from "../../../../test/common/testEditorServices.js";
import { StatusbarPart } from "../../../../browser/parts/statusbar/statusbarPart.js";
import { INotificationsCenter, NotificationsCenter } from "../../../../browser/parts/notifications/notificationsCenter.js";
import { NotificationActionRunner } from "../../../../browser/parts/notifications/notificationsCommands.js";
import { CommandService } from "../../../commands/common/commandService.js";
import { StatusbarAlignment, StatusbarService } from "../../../statusbar/browser/statusbar.js";
import { NotificationService } from "../../common/notificationService.js";
import { Event } from '../../../../../base/common/event.js';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { BrowserClipboardService } from '../../../../../platform/clipboard/browser/clipboardService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { BrowserContextMenuService } from '../../../../../platform/contextview/browser/contextMenuService.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { CopyNotificationMessageAction } from '../../../../browser/parts/notifications/notificationsActions.js';
import type { INativeContextMenuApi, INativeContextMenuRequest, INativeContextMenuResult } from '../../../../../base/parts/contextmenu/common/contextmenu.js';
import { ElectronContextMenuService } from '../../../contextmenu/electron-browser/contextMenuService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import chineseMessages from '../../../../../../../localization/zh-CN/editor.json' with { type: 'json' };

test('duplicate action IDs reject the entire notification before publishing a record', () => {
	using service = new NotificationService();
	const action = { id: 'duplicate', label: 'Action', run() { } };
	assert.throws(() => service.info('Invalid actions', [action, action]), /Duplicate notification action ID: duplicate/);
	assert.deepEqual(service.getNotifications(), []);
});

test('Chinese notification severity, message and removal labels agree between toast and center', () => {
	setNlsMessages('zh-CN', chineseMessages);
	try {
		using fixture = new NotificationsFixture();
		const text = '导入失败时应保留可诊断的信息。'.repeat(20);
		const labels = ['信息', '警告', '错误'];
		for (const severity of [NotificationSeverity.Info, NotificationSeverity.Warning, NotificationSeverity.Error]) fixture.service.notify({ severity, message: text, source: '执行跟踪' });
		const inspect = (selector: string) => [...fixture.document.querySelectorAll<HTMLElement>(selector)].map(row => ({
			label: row.getAttribute('aria-label'),
			message: row.querySelector('.ash-notification-message')?.textContent,
			source: row.querySelector('.ash-notification-source')?.textContent,
			icon: row.querySelector('.ash-notification-severity svg')?.getAttribute('data-ash-icon-id'),
			close: row.querySelector('button')?.getAttribute('aria-label'),
			quiet: row.querySelector('button')?.classList.contains('ash-button-quiet'),
		}));
		const expected = labels.map((label, index) => ({ label: `${label}: ${text}`, message: text, source: '执行跟踪', icon: ['info', 'warning', 'error'][index], close: '移除通知', quiet: true }));
		assert.deepEqual(inspect('.ash-notification'), expected);
		fixture.center.show();
		assert.deepEqual(inspect('.ash-notifications-row'), [...expected].reverse());
	} finally { resetNlsResolver(); }
});

test("clearing a toast removes only its shared record from the notification center", async () => {
	const browser = new JSDOM("<!doctype html><body><main></main></body>");
	try {
		using service = new NotificationService();
		using runner = createNotificationActionRunner(service);
		const root = browser.window.document.querySelector<HTMLElement>("main")!;
		using presentation = new NotificationsPresentation(root, root, service, runner);
		const center = presentation.center;
		const toggle = root.querySelector<HTMLButtonElement>(".ash-notifications-toggle")!;
		assert.equal(toggle.textContent, "Notifications");
		assert.equal(toggle.hidden, true);
		assert.equal(toggle.classList.contains('hidden'), true);
		let actionRuns = 0;
		const removed: number[] = [];
		service.onDidRemove(item => removed.push(item.id));
		const handle = service.notify({ severity: NotificationSeverity.Warning, message: "Workspace needs attention", source: "fixture", actions: [{ id: "open", label: "Open", run: () => { actionRuns++; } }] });
		assert.equal(toggle.hidden, false);
		assert.equal(toggle.classList.contains('hidden'), false);
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
		using presentation = new NotificationsPresentation(document.body, document.body, service, runner);
		const center = presentation.center;
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
		using presentation = new NotificationsPresentation(browser.window.document.body, browser.window.document.body, service, runner);
		const center = presentation.center;
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

for (const control of ["action", "remove"] as const) {
	for (const change of ["add", "remove"] as const) {
		test(`a retained toast ${control} keeps focus when another record changes by ${change}`, () => {
			using fixture = new NotificationsFixture();
			const { document, service } = fixture;
			const retained = service.info("Retained", [
				{ id: "first", label: "Same label", run() { } },
				{ id: "second", label: "Same label", run() { } },
			]);
			const other = service.info("Other");
			toastControl(document, retained.item.id, control)!.focus();
			if (change === "add") service.info("Added");
			else other.close();
			assert.equal(document.activeElement, toastControl(document, retained.item.id, control));
			assert.equal(service.getNotifications().includes(retained.item), true);
		});
	}
	for (const retained of [false, true]) {
		test(`the three-toast limit ${retained ? "preserves retained" : "does not restore evicted"} ${control} focus`, () => {
			using fixture = new NotificationsFixture();
			const { document, service } = fixture;
			const handles = ["First", "Second", "Third"].map(message => service.info(message, [{ id: "action", label: "Action", run() { } }]));
			const focused = handles[retained ? 1 : 0];
			toastControl(document, focused.item.id, control)!.focus();
			const last = service.info("Fourth");
			assert.equal(document.activeElement, retained ? toastControl(document, focused.item.id, control) : document.body);
			assert.equal(toastControl(document, handles[0].item.id, "remove"), undefined);
			assert.deepEqual([...document.querySelectorAll<HTMLElement>("[data-notification-close]")].map(element => Number(element.dataset.notificationClose)), [handles[1].item.id, handles[2].item.id, last.item.id]);
			assert.deepEqual(service.getNotifications().map(item => item.id), [...handles.map(handle => handle.item.id), last.item.id]);
		});
	}
	test(`closing a focused toast ${control} through its handle does not select a different control`, () => {
		using fixture = new NotificationsFixture();
		const { document, service } = fixture;
		const focused = service.info("Removed", [{ id: "action", label: "Action", run() { } }]);
		service.info("Other");
		toastControl(document, focused.item.id, control)!.focus();
		focused.close();
		assert.equal(document.activeElement, document.body);
		assert.equal(toastControl(document, focused.item.id, control), undefined);
	});
}

test("toast record changes leave outside focus alone and disposal releases focus ownership", () => {
	using fixture = new NotificationsFixture();
	const { document, service, center, outside } = fixture;
	const first = service.info("First");
	outside.focus();
	service.info("Second");
	first.close();
	assert.equal(document.activeElement, outside);
	center.dispose();
	service.info("After disposal");
	service.clear();
	assert.equal(document.activeElement, outside);
	assert.equal(document.querySelector(".ash-notification-host"), null);
});

test("activating another toast removal preserves the still-focused action", () => {
	using fixture = new NotificationsFixture();
	const { document, service } = fixture;
	const retained = service.info("Retained", [{ id: "action", label: "Action", run() { } }]);
	const other = service.info("Removed");
	toastControl(document, retained.item.id, "action")!.focus();
	toastControl(document, other.item.id, "remove")!.click();
	assert.equal(document.activeElement, toastControl(document, retained.item.id, "action"));
});

for (const dispose of [false, true]) {
	test(`toast removal does not steal focus after a reentrant ${dispose ? "disposal" : "center open"}`, () => {
		using fixture = new NotificationsFixture();
		const { document, service, center, outside, panel, origin } = fixture;
		const first = service.info("Removed");
		service.info("Retained");
		origin.focus();
		toastControl(document, first.item.id, "remove")!.focus();
		using listener = service.onDidRemove(() => {
			if (dispose) { center.dispose(); outside.focus(); }
			else center.show();
		});
		toastControl(document, first.item.id, "remove")!.click();
		assert.equal(document.activeElement, dispose ? outside : panel);
		assert.equal(document.querySelectorAll(".ash-notification-host .ash-notification").length, 0);
	});
}

test("a center opened during notification arrival keeps focus and hides every toast", () => {
	using fixture = new NotificationsFixture();
	const { document, service, center, panel } = fixture;
	const retained = service.info("Retained", [{ id: "action", label: "Action", run() { } }]);
	toastControl(document, retained.item.id, "action")!.focus();
	using listener = service.onDidAdd(() => center.show());
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
	test(`toast Escape ${control === "remove" ? "from a focused remove hides the presentation" : "leaves a focused action unchanged"}, preserves history, and admits new notifications`, () => {
		using fixture = new NotificationsFixture();
		const { document, service, center, panel, origin } = fixture;
		// jsdom has no layout. Real visibility and keyboard input are covered in smoke tests.
		origin.checkVisibility = () => true;
		let actionRuns = 0;
		const first = service.info("First", [{ id: "action", label: "Action", run() { actionRuns++; } }]);
		const second = service.info("Second");
		let removals = 0;
		using listener = service.onDidRemove(() => removals++);
		origin.focus();
		const target = toastControl(document, first.item.id, control)!;
		target.focus();
		const escape = new document.defaultView!.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		target.dispatchEvent(escape);
		assert.deepEqual({
			toasts: document.querySelectorAll(".ash-notification-host .ash-notification").length,
			history: service.getNotifications(), removals, actionRuns,
			controlFocused: document.activeElement === (control === "remove" ? origin : target), consumed: escape.defaultPrevented,
		}, { toasts: control === "remove" ? 0 : 2, history: [first.item, second.item], removals: 0, actionRuns: 0, controlFocused: true, consumed: control === "remove" });
		const next = service.info("Next");
		assert.deepEqual([...document.querySelectorAll<HTMLElement>(".ash-notification-host [data-notification-id]")].map(item => Number(item.dataset.notificationId)), control === "remove" ? [next.item.id] : [first.item.id, second.item.id, next.item.id]);
		center.show();
		assert.deepEqual([...panel.querySelectorAll<HTMLElement>("[data-notification-id]")].map(item => Number(item.dataset.notificationId)), [next.item.id, second.item.id, first.item.id]);
		center.hide();
		assert.equal(document.querySelectorAll(".ash-notification-host .ash-notification").length, 0);
	});

	test(`toast Escape from a focused ${control} leaves consumed, modified, and composing input to its owner`, () => {
		using fixture = new NotificationsFixture();
		const { document, service, origin } = fixture;
		const handle = service.info("Retained", [{ id: "action", label: "Action", run() { assert.fail("Escape must not run an action"); } }]);
		origin.focus();
		const target = toastControl(document, handle.item.id, control)!;
		target.focus();
		for (const options of [{ key: "Enter" }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { consumed: true }]) {
			const escape = new document.defaultView!.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...options });
			if ("consumed" in options) escape.preventDefault();
			target.dispatchEvent(escape);
			assert.equal(document.activeElement, target);
			assert.equal(document.querySelectorAll(".ash-notification-host .ash-notification").length, 1);
			assert.deepEqual(service.getNotifications(), [handle.item]);
			assert.equal(escape.defaultPrevented, "consumed" in options);
		}
	});
}

for (const unavailable of ["removed", "hidden", "hidden ancestor", "inert", "disabled", "aria hidden", "no visible layout"] as const) {
	test(`toast Escape keeps history without restoring a source that is ${unavailable}`, () => {
		using fixture = new NotificationsFixture();
		const { document, service, origin } = fixture;
		origin.checkVisibility = () => unavailable !== "no visible layout";
		const handle = service.info("Retained");
		origin.focus();
		const target = toastControl(document, handle.item.id, "remove")!;
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
		assert.deepEqual(service.getNotifications(), [handle.item]);
	});
}

for (const transition of ["outside", "center", "dispose"] as const) {
	test(`toast Escape does not reclaim focus when ${transition} owns the input before it bubbles`, () => {
		using fixture = new NotificationsFixture();
		const { document, service, center, panel, origin, outside } = fixture;
		origin.checkVisibility = () => true;
		const handle = service.info("Retained");
		origin.focus();
		const target = toastControl(document, handle.item.id, "remove")!;
		target.focus();
		using listener = addDisposableListener(target, "keydown", () => {
			if (transition === "center") center.show();
			else { if (transition === "dispose") center.dispose(); outside.focus(); }
		});
		const escape = new document.defaultView!.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		target.dispatchEvent(escape);
		assert.equal(document.activeElement, transition === "center" ? panel : outside);
		assert.equal(escape.defaultPrevented, false);
		assert.deepEqual(service.getNotifications(), [handle.item]);
	});

	test(`toast Escape does not reclaim focus when ${transition} takes ownership during DOM removal`, () => {
		using fixture = new NotificationsFixture();
		const { document, service, center, panel, origin, outside } = fixture;
		origin.checkVisibility = () => true;
		const handle = service.info("Retained");
		origin.focus();
		const target = toastControl(document, handle.item.id, "remove")!;
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
		assert.deepEqual(service.getNotifications(), [handle.item]);
	});
}

test("toast Escape applies only to a currently focused toast control", () => {
	using fixture = new NotificationsFixture();
	const { document, service, outside } = fixture;
	const handle = service.info("Retained");
	const target = toastControl(document, handle.item.id, "remove")!;
	outside.focus();
	const staleInput = new document.defaultView!.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
	target.dispatchEvent(staleInput);
	const content = target.closest("article")!.querySelector<HTMLElement>(".ash-notification-content")!;
	content.tabIndex = 0;
	content.focus();
	const contentInput = new document.defaultView!.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
	content.dispatchEvent(contentInput);
	assert.deepEqual({ consumed: [staleInput.defaultPrevented, contentInput.defaultPrevented], toasts: document.querySelectorAll(".ash-notification-host .ash-notification").length, history: service.getNotifications() }, {
		consumed: [false, false], toasts: 1, history: [handle.item],
	});
});

test("notification accessibility help explains toast Escape and retained history", () => {
	using fixture = new NotificationsFixture();
	using services = new InstantiationService();
	services.registerInstance(INotificationsCenter, fixture.center);
	const implementation = AccessibleViewRegistry.getImplementations().find(item => item.name === "notificationsHelp")!;
	using provider = implementation.getProvider(services)!;
	assert.match(provider.provideContent(), /When the Remove notification button in a toast has focus, press Escape to hide the toasts without removing them from history\./);
	assert.match(provider.provideContent(), /Context Menu key or Shift\+F10, and choose Copy Text to copy its message/);
	assert.match(provider.provideContent(), /Press Escape to close the menu and return to the notification/);
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
		using presentation = new NotificationsPresentation(browser.window.document.body, browser.window.document.body, service, runner, statusbar);
		const center = presentation.center;
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
	readonly presentation: NotificationsPresentation;

	constructor(statusbar?: StatusbarService, systemMenu?: INativeContextMenuApi) {
		super();
		const browser = new JSDOM("<!doctype html><body><button id='origin'>Origin</button><button id='outside'>Outside</button></body>", { url: "https://ash.test" });
		this._register(toDisposable(() => browser.window.close()));
		this.document = browser.window.document;
		this.origin = this.document.querySelector<HTMLButtonElement>("#origin")!;
		this.outside = this.document.querySelector<HTMLButtonElement>("#outside")!;
		this.service = this._register(new NotificationService());
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
	writeText = async (text: string): Promise<void> => { this.writes.push(text); };

	constructor(root: HTMLElement, toastContainer: HTMLElement, service: NotificationService, runner: NotificationActionRunner, statusbar?: StatusbarService, systemMenu?: INativeContextMenuApi) {
		super();
		const window = root.ownerDocument.defaultView!;
		// jsdom lacks layout and scrolling; context-view focus restoration requires a painted anchor.
		Object.defineProperty(window.Element.prototype, 'scrollTo', { configurable: true, value: () => { } });
		Object.defineProperty(window.Element.prototype, 'getClientRects', { configurable: true, value: () => [new window.DOMRect(0, 0, 100, 20)] });
		this.services = this._register(new InstantiationService());
		this.services.registerInstance(INotificationService, service);
		this.services.registerInstance(IContextKeyService, this._register(new ContextKeyService()));
		this.services.registerInstance(IClipboardService, new BrowserClipboardService({ writeText: text => this.writeText(text) } as Clipboard));
		this.services.registerInstance(ICommandService, this._register(new CommandService(this.services)));
		this.services.registerInstance(IMenuService, this.services.createInstance(MenuService));
		this.views = this._register(new BrowserContextViewService(root));
		this.services.registerInstance(IContextViewService, this.views);
		this.services.registerInstance(IKeybindingService, {
			inChordMode: false, onDidUpdateKeybindings: Event.None,
			getKeybindings: () => [], registerSchemaContribution: () => Disposable.None,
			resolveKeybinding() { throw new Error('No binding in this fixture'); },
			resolveUserBinding: () => undefined, lookupKeybindings: () => [], lookupKeybinding: () => undefined,
		});
		if (systemMenu) {
			const registry = new ConfigurationRegistry();
			registry.registerConfiguration({ key: 'window.menuStyle', defaultValue: 'system', parse: value => value });
			// Linux and Windows require a system title bar to use the Electron popup API.
			registry.registerConfiguration({ key: 'window.titleBarStyle', defaultValue: 'system', parse: value => value });
			this.services.registerInstance(IConfigurationService, this._register(new InMemoryConfigurationService(registry)));
		}
		this.menus = this._register(systemMenu ? this.services.createInstance(ElectronContextMenuService, systemMenu) : this.services.createInstance(BrowserContextMenuService));
		this.services.registerInstance(IContextMenuService, this.menus);
		this.center = this._register(this.services.createInstance(NotificationsCenter, root, toastContainer, runner, statusbar, undefined));
	}
}

function createNotificationActionRunner(service: NotificationService): NotificationActionRunner {
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
	assert.throws(() => services.createInstance(NotificationsCenter, fixture.document.body, fixture.document.body, fixture.runner, undefined, undefined), /Unknown service: notificationService/);
	using incomplete = new InstantiationService();
	incomplete.registerInstance(INotificationService, fixture.service);
	incomplete.registerInstance(IContextKeyService, fixture.presentation.services.get(IContextKeyService));
	assert.throws(() => incomplete.createInstance(NotificationsCenter, fixture.document.body, fixture.document.body, fixture.runner, undefined, undefined), /Unknown service: contextMenuService/);
});

for (const input of ['mouse', 'ContextMenu', 'Shift+F10'] as const) {
	test(`notification ${input} copies the raw message without source, actions, or presentation text`, async () => {
		using fixture = new NotificationsFixture();
		const message = 'First line\n[链接](https://example.test) <b>literal</b>\n第二行\t🙂';
		const handle = fixture.service.notify({ severity: NotificationSeverity.Warning, message, source: 'Excluded source', actions: [{ id: 'primary', label: 'Excluded action', run() { } }] });
		const copied = promiseWithResolvers<void>();
		fixture.presentation.writeText = async value => { fixture.presentation.writes.push(value); copied.resolve(); };
		const row = openCopyMenu(fixture, handle.item.id, input);
		const menuItem = fixture.document.querySelector<HTMLElement>('[role="menuitem"]')!;
		assert.equal(menuItem.textContent, 'Copy Text');
		menuItem.click();
		await copied.promise;
		assert.deepEqual({ writes: fixture.presentation.writes, history: fixture.service.getNotifications(), centerHidden: fixture.panel.hidden, focused: fixture.document.activeElement }, {
			writes: [message], history: [handle.item], centerHidden: false, focused: row,
		});
	});
}

test('Escape dismisses only the copy menu, returns to its row, and then closes the center', () => {
	using fixture = new NotificationsFixture();
	const handle = fixture.service.info('Retained after cancel');
	fixture.origin.focus();
	const row = openCopyMenu(fixture, handle.item.id);
	fixture.document.activeElement!.dispatchEvent(new fixture.document.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	assert.deepEqual({ menu: fixture.document.querySelector('[role="menu"]'), centerHidden: fixture.panel.hidden, focused: fixture.document.activeElement, writes: fixture.presentation.writes, history: fixture.service.getNotifications() }, {
		menu: null, centerHidden: false, focused: row, writes: [], history: [handle.item],
	});
	row.dispatchEvent(new fixture.document.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	assert.equal(fixture.panel.hidden, true);
	assert.equal(fixture.document.activeElement, fixture.origin);
});

for (const change of ['add', 'remove', 'hide', 'clear', 'dispose'] as const) {
	test(`center ${change} invalidates its browser copy menu and prevents an old menu item from writing`, async () => {
		using fixture = new NotificationsFixture();
		const handle = fixture.service.info('Original');
		openCopyMenu(fixture, handle.item.id);
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
	const handle = fixture.service.info('Original');
	openCopyMenu(fixture, handle.item.id);
	fixture.presentation.menus.showContextMenu({ getAnchor: () => fixture.outside, getActions: () => [{ id: 'other', label: 'Other menu', tooltip: '', enabled: true, run() { } }] });
	fixture.service.info('Rerender');
	fixture.center.hide();
	assert.deepEqual({ label: fixture.document.querySelector('[role="menuitem"]')?.textContent, writes: fixture.presentation.writes }, { label: 'Other menu', writes: [] });
});

test('copy menu cancellation preserves focus owned by a different dialog', () => {
	using fixture = new NotificationsFixture();
	const handle = fixture.service.info('Original');
	openCopyMenu(fixture, handle.item.id);
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
	const firstItem = first.service.info('First window');
	const secondItem = second.service.info('Second window');
	openCopyMenu(first, firstItem.item.id);
	openCopyMenu(second, secondItem.item.id);
	first.center.clearAll();
	second.document.querySelector<HTMLElement>('[role="menuitem"]')!.click();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual({ first: first.presentation.writes, second: second.presentation.writes, history: second.service.getNotifications() }, { first: [], second: ['Second window'], history: [secondItem.item] });
});

test('menu selection keeps an in-flight clipboard failure observable once after the center hides', async () => {
	using fixture = new NotificationsFixture();
	const handle = fixture.service.info('Original');
	const started = promiseWithResolvers<void>();
	const write = promiseWithResolvers<void>();
	const reported = promiseWithResolvers<void>();
	fixture.presentation.writeText = async value => { fixture.presentation.writes.push(value); started.resolve(); await write.promise; };
	fixture.service.onDidAdd(item => { if (item.severity === NotificationSeverity.Error) reported.resolve(); });
	openCopyMenu(fixture, handle.item.id);
	fixture.document.querySelector<HTMLElement>('[role="menuitem"]')!.click();
	await started.promise;
	fixture.center.hide();
	handle.close();
	write.reject(new Error('Clipboard permission denied'));
	await reported.promise;
	assert.deepEqual({ writes: fixture.presentation.writes, messages: fixture.service.getNotifications().map(item => item.message) }, { writes: ['Original'], messages: ['Clipboard permission denied'] });
});

test('window menu disposal suppresses late clipboard failure feedback without canceling the write', async () => {
	using fixture = new NotificationsFixture();
	const handle = fixture.service.info('Original');
	const started = promiseWithResolvers<void>();
	const write = promiseWithResolvers<void>();
	fixture.presentation.writeText = async value => { fixture.presentation.writes.push(value); started.resolve(); await write.promise; };
	openCopyMenu(fixture, handle.item.id);
	fixture.document.querySelector<HTMLElement>('[role="menuitem"]')!.click();
	await started.promise;
	fixture.presentation.dispose();
	write.reject(new Error('Late clipboard failure'));
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual({ writes: fixture.presentation.writes, history: fixture.service.getNotifications() }, { writes: ['Original'], history: [handle.item] });
});

for (const change of ['add', 'remove', 'hide', 'clear', 'dispose'] as const) {
	test(`center ${change} cancels its system popup and ignores its delayed selection`, async () => {
		const popup = promiseWithResolvers<INativeContextMenuResult>();
		const requests: INativeContextMenuRequest[] = [];
		let closed = 0;
		using fixture = new NotificationsFixture(undefined, { popup: request => { requests.push(request); return popup.promise; }, async close() { closed++; } });
		const handle = fixture.service.info('Original');
		openCopyMenu(fixture, handle.item.id);
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
	const handle = fixture.service.info('System message\n第二行');
	const reported = promiseWithResolvers<void>();
	fixture.presentation.writeText = async value => { fixture.presentation.writes.push(value); throw new Error('System clipboard denied'); };
	fixture.service.onDidAdd(item => { if (item.severity === NotificationSeverity.Error) reported.resolve(); });
	openCopyMenu(fixture, handle.item.id);
	const action = (await request.promise).items[0];
	assert.ok(action.type === 'action');
	popup.resolve({ selectedId: action.id });
	await reported.promise;
	assert.deepEqual({ writes: fixture.presentation.writes, messages: fixture.service.getNotifications().map(item => item.message) }, { writes: ['System message\n第二行'], messages: ['System message\n第二行', 'System clipboard denied'] });
});

test('system Copy Text releases its presentation before starting the selected write without canceling it', async () => {
	const popup = promiseWithResolvers<INativeContextMenuResult>();
	let request: INativeContextMenuRequest | undefined;
	let closeRequests = 0;
	using fixture = new NotificationsFixture(undefined, { popup: value => { request = value; return popup.promise; }, async close() { closeRequests++; } });
	const handle = fixture.service.info('Selected system message\n第二行');
	const order: string[] = [];
	const write = promiseWithResolvers<void>();
	using hidden = fixture.presentation.menus.onDidHideContextMenu(() => order.push('hide'));
	fixture.presentation.writeText = async value => { order.push('write'); fixture.presentation.writes.push(value); await write.promise; };
	openCopyMenu(fixture, handle.item.id);
	const selected = request!.items[0];
	assert.ok(selected.type === 'action');
	popup.resolve({ selectedId: selected.id });
	try {
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual({ order, writes: fixture.presentation.writes, closeRequests }, { order: ['hide', 'write'], writes: ['Selected system message\n第二行'], closeRequests: 0 });
		fixture.center.hide();
		assert.deepEqual({ writes: fixture.presentation.writes, closeRequests, messages: fixture.service.getNotifications().map(item => item.message) }, { writes: ['Selected system message\n第二行'], closeRequests: 0, messages: ['Selected system message\n第二行'] });
	} finally { write.resolve(); }
});

test('notification center creation retains startup history and the three-toast limit', () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	try {
		using service = new NotificationService();
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

for (const useCenter of [false, true]) {
	for (const change of ['remove', 'dispose'] as const) {
		test(`${useCenter ? 'center' : 'toast'} ${change} releases stale action controls and queued callbacks`, async () => {
			using fixture = new NotificationsFixture();
			let calls = 0;
			const handle = fixture.service.info('Task', [{ id: 'task', label: 'Run task', run() { calls++; } }]);
			if (useCenter) fixture.center.show();
			const button = fixture.document.querySelector<HTMLButtonElement>(`${useCenter ? '.ash-notifications-center' : '.ash-notification-host'} .ash-notification-action`)!;
			button.click();
			if (change === 'remove') handle.close();
			else fixture.center.dispose();
			button.click();
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(calls, 0);
		});
	}

	test(`${useCenter ? 'center' : 'toast'} repeated actions and a center transition start the shared task once`, async () => {
		using fixture = new NotificationsFixture();
		const started = promiseWithResolvers<void>();
		const completion = promiseWithResolvers<void>();
		let calls = 0;
		fixture.service.info('Pending task', [{ id: 'pending', label: 'Start', async run() { calls++; started.resolve(); await completion.promise; } }]);
		if (useCenter) fixture.center.show();
		const button = fixture.document.querySelector<HTMLButtonElement>(`${useCenter ? '.ash-notifications-center' : '.ash-notification-host'} .ash-notification-action`)!;
		try {
			button.click();
			button.click();
			await started.promise;
			fixture.center.show();
			fixture.service.info('Background arrival');
			fixture.panel.querySelector<HTMLButtonElement>('.ash-notification-action')!.click();
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(calls, 1);
		} finally { completion.resolve(); }
	});
}

test('center arrivals retain the focused action control', () => {
	using fixture = new NotificationsFixture();
	fixture.service.info('Retained task', [{ id: 'task', label: 'Run', run() { } }]);
	fixture.center.show();
	const button = fixture.panel.querySelector<HTMLButtonElement>('.ash-notification-action')!;
	button.focus();
	fixture.service.info('Another record');
	assert.equal(fixture.document.activeElement, button);
});

test('a shared action can be retried after one failed attempt without duplicate error records', async () => {
	using fixture = new NotificationsFixture();
	let calls = 0;
	const action: NotificationAction = { id: 'retry', label: 'Retry', async run() { calls++; if (calls === 1) throw new Error('First attempt failed'); } };
	await Promise.all([fixture.runner.runNotificationAction(action), fixture.runner.runNotificationAction(action)]);
	await fixture.runner.runNotificationAction(action);
	assert.deepEqual({ calls, messages: fixture.service.getNotifications().map(item => item.message) }, { calls: 2, messages: ['First attempt failed'] });
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
