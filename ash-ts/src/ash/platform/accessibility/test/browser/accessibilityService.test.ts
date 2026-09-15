import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { ContextKeyService } from "../../../../platform/contextkey/common/contextkey.js";
import { InMemoryConfigurationService } from "../../../../platform/configuration/common/inMemoryConfigurationService.js";
import { AccessibilityConfiguration, AccessibilitySupport, CONTEXT_ACCESSIBILITY_MODE_ENABLED } from "../../../../platform/accessibility/common/accessibility.js";
import { AccessibilityService } from "../../../../platform/accessibility/browser/accessibilityService.js";
import { h } from "../../../../base/browser/dom.js";

test("accessibility service projects screen-reader support and context state", () => {
	const environment = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
	const root = h(environment.window.document, "main");
	environment.window.document.body.append(root);
	using configuration = new InMemoryConfigurationService();
	using contextKeys = new ContextKeyService();
	using service = new AccessibilityService({
		root,
		contextKeyService: contextKeys,
		configurationService: configuration,
	});

	assert.equal(service.getAccessibilitySupport(), AccessibilitySupport.Unknown);
	assert.equal(service.isScreenReaderOptimized(), false);
	assert.equal(contextKeys.getValue(CONTEXT_ACCESSIBILITY_MODE_ENABLED.key), false);

	let changes = 0;
	using subscription = service.onDidChangeScreenReaderOptimized(() => changes += 1);
	service.setAccessibilitySupport(AccessibilitySupport.Enabled);
	assert.equal(service.isScreenReaderOptimized(), true);
	assert.equal(contextKeys.getValue(CONTEXT_ACCESSIBILITY_MODE_ENABLED.key), true);
	assert.equal(changes, 1);

	service.setAccessibilitySupport(AccessibilitySupport.Enabled);
	assert.equal(changes, 1);
});

test("accessibility service applies reduction and link presentation policies", async () => {
	const environment = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
	const root = h(environment.window.document, "main");
	environment.window.document.body.append(root);
	using configuration = new InMemoryConfigurationService();
	using contextKeys = new ContextKeyService();
	using service = new AccessibilityService({
		root,
		contextKeyService: contextKeys,
		configurationService: configuration,
	});

	assert.equal(root.classList.contains("ash-enable-motion"), true);
	assert.equal(root.classList.contains("ash-reduce-transparency"), false);
	assert.equal(root.classList.contains("ash-underline-links"), false);

	await configuration.updateValue(AccessibilityConfiguration.reduceMotion, "on");
	await configuration.updateValue(AccessibilityConfiguration.reduceTransparency, "on");
	await configuration.updateValue(AccessibilityConfiguration.underlineLinks, true);
	assert.equal(root.classList.contains("ash-reduce-motion"), true);
	assert.equal(root.classList.contains("ash-enable-motion"), false);
	assert.equal(root.classList.contains("ash-reduce-transparency"), true);
	assert.equal(root.classList.contains("ash-underline-links"), true);

	service.status("Saved");
	service.alert("Error");
	assert.equal(environment.window.document.querySelectorAll(".ash-aria-live").length, 1);
});
