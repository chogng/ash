import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { h } from "../../../base/browser/dom.js";

const mainEnvironment = new JSDOM(
	"<!doctype html><html><head></head><body></body></html>",
);
for (const [name, value] of Object.entries({
	window: mainEnvironment.window,
	document: mainEnvironment.window.document,
	Node: mainEnvironment.window.Node,
	MutationObserver: mainEnvironment.window.MutationObserver,
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const {
	isRegisteredWindow,
} = await import("../../../base/browser/window.js");
const {
	WorkbenchState,
} = await import(
	"../../../platform/workspace/common/workspace.js"
);
const {
	errorHandler,
	setUnexpectedErrorHandler,
} = await import("../../../base/common/errors.js");
const {
	WorkbenchWindow,
} = await import("../../../workbench/browser/window.js");

test(
	"WorkbenchWindow owns root identity and secondary document integration",
	async () => {
		const mainStyle =
			h(mainEnvironment.window.document, "style");
		mainStyle.dataset.source = "main";
		mainStyle.textContent = ".from-main { color: red; }";
		mainEnvironment.window.document.head.append(mainStyle);

		const secondaryEnvironment = new JSDOM(
			"<!doctype html><html><head></head><body>" +
				"<main><span></span></main></body></html>",
		);
		const secondaryWindow =
			secondaryEnvironment.window as unknown as Window;
		const root =
			secondaryEnvironment.window.document.querySelector("main");
		assert.ok(root);

		const workbenchWindow = new WorkbenchWindow({
			root,
			modeId: "academic",
			workbenchState: WorkbenchState.FOLDER,
		});

		assert.equal(root.classList.contains("ash-workbench"), true);
		assert.equal(root.dataset.workbenchMode, "academic");
		assert.equal(root.dataset.workbenchState, "folder");
		workbenchWindow.setWorkbenchState(WorkbenchState.EMPTY);
		assert.equal(root.dataset.workbenchState, "empty");
		assert.equal(
			isRegisteredWindow(secondaryWindow),
			true,
		);
		assert.equal(
			secondaryEnvironment.window.document.head
				.querySelector("style[data-source='main']")
				?.textContent,
			mainStyle.textContent,
		);

		const nextStyle =
			h(mainEnvironment.window.document, "style");
		nextStyle.dataset.source = "next";
		mainEnvironment.window.document.head.append(nextStyle);
		await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
		assert.ok(
			secondaryEnvironment.window.document.head
				.querySelector("style[data-source='next']"),
		);

		workbenchWindow.dispose();

		assert.equal(root.classList.contains("ash-workbench"), false);
		assert.equal(root.hasAttribute("data-product"), false);
		assert.equal(root.childElementCount, 0);
		assert.equal(
			isRegisteredWindow(secondaryWindow),
			false,
		);
		assert.equal(
			secondaryEnvironment.window.document.head.childElementCount,
			0,
		);
	},
);

test("WorkbenchWindow forwards secondary runtime errors to the central error handler", () => {
	const secondaryEnvironment = new JSDOM(
		"<!doctype html><html><body><main></main></body></html>",
	);
	const root = secondaryEnvironment.window.document.querySelector("main");
	assert.ok(root);
	const workbenchWindow = new WorkbenchWindow({
		root,
		modeId: "academic",
		workbenchState: WorkbenchState.FOLDER,
	});
	const previousHandler = errorHandler.getUnexpectedErrorHandler();
	const reported: unknown[] = [];
	setUnexpectedErrorHandler(error => reported.push(error));

	try {
		const error = new Error("secondary render failed");
		secondaryEnvironment.window.dispatchEvent(new secondaryEnvironment.window.ErrorEvent("error", {
			error,
			message: error.message,
		}));
		assert.deepEqual(reported, [error]);
	} finally {
		setUnexpectedErrorHandler(previousHandler);
		workbenchWindow.dispose();
	}
});
