import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import type { Page } from '@playwright/test';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { Workbench } from './workbench.js';

suite('Workbench layout completion', () => {
	for (const location of ['left', 'right'] as const) {
		test(`waits for configuration and geometry to agree before reporting the sidebar on the ${location}`, async () => {
			using clock = createClock();
			using fixture = createWorkbench(location === 'left' ? 'right' : 'left');
			let ready = false;
			const waiting = fixture.workbench.waitForSideBarLocation(location).then(() => { ready = true; });
			await setImmediate();
			assert.equal(ready, false);
			if (location === 'right') {
				fixture.configure(location);
			} else {
				fixture.layout(location);
			}
			await clock.advance(100);
			assert.equal(ready, false, 'configuration alone or geometry alone cannot finish the operation');
			fixture.configure(location);
			fixture.layout(location);
			await clock.advance(250);
			await waiting;
			assert.equal(ready, true);
			assert.equal(fixture.reads, 3);
		});
	}

	test('requires the activity rail and sidebar to finish the same location change', async () => {
		using clock = createClock();
		using fixture = createWorkbench('left');
		fixture.configure('right');
		fixture.layout('right');
		fixture.bounds.activitybar = fixture.rectangle(6, 36);
		let ready = false;
		const waiting = fixture.workbench.waitForSideBarLocation('right').then(() => { ready = true; });
		await setImmediate();
		assert.equal(ready, false, 'the rail cannot remain on the old side after the sidebar has moved');
		fixture.layout('right');
		await clock.advance(100);
		await waiting;
		assert.equal(ready, true);
	});

	test('observes a maximized panel when the editor and sidebar are hidden', async () => {
		using fixture = createWorkbench('right');
		fixture.hidden.add('editor');
		fixture.hidden.add('sidebar');
		fixture.hidden.delete('panel');
		await fixture.workbench.waitForSideBarLocation('right');
		assert.equal(fixture.reads, 1);
	});

	test('fails at the assertion deadline with the requested side and last geometry', async () => {
		using clock = createClock();
		using fixture = createWorkbench('left');
		const rejected = assert.rejects(fixture.workbench.waitForSideBarLocation('right'), error => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /Primary Side Bar configuration and visible part geometry are on the right/u);
			assert.match(error.message, /positioned/u);
			return true;
		});
		await setImmediate();
		await clock.advance(5_000);
		await rejected;
	});

	test('preserves observation failures instead of retrying actions or treating them as pending layout', async () => {
		using fixture = createWorkbench('left');
		const failure = new Error('Page closed');
		fixture.failRead = failure;
		await assert.rejects(fixture.workbench.waitForSideBarLocation('right'), error => error === failure);
		assert.equal(fixture.reads, 1);
	});
});

function createClock() {
	let now = performance.now();
	const performanceClock = mock.method(performance, 'now', () => now);
	mock.timers.enable({ apis: ['setTimeout'] });
	return {
		async advance(milliseconds: number) { now += milliseconds; mock.timers.tick(milliseconds); await setImmediate(); },
		[Symbol.dispose]() { mock.timers.reset(); performanceClock.mock.restore(); },
	};
}

function createWorkbench(initialLocation: 'left' | 'right') {
	const dom = new JSDOM('<!doctype html><main class="ash-workbench"><section data-part="activitybar"></section><section data-part="sidebar"></section><section data-part="editor"></section><section data-part="panel"></section></main>');
	const root = dom.window.document.querySelector('main')!;
	const rectangle = (left: number, width: number): DOMRect => ({ left, width, right: left + width, x: left, y: 30, top: 30, bottom: 530, height: 500, toJSON: () => ({}) });
	const fixture = {
		bounds: {} as Record<string, DOMRect>,
		hidden: new Set(['panel']),
		reads: 0,
		failRead: undefined as Error | undefined,
		rectangle,
		configure(location: 'left' | 'right') {
			for (const id of ['sidebar', 'activitybar']) root.querySelector(`[data-part="${id}"]`)!.classList.toggle('sidebar-right', location === 'right');
		},
		layout(location: 'left' | 'right') {
			this.bounds = location === 'left'
				? { activitybar: rectangle(6, 36), sidebar: rectangle(42, 217), editor: rectangle(265, 500), panel: rectangle(265, 500) }
				: { editor: rectangle(6, 500), panel: rectangle(6, 500), sidebar: rectangle(512, 217), activitybar: rectangle(729, 36) };
		},
		[Symbol.dispose]: () => dom.window.close(),
	};
	for (const element of root.querySelectorAll<HTMLElement>('[data-part]')) {
		const id = element.dataset.part!;
		element.getBoundingClientRect = () => fixture.bounds[id]!;
		element.getClientRects = () => (fixture.hidden.has(id) ? [] : [fixture.bounds[id]!]) as unknown as DOMRectList;
	}
	class Locator {
		constructor(private readonly selector: string) {}
		locator(selector: string) { return new Locator(`${this.selector} ${selector}`); }
		getByRole(role: string) { return this.locator(`[role="${role}"]`); }
		async evaluate(callback: (element: Element, argument: unknown) => unknown, argument: unknown) {
			fixture.reads++;
			if (fixture.failRead) throw fixture.failRead;
			return runInNewContext(`(${callback.toString()})(element, argument)`, { element: dom.window.document.querySelector(this.selector), argument });
		}
	}
	const page = { locator: (selector: string) => new Locator(selector) } as unknown as Page;
	fixture.configure(initialLocation);
	fixture.layout(initialLocation);
	return Object.assign(fixture, { workbench: new Workbench(page) });
}
