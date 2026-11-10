import { h } from '../../dom.js';
import { Disposable, toDisposable } from '../../../common/lifecycle.js';
import { formatNlsMessage } from '../../../../nls.js';
import { getHoverDelegate, type IManagedHover } from '../hover/hoverDelegate.js';
import './countBadge.css';

/** Host-provided CSS colors, resolved through the containing theme root. */
export interface ICountBadgeStyles {
	readonly badgeBackground: string | undefined;
	readonly badgeForeground: string | undefined;
	readonly badgeBorder: string | undefined;
}

interface IBadgeOptions {
	/** Outlined badges remain visually secondary alongside labels. */
	readonly presentation?: 'default' | 'accent' | 'outlined';
	readonly size?: 'default' | 'small';
}

export interface ICountBadgeOptions extends IBadgeOptions {
	readonly count?: number;
	readonly countFormat?: string;
	readonly titleFormat?: string;
}

/** A non-interactive badge whose host controls layout and accessible associations. */
export class Badge extends Disposable {
	protected readonly element: HTMLSpanElement;

	constructor(container: HTMLElement, label: string, options: IBadgeOptions = {}, styles?: ICountBadgeStyles) {
		super();
		this.element = h(container.ownerDocument, 'span');
		this.element.className = 'ash-badge';
		this.element.textContent = label;
		if (styles) {
			const colors = {
				'--ash-badge-style-badge-background': styles.badgeBackground,
				'--ash-badge-style-badge-foreground': styles.badgeForeground,
				'--ash-badge-style-badge-border': styles.badgeBorder,
			};
			for (const [property, value] of Object.entries(colors)) {
				if (value !== undefined) this.element.style.setProperty(property, value);
			}
		}
		this.element.classList.toggle('accent', options.presentation === 'accent');
		this.element.classList.toggle('outlined', options.presentation === 'outlined');
		this.element.classList.toggle('small', options.size === 'small');
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
	}
}

/** A badge that keeps its formatted count, accessible description and hover in sync. */
export class CountBadge extends Badge {
	private readonly hover: IManagedHover | undefined;

	constructor(container: HTMLElement, private readonly options: ICountBadgeOptions = {}, styles?: ICountBadgeStyles) {
		super(container, '', options, styles);
		this.element.classList.add('ash-count-badge');
		if (options.titleFormat) {
			this.hover = this._register(getHoverDelegate().setupHover({ target: this.element, content: '' }));
		}
		this.render(options.count ?? 0);
	}

	public setCount(count: number): void {
		this.render(count);
	}

	private render(count: number): void {
		const parameters = { '0': count };
		this.element.textContent = formatNlsMessage(this.options.countFormat ?? '{0}', parameters);
		if (this.options.titleFormat) {
			const description = formatNlsMessage(this.options.titleFormat, parameters);
			this.element.setAttribute('aria-label', description);
			this.hover!.update(description);
		}
	}
}
