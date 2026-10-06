import { addDisposableListener, h } from '../../../../../../../base/browser/dom.js';
import { status } from '../../../../../../../base/browser/ui/aria/aria.js';
import { ActionViewItem } from '../../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { AnchorPosition, ContextView, ContextViewFocusRestore } from '../../../../../../../base/browser/ui/contextview/contextview.js';
import { Menu } from '../../../../../../../base/browser/ui/menu/menu.js';
import { Separator, type IAction } from '../../../../../../../base/common/actions.js';
import { Disposable, MutableDisposable } from '../../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextViewService } from '../../../../../../../platform/contextview/browser/contextView.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';
import type { Button } from '../../../../../../../base/browser/ui/button/button.js';
import type { IModelPickerDelegate } from './modelPickerActionItem.js';
import { ILanguageModelsService } from '../../../../common/languageModels.js';
import { getModelConfigSummary, getModelConfigValueLabel, modelPickerEffortOptions } from './modelPickerModelConfig.js';
import './modelPicker.css';

let nextConfigurationId = 0;

/** The widget owns the trigger; this controller owns its configuration menu. */
export class ModelPickerConfiguration extends Disposable {
	private readonly contextView: ContextView;
	private readonly menu = this._register(new MutableDisposable<Menu>());

	constructor(
		private readonly delegate: IModelPickerDelegate,
		private readonly trigger: Button,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IAccessibleViewService private readonly accessibleViewService: IAccessibleViewService,
		@ILanguageModelsService private readonly languageModels: ILanguageModelsService,
	) {
		super();
		this.contextView = this._register(new ContextView(contextViewService.container));
		const button = this.trigger.domNode;
		this._register(addDisposableListener(button, 'focus', () => this.updateHelpHint()));
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
					() => localize('chat.modelPicker.configurationHelp', 'Model options menu. Thinking level and context size are separate groups. Press Enter or Space to open it. Use Up and Down Arrow to move between options, Enter to apply one, or Escape to return to the button.'),
					() => button.focus(),
					AccessibilityVerbositySettingId.ChatModelConfiguration,
				);
			},
		}));
	}

	public renderButton(): void {
		const entry = this.selectedEntry;
		const summary = entry ? getModelConfigSummary(entry, this.delegate.getSelectedReasoningEffort()) : '';
		this.trigger.hidden = this.delegate.isAutomaticModel() || summary.length === 0;
		this.trigger.label = summary;
		const label = entry?.supportedReasoningEfforts?.length ? localize('chat.modelPicker.configurationAriaLabel', 'Model options: {0}', summary) : summary;
		this.trigger.domNode.setAttribute('aria-label', label);
		this.trigger.setTitle(label);
		this.updateHelpHint();
	}

	private get selectedEntry(): ModelCatalogEntry | undefined {
		const selected = this.delegate.getSelectedModel();
		return this.delegate.getModels().find(entry => entry.model.provider === selected?.provider && entry.model.model === selected.model);
	}

	private updateHelpHint(): void {
		const entry = this.selectedEntry;
		const selected = entry ? modelPickerEffortOptions(entry, this.delegate.getSelectedReasoningEffort()).find(option => option.checked) : undefined;
		const hint = this.accessibleViewService.getOpenAriaHint(AccessibilityVerbositySettingId.ChatModelConfiguration);
		const description = [selected?.description, hint].filter(Boolean).join(' ');
		if (description) { this.trigger.domNode.setAttribute('aria-description', description); }
		else { this.trigger.domNode.removeAttribute('aria-description'); }
	}

	public show(): void {
		if (this.contextView.visible) {
			this.contextView.hide();
			return;
		}
		const entry = this.selectedEntry!;
		const options = entry.supportedReasoningEfforts?.length ? modelPickerEffortOptions(entry, this.delegate.getSelectedReasoningEffort()) : [];
		const headings = new Set<IAction>();
		const actions: IAction[] = [];
		if (options.length) {
			const heading = { id: 'ash.chat.effort.heading', label: localize('chat.modelPicker.thinkingEffort', 'Thinking Level'), tooltip: '', enabled: false, run: () => { } };
			headings.add(heading);
			actions.push(heading);
		}
		// Close after saving so reopening reads the updated selection; only close the menu that started the save.
		actions.push(...options.map(option => ({
			id: `ash.chat.input.effort.${option.effort ?? 'default'}`,
			label: option.label,
			tooltip: option.label,
			enabled: true,
			checked: option.checked,
			run: async () => {
				try {
					await this.delegate.selectReasoningEffort(option.value);
				} catch {
					status(localize('chat.modelPicker.effortFailed', 'Could not set thinking effort'));
				} finally {
					if (this.menu.value === menu) this.contextView.hide();
				}
			},
		})));
		if (entry.contextWindowOptions.length) {
			if (actions.length) { actions.push(new Separator()); }
			const heading = { id: 'ash.chat.context.heading', label: localize('chat.modelPicker.contextSize', 'Context Size'), tooltip: '', enabled: false, run: () => { } };
			headings.add(heading);
			actions.push(heading);
			for (const contextWindow of entry.contextWindowOptions) {
				actions.push({
					id: `ash.chat.input.context.${contextWindow}`,
					label: getModelConfigValueLabel(contextWindow),
					tooltip: localize('chat.modelPicker.contextChoice', '{0} context', getModelConfigValueLabel(contextWindow)),
					enabled: true,
					checked: contextWindow === entry.contextWindow,
					run: async () => {
						try {
							await this.languageModels.setModelPreferences(entry.model, { contextWindow });
						} catch {
							status(localize('chat.modelPicker.preferencesFailed', 'Could not update model settings'));
						} finally {
							if (this.menu.value === menu) this.contextView.hide();
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
		});
		menu.element.classList.add('ash-chat-model-configuration-menu');
		menu.element.setAttribute('aria-label', localize('chat.modelPicker.configuration', 'Model options'));
		for (const option of options) {
			if (option.description) menu.element.querySelector<HTMLButtonElement>(`[data-action-id='ash.chat.input.effort.${option.effort ?? 'default'}'] button`)?.setAttribute('aria-description', option.description);
		}
		for (const contextWindow of entry.contextWindowOptions) {
			const description = localize('chat.modelPicker.contextChoice', '{0} context', getModelConfigValueLabel(contextWindow));
			menu.element.querySelector<HTMLButtonElement>(`[data-action-id='ash.chat.input.context.${contextWindow}'] button`)!.setAttribute('aria-description', description);
		}
		this.menu.value = menu;
		const shown = this.contextView.show({
			anchor: this.trigger.domNode,
			content: menu.element,
			anchorPosition: AnchorPosition.Above,
			gap: 4,
			presentation: 'menu',
			focusRestore: ContextViewFocusRestore.Previous,
			layer: 20,
			isTargetWithin: target => menu.contains(target),
			onHide: () => {
				this.trigger.domNode.setAttribute('aria-expanded', 'false');
				this.menu.clear();
			},
		});
		if (!shown) {
			this.menu.clear();
			return;
		}
		this.trigger.domNode.setAttribute('aria-expanded', 'true');
		(menu.element.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? menu.element.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus();
	}
}

/** Group headings have layout but do not participate in menu navigation. */
class ModelConfigurationHeading extends ActionViewItem {
	constructor(action: IAction) {
		super(action);
	}

	public override render(container: HTMLElement): void {
		const heading = h(container.ownerDocument, 'div');
		heading.className = 'ash-chat-model-configuration-heading';
		heading.textContent = this.action.label;
		container.append(heading);
	}

	public override setTabbable(_tabbable: boolean): void { }
}
