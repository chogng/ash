import { h } from '../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import './loadingSkeleton.css';

/** Decorative content for one independently loading region; its owner supplies the actual state. */
export class LoadingSkeleton extends Disposable {
	readonly element: HTMLElement;
	private readonly status: HTMLElement;

	constructor(
		container: HTMLElement,
		private readonly label: string,
		layout: 'list' | 'cards' | 'transcript' | 'diff' = 'list',
		rows = 5,
	) {
		super();
		const document = container.ownerDocument;
		this.element = h(document, 'div', {
			className: `ash-sessions-loading ${layout}`,
			properties: { hidden: true },
		});
		this.status = h(document, 'span', { className: 'ash-sessions-loading-status', attributes: { role: 'status' } });
		const shapes = h(document, 'div', {
			className: 'ash-sessions-loading-shapes',
			attributes: { 'aria-hidden': 'true' },
		});
		for (let index = 0; index < rows; index++) {
			shapes.append(
				h(
					document,
					'div',
					{ className: 'ash-sessions-loading-row' },
					h(document, 'span', { className: 'ash-sessions-loading-block ash-sessions-loading-mark' }),
					h(
						document,
						'div',
						{ className: 'ash-sessions-loading-lines' },
						h(document, 'span', { className: 'ash-sessions-loading-block' }),
						h(document, 'span', { className: 'ash-sessions-loading-block' }),
						h(document, 'span', { className: 'ash-sessions-loading-block' }),
					),
				),
			);
		}
		this.element.append(this.status, shapes);
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
	}

	setVisible(visible: boolean): void {
		if (this.element.hidden === !visible) return;
		this.element.hidden = !visible;
		this.status.textContent = visible ? this.label : '';
	}
}
