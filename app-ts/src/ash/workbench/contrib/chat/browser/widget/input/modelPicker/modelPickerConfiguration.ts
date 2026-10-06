import { addDisposableListener, h, stopEvent } from '../../../../../../../base/browser/dom.js';
import { status } from '../../../../../../../base/browser/ui/aria/aria.js';
import { ButtonActionViewItem } from '../../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { AnchorPosition, ContextView, ContextViewFocusRestore } from '../../../../../../../base/browser/ui/contextview/contextview.js';
import { Menu } from '../../../../../../../base/browser/ui/menu/menu.js';
import type { IAction } from '../../../../../../../base/common/actions.js';
import { MutableDisposable } from '../../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextViewService } from '../../../../../../../platform/contextview/browser/contextView.js';
import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../../../../services/chat/common/modelCatalog.js';
import { modelPickerEffortLabel, modelPickerEffortOptions } from './modelPickerModelConfig.js';
import './modelPicker.css';

let nextConfigurationId = 0;

/** Presents the selected model's thinking effort beside the model selector. */
export class ModelPickerConfiguration extends ButtonActionViewItem {
	private readonly contextView: ContextView;
	private readonly menu = this._register(new MutableDisposable<Menu>());

	constructor(
		action: IAction,
		private readonly entry: ModelCatalogEntry,
		private readonly selectedEffort: ModelReasoningEffort | undefined,
		private readonly selectReasoningEffort: (effort: ModelReasoningEffort | undefined) => Promise<void>,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IAccessibleViewService private readonly accessibleViewService: IAccessibleViewService,
	) {
		super(action);
		this.contextView = this._register(new ContextView(contextViewService.container));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('ash-chat-input-effort-selector');
		this.button.toggleClassName('ash-chat-input-action', true);
		this.button.toggleClassName('ash-chat-input-effort-action', true);
		this.button.domNode.querySelector('.ash-button-label')?.classList.add('ash-chat-input-effort-label');
		this.button.domNode.setAttribute('aria-haspopup', 'menu');
		this.button.domNode.setAttribute('aria-expanded', 'false');
		this.button.domNode.setAttribute('aria-label', this.action.tooltip);
		const button = this.button.domNode;
		const updateHelpHint = (): void => {
			const hint = this.accessibleViewService.getOpenAriaHint(AccessibilityVerbositySettingId.ChatModelConfiguration);
			const selected = modelPickerEffortOptions(this.entry, this.selectedEffort).find(option => option.checked);
			const description = [selected?.description, hint].filter(Boolean).join(' ');
			if (description) button.setAttribute('aria-description', description);
			else button.removeAttribute('aria-description');
		};
		updateHelpHint();
		this._register(addDisposableListener(button, 'focus', updateHelpHint));
		this._register(AccessibleViewRegistry.register({
			type: AccessibleViewType.Help,
			priority: 100,
			name: `chatModelConfiguration-${++nextConfigurationId}`,
			getProvider: () => {
				const active = button.ownerDocument.activeElement;
				if (active !== button && (!active || !this.menu.value?.contains(active))) return undefined;
				return new AccessibleContentProvider(
					AccessibleViewProviderId.ChatModelConfiguration,
					{ type: AccessibleViewType.Help },
					() => [localize('chat.modelPicker.effortHelp', "Thinking level menu. Press Enter or Space to open it. Use Up and Down Arrow to choose a level, Enter to apply it, or Escape to return to the button. The level marked Default uses the model's configured effort."), ...modelPickerEffortOptions(this.entry, this.selectedEffort).filter(option => option.description).map(option => `${option.label}: ${option.description}`)].join('\n'),
					() => button.focus(),
					AccessibilityVerbositySettingId.ChatModelConfiguration,
				);
			},
		}));
		this._register(addDisposableListener(this.button.domNode, 'keydown', event => {
			if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
			stopEvent(event);
			this.show();
		}));
	}

	protected override runAction(): void {
		if (this.contextView.visible) {
			this.contextView.hide();
			return;
		}
		this.show();
	}

	private show(): void {
		if (this.contextView.visible) return;
		const options = modelPickerEffortOptions(this.entry, this.selectedEffort);
		const actions: IAction[] = options.map(option => {
			const { effort, label } = option;
			return {
				id: `ash.chat.input.effort.${effort ?? 'default'}`,
				label,
				tooltip: label,
				enabled: true,
				checked: option.checked,
				...(option.isDefault ? { badge: modelPickerEffortLabel(undefined) } : {}),
				run: async () => {
					try {
						await this.selectReasoningEffort(option.value);
					} catch {
						status(localize('chat.modelPicker.effortFailed', 'Could not set thinking effort'));
					}
				},
			};
		});
		const menu = new Menu(this.contextView.element, {
			actions,
			contextViewContainer: this.contextViewService.container,
			layer: 20,
			getCheckedActionsRepresentation: () => 'radio',
			onDidSelect: () => this.contextView.hide(),
		});
		menu.element.classList.add('ash-chat-model-configuration-menu');
		menu.element.setAttribute('aria-label', localize('chat.modelPicker.thinkingEffort', 'Thinking Level'));
		const heading = h(menu.element.ownerDocument, 'div');
		heading.className = 'ash-chat-model-configuration-heading';
		heading.setAttribute('role', 'presentation');
		heading.textContent = localize('chat.modelPicker.thinkingEffort', 'Thinking Level');
		menu.element.prepend(heading);
		for (const option of options) {
			const description = [option.description, option.isDefault ? modelPickerEffortLabel(undefined) : undefined].filter(Boolean).join(' ');
			if (description) menu.element.querySelector<HTMLButtonElement>(`[data-action-id='ash.chat.input.effort.${option.effort ?? 'default'}'] button`)?.setAttribute('aria-description', description);
		}
		this.menu.value = menu;
		const shown = this.contextView.show({
			anchor: this.button.domNode,
			content: menu.element,
			anchorPosition: AnchorPosition.Above,
			gap: 4,
			presentation: 'menu',
			focusRestore: ContextViewFocusRestore.Previous,
			layer: 20,
			isTargetWithin: target => menu.contains(target),
			onHide: () => {
				this.button.domNode.setAttribute('aria-expanded', 'false');
				this.menu.clear();
			},
		});
		if (!shown) {
			this.menu.clear();
			return;
		}
		this.button.domNode.setAttribute('aria-expanded', 'true');
		(menu.element.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? menu.element.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus();
	}
}
