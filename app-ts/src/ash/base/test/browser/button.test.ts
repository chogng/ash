import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Button } from "../../browser/ui/button/button.js";
import { setHoverDelegate, type IManagedHover } from "../../browser/ui/hover/hoverDelegate.js";
import { lxiconsLibrary } from "../../common/lxiconsLibrary.js";

test("Button only installs a Hover for an explicit title", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const contents: unknown[] = [];
	using delegateRegistration = setHoverDelegate({
		setupHover(options) {
			contents.push(options.content);
			return managedHover();
		},
	});
	using unlabeledHoverButton = new Button(dom.window.document.body, {
		label: "Save",
	});
	using titledButton = new Button(dom.window.document.body, {
		label: "Save",
		title: "Save changes",
	});

	assert.deepEqual(contents, ["Save changes"]);
	assert.ok(titledButton.domNode.querySelector(".ash-button-content.ash-icon-label"));
	assert.ok(titledButton.domNode.querySelector(".ash-button-label.ash-icon-label-text"));
	assert.equal(unlabeledHoverButton.domNode.hasAttribute("title"), false);
	titledButton.toggleClassName("host-button", true);
	titledButton.hidden = true;
	assert.equal(titledButton.domNode.hidden, true);
	assert.equal(titledButton.domNode.classList.contains("hidden"), true);
	assert.equal(titledButton.domNode.classList.contains("host-button"), true);

	using labelCenteredButton = new Button(dom.window.document.body, {
		label: "Commit",
		contentAlignment: "labelCentered",
	});
	assert.equal(labelCenteredButton.domNode.classList.contains("label-centered"), true);
	labelCenteredButton.label = "Commit changes";
	assert.equal(labelCenteredButton.label, "Commit changes");

	using iconButton = new Button(dom.window.document.body, {
		label: "Menu",
		icon: lxiconsLibrary.menu,
	});
	iconButton.label = "Application menu";
	assert.ok(iconButton.domNode.querySelector("svg.ash-icon"));

	using submitButton = new Button(dom.window.document.body, {
		label: "Submit",
		presentation: "primary",
		size: "small",
		type: "submit",
	});
	assert.equal(submitButton.domNode.type, "submit");
	assert.equal(submitButton.domNode.classList.contains("ash-button-primary"), true);
	assert.equal(submitButton.domNode.classList.contains("ash-button-small"), true);
	assert.equal(unlabeledHoverButton.domNode.classList.contains("ash-button-quiet"), true);

	dom.window.close();
});

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
