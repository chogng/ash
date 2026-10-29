import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { browserEnvironment } from '../../../../../../editor/test/browser/testEditorDom.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import {
	ContextKeyService,
	IContextKeyService,
} from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { FilterWidget } from '../../viewFilter.js';
import { FilterViewPane } from '../../viewPane.js';
import { Emitter } from '../../../../../../base/common/event.js';

suite('View filter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('requires its context service and publishes edits immediately through its production creation path', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(FilterWidget, { ariaLabel: 'Output filter' }), /contextKeyService/);
		using context = new ContextKeyService();
		services.registerInstance(IContextKeyService, context);
		using widget = services.createInstance(FilterWidget, {
			ariaLabel: 'Output filter',
			placeholder: 'Filter output',
			text: 'initial',
		});
		browserEnvironment.window.document.body.append(widget.element);
		const input = widget.element.querySelector('input')!;
		const edits: string[] = [];
		using listener = widget.onDidChangeFilterText(value => edits.push(value));
		assert.equal(widget.getFilterText(), 'initial');
		assert.equal(input.getAttribute('aria-label'), 'Output filter');
		input.value = 'typed';
		input.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
		widget.setFilterText('command');
		assert.deepEqual(edits, ['typed', 'command']);
		widget.focus();
		assert.equal(widget.hasFocus(), true);
	});

	test('commits only accepted filters, bounds history and restores the draft through keyboard navigation', () => {
		using services = new InstantiationService();
		using context = new ContextKeyService();
		services.registerInstance(IContextKeyService, context);
		using widget = services.createInstance(FilterWidget, {
			ariaLabel: 'Output filter',
			history: Array.from({ length: 101 }, (_, index) => `saved-${index}`),
		});
		browserEnvironment.window.document.body.append(widget.element);
		const input = widget.element.querySelector('input')!;
		let accepts = 0;
		using listener = widget.onDidAcceptFilterText(() => accepts++);
		assert.equal(widget.getHistory().length, 100);
		widget.setFilterText('draft');
		key(input, 'ArrowUp');
		assert.equal(widget.getFilterText(), 'saved-100');
		key(input, 'ArrowDown');
		assert.equal(widget.getFilterText(), 'draft');
		assert.equal(input.selectionStart, 5);
		assert.equal(accepts, 0);
		key(input, 'Enter', { isComposing: true });
		assert.equal(accepts, 0);
		key(input, 'Enter');
		assert.equal(accepts, 1);
		assert.equal(widget.getHistory().length, 100);
		assert.equal(widget.getHistory().at(-1), 'draft');
		key(input, 'Enter');
		assert.equal(widget.getHistory().filter(value => value === 'draft').length, 1);
	});

	test('owns badge accessibility and releases its DOM, history registration and listeners on disposal', () => {
		using services = new InstantiationService();
		using context = new ContextKeyService();
		services.registerInstance(IContextKeyService, context);
		const widget = services.createInstance(FilterWidget, { ariaLabel: 'Output filter' });
		try {
			browserEnvironment.window.document.body.append(widget.element);
			const badge = widget.element.querySelector<HTMLElement>('[role="status"]')!;
			widget.updateBadge('2 of 5');
			assert.equal(badge.textContent, '2 of 5');
			assert.equal(badge.hidden, false);
			assert.equal(badge.getAttribute('aria-atomic'), 'true');
			widget.updateBadge(undefined);
			assert.equal(badge.hidden, true);
			widget.layout(240);
			assert.equal(widget.element.style.maxWidth, '240px');
			const input = widget.element.querySelector('input')!;
			widget.dispose();
			assert.equal(widget.element.isConnected, false);
			assert.doesNotThrow(() => key(input, 'ArrowUp'));
		} finally {
			widget.dispose();
		}
	});

	test('retains the same filter, query, selection and focus when responsive layout moves its host', () => {
		using services = new InstantiationService();
		using context = new ContextKeyService();
		services.registerInstance(IContextKeyService, context);
		using pane = services.createInstance(TestFilterPane, browserEnvironment.window.document.body, {
			id: 'filter-pane',
			title: 'Output',
			filterOptions: { ariaLabel: 'Output filter', text: 'current query' },
		});
		pane.setVisible(true);
		pane.layout(300, 0, 320);
		const widget = pane.getFilterWidget();
		const input = widget.element.querySelector('input')!;
		widget.focus();
		input.setSelectionRange(2, 7);
		assert.equal(pane.shouldShowFilterInHeader(), false);
		assert.equal(widget.element.parentElement?.className, 'ash-view-pane-filter-container');
		assert.deepEqual(pane.contentSize, [228, 320]);
		pane.layout(300, 0, 800);
		assert.equal(pane.shouldShowFilterInHeader(), true);
		assert.equal(pane.getFilterWidget(), widget);
		assert.equal(widget.element.parentElement?.className, 'ash-pane-view-header-actions');
		assert.equal(widget.getFilterText(), 'current query');
		assert.equal(widget.hasFocus(), true);
		assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 7]);
		assert.deepEqual(pane.contentSize, [272, 800]);
		pane.layout(300, 0, 240);
		assert.equal(widget.hasFocus(), true);
		assert.deepEqual(pane.contentSize, [228, 240]);
		key(input, 'Enter');
		assert.equal(pane.bodyFocused, true);
		assert.equal(widget.getHistory().at(-1), 'current query');
	});

	test('filter focus follows a lent title host, then returns to body without rebuilding the input', () => {
		using services = new InstantiationService();
		using context = new ContextKeyService();
		services.registerInstance(IContextKeyService, context);
		using pane = services.createInstance(TestFilterPane, browserEnvironment.window.document.body, {
			id: 'filter-title-pane',
			title: 'Output',
			filterOptions: { ariaLabel: 'Output filter' },
		});
		pane.setVisible(true);
		pane.layout(80, 0, 240);
		const host = browserEnvironment.window.document.createElement('div');
		browserEnvironment.window.document.body.append(host);
		try {
			pane.filterWidget.focus();
			const restoreFocus = pane.captureTitleActionsFocus();
			pane.setHeaderVisible(false);
			pane.setHeaderActionsHost(host);
			restoreFocus?.();
			assert.equal(host.contains(pane.filterWidget.element), true);
			assert.equal(pane.hasFocus(), true);
			pane.layout(300, 0, 240);
			assert.equal(host.contains(pane.filterWidget.element), false);
			assert.equal(pane.filterWidget.hasFocus(), true);
			pane.dispose();
			assert.equal(host.children.length, 0);
		} finally {
			host.remove();
		}
	});

	test('observes externally replaced workspace history without replacing the focused filter', () => {
		using services = new InstantiationService();
		using context = new ContextKeyService();
		using changed = new Emitter<string[]>();
		services.registerInstance(IContextKeyService, context);
		const history = Object.assign(new Set(['previous']), { onDidChange: changed.event });
		using widget = services.createInstance(FilterWidget, { ariaLabel: 'Output filter', history });
		browserEnvironment.window.document.body.append(widget.element);
		widget.setFilterText('draft');
		widget.focus();
		const input = widget.element.querySelector('input')!;
		history.clear();
		history.add('external');
		changed.fire(['external']);
		assert.equal(widget.element.querySelector('input'), input);
		assert.equal(widget.hasFocus(), true);
		assert.equal(widget.getFilterText(), 'draft');
		key(input, 'ArrowUp');
		assert.equal(widget.getFilterText(), 'external');
		key(input, 'ArrowDown');
		assert.equal(widget.getFilterText(), 'draft');
	});
});

class TestFilterPane extends FilterViewPane {
	contentSize: [number, number] = [0, 0];
	bodyFocused = false;
	protected override layoutBodyContent(height: number, width: number): void {
		this.contentSize = [height, width];
	}
	protected override focusBodyContent(): void {
		this.bodyFocused = true;
	}
}

function key(input: HTMLInputElement, key: string, options: KeyboardEventInit = {}): void {
	input.dispatchEvent(
		new browserEnvironment.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }),
	);
}
