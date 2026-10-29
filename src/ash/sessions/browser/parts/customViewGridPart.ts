import { defaultButtonStyles } from '../../../platform/theme/browser/defaultStyles.js';
import { h, type IDimension } from '../../../base/browser/dom.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import { ScrollableElement } from '../../../base/browser/ui/scrollbar/scrollableElement.js';
import { DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { autorun } from '../../../base/common/observable.js';
import { IMenuService } from '../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { Part } from '../../../workbench/browser/part.js';
import type { AbstractCustomView, ICustomViewDescriptor } from '../../services/customView/browser/customView.js';
import type { ICustomViewGridPartService } from '../../services/customView/browser/customViewGridPartService.js';
import './media/customViewGridPart.css';

/** Passive renderer. Workbench selects the view and commits its visibility before focusing it. */
export class CustomViewGridPart extends Part implements ICustomViewGridPartService {
	private readonly rendered = this._register(new MutableDisposable<DisposableStore>());
	private active: AbstractCustomView | undefined;
	private descriptor: ICustomViewDescriptor | undefined;
	private dimension: IDimension = { width: 0, height: 0 };
	override get minimumWidth(): number {
		return 300;
	}

	constructor(
		container: HTMLElement,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IMenuService private readonly menus: IMenuService,
		@IContextKeyService private readonly contexts: IContextKeyService,
		@INotificationService private readonly notifications: INotificationService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) {
		super(container, 'customview', theme, storage);
		this.domNode.classList.add('ash-custom-view-grid');
		this.titleDomNode.hidden = true;
	}

	setView(descriptor: ICustomViewDescriptor | undefined): void {
		if (descriptor === this.descriptor) return;
		this.rendered.clear();
		this.active = undefined;
		this.descriptor = descriptor;
		this.contentDomNode.replaceChildren();
		if (!descriptor) return;
		const lifetime = new DisposableStore();
		this.rendered.value = lifetime;
		const view = lifetime.add(this.instantiation.createInstance(descriptor.ctor));
		this.active = view;
		const scrolling = lifetime.add(
			new ScrollableElement(this.contentDomNode, { direction: 'vertical', tabIndex: -1 }),
		);
		scrolling.element.classList.add('ash-custom-view-scroll');
		const page = h(this.domNode.ownerDocument, 'div', { className: 'ash-custom-view-page' });
		page.dataset.customViewId = descriptor.id;
		page.style.maxWidth = `${view.maxWidth ?? 960}px`;
		const header = h(this.domNode.ownerDocument, 'header', { className: 'ash-custom-view-header' });
		const title = h(this.domNode.ownerDocument, 'h1');
		const description = h(this.domNode.ownerDocument, 'p');
		const actions = h(this.domNode.ownerDocument, 'div', { className: 'ash-custom-view-actions' });
		header.append(title, description, actions);
		page.append(header);
		scrolling.contentElement.append(page);
		lifetime.add(
			autorun(reader => {
				title.textContent = view.title.read(reader);
				description.textContent = view.description.read(reader) ?? '';
				description.hidden = !description.textContent;
			}),
		);
		if (descriptor.actions) {
			const menu = lifetime.add(this.menus.createMenu(descriptor.actions.menuId, this.contexts));
			const buttons = lifetime.add(new MutableDisposable<DisposableStore>());
			const update = (): void => {
				buttons.value = new DisposableStore();
				actions.replaceChildren();
				for (const [, group] of menu.getActions())
					for (const action of group) {
						const button = buttons.value.add(
							new Button(actions, {
								...defaultButtonStyles,
								label: action.label,
								icon: action.icon,
								presentation: action.id === descriptor.actions?.primaryActionId ? 'primary' : 'quiet',
								enabled: action.enabled,
								onClick: () => {
									void Promise.resolve(action.run()).catch(error =>
										this.notifications.error(String(error)),
									);
								},
							}),
						);
						button.domNode.dataset.actionId = action.id;
					}
			};
			lifetime.add(menu.onDidChange(update));
			update();
		}
		const content = h(this.domNode.ownerDocument, 'div');
		page.append(content);
		view.render(content);
		view.layout(this.dimension.width, this.dimension.height);
	}

	focusActiveView(): void {
		this.active?.focus();
	}

	override layout(dimension: IDimension): void {
		this.dimension = dimension;
		this.active?.layout(dimension.width, dimension.height);
	}
}
