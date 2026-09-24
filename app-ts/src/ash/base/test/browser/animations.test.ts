import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import {
	animateElement,
	bounceElement,
	isReducedMotion,
	UI_ANIMATION_DURATION,
	UI_ANIMATION_EASING,
} from "../../browser/ui/animations/animations.js";
import { h } from "../../browser/dom.js";

test("UI animations use shared timing and honor reduced motion", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const element = h(dom.window.document, "button");
	const calls: Array<{ keyframes: unknown; options: unknown }> = [];
	Object.defineProperty(element, "animate", {
		configurable: true,
		value: (keyframes: unknown, options: unknown) => {
			calls.push({ keyframes, options });
			return { cancel(): void {} } as unknown as Animation;
		},
	});

	assert.equal(isReducedMotion(element), false);
	assert.ok(animateElement(element, [{ opacity: 0 }, { opacity: 1 }]));
	assert.deepEqual(calls[0]?.options, {
		delay: 0,
		direction: "normal",
		duration: UI_ANIMATION_DURATION.normal,
		easing: UI_ANIMATION_EASING,
		fill: "both",
		iterations: 1,
	});

	assert.ok(bounceElement(element, {
		scale: [1, 1.05, 1],
		duration: UI_ANIMATION_DURATION.fast,
	}));
	assert.deepEqual(calls[1]?.keyframes, [
		{ offset: 0, transform: "scale(1)" },
		{ offset: 0.5, transform: "scale(1.05)" },
		{ offset: 1, transform: "scale(1)" },
	]);

	element.classList.add("ash-reduce-motion");
	assert.equal(isReducedMotion(element), true);
	assert.equal(animateElement(element, [{ opacity: 0 }, { opacity: 1 }]), undefined);
	dom.window.close();
});
