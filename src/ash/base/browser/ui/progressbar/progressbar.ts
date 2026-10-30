import { Disposable, toDisposable } from '../../../common/lifecycle.js';
import { h } from '../../dom.js';
import './progressbar.css';

export interface IProgressBarStyles {
	readonly progressBarBackground: string | undefined;
}

/** A determinate or indeterminate progress indicator. */
export class ProgressBar extends Disposable {
	readonly element: HTMLProgressElement;

	constructor(container: HTMLElement, options: Partial<IProgressBarStyles> = {}) {
		super();
		const element = h(container.ownerDocument, 'progress');
		this.element = element;
		this._register(toDisposable(() => element.remove()));
		element.className = 'ash-progress-bar';
		if (options.progressBarBackground !== undefined) {
			element.style.accentColor = options.progressBarBackground;
			element.style.color = options.progressBarBackground;
		}
		element.max = 1;
		container.append(element);
	}

	set value(value: number | undefined) {
		if (value === undefined) this.element.removeAttribute('value');
		else this.element.value = Math.max(0, Math.min(1, value));
	}
}
