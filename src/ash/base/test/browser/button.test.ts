import assert from "node:assert/strict";
import { suite, test } from "mocha";
import { JSDOM } from "jsdom";
import { Button } from "../../browser/ui/button/button.js";
import { setHoverDelegate, type IManagedHover } from "../../browser/ui/hover/hoverDelegate.js";
import { Lxicon } from "../../common/lxicons.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';

suite('Button deferred content', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('host content stays intact while labels and icons are created and released on demand', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		using cleanup = { [Symbol.dispose]: () => dom.window.close() };
		let clicks = 0;
		using button = new Button(dom.window.document.body, { label: '', iconOnly: true, ariaLabel: 'Choose color', onClick: () => clicks++ });
		assert.equal(button.domNode.childElementCount, 0);
		const swatch = dom.window.document.createElement('span');
		button.domNode.append(swatch);
		for (let visit = 0; visit < 3; visit++) {
			button.label = 'Color';
			assert.equal(button.label, 'Color');
			assert.equal(button.domNode.lastElementChild, swatch);
			button.icon = Lxicon.menu;
			button.label = '';
			assert.ok(button.domNode.querySelector('.ash-icon'));
			button.icon = undefined;
			assert.equal(button.domNode.childElementCount, 1);
			assert.equal(button.domNode.firstElementChild, swatch);
		}
		button.icon = Lxicon.menu;
		assert.ok(button.domNode.querySelector('.ash-icon'));
		button.icon = undefined;
		assert.equal(button.domNode.childElementCount, 1);
		assert.equal(button.domNode.getAttribute('aria-label'), 'Choose color');
		button.domNode.click();
		assert.equal(clicks, 1);
	});
});

test("Button only installs a Hover for an explicit title", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const contents: unknown[] = [];
	using delegateRegistration = setHoverDelegate({
		setupDelayedHover() { throw new Error("Unexpected delayed hover registration"); },
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
		icon: Lxicon.menu,
		iconOnly: true,
	});
	assert.equal(iconButton.domNode.classList.contains("icon-only"), true);
	assert.equal(iconButton.domNode.getAttribute("aria-label"), "Menu");
	iconButton.label = "Application menu";
	assert.equal(iconButton.domNode.getAttribute("aria-label"), "Application menu");
	assert.ok(iconButton.domNode.querySelector(".ash-icon"));

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
		show() { },
		hide() { },
		update() { },
		dispose() { },
		[Symbol.dispose]() { },
	};
}
