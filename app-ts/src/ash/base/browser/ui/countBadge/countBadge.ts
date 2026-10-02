import { h } from '../../dom.js';
import { Disposable, toDisposable } from '../../../common/lifecycle.js';
import { formatNlsMessage } from '../../../../nls.js';
import { getHoverDelegate, type IManagedHover } from '../hover/hoverDelegate.js';
import './countBadge.css';

export interface ICountBadgeOptions {
	readonly count?: number;
	readonly countFormat?: string;
	readonly titleFormat?: string;
}

/** A non-interactive count with shared theming and a description that follows its value. */
export class CountBadge extends Disposable {
	public readonly domNode: HTMLSpanElement;
	private readonly hover: IManagedHover | undefined;

	constructor(container: HTMLElement, private readonly options: ICountBadgeOptions = {}) {
		super();
		this.domNode = h(container.ownerDocument, 'span');
		this.domNode.className = 'ash-count-badge';
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		if (options.titleFormat) {
			this.hover = this._register(getHoverDelegate().setupHover({ target: this.domNode, content: '' }));
		}
		this.render(options.count ?? 0);
	}

	public setCount(count: number): void {
		this.render(count);
	}

	private render(count: number): void {
		const parameters = { '0': count };
		this.domNode.textContent = formatNlsMessage(this.options.countFormat ?? '{0}', parameters);
		if (this.options.titleFormat) {
			const description = formatNlsMessage(this.options.titleFormat, parameters);
			this.domNode.setAttribute('aria-label', description);
			this.hover!.update(description);
		}
	}
}
