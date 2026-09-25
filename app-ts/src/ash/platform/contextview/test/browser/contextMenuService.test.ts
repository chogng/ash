import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { h } from "../../../../base/browser/dom.js";
import type { IAction } from "../../../../base/common/actions.js";
import { type IMenuActionOptions, type IMenuService, MenuId } from "../../../actions/common/actions.js";
import { ContextKeyService, type IContextKeyService } from "../../../contextkey/browser/contextKeyService.js";

test("menu delegates prepend explicit actions and use their context-key scope", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: environment.window,
	});
	const { transformContextMenuDelegate } = await import(
		"../../browser/contextMenuService.js"
	);
	const explicit = action("explicit");
	const contributed = action("contributed");
	using globalContext = new ContextKeyService();
	using scopedContext = globalContext.createScoped(h(environment.window.document, "div"));
	let receivedContext: unknown;
	const menuService = {
		getMenuActions(
			_id: MenuId,
			_options?: IMenuActionOptions,
			contextKeyService?: IContextKeyService,
		) {
			receivedContext = contextKeyService;
			return [["navigation", [contributed]]];
		},
	} as unknown as IMenuService;
	const delegate = transformContextMenuDelegate({
		menuId: MenuId.for("test.contextMenu"),
		contextKeyService: scopedContext,
		getAnchor: () => environment.window.document.body,
		getActions: () => [explicit],
	}, menuService, globalContext);

	assert.deepEqual(
		delegate.getActions().filter((item) => item.id !== "ash.actions.separator"),
		[explicit, contributed],
	);
	assert.equal(receivedContext, scopedContext);
	environment.window.close();
	Reflect.deleteProperty(globalThis, "window");
});

function action(id: string): IAction {
	return {
		id,
		label: id,
		tooltip: id,
		enabled: true,
		run() {},
	};
}
