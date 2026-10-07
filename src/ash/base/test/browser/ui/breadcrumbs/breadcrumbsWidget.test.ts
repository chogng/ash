import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { BreadcrumbsItem, BreadcrumbsWidget, type IBreadcrumbsWidgetStyles } from '../../../../browser/ui/breadcrumbs/breadcrumbsWidget.js';
import { Lxicon } from '../../../../common/lxicons.js';
import { toDisposable } from '../../../../common/lifecycle.js';

class LabelItem extends BreadcrumbsItem {
	public disposeCount = 0;
	constructor(public readonly label: string) { super(); }
	public dispose(): void { this.disposeCount++; }
	public equals(other: BreadcrumbsItem): boolean { return other instanceof LabelItem && other.label === this.label; }
	public render(container: HTMLElement): void { container.textContent = this.label; }
}

const styles: IBreadcrumbsWidgetStyles = {
	breadcrumbsBackground: undefined,
	breadcrumbsForeground: undefined,
	breadcrumbsHoverForeground: undefined,
	breadcrumbsFocusForeground: undefined,
	breadcrumbsFocusAndSelectionForeground: undefined,
};

suite('BreadcrumbsWidget', () => {
	test('moves focus independently of activation and blocks disabled clicks', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using widget = new BreadcrumbsWidget(dom.window.document.body, 3, undefined, Lxicon.chevronRight, styles);
			const first = new LabelItem('folder');
			const last = new LabelItem('file.ts');
			widget.setItems([first, last]);
			const selected: Array<BreadcrumbsItem | undefined> = [];
			using listener = widget.onDidSelectItem(event => selected.push(event.item));
			widget.setFocused(last);
			const button = dom.window.document.activeElement!;
			button.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
			assert.deepEqual([widget.getFocused(), widget.getSelection(), selected.length], [first, undefined, 0]);
			(dom.window.document.activeElement as HTMLButtonElement).click();
			assert.deepEqual(selected, [first]);
			assert.equal(dom.window.document.activeElement?.getAttribute('aria-pressed'), 'true');
			widget.setEnabled(false);
			widget.setFocused(last);
			dom.window.document.querySelectorAll('button')[1]!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
			assert.deepEqual(selected, [first]);
			assert.equal(dom.window.document.querySelectorAll('button:disabled').length, 2);
		} finally {
			dom.window.close();
		}
	});

	test('retains equal prefix nodes and releases replaced and duplicate items exactly once', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			const widget = new BreadcrumbsWidget(dom.window.document.body, 3, undefined, Lxicon.chevronRight, styles);
			const first = new LabelItem('folder');
			const last = new LabelItem('old.ts');
			widget.setItems([first, last]);
			const retained = dom.window.document.querySelector('button');
			const duplicate = new LabelItem('folder');
			const replacement = new LabelItem('new.ts');
			widget.setItems([duplicate, replacement]);
			assert.equal(dom.window.document.querySelector('button'), retained);
			assert.deepEqual([first.disposeCount, last.disposeCount, duplicate.disposeCount, replacement.disposeCount], [0, 1, 1, 0]);
			widget.dispose();
			widget.dispose();
			assert.deepEqual([first.disposeCount, replacement.disposeCount, dom.window.document.body.childElementCount], [1, 1, 0]);
		} finally {
			dom.window.close();
		}
	});

	test('cancels a deferred reveal when focus, items, or lifetime changes', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		const operations: string[] = [];
		try {
			const widget = new BreadcrumbsWidget(dom.window.document.body, 3, undefined, Lxicon.chevronRight, styles, () => {
				operations.push('scheduled');
				return toDisposable(() => operations.push('cancelled'));
			});
			const first = new LabelItem('first');
			widget.setItems([first, new LabelItem('last')]);
			widget.revealLast();
			widget.reveal(first);
			widget.domFocus();
			widget.revealLast();
			widget.setItems([]);
			widget.setItems([new LabelItem('final')]);
			widget.revealLast();
			widget.dispose();
			assert.deepEqual(operations, Array.from({ length: 4 }, () => ['scheduled', 'cancelled']).flat());
		} finally {
			dom.window.close();
		}
	});
});
