import { getActiveElement, h } from '../../../base/browser/dom.js';
import { observeElementSize } from '../../../base/browser/observer.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import { ScrollableElement } from '../../../base/browser/ui/scrollbar/scrollableElement.js';
import { defaultGenerator } from '../../../base/common/idGenerator.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { autorun } from '../../../base/common/observable.js';
import { IMenuService } from '../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../platform/theme/browser/defaultStyles.js';
import type { AbstractCustomView, ICustomViewDescriptor } from '../../services/customView/browser/customView.js';

/** Owns one contributed page and keeps its header visible while the body scrolls. */
export class CustomViewNode extends Disposable {
	private readonly element: HTMLElement;
	private readonly scrolling: ScrollableElement;
	private readonly view: AbstractCustomView;

	constructor(
		container: HTMLElement,
		descriptor: ICustomViewDescriptor,
		@IInstantiationService instantiation: IInstantiationService,
		@IMenuService menus: IMenuService,
		@IContextKeyService contexts: IContextKeyService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		const document = container.ownerDocument;
		const fill = descriptor.layout === 'fill';
		const actionOptions = descriptor.actions;
		const iconOnly = actionOptions?.style === 'toolbar';

		this.view = this._register(instantiation.createInstance(descriptor.ctor));
		const title = h(document, 'h1', { attributes: { id: defaultGenerator.nextId() } });
		const description = h(document, 'p');
		const actions = h(document, 'div', { className: 'ash-custom-view-actions' });
		const header = h(document, 'header', { className: 'ash-custom-view-header' }, title, description, actions);
		header.classList.toggle('has-toolbar', iconOnly);

		this.element = h(document, 'section', {
			className: 'ash-custom-view-page',
			attributes: { 'aria-labelledby': title.id, 'data-custom-view-id': descriptor.id },
		}, header);
		this._register(toDisposable(() => this.element.remove()));

		this.scrolling = this._register(new ScrollableElement(this.element, { direction: 'vertical', tabIndex: -1 }));
		this.scrolling.element.classList.add('ash-custom-view-scroll');
		this.scrolling.contentElement.classList.toggle('ash-custom-view-fill', fill);
		const content = h(document, 'div', { className: 'ash-custom-view-body' });
		const maxWidth = fill ? 'none' : `${this.view.maxWidth ?? 960}px`;
		header.style.maxWidth = maxWidth;
		content.style.maxWidth = maxWidth;
		this.scrolling.append(content);

		this._register(autorun(reader => {
			title.textContent = this.view.title.read(reader);
			description.textContent = this.view.description.read(reader) ?? '';
			description.hidden = !description.textContent;
		}));

		if (actionOptions) {
			const menu = this._register(menus.createMenu(actionOptions.menuId, contexts));
			const buttons = this._register(new MutableDisposable<DisposableStore>());
			const update = (): void => {
				const lifetime = new DisposableStore();
				buttons.value = lifetime;
				actions.replaceChildren();
				for (const [, group] of menu.getActions()) {
					for (const action of group) {
						const button = lifetime.add(new Button(actions, {
							...defaultButtonStyles,
							label: action.label,
							icon: action.icon,
							iconOnly,
							presentation: action.id === actionOptions.primaryActionId ? 'primary' : 'quiet',
							enabled: action.enabled,
							onClick: () => {
								void Promise.resolve(action.run()).catch(error => notifications.error(String(error)));
							},
						}));
						button.domNode.dataset.actionId = action.id;
					}
				}
			};
			this._register(menu.onDidChange(update));
			update();
		}

		container.append(this.element);
		try {
			this.view.render(content);
		} catch (error) {
			this.dispose();
			throw error;
		}
		// Header changes can resize the body without changing the Grid allocation.
		this._register(observeElementSize(this.scrolling.scrollableElement, size => {
			this.view.layout(content.clientWidth, size.height);
		}));
	}

	focus(): void {
		this.view.focus();
		if (!this.element.contains(getActiveElement(this.element.ownerDocument))) {
			this.scrolling.element.focus({ preventScroll: true });
		}
	}
}
