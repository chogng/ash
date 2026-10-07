import './media/settingsWidgets.css';
import { localize } from '../../../../nls.js';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { addDisposableListener, getActiveElement, h, stopEvent } from '../../../../base/browser/dom.js';
import { isAncestorOfActiveElement } from '../../../../base/browser/focus.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { AnchorAlignment, type IContextViewProvider } from '../../../../base/browser/ui/contextview/contextview.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { SelectBox, type SelectOption } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { Switch } from '../../../../base/browser/ui/toggle/toggle.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import type { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import { parseJsonc } from '../../../../base/common/jsonc.js';
import type { JsonSchema } from '../../../../base/common/jsonSchema.js';
import type { IBooleanSetting, INumberSetting, ISelectSetting, ISetting, IStringMapSetting, ITextSetting, SettingReference, SettingValueBinding, SettingsPresentation } from '../../../services/preferences/common/preferences.js';
import { configurationSettingBinding, SettingModel, type SettingState } from '../../../services/preferences/common/settingsModels.js';
import { SettingsSearchMenu } from './settingsSearchMenu.js';
import { SettingsTreeIndicatorsLabel } from './settingsEditorSettingIndicators.js';

interface SettingsSearchWidgetOptions {
	readonly ariaControls: string;
	readonly contextMenuProvider: IContextMenuProvider;
	readonly localizationService: ILocalizationService;
}

/** Owns Settings search input, localization, and search-specific keyboard behavior. */
export class SettingsSearchWidget extends Disposable {
	public readonly domNode: HTMLDivElement;
	public readonly onDidChange: Event<string>;
	public readonly onDidRequestFocusResults: Event<void>;

	private readonly focusResultsEmitter = this._register(new Emitter<void>());
	private readonly inputBox: InputBox;
	private readonly searchMenu: SettingsSearchMenu;

	constructor(container: HTMLElement, private readonly options: SettingsSearchWidgetOptions) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-settings-search';
		this.domNode.setAttribute('role', 'search');
		const searchLabel = this.localized('chrome.search', 'Search settings');
		this.inputBox = this._register(new InputBox(this.domNode, {
			type: 'search',
			placeholder: searchLabel,
			ariaLabel: searchLabel,
			ariaControls: options.ariaControls,
		}));
		this.inputBox.element.classList.add('ash-settings-search-input');
		this.searchMenu = this._register(new SettingsSearchMenu(this.domNode, {
			getValue: () => this.inputBox.value,
			setValue: value => { this.inputBox.value = value; },
			focus: () => this.inputBox.focus(),
			contextMenuProvider: options.contextMenuProvider,
		}));
		container.append(this.domNode);
		this.onDidChange = this.inputBox.onDidChange;
		this.onDidRequestFocusResults = this.focusResultsEmitter.event;
		this._register(this.inputBox.onKeyDown(event => this.handleKeydown(event)));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public get value(): string {
		return this.inputBox.value;
	}

	public set value(value: string) {
		this.inputBox.value = value;
	}

	public focus(): void {
		this.inputBox.focus();
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape' && this.inputBox.value) {
			stopEvent(event);
			this.inputBox.value = '';
			return;
		}
		if (event.key !== 'ArrowDown') return;
		stopEvent(event);
		this.focusResultsEmitter.fire();
	}

	private updateLocalizedChrome(): void {
		const searchLabel = this.localized('chrome.search', 'Search settings');
		this.inputBox.placeholder = searchLabel;
		this.inputBox.inputElement.setAttribute('aria-label', searchLabel);
	}

	private localized(key: string, fallback: string): string {
		return this.options.localizationService.translate('ash.settings', key, fallback);
	}
}

export interface SettingWidgetOptions {
	readonly clipboardService: IClipboardService;
	readonly configurationService: IConfigurationService;
	readonly contextMenuProvider: IContextMenuProvider;
	readonly contextViewProvider: IContextViewProvider;
	readonly onStatus: (message: string, isError: boolean) => void;
	readonly onOpenSettings?: (key: string) => Promise<void>;
}

export interface SettingWidget extends IDisposable {
	readonly domNode: HTMLElement;

	update(setting: ISetting): void;
}

interface SettingActionsOptions {
	readonly reference: SettingReference;
	readonly contextMenuProvider: IContextMenuProvider;
	readonly clipboardService: IClipboardService;
	readonly onError: (error: unknown) => void;
	readonly openSettings?: () => Promise<void>;
}

class SettingActions extends Disposable {
	private readonly actionsDomNode: HTMLSpanElement;
	private readonly trigger: Button;

	constructor(container: HTMLElement, label: string, private readonly options: SettingActionsOptions) {
		super();
		this.actionsDomNode = h(container.ownerDocument, 'span');
		this.actionsDomNode.className = 'ash-setting-item-actions';
		this.trigger = this._register(new Button(this.actionsDomNode, {
			label: '',
			icon: Lxicon.gear,
			onClick: () => this.show(),
		}));
		this.trigger.toggleClassName('ash-setting-item-actions-trigger', true);
		this.trigger.domNode.setAttribute('aria-haspopup', 'menu');
		this.trigger.domNode.setAttribute('aria-expanded', 'false');
		this.updateLabel(label);
		container.dataset.settingsItemId = options.reference.id;
		container.dataset.settingsItemKind = 'setting';
		container.classList.add('ash-setting-item');
		container.prepend(this.actionsDomNode);
		this._register(toDisposable(() => {
			container.classList.remove('ash-setting-item');
			this.actionsDomNode.remove();
		}));
	}

	public updateLabel(label: string): void {
		const actionLabel = `More actions for ${label}`;
		this.trigger.label = actionLabel;
		this.trigger.setTitle(actionLabel);
		this.trigger.domNode.setAttribute('aria-label', actionLabel);
	}

	private show(): void {
		if (this.actionsDomNode.classList.contains('is-open')) return;
		const actions: IAction[] = [
			{
				id: 'settings.resetSetting',
				label: 'Reset Setting',
				tooltip: '',
				enabled: !this.options.reference.isDefault(),
				run: () => this.run(() => this.options.reference.reset()),
			},
			{
				id: 'settings.copySettingId',
				label: 'Copy Setting ID',
				tooltip: '',
				enabled: true,
				run: () => this.run(() => this.options.clipboardService.writeText(this.options.reference.id)),
			},
		];
		if (this.options.openSettings) {
			actions.push({
				id: 'settings.editInSettingsJson',
				label: localize({ bundle: 'ash.settings', key: 'json.edit' }, 'Edit in settings.json'),
				tooltip: '',
				enabled: true,
				run: () => this.run(this.options.openSettings!),
			});
		}
		this.setOpen(true);
		try {
			this.options.contextMenuProvider.showContextMenu({
				getAnchor: () => this.trigger.domNode,
				getActions: () => actions,
				onHide: () => this.setOpen(false),
			});
		} catch (error) {
			this.setOpen(false);
			this.options.onError(error);
		}
	}

	private run(operation: () => Promise<void>): void {
		void operation().catch(error => this.options.onError(error));
	}

	private setOpen(open: boolean): void {
		this.actionsDomNode.classList.toggle('is-open', open);
		this.trigger.domNode.setAttribute('aria-expanded', String(open));
	}
}

abstract class AbstractSettingWidget<TSetting extends ISetting, TValue> extends Disposable implements SettingWidget {
	public readonly domNode: HTMLDivElement;
	protected readonly copyDomNode: HTMLSpanElement;
	protected readonly model: SettingModel<TValue>;
	protected readonly presentation: SettingsPresentation;
	protected descriptor: TSetting;

	private readonly actions: SettingActions;
	private readonly descriptionDomNode: HTMLSpanElement;
	private readonly indicators: SettingsTreeIndicatorsLabel;
	private readonly titleDomNode: HTMLSpanElement;

	protected constructor(container: HTMLElement, descriptor: TSetting, binding: SettingValueBinding<TValue>, private readonly options: SettingWidgetOptions, kind?: 'select' | 'toggle') {
		super();
		const document = container.ownerDocument;
		this.descriptor = descriptor;
		this.presentation = settingPresentation(descriptor);
		this.domNode = h(document, 'div');
		this.domNode.className = `ash-configuration-setting ash-${this.presentation}-setting`;
		if (kind === 'select' && this.presentation === 'editor') this.domNode.classList.add('ash-editor-setting-select-row');
		if (kind === 'toggle') this.domNode.classList.add(`ash-${this.presentation}-toggle-setting`);
		this._register(toDisposable(() => this.domNode.remove()));

		this.copyDomNode = h(document, 'span');
		this.copyDomNode.className = `ash-configuration-setting-copy ash-${this.presentation}-setting-copy`;
		this.titleDomNode = h(document, 'span');
		this.titleDomNode.className = `ash-configuration-setting-title ash-${this.presentation}-setting-title`;
		this.descriptionDomNode = h(document, 'span');
		this.descriptionDomNode.className = `ash-configuration-setting-description ash-${this.presentation}-setting-description`;
		this.indicators = this._register(new SettingsTreeIndicatorsLabel(this.copyDomNode));
		this.copyDomNode.prepend(this.titleDomNode, this.descriptionDomNode);
		this.updateCopy(descriptor);

		this.model = this._register(new SettingModel(binding));
		this.actions = this._register(new SettingActions(this.domNode, descriptor.title, {
			reference: {
				id: this.model.id,
				isDefault: () => this.model.isDefault(),
				reset: () => this.resetSetting(),
			},
			contextMenuProvider: options.contextMenuProvider,
			clipboardService: options.clipboardService,
			onError: error => options.onStatus(settingErrorMessage(error, 'Unable to run the setting action.'), true),
			openSettings: !descriptor.binding && options.onOpenSettings ? () => options.onOpenSettings!(descriptor.configuration.key) : undefined,
		}));
	}

	public update(setting: ISetting): void {
		if (setting.id !== this.descriptor.id || setting.valueType !== this.descriptor.valueType) {
			throw new TypeError(`Setting Widget '${this.descriptor.id}' cannot update from '${setting.id}'`);
		}
		if (settingPresentation(setting) !== this.presentation) {
			throw new TypeError(`Setting Widget '${setting.id}' cannot change presentation`);
		}
		this.descriptor = setting as TSetting;
		this.updateCopy(this.descriptor);
		this.actions.updateLabel(this.descriptor.title);
		this.updateControl(this.descriptor);
	}

	protected bindState(renderState: (state: SettingState<TValue>) => void): void {
		const render = (state: SettingState<TValue>): void => {
			this.indicators.update({ isPending: state.isPending });
			renderState(state);
		};
		this._register(this.model.onDidChange(render));
		render(this.model.state);
	}

	protected reportStatus(message: string, isError: boolean): void {
		this.options.onStatus(message, isError);
	}

	protected async updateSetting(value: TValue): Promise<void> {
		this.reportStatus('', false);
		try {
			await this.model.update(value);
		} catch (error) {
			this.reportStatus(settingErrorMessage(error, 'Unable to save the setting.'), true);
		}
	}

	protected abstract updateControl(descriptor: TSetting): void;

	private async resetSetting(): Promise<void> {
		this.reportStatus('', false);
		try {
			await this.model.reset();
		} catch (error) {
			this.reportStatus(settingErrorMessage(error, 'Unable to reset the setting.'), true);
			throw error;
		}
	}

	private updateCopy(descriptor: TSetting): void {
		this.titleDomNode.textContent = descriptor.title;
		this.descriptionDomNode.textContent = descriptor.description;
	}
}

class BooleanSettingWidget extends AbstractSettingWidget<IBooleanSetting, boolean> {
	private readonly toggle: Switch;

	constructor(container: HTMLElement, descriptor: IBooleanSetting, options: SettingWidgetOptions) {
		super(container, descriptor, descriptor.binding ?? configurationSettingBinding(options.configurationService, descriptor.configuration), options, 'toggle');
		this.toggle = this._register(new Switch(this.domNode, { ariaLabel: descriptor.title, content: this.copyDomNode, contentPlacement: 'before-control' }));
		this.toggle.element.classList.add(`ash-${this.presentation}-toggle-control`);
		this.toggle.input.dataset.configurationKey = descriptor.configuration.key;
		this.bindState(state => {
			this.toggle.checked = state.value;
			this.toggle.busy = state.isPending;
		});
		this._register(this.toggle.onDidChange(checked => void this.updateSetting(checked)));
	}

	protected updateControl(descriptor: IBooleanSetting): void {
		this.toggle.setAriaLabel(descriptor.title);
	}
}

class NumberSettingWidget extends AbstractSettingWidget<INumberSetting, number> {
	private readonly input: HTMLInputElement;
	private readonly inputBox: InputBox | undefined;

	constructor(container: HTMLElement, descriptor: INumberSetting, options: SettingWidgetOptions) {
		super(container, descriptor, descriptor.binding ?? configurationSettingBinding(options.configurationService, descriptor.configuration), options);
		this.domNode.append(this.copyDomNode);
		if (this.presentation === 'editor') {
			this.inputBox = this._register(new InputBox(this.domNode, {
				type: 'number',
				ariaLabel: descriptor.title,
				presentation: 'compact',
			}));
			this.inputBox.element.classList.add('ash-editor-setting-number');
			this.input = this.inputBox.inputElement;
			this.inputBox.step = '1';
		} else {
			this.inputBox = undefined;
			this.input = h(this.domNode.ownerDocument, 'input');
			this.input.className = 'ash-general-setting-control';
			this.input.type = 'number';
			this.input.step = 'any';
			this.domNode.append(this.input);
		}
		this.input.dataset.configurationKey = descriptor.configuration.key;
		this.updateControl(descriptor);
		this.bindState(state => {
			this.input.value = String(state.value);
			if (this.inputBox) this.inputBox.enabled = !state.isPending;
			else this.input.disabled = state.isPending;
		});
		this._register(addDisposableListener(this.input, 'change', () => this.acceptValue()));
	}

	protected updateControl(descriptor: INumberSetting): void {
		this.input.min = String(descriptor.minimum);
		this.input.max = String(descriptor.maximum);
		this.input.setAttribute('aria-label', descriptor.title);
	}

	private acceptValue(): void {
		const value = this.input.valueAsNumber;
		if (!Number.isFinite(value) || value < this.descriptor.minimum || value > this.descriptor.maximum) {
			this.model.refresh();
			this.input.value = String(this.model.state.value);
			this.reportStatus(`${this.descriptor.title} must be between ${this.descriptor.minimum} and ${this.descriptor.maximum}.`, true);
			return;
		}
		void this.updateSetting(value);
	}
}

class SelectSettingWidget extends AbstractSettingWidget<ISelectSetting, string | boolean> {
	private readonly select: SelectBox;

	constructor(container: HTMLElement, descriptor: ISelectSetting, options: SettingWidgetOptions) {
		super(container, descriptor, descriptor.binding ?? configurationSettingBinding(options.configurationService, descriptor.configuration), options, 'select');
		this.select = this._register(new SelectBox(this.domNode, {
			options: descriptor.options.map(option => ({ value: String(option.value), label: option.label })),
			ariaLabel: descriptor.title,
			presentation: 'field',
			contextViewProvider: options.contextViewProvider,
		}));
		this.select.element.classList.add(this.presentation === 'general' ? 'ash-general-setting-control' : 'ash-editor-setting-select');
		this.select.element.dataset.configurationKey = descriptor.id;
		this.domNode.append(this.copyDomNode, this.select.element);
		this.bindState(state => this.renderState(state));
		this._register(this.select.onDidSelect(({ value }) => void this.handleSelection(value)));
	}

	protected updateControl(descriptor: ISelectSetting): void {
		this.select.setAriaLabel(descriptor.title);
		const options = descriptor.options.map(option => ({ value: String(option.value), label: option.label }));
		if (sameSelectOptions(this.select.options, options)) return;
		this.select.setOptions(options);
		this.model.refresh();
		this.renderState(this.model.state);
	}

	private async handleSelection(value: string): Promise<void> {
		const option = this.descriptor.options.find(candidate => String(candidate.value) === value);
		if (!option) return;
		const hadFocus = isAncestorOfActiveElement(this.select.element);
		await this.updateSetting(option.value);
		// Saving disables the trigger. Restore its focus only if the user has not moved to another control.
		const document = this.domNode.ownerDocument;
		if (hadFocus && this.domNode.isConnected && getActiveElement(document) === document.body) this.select.focus();
	}

	private renderState(state: SettingState<string | boolean>): void {
		this.select.value = String(state.value);
		this.select.enabled = !state.isPending;
	}
}

class TextSettingWidget extends AbstractSettingWidget<ITextSetting, string> {
	private readonly input: HTMLInputElement;

	constructor(container: HTMLElement, descriptor: ITextSetting, options: SettingWidgetOptions) {
		super(container, descriptor, descriptor.binding ?? configurationSettingBinding(options.configurationService, descriptor.configuration), options);
		this.input = h(this.domNode.ownerDocument, 'input');
		this.input.className = `ash-${this.presentation}-setting-text`;
		this.input.type = 'text';
		this.input.dataset.configurationKey = descriptor.configuration.key;
		this.domNode.append(this.copyDomNode, this.input);
		this.updateControl(descriptor);
		this.bindState(state => {
			this.input.value = state.value;
			this.input.disabled = state.isPending;
		});
		this._register(addDisposableListener(this.input, 'change', () => void this.updateSetting(this.input.value)));
	}

	protected updateControl(descriptor: ITextSetting): void {
		this.input.placeholder = descriptor.placeholder;
		this.input.setAttribute('aria-label', descriptor.title);
	}
}

let objectKeySuggestionsId = 0;

/** Suggestions stay in the input's focus path; ContextView owns popup placement and dismissal. */
class StringMapSuggestions extends Disposable {
	private readonly list: HTMLDivElement;
	private candidates: readonly [string, JsonSchema][] = [];
	private activeIndex = -1;
	private visible = false;

	constructor(
		private readonly input: HTMLInputElement,
		private readonly contextView: IContextViewProvider,
		private readonly getProperties: () => Readonly<Record<string, JsonSchema>>,
		private readonly accept: (key: string) => void,
	) {
		super();
		this.list = h(input.ownerDocument, 'div');
		this.list.id = `ash-settings-key-suggestions-${objectKeySuggestionsId++}`;
		this.list.className = 'ash-settings-key-suggestions';
		this.list.setAttribute('role', 'listbox');
		input.setAttribute('role', 'combobox');
		input.setAttribute('aria-autocomplete', 'list');
		input.setAttribute('aria-haspopup', 'listbox');
		input.setAttribute('aria-controls', this.list.id);
		input.setAttribute('aria-expanded', 'false');
		input.autocomplete = 'off';
		input.spellcheck = false;
		this._register(addDisposableListener(input, 'focus', () => this.show()));
		this._register(addDisposableListener(input, 'input', () => this.show()));
		this._register(addDisposableListener(input, 'blur', () => this.hide()));
		this._register(addDisposableListener(input, 'keydown', event => {
			if (event.isComposing) { return; }
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				if (!this.visible) { this.show(); }
				if (!this.visible) { return; }
				stopEvent(event);
				let next = this.activeIndex + (event.key === 'ArrowDown' ? 1 : -1);
				if (this.activeIndex < 0) {
					next = event.key === 'ArrowDown' ? 0 : this.candidates.length - 1;
				}
				this.setActiveIndex((next + this.candidates.length) % this.candidates.length);
			} else if (event.key === 'Enter' && this.visible && this.activeIndex >= 0) {
				stopEvent(event);
				this.commit(this.activeIndex);
			} else if (event.key === 'Escape' && this.visible) {
				stopEvent(event);
				this.hide();
			}
		}));
		this._register(addDisposableListener(this.list, 'pointerdown', event => event.preventDefault()));
		this._register(addDisposableListener(this.list, 'click', event => {
			const option = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]');
			if (option) { this.commit(Number(option.dataset.index)); }
		}));
		this._register(addDisposableListener(this.list, 'pointermove', event => {
			const option = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]');
			if (option) { this.setActiveIndex(Number(option.dataset.index)); }
		}));
		this._register(toDisposable(() => {
			this.hide();
			this.list.remove();
		}));
	}

	private show(): void {
		const inputWidth = this.input.getBoundingClientRect().width;
		const query = this.input.value.trim().toLocaleLowerCase();
		this.candidates = Object.entries(this.getProperties())
			.filter(([key, schema]) => !schema.doNotSuggest && [key, schema.description ?? ''].some(text => text.toLocaleLowerCase().includes(query)))
			.sort(([left], [right]) => left.localeCompare(right));
		if (!this.candidates.length) {
			this.hide();
			return;
		}
		this.list.replaceChildren(...this.candidates.map(([key, schema], index) => {
			const option = h(this.input.ownerDocument, 'div');
			option.id = `${this.list.id}-${index}`;
			option.className = 'ash-settings-key-option';
			option.dataset.index = String(index);
			option.setAttribute('role', 'option');
			option.setAttribute('aria-selected', 'false');
			const name = h(this.input.ownerDocument, 'span');
			name.className = 'ash-settings-key-name';
			name.textContent = key;
			const description = h(this.input.ownerDocument, 'span');
			description.className = 'ash-settings-key-description';
			description.textContent = schema.description ?? '';
			option.append(name, description);
			return option;
		}));
		this.activeIndex = -1;
		this.input.removeAttribute('aria-activedescendant');
		this.list.setAttribute('aria-label', this.input.getAttribute('aria-label')!);
		this.list.style.minWidth = `${inputWidth}px`;
		if (this.visible) {
			this.contextView.layout();
			return;
		}
		this.visible = this.contextView.show({
			anchor: this.input,
			anchorAlignment: AnchorAlignment.Left,
			content: this.list,
			onHide: () => {
				this.visible = false;
				this.input.setAttribute('aria-expanded', 'false');
				this.input.removeAttribute('aria-activedescendant');
			},
		});
		this.input.setAttribute('aria-expanded', String(this.visible));
	}

	private setActiveIndex(index: number): void {
		this.activeIndex = index;
		for (const [candidate, option] of [...this.list.children].entries()) {
			option.classList.toggle('focused', candidate === index);
			option.setAttribute('aria-selected', String(candidate === index));
		}
		const active = this.list.children[index];
		this.input.setAttribute('aria-activedescendant', active.id);
		active.scrollIntoView({ block: 'nearest' });
	}

	private commit(index: number): void {
		const [key] = this.candidates[index];
		this.hide();
		this.accept(key);
	}

	private hide(): void {
		if (this.visible) { this.contextView.hide(); }
	}
}

class StringMapSettingWidget extends AbstractSettingWidget<IStringMapSetting, Record<string, unknown>> {
	private readonly rows: HTMLDivElement;
	private readonly addButton: Button;
	private readonly rowDisposables = this._register(new DisposableStore());
	private renderedValue: Record<string, unknown> | undefined;
	private readonly contextViewProvider: IContextViewProvider;

	constructor(container: HTMLElement, descriptor: IStringMapSetting, options: SettingWidgetOptions) {
		super(container, descriptor, descriptor.binding ?? configurationSettingBinding(options.configurationService, descriptor.configuration), options);
		this.contextViewProvider = options.contextViewProvider;
		this.domNode.classList.add('ash-string-map-setting');
		this.domNode.dataset.configurationKey = descriptor.configuration.key;
		this.rows = h(this.domNode.ownerDocument, 'div');
		this.rows.className = 'ash-string-map-rows';
		const actions = h(this.domNode.ownerDocument, 'div');
		actions.className = 'ash-string-map-actions';
		this.addButton = this._register(new Button(actions, {
			label: descriptor.addLabel,
			ariaLabel: descriptor.addLabel,
			onClick: () => {
				const keyInput = this.addRow('', '');
				keyInput.focus();
			},
		}));
		if (!descriptor.binding && options.onOpenSettings) {
			const editButton = this._register(new Button(actions, {
				label: localize({ bundle: 'ash.settings', key: 'json.edit' }, 'Edit in settings.json'),
				onClick: () => {
					void options.onOpenSettings!(this.descriptor.configuration.key).catch(error => options.onStatus(settingErrorMessage(error, 'Unable to open settings.json.'), true));
				},
			}));
		}
		this.domNode.append(this.copyDomNode, this.rows, actions);
		this.bindState(state => {
			if (!sameStringMap(this.renderedValue, state.value)) {
				this.renderRows(state.value);
			}
			this.addButton.enabled = !state.isPending;
			for (const input of this.rows.querySelectorAll('input')) {
				input.disabled = state.isPending;
			}
			for (const button of this.rows.querySelectorAll('button')) {
				button.disabled = state.isPending;
			}
		});
	}

	protected updateControl(descriptor: IStringMapSetting): void {
		this.addButton.label = descriptor.addLabel;
		this.addButton.domNode.setAttribute('aria-label', descriptor.addLabel);
		this.updateRowLabels();
	}

	private renderRows(value: Record<string, unknown>): void {
		this.rowDisposables.clear();
		this.rows.replaceChildren();
		for (const [key, childPatterns] of Object.entries(value)) {
			this.addRow(key, typeof childPatterns === 'string' ? childPatterns : JSON.stringify(childPatterns));
		}
		this.renderedValue = value;
	}

	private addRow(key: string, childPatterns: string): HTMLInputElement {
		const row = h(this.domNode.ownerDocument, 'div');
		row.className = 'ash-string-map-row';
		const keyInput = h(this.domNode.ownerDocument, 'input');
		keyInput.type = 'text';
		keyInput.value = key;
		keyInput.dataset.patternPart = 'key';
		const valueInput = h(this.domNode.ownerDocument, 'input');
		valueInput.type = 'text';
		valueInput.value = childPatterns;
		valueInput.dataset.patternPart = 'value';
		row.append(keyInput, valueInput);
		const rowDisposables = this.rowDisposables.add(new DisposableStore());
		if (this.descriptor.configuration.schema?.properties) {
			rowDisposables.add(new StringMapSuggestions(keyInput, this.contextViewProvider, () => {
				const used = [...this.rows.querySelectorAll<HTMLInputElement>('[data-pattern-part="key"]')]
					.filter(input => input !== keyInput).map(input => input.value.trim());
				return Object.fromEntries(Object.entries(this.descriptor.configuration.schema!.properties!).filter(([key]) => !used.includes(key)));
			}, key => {
				keyInput.value = key;
				valueInput.focus();
				if (valueInput.value.trim()) { this.acceptRows(); }
			}));
		}
		const valueSuggestions = (): Readonly<Record<string, JsonSchema>> => {
			const schema = this.descriptor.configuration.schema?.additionalProperties;
			if (typeof schema !== 'object') { return {}; }
			return Object.fromEntries([schema, ...schema.anyOf ?? [], ...schema.oneOf ?? []].flatMap(alternative =>
				(alternative.enum ?? []).flatMap((value, index) => typeof value === 'string' ? [[value, { description: alternative.enumDescriptions?.[index] ?? '' }]] : [])));
		};
		if (Object.keys(valueSuggestions()).length) {
			rowDisposables.add(new StringMapSuggestions(valueInput, this.contextViewProvider, valueSuggestions, value => {
				valueInput.value = value;
				this.acceptRows();
			}));
		}
		rowDisposables.add(addDisposableListener(keyInput, 'change', () => this.acceptRows()));
		rowDisposables.add(addDisposableListener(valueInput, 'change', () => this.acceptRows()));
		rowDisposables.add(new Button(row, {
			label: this.descriptor.removeLabel,
			ariaLabel: this.descriptor.removeLabel,
			size: 'small',
			onClick: () => {
				row.remove();
				rowDisposables.dispose();
				this.updateRowLabels();
				this.acceptRows();
			},
		}));
		this.rows.append(row);
		this.updateRowLabels();
		return keyInput;
	}

	private updateRowLabels(): void {
		for (const [index, row] of [...this.rows.children].entries()) {
			row.querySelector<HTMLInputElement>('[data-pattern-part="key"]')?.setAttribute('aria-label', `${this.descriptor.keyLabel} ${index + 1}`);
			row.querySelector<HTMLInputElement>('[data-pattern-part="value"]')?.setAttribute('aria-label', `${this.descriptor.valueLabel} ${index + 1}`);
			row.querySelector<HTMLButtonElement>('button')?.setAttribute('aria-label', `${this.descriptor.removeLabel} ${index + 1}`);
		}
	}

	private acceptRows(): void {
		if (this.model.state.isPending) return;
		const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		for (const row of this.rows.children) {
			const keyInput = row.querySelector<HTMLInputElement>('[data-pattern-part="key"]');
			const valueInput = row.querySelector<HTMLInputElement>('[data-pattern-part="value"]');
			if (!keyInput || !valueInput) continue;
			const key = keyInput.value.trim();
			const childPatterns = valueInput.value.trim();
			keyInput.setAttribute('aria-invalid', String(!key));
			valueInput.setAttribute('aria-invalid', String(!childPatterns));
			if (!key || !childPatterns) {
				this.reportStatus(this.descriptor.incompleteMessage, true);
				return;
			}
			if (Object.hasOwn(value, key)) {
				keyInput.setAttribute('aria-invalid', 'true');
				this.reportStatus(this.descriptor.duplicateMessage, true);
				return;
			}
			try {
				value[key] = this.descriptor.structuredValues && /^(?:\{|\[|true$|false$)/u.test(childPatterns) ? parseJsonc(childPatterns, key) : childPatterns;
			} catch (error) {
				valueInput.setAttribute('aria-invalid', 'true');
				this.reportStatus(settingErrorMessage(error, 'Invalid setting value.'), true);
				return;
			}
		}
		try {
			this.descriptor.configuration.parse(value);
		} catch (error) {
			this.reportStatus(settingErrorMessage(error, 'Invalid setting value.'), true);
			return;
		}
		if (sameStringMap(value, this.model.state.value)) {
			this.reportStatus('', false);
			return;
		}
		this.renderedValue = value;
		void this.updateSetting(value);
	}
}

export function createSettingWidget(container: HTMLElement, setting: ISetting, options: SettingWidgetOptions): SettingWidget {
	switch (setting.valueType) {
		case 'boolean':
			return new BooleanSettingWidget(container, setting, options);
		case 'number':
			return new NumberSettingWidget(container, setting, options);
		case 'select':
			return new SelectSettingWidget(container, setting, options);
		case 'text':
			return new TextSettingWidget(container, setting, options);
		case 'stringMap':
			return new StringMapSettingWidget(container, setting, options);
	}
}

function sameStringMap(left: Record<string, unknown> | undefined, right: Record<string, unknown>): boolean {
	if (!left) return false;
	const leftEntries = Object.entries(left);
	const rightEntries = Object.entries(right);
	return leftEntries.length === rightEntries.length && leftEntries.every(([key, value], index) => key === rightEntries[index]?.[0] && JSON.stringify(value) === JSON.stringify(rightEntries[index]?.[1]));
}

function sameSelectOptions(left: readonly SelectOption[], right: readonly SelectOption[]): boolean {
	return left.length === right.length && left.every((option, index) => {
		const candidate = right[index];
		return candidate !== undefined && option.value === candidate.value && option.label === candidate.label;
	});
}

function settingPresentation(setting: ISetting): SettingsPresentation {
	return setting.presentation ?? 'editor';
}

function settingErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}
