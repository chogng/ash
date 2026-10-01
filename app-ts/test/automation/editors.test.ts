import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import type { Locator, Page } from '@playwright/test';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { h } from '../../src/ash/base/browser/dom.js';
import { EditorGroup, Editors } from './editors.js';

suite('Editor automation completion', () => {
	test('waits for a new selected tab and its own visible, focused text input even when the tab count is unchanged', async () => {
		const fixture = createFixture();
		let now = performance.now();
		const clock = mock.method(performance, 'now', () => now);
		mock.timers.enable({ apis: ['setTimeout'] });
		const observed: unknown[] = [];
		const stages = [
			() => fixture.replaceTab(false),
			() => fixture.document.getElementById('new-tab')!.setAttribute('aria-selected', 'true'),
			() => { fixture.document.getElementById('new-panel')!.hidden = false; },
			() => fixture.addInput(),
			() => fixture.document.querySelector<HTMLElement>('#new-panel .stanza-editor-input')!.focus(),
		];
		fixture.afterPoll = result => {
			const tabs = result as { id: string; inputFocused: boolean }[];
			observed.push(tabs.length === 1 && tabs[0]!.inputFocused ? tabs[0]!.id : '');
			stages.shift()?.();
		};
		try {
			const opening = fixture.editors.newUntitledFile();
			await setImmediate();
			for (const interval of [100, 250, 500, 1000, 1000]) {
				now += interval;
				mock.timers.tick(interval);
				await setImmediate();
			}
			const tab = await opening;
			assert.deepEqual({ observed, selector: (tab as unknown as DomLocator).selector, presses: fixture.presses }, {
				observed: ['', '', '', '', '', 'new-tab'],
				selector: '.ash-workbench-editor [id="new-tab"]',
				presses: ['ControlOrMeta+N'],
			});
		} finally {
			mock.timers.reset();
			clock.mock.restore();
			fixture.dispose();
		}
	});

	test('a retained Welcome tab does not count toward nine new editors or make an unfinished batch ready', async () => {
		const fixture = createFixture();
		fixture.document.getElementById('old-tab')!.setAttribute('aria-label', 'Welcome');
		fixture.document.getElementById('old-tab')!.setAttribute('aria-selected', 'false');
		fixture.document.getElementById('old-panel')!.textContent = 'Welcome';
		const previousIds = await fixture.group.getTabIds();
		const initial = Array.from({ length: 8 }, (_, index) => fixture.addTextTab(`created-${index + 1}`));
		const eighth = initial.at(-1)!;
		eighth.tab.setAttribute('aria-selected', 'true');
		eighth.panel.hidden = false;
		eighth.input.focus();
		assert.equal(fixture.document.querySelectorAll('[role="tab"]').length, 9);
		let ninth!: ReturnType<typeof fixture.addTextTab>;
		const observedCounts: number[] = [];
		const stages = [
			() => { ninth = fixture.addTextTab('created-9'); ninth.input.remove(); },
			() => { eighth.tab.setAttribute('aria-selected', 'false'); eighth.panel.hidden = true; ninth.tab.setAttribute('aria-selected', 'true'); ninth.panel.hidden = false; },
			() => ninth.panel.append(ninth.input),
			() => ninth.input.focus(),
		];
		fixture.afterPoll = result => {
			observedCounts.push((result as unknown[]).length);
			stages.shift()?.();
		};
		let now = performance.now();
		const clock = mock.method(performance, 'now', () => now);
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			let ready = false;
			const opening = fixture.group.waitForNewTextEditors(previousIds, 9).then(tabs => { ready = true; return tabs; });
			await setImmediate();
			for (const interval of [100, 250, 500, 1000]) {
				assert.equal(ready, false);
				now += interval;
				mock.timers.tick(interval);
				await setImmediate();
			}
			const opened = await opening;
			assert.deepEqual({ observedCounts, selectors: opened.map(tab => (tab as unknown as DomLocator).selector), presses: fixture.presses }, {
				observedCounts: [8, 9, 9, 9, 9],
				selectors: Array.from({ length: 9 }, (_, index) => `.ash-editor-group [id="created-${index + 1}"]`),
				presses: [],
			});
			assert.equal(fixture.document.querySelectorAll('[role="tab"]').length, 10);
		} finally {
			mock.timers.reset();
			clock.mock.restore();
			fixture.dispose();
		}
	});

	test('an extra new editor fails the exact creation count instead of accepting at least nine', async () => {
		const fixture = createFixture();
		const previousIds = await fixture.group.getTabIds();
		const added = Array.from({ length: 10 }, (_, index) => fixture.addTextTab(`extra-${index + 1}`));
		const last = added.at(-1)!;
		last.tab.setAttribute('aria-selected', 'true');
		last.panel.hidden = false;
		last.input.focus();
		let now = performance.now();
		const clock = mock.method(performance, 'now', () => now);
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			const rejected = assert.rejects(fixture.group.waitForNewTextEditors(previousIds, 9), /exactly 9 new text editors/u);
			await setImmediate();
			now += 5000;
			mock.timers.tick(5000);
			await rejected;
			assert.deepEqual(fixture.presses, []);
		} finally {
			mock.timers.reset();
			clock.mock.restore();
			fixture.dispose();
		}
	});

	test('custom menu or command triggers run once and obey the same completion contract', async () => {
		const fixture = createFixture();
		let calls = 0;
		try {
			await fixture.editors.newUntitledFile(async () => {
				calls++;
				fixture.replaceTab(true);
				fixture.addInput().focus();
			});
			assert.deepEqual({ calls, presses: fixture.presses }, { calls: 1, presses: [] });
		} finally {
			fixture.dispose();
		}
	});

	test('does not retry an action that fails', async () => {
		const fixture = createFixture();
		const failure = new Error('New Untitled failed');
		let calls = 0;
		try {
			await assert.rejects(fixture.editors.newUntitledFile(async () => { calls++; throw failure; }), error => error === failure);
			assert.equal(calls, 1);
		} finally {
			fixture.dispose();
		}
	});

	test('observation failures are not mistaken for an editor that is still loading', async () => {
		const fixture = createFixture();
		const failure = new Error('Page closed');
		fixture.afterPoll = () => { throw failure; };
		try {
			await assert.rejects(fixture.editors.newUntitledFile(), error => error === failure);
			assert.deepEqual(fixture.presses, ['ControlOrMeta+N']);
		} finally {
			fixture.dispose();
		}
	});

	test('fails on the ordinary assertion deadline instead of accepting an old focused editor', async () => {
		const fixture = createFixture();
		let now = performance.now();
		const clock = mock.method(performance, 'now', () => now);
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			const rejected = assert.rejects(fixture.editors.newUntitledFile(), /exactly 1 new text editors/u);
			await setImmediate();
			now += 5000;
			mock.timers.tick(5000);
			await rejected;
			assert.deepEqual(fixture.presses, ['ControlOrMeta+N']);
		} finally {
			mock.timers.reset();
			clock.mock.restore();
			fixture.dispose();
		}
	});
});

function createFixture() {
	const dom = new JSDOM('<!doctype html><div class="ash-workbench-editor"><div class="ash-editor-group"><button role="tab" id="old-tab" aria-selected="true" aria-controls="old-panel"></button><div role="tabpanel" id="old-panel"><textarea class="stanza-editor-input"></textarea></div></div></div>');
	const document = dom.window.document;
	document.querySelector<HTMLElement>('.stanza-editor-input')!.focus();
	const presses: string[] = [];
	const fixture = {
		document,
		presses,
		afterPoll: undefined as ((result: unknown) => void) | undefined,
		dispose: () => dom.window.close(),
		addTextTab(id: string) {
			const tab = h(document, 'button', { attributes: { id, role: 'tab', 'aria-controls': `${id}-panel`, 'aria-selected': 'false' } });
			const panel = h(document, 'div', { attributes: { id: `${id}-panel`, role: 'tabpanel' } });
			panel.hidden = true;
			const input = h(document, 'textarea', { className: 'stanza-editor-input' });
			panel.append(input);
			document.querySelector('.ash-editor-group')!.append(tab, panel);
			return { tab, panel, input };
		},
		replaceTab(ready: boolean) {
			document.getElementById('old-tab')!.remove();
			document.querySelector('.ash-editor-group')!.insertAdjacentHTML('beforeend', `<button role="tab" id="new-tab" aria-selected="${ready}" aria-controls="new-panel"></button><div role="tabpanel" id="new-panel"${ready ? '' : ' hidden'}></div>`);
		},
		addInput() {
			const input = h(document, 'textarea');
			input.className = 'stanza-editor-input';
			document.getElementById('new-panel')!.append(input);
			return input;
		},
	};
	const page = {
		locator: (selector: string) => new DomLocator(selector, document, result => fixture.afterPoll?.(result)),
		keyboard: { press: async (key: string) => { presses.push(key); } },
	} as unknown as Page;
	return Object.assign(fixture, { editors: new Editors(page), group: new EditorGroup(new DomLocator('.ash-editor-group', document, result => fixture.afterPoll?.(result)) as unknown as Locator) });
}

class DomLocator {
	constructor(readonly selector: string, private readonly document: Document, private readonly afterPoll: (result: unknown) => void) {}

	locator(selector: string): DomLocator {
		return new DomLocator(`${this.selector} ${selector}`, this.document, this.afterPoll);
	}

	getByRole(role: string): DomLocator {
		return this.locator(`[role="${role}"]`);
	}

	async evaluateAll(callback: (elements: Element[], argument: unknown) => unknown, argument: unknown): Promise<unknown> {
		// Execute the actual browser callback without access to its module closure.
		const result: unknown = runInNewContext(`(${callback.toString()})(elements, argument)`, {
			elements: [...this.document.querySelectorAll(this.selector)],
			argument,
		});
		if (argument !== undefined) this.afterPoll(result);
		return result;
	}
}
