import { addDisposableListener, h, stopEvent } from '../../../../../../../base/browser/dom.js';
import { status } from '../../../../../../../base/browser/ui/aria/aria.js';
import { ActionViewItem, ButtonActionViewItem } from '../../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { AnchorPosition, ContextView, ContextViewFocusRestore } from '../../../../../../../base/browser/ui/contextview/contextview.js';
import { Menu } from '../../../../../../../base/browser/ui/menu/menu.js';
import { Separator, type IAction } from '../../../../../../../base/common/actions.js';
import { MutableDisposable } from '../../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextViewService } from '../../../../../../../platform/contextview/browser/contextView.js';
import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../../../../services/chat/common/modelCatalog.js';
import { ILanguageModelsService } from '../../../../common/languageModels.js';
import { getModelConfigValueLabel, modelPickerEffortLabel, modelPickerEffortOptions } from './modelPickerModelConfig.js';
import './modelPicker.css';

let nextConfigurationId = 0;

/** Presents the selected model's effort and context settings beside the model selector. */
export class ModelPickerConfiguration extends ButtonActionViewItem {
	private readonly contextView: ContextView;
	private readonly menu = this._register(new MutableDisposable<Menu>());

	constructor(
		action: IAction,
		private readonly entry: ModelCatalogEntry,
		private readonly selectedEffort: ModelReasoningEffort | undefined,
		private readonly selectReasoningEffort: (effort: ModelReasoningEffort | undefined) => Promise<void>,
		private readonly onDidSave: () => void,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IAccessibleViewService private readonly accessibleViewService: IAccessibleViewService,
		@ILanguageModelsService private readonly languageModels: ILanguageModelsService,
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
					() => [localize('chat.modelPicker.configurationHelp', "Model options menu. Thinking level and context size are separate groups. Press Enter or Space to open it. Use Up and Down Arrow to move between options, Enter to apply one, or Escape to return to the button. Default marks the model's default option."), ...modelPickerEffortOptions(this.entry, this.selectedEffort).filter(option => option.description).map(option => `${option.label}: ${option.description}`)].join('\n'),
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
		const options = this.entry.supportedReasoningEfforts?.length ? modelPickerEffortOptions(this.entry, this.selectedEffort) : [];
		const headings = new Set<IAction>();
		const actions: IAction[] = [];
		const addHeading = (id: string, label: string): void => {
			const heading: IAction = { id, label, tooltip: '', enabled: false, run: () => { } };
			headings.add(heading);
			actions.push(heading);
		};
		if (options.length) {
			addHeading('ash.chat.input.effort.heading', localize('chat.modelPicker.thinkingEffort', 'Thinking Level'));
		}
		actions.push(...options.map(option => {
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
						this.onDidSave();
					} catch {
						status(localize('chat.modelPicker.effortFailed', 'Could not set thinking effort'));
					}
				},
			};
		}));
		if (this.entry.contextWindowOptions.length) {
			if (actions.length) {
				actions.push(new Separator());
			}
			addHeading('ash.chat.input.context.heading', localize('chat.modelPicker.contextSize', 'Context Size'));
			for (const contextWindow of this.entry.contextWindowOptions) {
				const label = getModelConfigValueLabel(contextWindow);
				actions.push({
					id: `ash.chat.input.context.${contextWindow}`,
					label,
					tooltip: localize('chat.modelPicker.contextChoice', '{0} context', label),
					enabled: true,
					checked: contextWindow === this.entry.contextWindow,
					badge: contextWindow === this.entry.defaultContextWindow ? modelPickerEffortLabel(undefined) : undefined,
					run: async () => {
						try {
							await this.languageModels.setModelPreferences(this.entry.model, { contextWindow });
							this.onDidSave();
						} catch {
							status(localize('chat.modelPicker.preferencesFailed', 'Could not update model settings'));
						}
					},
				});
			}
		}
		const menu = new Menu(this.contextView.element, {
			actions,
			contextViewContainer: this.contextViewService.container,
			layer: 20,
			getCheckedActionsRepresentation: () => 'radio',
			actionViewItemProvider: action => headings.has(action) ? new ModelConfigurationHeading(action) : undefined,
			onDidSelect: () => this.contextView.hide(),
		});
		menu.element.classList.add('ash-chat-model-configuration-menu');
		menu.element.setAttribute('aria-label', localize('chat.modelPicker.configuration', 'Model options'));
		for (const option of options) {
			const description = [option.description, option.isDefault ? modelPickerEffortLabel(undefined) : undefined].filter(Boolean).join(' ');
			if (description) menu.element.querySelector<HTMLButtonElement>(`[data-action-id='ash.chat.input.effort.${option.effort ?? 'default'}'] button`)?.setAttribute('aria-description', description);
		}
		for (const contextWindow of this.entry.contextWindowOptions) {
			const description = localize('chat.modelPicker.contextChoice', '{0} context', getModelConfigValueLabel(contextWindow));
			const defaultLabel = contextWindow === this.entry.defaultContextWindow ? modelPickerEffortLabel(undefined) : '';
			menu.element.querySelector<HTMLButtonElement>(`[data-action-id='ash.chat.input.context.${contextWindow}'] button`)?.setAttribute('aria-description', [description, defaultLabel].filter(Boolean).join(' '));
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

/** Group labels participate in menu layout but never take keyboard focus. */
class ModelConfigurationHeading extends ActionViewItem {
	public override render(container: HTMLElement): void {
		const heading = h(container.ownerDocument, 'div');
		heading.className = 'ash-chat-model-configuration-heading';
		heading.textContent = this.action.label;
		container.append(heading);
	}

	public override setTabbable(_tabbable: boolean): void { }
}
