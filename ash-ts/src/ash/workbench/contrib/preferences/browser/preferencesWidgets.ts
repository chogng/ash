import './media/preferencesWidgets.css';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { addDisposableListener, h, stopEvent } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import type { IContextViewProvider } from '../../../../base/browser/ui/contextview/contextview.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { SelectBox, type SelectOption } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { Checkbox, Switch, type Toggle } from '../../../../base/browser/ui/toggle/toggle.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { lxiconsLibrary } from '../../../../base/common/lxiconsLibrary.js';
import type { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import type { IBooleanSetting, INumberSetting, ISelectSetting, ISetting, ITextSetting, SettingReference, SettingValueBinding, SettingsPresentation } from '../../../services/preferences/common/preferences.js';
import { configurationSettingBinding, SettingModel, type SettingState } from '../../../services/preferences/common/preferencesModels.js';
import { SettingsSearchMenu } from './settingsSearchMenu.js';
import { SettingsTreeIndicatorsLabel } from './settingsEditorSettingIndicators.js';

interface PreferencesSearchWidgetOptions {
	readonly ariaControls: string;
	readonly contextMenuProvider: IContextMenuProvider;
	readonly localizationService: ILocalizationService;
}

/** Owns Preferences search input, localization, and search-specific keyboard behavior. */
export class PreferencesSearchWidget extends Disposable {
	public readonly domNode: HTMLDivElement;
	public readonly onDidChange: Event<string>;
	public readonly onDidRequestFocusResults: Event<void>;

	private readonly focusResultsEmitter = this._register(new Emitter<void>());
	private readonly inputBox: InputBox;
	private readonly searchMenu: SettingsSearchMenu;

	constructor(container: HTMLElement, private readonly options: PreferencesSearchWidgetOptions) {
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
		this._register(options.localizationService.onDidChange(() => this.updateLocalizedChrome()));
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
			icon: lxiconsLibrary.gear,
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
		const actions: readonly IAction[] = [
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
			this.indicators.update({ isModified: !state.isDefault, isPending: state.isPending });
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
	private readonly toggle: Toggle;

	constructor(container: HTMLElement, descriptor: IBooleanSetting, options: SettingWidgetOptions) {
		super(container, descriptor, configurationSettingBinding(options.configurationService, descriptor.configuration), options, 'toggle');
		this.toggle = this._register(this.presentation === 'general'
			? new Checkbox(this.domNode, { ariaLabel: descriptor.title, content: this.copyDomNode, contentPlacement: 'before-control' })
			: new Switch(this.domNode, { ariaLabel: descriptor.title, content: this.copyDomNode, contentPlacement: 'before-control' }));
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
		super(container, descriptor, configurationSettingBinding(options.configurationService, descriptor.configuration), options);
		this.domNode.append(this.copyDomNode);
		if (this.presentation === 'editor') {
			this.inputBox = this._register(new InputBox(this.domNode, {
				type: 'number',
				ariaLabel: descriptor.title,
				presentation: 'field',
			}));
			this.inputBox.element.classList.add('ash-editor-setting-number');
			this.input = this.inputBox.inputElement;
			this.inputBox.step = '1';
		} else {
			this.inputBox = undefined;
			this.input = h(this.domNode.ownerDocument, 'input');
			this.input.className = 'ash-general-setting-control';
			this.input.type = 'number';
			this.input.step = '1';
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
		if (!Number.isSafeInteger(value) || value < this.descriptor.minimum || value > this.descriptor.maximum) {
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
		super(container, descriptor, configurationSettingBinding(options.configurationService, descriptor.configuration), options, 'select');
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
		this._register(this.select.onDidSelect(({ value }) => {
			const option = this.descriptor.options.find(candidate => String(candidate.value) === value);
			if (option) void this.updateSetting(option.value);
		}));
	}

	protected updateControl(descriptor: ISelectSetting): void {
		this.select.setAriaLabel(descriptor.title);
		const options = descriptor.options.map(option => ({ value: String(option.value), label: option.label }));
		if (sameSelectOptions(this.select.options, options)) return;
		this.select.setOptions(options);
		this.renderState(this.model.state);
	}

	private renderState(state: SettingState<string | boolean>): void {
		this.select.value = String(state.value);
		this.select.enabled = !state.isPending;
	}
}

class TextSettingWidget extends AbstractSettingWidget<ITextSetting, string> {
	private readonly input: HTMLInputElement;

	constructor(container: HTMLElement, descriptor: ITextSetting, options: SettingWidgetOptions) {
		super(container, descriptor, configurationSettingBinding(options.configurationService, descriptor.configuration), options);
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
		this._register(addDisposableListener(this.input, 'change', () => void this.updateSetting(this.input.value.trim())));
	}

	protected updateControl(descriptor: ITextSetting): void {
		this.input.placeholder = descriptor.placeholder;
		this.input.setAttribute('aria-label', descriptor.title);
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
	}
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
