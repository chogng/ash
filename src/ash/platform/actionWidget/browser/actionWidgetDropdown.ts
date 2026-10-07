import { addDisposableListener, stopEvent } from '../../../base/browser/dom.js';
import { EventType, Gesture } from '../../../base/browser/touch.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import { Separator, type IAction } from '../../../base/common/actions.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { ActionListItemKind, type IActionListOptions } from './actionList.js';
import { IActionWidgetService } from './actionWidget.js';

export interface IActionWidgetDropdownAction extends IAction { }

export interface IActionWidgetDropdownActionProvider {
	getActions(): readonly IActionWidgetDropdownAction[] | Promise<readonly IActionWidgetDropdownAction[]>;
}

export interface IActionWidgetDropdownOptions {
	readonly label: string;
	readonly ariaLabel: string;
	readonly actions?: readonly IActionWidgetDropdownAction[];
	readonly actionProvider?: IActionWidgetDropdownActionProvider;
	/** A custom renderer owns the trigger's label content; the dropdown retains the trigger and input listeners. */
	readonly labelRenderer?: (element: HTMLElement) => IDisposable | null;
	readonly getAnchor?: () => HTMLElement;
	readonly listOptions?: IActionListOptions;
}

/** Owns a dropdown trigger; the shared action service owns its popup and dismissal. */
export class ActionWidgetDropdown extends Disposable {
	public readonly element: HTMLButtonElement;
	private readonly visibilityChanged = this._register(new Emitter<boolean>());
	public readonly onDidChangeVisibility = this.visibilityChanged.event;
	private visible = false;
	private opening: object | undefined;

	constructor(
		container: HTMLElement,
		private readonly options: IActionWidgetDropdownOptions,
		@IActionWidgetService private readonly actionWidgetService: IActionWidgetService,
	) {
		super();
		if (!options.actions && !options.actionProvider) { throw new TypeError('An action dropdown requires actions or an action provider'); }
		const button = this._register(new Button(container, {
			label: options.label,
			ariaLabel: options.ariaLabel,
			icon: options.labelRenderer ? undefined : Lxicon.chevronDown,
			presentation: options.labelRenderer ? 'quiet' : 'secondary',
			size: options.labelRenderer ? 'standard' : 'small',
		}));
		this.element = button.domNode;
		this.element.classList.add('ash-action-widget-dropdown');
		if (options.labelRenderer) {
			const label = options.labelRenderer(this.element);
			if (label) { this._register(label); }
		}
		this.element.setAttribute('aria-haspopup', 'menu');
		this.element.setAttribute('aria-expanded', 'false');
		this._register(toDisposable(() => this.hide()));
		this._register(addDisposableListener(this.element, 'mousedown', event => {
			if (event.button !== 0 || this.element.disabled) { return; }
			stopEvent(event);
			this.activate();
		}));
		this._register(Gesture.addTarget(this.element));
		this._register(addDisposableListener(this.element, EventType.Tap, event => {
			stopEvent(event);
			if (!this.element.disabled) { this.activate(); }
		}));
		// Assistive technology activates semantic buttons via click without a preceding pointer sequence.
		this._register(addDisposableListener(this.element, 'click', event => {
			if (event.detail === 0 && !this.element.disabled) { this.activate(); }
		}));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.isComposing || this.element.disabled) { return; }
			if (event.key === 'Enter' || event.key === ' ') {
				stopEvent(event);
				this.activate();
			} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				stopEvent(event);
				this.show();
			}
		}));
	}

	public show(): void {
		if (this.visible || this.opening || this.element.disabled) {
			return;
		}
		if (this.options.actionProvider) {
			const request = this.opening = {};
			void this.readActions(request);
			return;
		}
		this.showActions(this.options.actions!);
	}

	private async readActions(request: object): Promise<void> {
		let actions: readonly IActionWidgetDropdownAction[];
		try {
			actions = await this.options.actionProvider!.getActions();
		} catch {
			if (this.opening === request) { this.opening = undefined; }
			return;
		}
		// Dismissal or disposal invalidates a pending catalog read before it can display a menu.
		if (this.opening !== request || this.isDisposed) { return; }
		this.opening = undefined;
		this.showActions(actions);
	}

	private showActions(actions: readonly IActionWidgetDropdownAction[]): void {
		if (actions.length === 0) { return; }
		this.visible = true;
		this.element.setAttribute('aria-expanded', 'true');
		this.visibilityChanged.fire(true);
		this.actionWidgetService.show('actionWidgetDropdown', false, actions.map(action => ({
			kind: action instanceof Separator ? ActionListItemKind.Separator : ActionListItemKind.Action,
			item: action,
			label: action.label,
			disabled: !action.enabled,
			checked: action.checked,
			group: { title: '', icon: action.icon },
		})), {
			onSelect: async action => {
				// Running a choice may replace its trigger; retire this popup before that replacement opens another.
				this.hide();
				await action.run();
			},
			onHide: () => {
				this.visible = false;
				this.element.setAttribute('aria-expanded', 'false');
				this.visibilityChanged.fire(false);
			},
		}, this.options.getAnchor?.() ?? this.element, this.options.listOptions);
	}

	public hide(): void {
		this.opening = undefined;
		if (this.visible) {
			this.actionWidgetService.hide();
		}
	}

	public setEnabled(enabled: boolean): void {
		this.element.disabled = !enabled;
		this.element.setAttribute('aria-disabled', String(!enabled));
		if (!enabled) { this.hide(); }
	}

	private activate(): void {
		this.element.focus();
		if (this.visible || this.opening) { this.hide(); }
		else { this.show(); }
	}
}
