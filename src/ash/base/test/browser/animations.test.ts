import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import {
	animateElement,
	bounceElement,
	isReducedMotion,
	UI_ANIMATION_DURATION,
	UI_ANIMATION_EASING,
	captureAnimationTarget,
	triggerConfettiAnimation,
} from '../../browser/ui/animations/animations.js';
import { h } from '../../browser/dom.js';

test('UI animations use shared timing and honor reduced motion', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const element = h(dom.window.document, 'button');
	const calls: Array<{ keyframes: unknown; options: unknown; }> = [];
	Object.defineProperty(element, 'animate', {
		configurable: true,
		value: (keyframes: unknown, options: unknown) => {
			calls.push({ keyframes, options });
			return { cancel(): void { } } as unknown as Animation;
		},
	});

	assert.equal(isReducedMotion(element), false);
	assert.ok(animateElement(element, [{ opacity: 0 }, { opacity: 1 }]));
	assert.deepEqual(calls[0]?.options, {
		delay: 0,
		direction: 'normal',
		duration: UI_ANIMATION_DURATION.normal,
		easing: UI_ANIMATION_EASING,
		fill: 'both',
		iterations: 1,
	});

	assert.ok(bounceElement(element, {
		scale: [1, 1.05, 1],
		duration: UI_ANIMATION_DURATION.fast,
	}));
	assert.deepEqual(calls[1]?.keyframes, [
		{ offset: 0, transform: 'scale(1)' },
		{ offset: 0.5, transform: 'scale(1.05)' },
		{ offset: 1, transform: 'scale(1)' },
	]);

	element.classList.add('ash-reduce-motion');
	assert.equal(isReducedMotion(element), true);
	assert.equal(animateElement(element, [{ opacity: 0 }, { opacity: 1 }]), undefined);
	dom.window.close();
});

test('click feedback retains its captured position after the source disappears and releases completed effects', async () => {
	const dom = new JSDOM('<!doctype html><body><main data-color-theme="light"><button></button></main></body>');
	try {
		const button = dom.window.document.querySelector('button')!;
		Object.defineProperty(button, 'getBoundingClientRect', { value: () => new dom.window.DOMRect(20, 30, 80, 24) });
		const finishes: Array<() => void> = [];
		const calls: Array<{ keyframes: unknown; options: unknown; cancelled: boolean; }> = [];
		Object.defineProperty(dom.window.HTMLElement.prototype, 'animate', {
			value: function (keyframes: unknown, options: unknown) {
				const call = { keyframes, options, cancelled: false };
				calls.push(call);
				const finished = new Promise<void>(resolve => finishes.push(resolve));
				return { finished, cancel() { call.cancelled = true; } } as unknown as Animation;
			}
		});
		const target = captureAnimationTarget(button);
		button.remove();
		const feedback = triggerConfettiAnimation(target)!;
		try {
			const overlay = target.container.querySelector<HTMLElement>('.ash-click-confetti')!;
			assert.ok(overlay);
			assert.equal(overlay.getAttribute('aria-hidden'), 'true');
			assert.deepEqual([overlay.style.left, overlay.style.top, overlay.style.width, overlay.style.height], ['20px', '30px', '80px', '24px']);
			assert.equal(calls.length, 18, 'Detached source plays particles without retaining a bounce on the removed button');
			for (const finish of finishes) finish();
			await Promise.resolve();
			await Promise.resolve();
			assert.equal(overlay.isConnected, false);
			assert.ok(calls.every(call => call.cancelled));
		} finally { feedback.dispose(); }
	} finally { dom.window.close(); }
});

test('click feedback honors reduced motion and cancels pending effects on window teardown', () => {
	const dom = new JSDOM('<!doctype html><body><button></button></body>');
	try {
		const button = dom.window.document.querySelector('button')!;
		assert.equal(triggerConfettiAnimation(button), undefined, 'Unsupported animation APIs leave no overlay');
		let cancelled = 0;
		Object.defineProperty(dom.window.HTMLElement.prototype, 'animate', { value: () => ({ finished: new Promise(() => { }), cancel() { cancelled++; } }) });
		dom.window.document.body.classList.add('ash-reduce-motion');
		assert.equal(triggerConfettiAnimation(button), undefined);
		assert.equal(dom.window.document.querySelector('.ash-click-confetti'), null);
		dom.window.document.body.classList.remove('ash-reduce-motion');
		const feedback = triggerConfettiAnimation(button)!;
		dom.window.dispatchEvent(new dom.window.Event('pagehide'));
		assert.equal(dom.window.document.querySelector('.ash-click-confetti'), null);
		assert.equal(cancelled, 19);
		feedback.dispose();
		assert.equal(cancelled, 19);
	} finally { dom.window.close(); }
});

test('UI animations respect an explicit motion preference over the system', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const element = h(dom.window.document, 'button');
	dom.window.document.body.append(element);
	Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: true }) });
	assert.equal(isReducedMotion(element), true);
	dom.window.document.body.classList.add('ash-enable-motion');
	assert.equal(isReducedMotion(element), false);
	dom.window.document.body.classList.replace('ash-enable-motion', 'ash-reduce-motion');
	assert.equal(isReducedMotion(element), true);
	dom.window.close();
});
