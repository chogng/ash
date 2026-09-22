import * as browser from '../../../base/browser/browser.js';
import { getWindow } from '../../../base/browser/dom.js';
import { PixelRatio } from '../../../base/browser/pixelRatio.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { AccessibilitySupport, IAccessibilityService } from '../../../platform/accessibility/common/accessibility.js';
import { type IEditorConfiguration } from '../../common/config/editorConfiguration.js';
import { EditorZoom } from '../../common/config/editorZoom.js';
import {
	ComputeOptionsMemory,
	ConfigurationChangedEvent,
	EditorOption,
	editorOptionsRegistry,
	type FindComputedEditorOptionValueById,
	type IComputedEditorOptions,
	type IEditorOptions,
	type IEnvironmentalOptions,
} from '../../common/config/editorOptions.js';
import { type BareFontInfo, type FontInfo, type IValidatedEditorOptions } from '../../common/config/fontInfo.js';
import { createBareFontInfoFromValidatedSettings } from '../../common/config/fontInfoFromSettings.js';
import { type IDimension } from '../../common/core/2d/dimension.js';
import { InputMode } from '../../common/inputMode.js';
import { type MenuId } from '../../../platform/actions/common/actions.js';
import { ElementSizeObserver } from './elementSizeObserver.js';
import { FontMeasurements } from './fontMeasurements.js';
import { migrateOptions } from './migrateOptions.js';
import { TabFocus } from './tabFocus.js';

/** Options supplied while constructing a browser code editor. */
export interface IEditorConstructionOptions extends IEditorOptions {
	readonly dimension?: IDimension;
	readonly overflowWidgetsDomNode?: HTMLElement;
}

/** Browser values used to compute editor options. */
export interface IEnvConfiguration {
	readonly extraEditorClassName: string;
	readonly outerWidth: number;
	readonly outerHeight: number;
	readonly emptySelectionClipboard: boolean;
	readonly pixelRatio: number;
	readonly accessibilitySupport: AccessibilitySupport;
	readonly editContextSupported: boolean;
}

/** Dense option storage shared by configuration consumers. */
export class ComputedEditorOptions implements IComputedEditorOptions {
	private readonly values: unknown[] = [];

	_read<T>(id: EditorOption): T {
		if (id >= this.values.length) throw new RangeError(`Editor option ${id} has not been computed`);
		return this.values[id] as T;
	}

	get<T extends EditorOption>(id: T): FindComputedEditorOptionValueById<T> {
		return this._read(id);
	}

	_write<T>(id: EditorOption, value: T): void {
		this.values[id] = value;
	}
}

class ValidatedEditorOptions implements IValidatedEditorOptions {
	private readonly values: unknown[] = [];

	_read<T>(id: EditorOption): T {
		return this.values[id] as T;
	}

	get<T extends EditorOption>(id: T): FindComputedEditorOptionValueById<T> {
		return this._read(id);
	}

	_write<T>(id: EditorOption, value: T): void {
		this.values[id] = value;
	}
}

/** Owns browser-derived editor options and publishes complete configuration changes. */
export class EditorConfiguration extends Disposable implements IEditorConfiguration {
	private readonly changeEmitter = this._register(new Emitter<ConfigurationChangedEvent>());
	private readonly fastChangeEmitter = this._register(new Emitter<ConfigurationChangedEvent>());
	private readonly containerObserver: ElementSizeObserver;
	private readonly targetWindow: Window;
	private readonly computeMemory = new ComputeOptionsMemory();
	private readonly rawOptions: IEditorOptions;
	private validatedOptions: ValidatedEditorOptions;
	private reservedHeight = 0;
	private isDominatedByLongLines = false;
	private lineNumbersDigitCount = 1;
	private viewLineCount = 1;
	private glyphMarginDecorationLaneCount = 1;

	readonly isSimpleWidget: boolean;
	readonly contextMenuId: MenuId;
	readonly onDidChange = this.changeEmitter.event;
	readonly onDidChangeFast = this.fastChangeEmitter.event;
	options: ComputedEditorOptions;

	constructor(
		isSimpleWidget: boolean,
		contextMenuId: MenuId,
		options: Readonly<IEditorConstructionOptions>,
		container: HTMLElement,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
	) {
		super();
		this.isSimpleWidget = isSimpleWidget;
		this.contextMenuId = contextMenuId;
		this.targetWindow = getWindow(container);
		const { dimension, overflowWidgetsDomNode: _overflowWidgetsDomNode, ...editorOptions } = options;
		this.rawOptions = cloneAndMigrate(editorOptions);
		this.validatedOptions = validateOptions(this.rawOptions);
		this.containerObserver = this._register(new ElementSizeObserver(container, dimension));
		this.options = this.computeOptions();
		if (this.options.get(EditorOption.automaticLayout)) this.containerObserver.startObserving();

		this._register(EditorZoom.onDidChangeZoomLevel(() => this.recomputeOptions()));
		this._register(TabFocus.onDidChangeTabFocus(() => this.recomputeOptions()));
		this._register(InputMode.onDidChangeInputMode(() => this.recomputeOptions()));
		this._register(this.accessibilityService.onDidChangeScreenReaderOptimized(() => this.recomputeOptions()));
		this._register(FontMeasurements.onDidChange(() => this.recomputeOptions()));
		this._register(PixelRatio.getInstance(this.targetWindow).onDidChange(() => this.recomputeOptions()));
		this._register(this.containerObserver.onDidChange(() => this.recomputeOptions()));
	}

	getRawOptions(): IEditorOptions {
		return this.rawOptions;
	}

	updateOptions(newOptions: Readonly<IEditorOptions>): void {
		const update = cloneAndMigrate(newOptions);
		const wasAutomatic = this.options.get(EditorOption.automaticLayout);
		let changed = false;
		for (const option of editorOptionsRegistry) {
			if (!Object.prototype.hasOwnProperty.call(update, option.name)) continue;
			const result = option.applyUpdate(
				(this.rawOptions as Record<string, unknown>)[option.name],
				(update as Record<string, unknown>)[option.name],
			);
			(this.rawOptions as Record<string, unknown>)[option.name] = result.newValue;
			changed ||= result.didChange;
		}
		if (!changed) return;
		this.validatedOptions = validateOptions(this.rawOptions);
		this.recomputeOptions();
		const isAutomatic = this.options.get(EditorOption.automaticLayout);
		if (wasAutomatic === isAutomatic) return;
		if (isAutomatic) this.containerObserver.startObserving();
		else this.containerObserver.stopObserving();
	}

	observeContainer(dimension?: IDimension): void {
		this.containerObserver.observe(dimension);
	}

	setIsDominatedByLongLines(value: boolean): void {
		if (this.isDominatedByLongLines === value) return;
		this.isDominatedByLongLines = value;
		this.recomputeOptions();
	}

	setModelLineCount(count: number): void {
		const digits = digitCount(count);
		if (this.lineNumbersDigitCount === digits) return;
		this.lineNumbersDigitCount = digits;
		this.recomputeOptions();
	}

	setViewLineCount(count: number): void {
		if (this.viewLineCount === count) return;
		this.viewLineCount = count;
		this.recomputeOptions();
	}

	setReservedHeight(height: number): void {
		if (this.reservedHeight === height) return;
		this.reservedHeight = height;
		this.recomputeOptions();
	}

	setGlyphMarginDecorationLaneCount(count: number): void {
		if (this.glyphMarginDecorationLaneCount === count) return;
		this.glyphMarginDecorationLaneCount = count;
		this.recomputeOptions();
	}

	protected _readEnvConfiguration(): IEnvConfiguration {
		return {
			extraEditorClassName: editorClassName(),
			outerWidth: this.containerObserver.getWidth(),
			outerHeight: this.containerObserver.getHeight(),
			emptySelectionClipboard: browser.isWebKit || browser.isFirefox,
			pixelRatio: PixelRatio.getInstance(this.targetWindow).value,
			accessibilitySupport: this.accessibilityService.isScreenReaderOptimized()
				? AccessibilitySupport.Enabled
				: this.accessibilityService.getAccessibilitySupport(),
			editContextSupported: typeof (this.targetWindow as Window & { EditContext?: unknown }).EditContext === 'function',
		};
	}

	protected _readFontInfo(font: BareFontInfo): FontInfo {
		return FontMeasurements.readFontInfo(this.targetWindow, font);
	}

	private recomputeOptions(): void {
		const next = this.computeOptions();
		const event = changedOptions(this.options, next);
		if (!event) return;
		this.options = next;
		this.fastChangeEmitter.fire(event);
		this.changeEmitter.fire(event);
	}

	private computeOptions(): ComputedEditorOptions {
		const browserEnv = this._readEnvConfiguration();
		const fontInfo = this._readFontInfo(createBareFontInfoFromValidatedSettings(
			this.validatedOptions,
			browserEnv.pixelRatio,
			this.isSimpleWidget,
		));
		const env: IEnvironmentalOptions = {
			memory: this.computeMemory,
			outerWidth: browserEnv.outerWidth,
			outerHeight: Math.max(0, browserEnv.outerHeight - this.reservedHeight),
			fontInfo,
			extraEditorClassName: browserEnv.extraEditorClassName,
			isDominatedByLongLines: this.isDominatedByLongLines,
			viewLineCount: this.viewLineCount,
			lineNumbersDigitCount: this.lineNumbersDigitCount,
			emptySelectionClipboard: browserEnv.emptySelectionClipboard,
			pixelRatio: browserEnv.pixelRatio,
			tabFocusMode: this.validatedOptions.get(EditorOption.tabFocusMode) || TabFocus.getTabFocusMode(),
			inputMode: InputMode.getInputMode(),
			accessibilitySupport: browserEnv.accessibilitySupport,
			glyphMarginDecorationLaneCount: this.glyphMarginDecorationLaneCount,
			editContextSupported: browserEnv.editContextSupported,
		};
		const result = new ComputedEditorOptions();
		for (const option of editorOptionsRegistry) {
			result._write(option.id, option.compute(env, result, this.validatedOptions._read(option.id)));
		}
		return result;
	}
}

function validateOptions(options: IEditorOptions): ValidatedEditorOptions {
	const result = new ValidatedEditorOptions();
	for (const option of editorOptionsRegistry) {
		result._write(option.id, option.validate((options as Record<string, unknown>)[option.name]));
	}
	return result;
}

function changedOptions(previous: ComputedEditorOptions, next: ComputedEditorOptions): ConfigurationChangedEvent | undefined {
	const changed: boolean[] = [];
	let anyChanged = false;
	for (const option of editorOptionsRegistry) {
		const didChange = !sameValue(previous._read(option.id), next._read(option.id));
		changed[option.id] = didChange;
		anyChanged ||= didChange;
	}
	return anyChanged ? new ConfigurationChangedEvent(changed) : undefined;
}

function sameValue(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
	}
	const leftEntries = Object.entries(left);
	const rightRecord = right as Record<string, unknown>;
	return leftEntries.length === Object.keys(rightRecord).length && leftEntries.every(([key, value]) => sameValue(value, rightRecord[key]));
}

function cloneAndMigrate(options: Readonly<IEditorOptions>): IEditorOptions {
	const result = cloneValue(options) as IEditorOptions;
	migrateOptions(result);
	return result;
}

function cloneValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cloneValue);
	if (!value || typeof value !== 'object') return value;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
}

function digitCount(value: number): number {
	if (!Number.isFinite(value) || value < 1) return 1;
	return Math.floor(value).toString().length;
}

function editorClassName(): string {
	const classes: string[] = [];
	if (browser.isSafari || browser.isWebkitWebView) classes.push('no-minimap-shadow', 'enable-user-select');
	else classes.push('no-user-select');
	if (isMacintosh) classes.push('mac');
	return `${classes.join(' ')} `;
}
