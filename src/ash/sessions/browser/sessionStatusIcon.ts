import './sessionStatusIcon.css';
import { h } from '../../base/browser/dom.js';
import { appendIcon } from '../../base/browser/ui/lxicons/lxicon.js';
import { createPixelSpinner } from '../../base/browser/ui/pixelSpinner/pixelSpinner.js';
import type { Icon } from '../../base/common/icon.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { IAccessibilityService } from '../../platform/accessibility/common/accessibility.js';

export type ISessionStatusIcon = { readonly label: string; } & (
	| { readonly kind: 'inProgress' | 'static'; readonly icon: Icon; }
	| { render(container: HTMLElement, reducedMotion: boolean): IDisposable | void; }
);

type IconRenderer = Extract<ISessionStatusIcon, { render: unknown; }>['render'];
const spinner = Symbol('session spinner');

interface IconLayer {
	readonly element: HTMLElement;
	readonly resources: DisposableStore;
	readonly key: string | IconRenderer | typeof spinner;
}

/** Owns the visible status indicator and its transition inside a host-provided slot. */
export class SessionStatusIcon extends Disposable {
	private readonly transition = this._register(new MutableDisposable<DisposableStore>());
	private current: IconLayer | undefined;
	private status: ISessionStatusIcon | undefined;
	private restingIcon: Icon | undefined;

	constructor(private readonly container: HTMLElement,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
	) {
		super();
		this.container.classList.add('ash-session-status-icon');
		this._register(toDisposable(() => this.current?.resources.dispose()));
		this._register(accessibility.onDidChangeReducedMotion(() => {
			this.transition.clear();
			this.render(false, true);
		}));
	}

	setRestingIcon(icon: Icon | undefined): void {
		if (this.restingIcon?.id === icon?.id) { return; }
		this.restingIcon = icon;
		if (!this.status) { this.render(true); }
	}

	setStatus(status: ISessionStatusIcon | undefined): void {
		if (this.status === status) { return; }
		this.status = status;
		this.render(true);
	}

	private render(animate: boolean, motionChanged = false): void {
		const reducedMotion = this.accessibility.isMotionReduced();
		const custom = this.status && 'render' in this.status ? this.status.render : undefined;
		const statusIcon = this.status && 'kind' in this.status ? this.status : undefined;
		const icon = statusIcon?.icon ?? this.restingIcon;
		const key = custom ?? (statusIcon?.kind === 'inProgress' && !reducedMotion ? spinner : icon?.id);
		const previous = this.current;
		// Keep the spinner running when the label changes between in-progress states.
		if (previous?.key === key && !(custom && motionChanged)) { return; }

		this.transition.clear();
		this.current = undefined;
		if (key !== undefined) {
			const resources = new DisposableStore();
			const element = h(this.container.ownerDocument, 'span', { className: 'ash-session-status-icon-layer' });
			resources.add(toDisposable(() => element.remove()));
			if (custom) {
				const rendering = custom(element, reducedMotion);
				if (rendering) { resources.add(rendering); }
			} else if (key === spinner) {
				element.classList.add('ash-session-status-icon-progress');
				resources.add(createPixelSpinner(element, { variant: 'grid' }));
			} else if (icon) {
				appendIcon(icon, element);
			}
			this.container.append(element);
			this.current = { element, key, resources };
		}

		if (animate && !reducedMotion && previous && this.current) {
			this.crossFade(previous, this.current);
		} else {
			previous?.resources.dispose();
		}
	}

	private crossFade(previous: IconLayer, current: IconLayer): void {
		const resources = new DisposableStore();
		this.transition.value = resources;
		const timing = { duration: 180, easing: 'ease' };
		const outgoing = previous.element.animate([{ opacity: 1 }, { opacity: 0 }], timing);
		const incoming = current.element.animate([{ opacity: 0 }, { opacity: 1 }], timing);
		resources.add(previous.resources);
		resources.add(toDisposable(() => {
			outgoing.onfinish = null;
			outgoing.cancel();
			incoming.cancel();
		}));
		outgoing.onfinish = () => this.transition.clear();
	}
}
