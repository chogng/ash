import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import type { IContextMenuDelegate, IContextMenuProvider } from "../../browser/contextmenu.js";
import { setHoverDelegate, type HoverDelegateSetupOptions, type IManagedHover } from "../../browser/ui/hover/hoverDelegate.js";
import { ToolBar } from "../../browser/ui/toolbar/toolbar.js";
import type { IAction } from "../../common/actions.js";
import { Separator } from "../../common/actions.js";
import { AnchorPosition } from "../../common/layout.js";

test("ToolBar renders primary actions and trails More Actions", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const contextMenuProvider = new TestContextMenuProvider();
	const toolbar = new ToolBar(dom.window.document.body, {
		contextMenuProvider,
		ariaLabel: "Test actions",
	});
	toolbar.setActions(
		[action("primary")],
		[action("secondary")],
	);
	dom.window.document.body.append(toolbar.element);

	const buttons = toolbar.element.querySelectorAll("button");
	assert.equal(toolbar.element.getAttribute("role"), "toolbar");
	assert.equal(toolbar.element.getAttribute("aria-label"), "Test actions");
	assert.equal(toolbar.element.classList.contains("ash-toolbar-default"), true);
	assert.equal(buttons.length, 2);
	assert.equal(buttons[0]?.textContent, "primary");
	assert.equal(buttons[0]?.getAttribute("aria-label"), "primary");
	assert.equal(buttons[1]?.title, "More Actions");
	assert.equal(buttons[1]?.getAttribute("aria-haspopup"), "menu");
	assert.equal(toolbar.element.textContent?.includes("secondary"), false);

	buttons[1]?.click();
	assert.deepEqual(
		contextMenuProvider.lastOptions?.getActions().map(({ id }) => id),
		["secondary"],
	);
	assert.equal(buttons[1]?.getAttribute("aria-expanded"), "true");
	assert.equal(buttons[1]?.classList.contains("active"), true);
	contextMenuProvider.lastOptions?.onHide?.(false);
	assert.equal(buttons[1]?.getAttribute("aria-expanded"), "false");
	assert.equal(buttons[1]?.classList.contains("active"), false);

	toolbar.dispose();
	dom.window.close();
});

test("ToolBar exposes component-owned foreground presentations", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const toolbar = new ToolBar(dom.window.document.body, {
		contextMenuProvider: new TestContextMenuProvider(),
		presentation: "inherit-foreground",
	});

	assert.equal(toolbar.element.classList.contains("ash-toolbar-inherit-foreground"), true);

	toolbar.dispose();
	dom.window.close();
});

test("ToolBar highlights checked actions only when requested", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const toolbar = new ToolBar(dom.window.document.body, {
		contextMenuProvider: new TestContextMenuProvider(),
		highlightToggledItems: true,
	});
	toolbar.setActions([{ ...action("checked"), checked: true }]);

	const button = toolbar.element.querySelector("button");
	assert.equal(toolbar.element.classList.contains("highlight-toggled"), true);
	assert.equal(button?.classList.contains("checked"), true);
	assert.equal(button?.getAttribute("aria-pressed"), "true");

	toolbar.dispose();
	dom.window.close();
});

test("ToolBar applies its hover anchor position to primary and More Actions items", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const setups: HoverDelegateSetupOptions[] = [];
	using delegateRegistration = setHoverDelegate({
		setupHover(options) {
			setups.push(options);
			return managedHover();
		},
	});
	using toolbar = new ToolBar(dom.window.document.body, {
		contextMenuProvider: new TestContextMenuProvider(),
		hoverAnchorPosition: AnchorPosition.Below,
	});
	toolbar.setActions([action("primary")], [action("secondary")]);

	assert.deepEqual(setups.map(({ anchorPosition }) => anchorPosition), [AnchorPosition.Below, AnchorPosition.Below]);

	dom.window.close();
});

test("ToolBar omits More Actions when secondary actions are empty", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const toolbar = new ToolBar(dom.window.document.body, {
		contextMenuProvider: new TestContextMenuProvider(),
	});
	toolbar.setActions(
		[new Separator(), action("primary"), new Separator()],
		[new Separator()],
	);

	const buttons = toolbar.element.querySelectorAll("button");
	assert.equal(buttons.length, 1);
	assert.equal(buttons[0]?.textContent, "primary");

	toolbar.dispose();
	dom.window.close();
});

test("ToolBar can place More Actions before a named primary action", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const toolbar = new ToolBar(dom.window.document.body, {
		contextMenuProvider: new TestContextMenuProvider(),
		moreActionsPlacement: { beforeActionId: "maximize" },
	});
	toolbar.setActions(
		[action("kill"), action("maximize"), action("close")],
		[action("clear")],
		[action("account"), action("manage")],
	);

	assert.deepEqual(
		[...toolbar.element.querySelectorAll<HTMLElement>("[data-action-id]")]
			.map((item) => item.dataset.actionId),
		["kill", "ash.toolbar.moreActions", "maximize", "close", "account", "manage"],
	);

	toolbar.dispose();
	dom.window.close();
});

class TestContextMenuProvider implements IContextMenuProvider {
	lastOptions: IContextMenuDelegate | undefined;

	showContextMenu(options: IContextMenuDelegate): void {
		this.lastOptions = options;
	}
}

function action(id: string): IAction {
	return {
		id,
		label: id,
		tooltip: id,
		enabled: true,
		run() {},
	};
}

function managedHover(): IManagedHover {
	return {
		visible: false,
		show() {},
		hide() {},
		update() {},
		dispose() {},
		[Symbol.dispose]() {},
	};
}
