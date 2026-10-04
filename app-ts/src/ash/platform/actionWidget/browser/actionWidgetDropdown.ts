import { addDisposableListener, stopEvent } from '../../../base/browser/dom.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import { Separator, type IAction } from '../../../base/common/actions.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { ActionListItemKind, type IActionListOptions } from './actionList.js';
import { IActionWidgetService } from './actionWidget.js';

export interface IActionWidgetDropdownAction extends IAction {}

export interface IActionWidgetDropdownOptions {
	readonly label: string;
	readonly ariaLabel: string;
	readonly actions: readonly IActionWidgetDropdownAction[];
	readonly listOptions?: IActionListOptions;
}

/** Owns a dropdown trigger; the shared action service owns its popup and dismissal. */
export class ActionWidgetDropdown extends Disposable {
	public readonly element: HTMLButtonElement;
	private readonly button: Button;
	private visible = false;

	constructor(
		container: HTMLElement,
		private readonly options: IActionWidgetDropdownOptions,
		@IActionWidgetService private readonly actionWidgetService: IActionWidgetService,
	) {
		super();
		this.button = this._register(new Button(container, {
			label: options.label,
			ariaLabel: options.ariaLabel,
			icon: Lxicon.chevronDown,
			presentation: 'secondary',
			size: 'small',
			onClick: () => this.visible ? this.hide() : this.show(),
		}));
		this.element = this.button.domNode;
		this.element.classList.add('ash-action-widget-dropdown');
		this.element.setAttribute('aria-haspopup', 'menu');
		this.element.setAttribute('aria-expanded', 'false');
		this._register(toDisposable(() => this.hide()));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (!event.isComposing && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
				stopEvent(event);
				this.show();
			}
		}));
	}

	public show(): void {
		if (this.visible) {
			return;
		}
		this.visible = true;
		this.element.setAttribute('aria-expanded', 'true');
		this.actionWidgetService.show('actionWidgetDropdown', false, this.options.actions.map(action => ({
			kind: action instanceof Separator ? ActionListItemKind.Separator : ActionListItemKind.Action,
			item: action,
			label: action.label,
			disabled: !action.enabled,
		})), {
			onSelect: async action => {
				// Running a choice may replace its trigger; retire this popup before that replacement opens another.
				this.hide();
				await action.run();
			},
			onHide: () => {
				this.visible = false;
				this.element.setAttribute('aria-expanded', 'false');
			},
		}, this.element, this.options.listOptions);
	}

	public hide(): void {
		if (this.visible) {
			this.actionWidgetService.hide();
		}
	}
}
