import "./views.css";
import { Emitter } from "../../../../base/common/event.js";
import { Pane, type IPaneOptions } from "../../../../base/browser/ui/splitview/paneview.js";
import type { IView } from "../../../common/views.js";
import { isAncestorOfActiveElement } from '../../../../base/browser/focus.js';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { IViewContentDescriptor, WorkbenchViewRegistry } from '../../../common/views.js';
import { localize } from '../../../../nls.js';

/** Runtime inputs supplied by a browser view container to every pane. */
export type IViewPaneOptions = IPaneOptions;

/** Optional title content and actions projected together into a hosting Part. */
export interface PartTitleProjection {
	readonly content?: HTMLElement;
	readonly actions?: HTMLElement;
}

/** A titled, independently managed view hosted inside a workbench view container. */
export abstract class ViewPane extends Pane implements IView {
	protected readonly viewWelcomeState = this._register(new Emitter<void>());
	public readonly onDidChangeViewWelcomeState = this.viewWelcomeState.event;

	public shouldShowWelcome(): boolean {
		return false;
	}
	private visible = false;
	private readonly bodyVisibility = this._register(new Emitter<boolean>());
	readonly onDidChangeBodyVisibility = this.bodyVisibility.event;
	private readonly visibility = this._register(new Emitter<boolean>());
	public readonly onDidChangeVisibility = this.visibility.event;

	protected constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		this.element.classList.add("ash-view-pane");
		this.element.dataset.viewId = options.id;
		this.element.hidden = true;
	}

	/** Optional title content and actions projected into the hosting Pane Composite Part. */
	get partTitleProjection(): PartTitleProjection | undefined {
		return undefined;
	}

	/** Views with intrinsic content widths report them independently of the current allocation. */
	getOptimalWidth(): number {
		return 0;
	}

	isVisible(): boolean {
		return this.visible;
	}

	public hasFocus(): boolean {
		return isAncestorOfActiveElement(this.element);
	}

	isBodyVisible(): boolean {
		return this.visible && this.isExpanded();
	}

	isExpanded(): boolean {
		return !this.isCollapsed();
	}

	setExpanded(expanded: boolean): boolean {
		const changed = expanded !== this.isExpanded();
		this.setCollapsed(!expanded);
		return changed;
	}

	override setCollapsed(collapsed: boolean): void {
		if (collapsed === this.isCollapsed()) return;
		const bodyWasVisible = this.isBodyVisible();
		super.setCollapsed(collapsed);
		if (bodyWasVisible !== this.isBodyVisible()) this.bodyVisibility.fire(this.isBodyVisible());
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.element.hidden = !visible;
		this.visibility.fire(visible);
		if (this.isExpanded()) this.bodyVisibility.fire(visible);
	}
}

/** Owns welcome DOM and listeners for the pane that creates it. */
export class ViewWelcomeController extends Disposable {
	private readonly renderedContent = this._register(new DisposableStore());
	private readonly domNode: HTMLElement;
	private readonly scrollable: ScrollableElement;
	private descriptors: readonly IViewContentDescriptor[] = [];
	private readonly buttons: { button: Button; descriptor: IViewContentDescriptor; }[] = [];
	private isEnabled = false;
	public get enabled(): boolean { return this.isEnabled; }

	constructor(
		private readonly container: HTMLElement,
		private readonly delegate: Pick<ViewPane, 'id' | 'shouldShowWelcome' | 'onDidChangeViewWelcomeState'>,
		private readonly registry: WorkbenchViewRegistry,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IOpenerService private readonly openerService: IOpenerService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-view-welcome hidden';
		this.domNode.hidden = true;
		this.domNode.tabIndex = -1;
		this.domNode.setAttribute('role', 'region');
		this.domNode.setAttribute('aria-label', localize('view.welcome', 'Welcome'));
		container.append(this.domNode);
		this.scrollable = this._register(new ScrollableElement(this.domNode, { direction: 'vertical', tabIndex: -1 }));
		this.scrollable.element.classList.add('ash-view-welcome-viewport');
		this.scrollable.contentElement.classList.add('ash-view-welcome-content');
		this._register(toDisposable(() => {
			container.classList.remove('welcome');
			this.domNode.remove();
		}));
		this._register(delegate.onDidChangeViewWelcomeState(() => this.update()));
		this._register(registry.onDidChangeViewWelcomeContent(id => {
			if (id === delegate.id) this.update();
		}));
		this._register(contextKeyService.onDidChangeContext(event => {
			const keys = new Set<string>();
			for (const descriptor of registry.getViewWelcomeContent(delegate.id)) {
				for (const expression of [descriptor.when, descriptor.precondition]) {
					if (expression && expression !== 'default') {
						for (const key of expression.keys()) keys.add(key);
					}
				}
			}
			if (event.affectsSome(keys)) this.update();
		}));
	}

	public focus(): void {
		(this.buttons.find(item => item.button.enabled)?.button.domNode ?? this.domNode).focus();
	}

	public update(): void {
		if (this.isDisposed) return;
		const contents = this.registry.getViewWelcomeContent(this.delegate.id);
		let selected = contents.filter(descriptor => descriptor.when !== 'default' && this.contextKeyService.contextMatchesRules(descriptor.when, this.container));
		if (selected.length === 0) selected = contents.filter(descriptor => descriptor.when === 'default');
		const enabled = this.delegate.shouldShowWelcome() && selected.length > 0;
		const hadFocus = this.domNode.contains(this.domNode.ownerDocument.activeElement);
		this.isEnabled = enabled;
		this.domNode.hidden = !enabled;
		this.domNode.classList.toggle('hidden', !enabled);
		this.container.classList.toggle('welcome', enabled);
		if (!enabled) selected = [];
		if (selected.length !== this.descriptors.length || selected.some((descriptor, index) => descriptor !== this.descriptors[index])) {
			this.renderedContent.clear();
			this.buttons.length = 0;
			this.scrollable.replaceChildren();
			this.descriptors = selected;
			for (const descriptor of selected) {
				for (const line of descriptor.content.split('\n').map(line => line.trim()).filter(Boolean)) {
					const link = /^\[([^\]]+)\]\((command:[^\s)]+)\)$/u.exec(line);
					if (link) {
						const button = this.renderedContent.add(new Button(this.scrollable.contentElement, {
							label: link[1], title: link[1],
							presentation: 'primary',
							onClick: () => { void this.open(link[2], descriptor); },
						}));
						this.buttons.push({ button, descriptor });
					} else {
						const paragraph = h(this.domNode.ownerDocument, 'p');
						paragraph.textContent = line;
						this.scrollable.contentElement.append(paragraph);
					}
				}
			}
		}
		for (const { button, descriptor } of this.buttons) {
			button.enabled = this.contextKeyService.contextMatchesRules(descriptor.precondition, this.container);
		}
		this.scrollable.layout();
		if (hadFocus) {
			if (enabled && !this.domNode.contains(this.domNode.ownerDocument.activeElement)) this.focus();
			if (!enabled) this.container.closest<HTMLElement>('.ash-view-pane')?.focus();
		}
	}

	private async open(target: string, descriptor: IViewContentDescriptor): Promise<void> {
		if (!this.enabled || !this.contextKeyService.contextMatchesRules(descriptor.precondition, this.container)) return;
		try {
			// Only registered product content reaches this renderer; command links retain their existing host owner.
			await this.openerService.open(target, { allowCommands: true, fromUserGesture: true });
		} catch (error) {
			this.notifications.error(localize('view.welcome.actionFailed', 'Could not complete the action: {0}', error instanceof Error ? error.message : String(error)));
		}
	}
}
