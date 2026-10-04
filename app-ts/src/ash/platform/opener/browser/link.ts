import './link.css';
import { addDisposableListener, stopEvent } from '../../../base/browser/dom.js';
import type { IHoverDelegate, IManagedHover } from '../../../base/browser/ui/hover/hoverDelegate.js';
import { onUnexpectedError } from '../../../base/common/errors.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IHoverService } from '../../hover/browser/hoverService.js';
import { IOpenerService } from '../common/opener.js';

export interface ILinkDescriptor {
	readonly label: string | HTMLElement;
	readonly href: string;
	readonly title?: string;
	readonly tabIndex?: number;
}

export interface ILinkOptions {
	readonly opener?: (href: string) => void;
	readonly hoverDelegate?: IHoverDelegate;
	readonly textLinkForeground?: string;
}

/** An inline UI action. Editor text links remain owned by the editor contribution. */
export class Link extends Disposable {
	private readonly anchorDomNode: HTMLAnchorElement;
	private readonly tooltip = this._register(new MutableDisposable<IManagedHover>());
	private readonly hoverDelegate: IHoverDelegate;
	private descriptor: ILinkDescriptor;
	private isEnabled = true;

	constructor(
		container: HTMLElement,
		descriptor: ILinkDescriptor,
		private readonly options: ILinkOptions = {},
		@IHoverService hoverService: IHoverService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		this.descriptor = descriptor;
		this.hoverDelegate = options.hoverDelegate ?? hoverService;
		this.anchorDomNode = container.ownerDocument.createElement('a');
		this.anchorDomNode.className = 'ash-link';
		this.anchorDomNode.setAttribute('role', 'button');
		if (options.textLinkForeground) this.anchorDomNode.style.setProperty('--ash-link-foreground', options.textLinkForeground);
		container.append(this.anchorDomNode);
		this._register(toDisposable(() => this.anchorDomNode.remove()));
		this._register(addDisposableListener(this.anchorDomNode, 'click', event => this.activate(event)));
		this._register(addDisposableListener(this.anchorDomNode, 'keydown', event => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			stopEvent(event);
			if (!event.repeat) this.activate(event);
		}));
		this.link = descriptor;
	}

	get enabled(): boolean { return this.isEnabled; }

	set enabled(value: boolean) {
		this.assertNotDisposed();
		this.isEnabled = value;
		this.anchorDomNode.classList.toggle('disabled', !value);
		this.anchorDomNode.setAttribute('aria-disabled', String(!value));
		this.anchorDomNode.tabIndex = value ? this.descriptor.tabIndex ?? 0 : -1;
		this.updateTooltip();
	}

	set link(descriptor: ILinkDescriptor) {
		this.assertNotDisposed();
		this.descriptor = descriptor;
		this.anchorDomNode.replaceChildren(descriptor.label);
		this.anchorDomNode.href = descriptor.href;
		this.enabled = this.isEnabled;
	}

	private updateTooltip(): void {
		if (!this.isEnabled || !this.descriptor.title) {
			this.tooltip.clear();
		} else if (this.tooltip.value) {
			this.tooltip.value.update(this.descriptor.title);
		} else {
			this.tooltip.value = this.hoverDelegate.setupHover({ target: this.anchorDomNode, content: this.descriptor.title });
		}
	}

	private activate(event: MouseEvent | KeyboardEvent): void {
		// The service owns navigation, including rejection. The anchor must never navigate itself.
		stopEvent(event);
		if (!this.isEnabled) return;
		if (this.options.opener) this.options.opener(this.descriptor.href);
		else void this.openerService.open(this.descriptor.href, { fromUserGesture: true, allowContributedOpeners: true }).catch(onUnexpectedError);
	}
}
