import { registerTestComponentServices } from '../../../../test/common/testEditorServices.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { darkColorTheme, lightColorTheme } from '../../../../../platform/theme/common/colorTheme.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { setHoverDelegate, type IManagedHover } from "../../../../../base/browser/ui/hover/hoverDelegate.js";
import { Lxicon } from "../../../../../base/common/lxicons.js";
import { StatusbarPart } from "../../../../../workbench/browser/parts/statusbar/statusbarPart.js";
import { StatusbarAlignment, StatusbarService } from "../../../../../workbench/services/statusbar/browser/statusbar.js";

test("status bar entries render an icon before their text", () => {
	const document = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test" }).window.document;
	using service = new StatusbarService();
	using entry = service.addEntry({ icon: Lxicon.gitBranch, text: "main", ariaLabel: "Git branch main" }, { id: "test.branch", alignment: StatusbarAlignment.Left });
	using services = createStatusbarServices(document.body.ownerDocument);
	using part = services.createInstance(StatusbarPart, document.body, service);
	const element = part.domNode.querySelector<HTMLElement>('[data-statusbar-item-id="test.branch"]');
	const label = element?.querySelector<HTMLElement>(".ash-statusbar-item-label");

	assert.ok(element);
	assert.ok(label);
	assert.equal(label.firstElementChild?.tagName.toLowerCase(), "svg");
	assert.equal(element.textContent, "main");
	assert.equal(element.getAttribute("aria-label"), "Git branch main");
	assert.equal(label.getAttribute("role"), "button");
	assert.equal(part.minimumHeight, 32);
	assert.equal(part.maximumHeight, 32);
	assert.equal(part.domNode.getAttribute("role"), "status");
	assert.equal(part.domNode.getAttribute("aria-live"), "off");
	assert.deepEqual([...part.domNode.children].map(element => element.className), [
		"ash-statusbar-items ash-statusbar-items-left",
		"ash-statusbar-items ash-statusbar-items-right",
	]);

	const icon = label.firstElementChild;
	const textNode = label.lastChild;
	entry.update({ icon: Lxicon.gitBranch, text: "develop", ariaLabel: "Git branch develop" });
	assert.equal(label.firstElementChild, icon);
	assert.equal(label.lastChild, textNode);
	assert.equal(textNode?.textContent, "develop");
});

test("status bar entries support accessible icon-only presentation", () => {
	const document = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test" }).window.document;
	using service = new StatusbarService();
	using entry = service.addEntry({ icon: Lxicon.remote, text: "", ariaLabel: "App Server ready", tooltip: "Connected" }, { id: "test.remote", alignment: StatusbarAlignment.Left });
	using services = createStatusbarServices(document.body.ownerDocument);
	using part = services.createInstance(StatusbarPart, document.body, service);
	const element = part.domNode.querySelector<HTMLElement>('[data-statusbar-item-id="test.remote"]');
	const label = element?.querySelector<HTMLElement>(".ash-statusbar-item-label");

	assert.ok(element);
	assert.ok(label);
	assert.ok(element.querySelector("svg.ash-icon"));
	assert.equal(element.classList.contains("icon-only"), true);
	assert.equal(element.textContent, "");
	assert.equal(element.getAttribute("aria-label"), "App Server ready");
	assert.equal(label.title, "Connected");
});

test("status bar entries render grouped segments inside one action", () => {
	const document = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test" }).window.document;
	using service = new StatusbarService();
	using entry = service.addEntry({
		text: "",
		segments: [
			{ icon: Lxicon.error, text: "2" },
			{ icon: Lxicon.warning, text: "1" },
		],
		ariaLabel: "Errors: 2, Warnings: 1",
	}, { id: "test.problems", alignment: StatusbarAlignment.Left });
	using services = createStatusbarServices(document.body.ownerDocument);
	using part = services.createInstance(StatusbarPart, document.body, service);
	const element = part.domNode.querySelector<HTMLElement>('[data-statusbar-item-id="test.problems"]');
	const label = element?.querySelector<HTMLElement>(".ash-statusbar-item-label");
	const segments = label?.querySelectorAll<HTMLElement>(".ash-statusbar-item-segment");

	assert.ok(element);
	assert.ok(label);
	assert.equal(segments?.length, 2);
	assert.deepEqual([...segments ?? []].map(segment => segment.textContent), ["2", "1"]);
	assert.equal(label.querySelectorAll("svg.ash-icon").length, 2);
	assert.equal(label.getAttribute("aria-label"), "Errors: 2, Warnings: 1");

	entry.update({ text: "", segments: [{ icon: Lxicon.error, text: "3" }, { icon: Lxicon.warning, text: "0" }] });
	assert.equal(element.textContent, "30");
});

test("status bar entries compact adjacent members of the same group", () => {
	const dom = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test" });
	const { document } = dom.window;
	using service = new StatusbarService();
	using remote = service.addEntry({ kind: "remote", text: "", run() { } }, { id: "test.remote", alignment: StatusbarAlignment.Left, priority: 3 });
	using branch = service.addEntry({ text: "main", run() { } }, { id: "test.branch", alignment: StatusbarAlignment.Left, priority: 2, compactGroup: "git" });
	using sync = service.addEntry({ icon: Lxicon.sync, text: "2↓ 1↑", run() { } }, { id: "test.sync", alignment: StatusbarAlignment.Left, priority: 1, compactGroup: "git" });
	using problems = service.addEntry({ text: "0" }, { id: "test.problems", alignment: StatusbarAlignment.Left, priority: 0 });
	using services = createStatusbarServices(document.body.ownerDocument);
	using part = services.createInstance(StatusbarPart, document.body, service);
	const branchElement = part.domNode.querySelector<HTMLElement>('[data-statusbar-item-id="test.branch"]');
	const syncElement = part.domNode.querySelector<HTMLElement>('[data-statusbar-item-id="test.sync"]');
	const problemsElement = part.domNode.querySelector<HTMLElement>('[data-statusbar-item-id="test.problems"]');

	assert.ok(branchElement);
	assert.ok(syncElement);
	assert.ok(problemsElement);
	const compactGroup = part.domNode.querySelector<HTMLElement>('[data-compact-group="git"]');
	assert.ok(compactGroup);
	assert.deepEqual([...compactGroup.children], [branchElement, syncElement]);
	assert.deepEqual([...compactGroup.parentElement?.children ?? []], [
		part.domNode.querySelector('[data-statusbar-item-id="test.remote"]'),
		compactGroup,
		problemsElement,
	]);
	assert.equal(branchElement.classList.contains("compact-left"), false);
	assert.equal(branchElement.classList.contains("compact-right"), true);
	assert.equal(syncElement.classList.contains("compact-left"), true);
	assert.equal(syncElement.classList.contains("compact-right"), false);

	branchElement.querySelector(".ash-statusbar-item-label")?.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
	assert.equal(branchElement.classList.contains("compact-entry-hover"), true);
	assert.equal(syncElement.classList.contains("compact-group-hover"), true);
	assert.equal(syncElement.classList.contains("compact-entry-hover"), false);

	syncElement.querySelector(".ash-statusbar-item-label")?.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
	assert.equal(branchElement.classList.contains("compact-group-hover"), true);
	assert.equal(branchElement.classList.contains("compact-entry-hover"), false);
	assert.equal(syncElement.classList.contains("compact-entry-hover"), true);

	syncElement.querySelector(".ash-statusbar-item-label")?.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true }));
	assert.equal(branchElement.classList.contains("compact-group-hover"), false);
	assert.equal(syncElement.classList.contains("compact-group-hover"), false);
	dom.window.close();
});

test("status bar entry updates retain the item shell and activate commands", () => {
	const dom = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test" });
	const { document } = dom.window;
	let activations = 0;
	using service = new StatusbarService();
	using entry = service.addEntry({ text: "main", run: () => activations += 1 }, { id: "test.branch", alignment: StatusbarAlignment.Left });
	using services = createStatusbarServices(document.body.ownerDocument);
	using part = services.createInstance(StatusbarPart, document.body, service);
	const element = part.domNode.querySelector<HTMLElement>('[data-statusbar-item-id="test.branch"]');
	const label = element?.querySelector<HTMLElement>(".ash-statusbar-item-label");
	const textNode = label?.firstChild;

	assert.ok(element);
	assert.ok(label);
	assert.equal(label.tabIndex, -1);
	label.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
	assert.equal(activations, 1);

	entry.update({ text: "detached", run: () => activations += 1 });
	assert.equal(part.domNode.querySelector('[data-statusbar-item-id="test.branch"]'), element);
	assert.equal(element?.querySelector(".ash-statusbar-item-label"), label);
	assert.equal(label?.firstChild, textNode);
	assert.equal(element.textContent, "detached");
	dom.window.close();
});

test("status bar items are focused through the part and activate from the keyboard", () => {
	const dom = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test" });
	const { document } = dom.window;
	let activations = 0;
	using service = new StatusbarService();
	using first = service.addEntry({ text: "first", run: () => activations += 1 }, { id: "test.first", alignment: StatusbarAlignment.Left, priority: 2 });
	using second = service.addEntry({ text: "second", run: () => activations += 1 }, { id: "test.second", alignment: StatusbarAlignment.Left, priority: 1 });
	using services = createStatusbarServices(document.body.ownerDocument);
	using part = services.createInstance(StatusbarPart, document.body, service);
	document.body.append(part.domNode);
	const content = part.domNode;
	const labels = part.domNode.querySelectorAll<HTMLElement>(".ash-statusbar-item-label");

	assert.equal(content.tabIndex, 0);
	assert.equal(labels[0]?.tabIndex, -1);
	assert.equal(labels[1]?.tabIndex, -1);

	part.focusNextEntry();
	assert.equal(document.activeElement, labels[0]);
	part.focusNextEntry();
	assert.equal(document.activeElement, labels[1]);
	part.focusPreviousEntry();
	assert.equal(document.activeElement, labels[0]);

	const enter = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
	labels[0]?.dispatchEvent(enter);
	assert.equal(enter.defaultPrevented, true);
	assert.equal(activations, 1);

	first.update({ text: "read-only" });
	const disabledLabel = part.domNode.querySelector<HTMLElement>('[data-statusbar-item-id="test.first"] .ash-statusbar-item-label');
	assert.ok(disabledLabel);
	assert.equal(disabledLabel.tabIndex, -1);
	assert.equal(disabledLabel.getAttribute("aria-disabled"), "true");
	assert.equal(disabledLabel.classList.contains("disabled"), true);
	disabledLabel.click();
	assert.equal(activations, 1);

	dom.window.close();
});

for (const alignment of [StatusbarAlignment.Left, StatusbarAlignment.Right]) {
	test(`status bar ${alignment === StatusbarAlignment.Left ? "left" : "right"} entries retain the same focused node through updates and regrouping`, () => {
		const browser = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test" });
		try {
			const { document } = browser.window;
			using service = new StatusbarService();
			using entry = service.addEntry({ text: "origin", run() { } }, { id: "test.origin", alignment, priority: 2, compactGroup: "test.group" });
			using peer = service.addEntry({ text: "peer", run() { } }, { id: "test.peer", alignment, priority: 0, compactGroup: "test.group" });
			using services = createStatusbarServices(document);
			using part = services.createInstance(StatusbarPart, document.body, service);
			document.body.append(part.domNode);
			const origin = part.domNode.querySelector<HTMLElement>('[data-statusbar-item-id="test.origin"] .ash-statusbar-item-label')!;
			origin.focus();
			entry.update({ text: "updated", run() { } });
			assert.equal(document.activeElement, origin);
			using inserted = service.addEntry({ text: "between", run() { } }, { id: "test.between", alignment, priority: 1 });
			assert.equal(document.activeElement, origin);
			assert.equal(part.domNode.querySelector('[data-compact-group="test.group"]'), null);
			inserted.dispose();
			assert.equal(document.activeElement, origin);
			assert.ok(part.domNode.querySelector('[data-compact-group="test.group"]')?.contains(origin));
			peer.dispose();
			assert.equal(document.activeElement, origin);
			assert.equal(part.domNode.querySelector('[data-statusbar-item-id="test.origin"] .ash-statusbar-item-label'), origin);
		} finally {
			browser.window.close();
		}
	});
}

test("status bar rendering does not restore a removed focused entry or take outside focus", () => {
	const browser = new JSDOM("<!doctype html><body><button>Outside</button></body>", { url: "https://ash.test" });
	try {
		const { document } = browser.window;
		using service = new StatusbarService();
		using entry = service.addEntry({ text: "origin", run() { } }, { id: "test.origin", alignment: StatusbarAlignment.Left });
		using services = createStatusbarServices(document);
		using part = services.createInstance(StatusbarPart, document.body, service);
		document.body.append(part.domNode);
		const origin = part.domNode.querySelector<HTMLElement>(".ash-statusbar-item-label")!;
		const outside = document.querySelector<HTMLButtonElement>("button")!;
		outside.focus();
		entry.update({ text: "updated", run() { } });
		assert.equal(document.activeElement, outside);
		origin.focus();
		entry.dispose();
		assert.equal(origin.isConnected, false);
		assert.equal(document.activeElement, document.body);
		using replacement = service.addEntry({ text: "replacement", run() { } }, { id: "test.origin", alignment: StatusbarAlignment.Left });
		assert.equal(document.activeElement, document.body);
		assert.notEqual(part.domNode.querySelector(".ash-statusbar-item-label"), origin);
	} finally {
		browser.window.close();
	}
});

test("status bar rendering preserves focus explicitly moved outside during an entry update", () => {
	const browser = new JSDOM("<!doctype html><body><button>Outside</button></body>", { url: "https://ash.test" });
	try {
		const { document } = browser.window;
		const outside = document.querySelector<HTMLButtonElement>("button")!;
		let moveFocus = false;
		using delegateRegistration = setHoverDelegate({
			setupDelayedHover() { throw new Error("Unexpected delayed hover registration"); },
			setupHover() {
				if (moveFocus) outside.focus();
				return managedHover();
			},
		});
		using service = new StatusbarService();
		using entry = service.addEntry({ text: "origin", tooltip: "before", run() { } }, { id: "test.origin", alignment: StatusbarAlignment.Left });
		using services = createStatusbarServices(document);
		using part = services.createInstance(StatusbarPart, document.body, service);
		document.body.append(part.domNode);
		const origin = part.domNode.querySelector<HTMLElement>(".ash-statusbar-item-label")!;
		origin.focus();
		moveFocus = true;
		entry.update({ text: "updated", tooltip: "after", run() { } });
		assert.equal(origin.isConnected, true);
		assert.equal(document.activeElement, outside);
	} finally {
		browser.window.close();
	}
});

test("status bar item tooltips use the managed statusbar hover group", () => {
	const dom = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test" });
	const setups: Array<{ target: HTMLElement; content: unknown; groupId?: string; }> = [];
	using delegateRegistration = setHoverDelegate({
		setupDelayedHover() { throw new Error("Unexpected delayed hover registration"); },
		setupHover(options) {
			setups.push(options);
			return managedHover();
		},
	});
	using service = new StatusbarService();
	using entry = service.addEntry({ text: "main", tooltip: "Git branch main" }, { id: "test.branch", alignment: StatusbarAlignment.Left });
	using services = createStatusbarServices(dom.window.document.body.ownerDocument);
	using part = services.createInstance(StatusbarPart, dom.window.document.body, service);
	const label = part.domNode.querySelector<HTMLElement>(".ash-statusbar-item-label");

	assert.ok(label);
	assert.equal(setups.length, 1);
	assert.equal(setups[0]?.target, label);
	assert.equal(setups[0]?.content, "Git branch main");
	assert.equal(setups[0]?.groupId, "statusbar");

	entry.update({ text: "develop", tooltip: "Git branch main" });
	assert.equal(setups.length, 1);
	entry.update({ text: "develop", tooltip: "Git branch develop" });
	assert.equal(setups.length, 2);

	dom.window.close();
});

function managedHover(): IManagedHover {
	return {
		visible: false,
		show() { },
		hide() { },
		update() { },
		dispose() { },
		[Symbol.dispose]() { },
	};
}

function createStatusbarServices(document: Document): InstantiationService {
	const services = new InstantiationService();
	services.registerSingleton(IThemeService, () => new TestThemeService(darkColorTheme));
	services.registerSingleton(IStorageService, () => new BrowserStorageService({ ownerWindow: document.defaultView!, workspaceId: 'statusbar-test', backend: document.defaultView!.localStorage, flushInterval: 0 }));
	return registerTestComponentServices(services, document);
}

test('Part saves live state before storage flush and releases theme and save listeners with its DOM', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	try {
		using services = createStatusbarServices(browser.window.document);
		using entries = new StatusbarService();
		using part = services.createInstance(StatefulStatusbar, browser.window.document.body, entries);
		const storage = services.get(IStorageService);
		const themes = services.get(IThemeService) as TestThemeService;
		assert.equal(part.getId(), 'statusbar');
		assert.equal(part.themeId, darkColorTheme.id);
		themes.setColorTheme(lightColorTheme);
		assert.equal(part.themeId, lightColorTheme.id);
		assert.equal(part.styleUpdates, 1);
		await storage.flush();
		assert.deepEqual(JSON.parse(storage.get('memento/statusbar', StorageScope.WORKSPACE)!), { saves: 1 });
		part.dispose();
		themes.setColorTheme(darkColorTheme);
		await storage.flush();
		assert.equal(part.styleUpdates, 1);
		assert.equal(part.domNode.isConnected, false);
		assert.deepEqual(JSON.parse(storage.get('memento/statusbar', StorageScope.WORKSPACE)!), { saves: 1 });
	} finally {
		browser.window.close();
	}
});

class StatefulStatusbar extends StatusbarPart {
	public styleUpdates = 0;
	private saves = 0;
	public get themeId(): string { return this.theme.id; }
	public override updateStyles(): void { this.styleUpdates++; }
	protected override saveState(): void {
		Object.assign(this.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE), { saves: ++this.saves });
	}
}
