import { PixelRatio } from '../../../base/browser/pixelRatio.js';
import { addDisposableListener } from '../../../base/browser/dom.js';
import { disposableWindowTimeout } from '../../../base/browser/scheduler.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import { EditorFontLigatures } from '../../common/config/editorOptions.js';
import { BareFontInfo, FontInfo, SERIALIZED_FONT_INFO_VERSION } from '../../common/config/fontInfo.js';
import { CharWidthRequest, CharWidthRequestType, readCharWidths } from './charWidthReader.js';

export interface ISerializedFontInfo {
	readonly version: number;
	readonly pixelRatio: number;
	readonly fontFamily: string;
	readonly fontWeight: string;
	readonly fontSize: number;
	readonly fontFeatureSettings: string;
	readonly fontVariationSettings: string;
	readonly lineHeight: number;
	readonly letterSpacing: number;
	readonly isMonospace: boolean;
	readonly typicalHalfwidthCharacterWidth: number;
	readonly typicalFullwidthCharacterWidth: number;
	readonly canUseHalfwidthRightwardsArrow: boolean;
	readonly spaceWidth: number;
	readonly middotWidth: number;
	readonly wsmiddotWidth: number;
	readonly maxDigitWidth: number;
}

interface FontCache {
	readonly values: Map<string, FontInfo>;
	restored: boolean;
	measured: boolean;
}

export class FontMeasurementsImpl extends Disposable {
	private _cache = new WeakMap<Window, FontCache>();
	private readonly _eviction = this._register(new DisposableMap<Window, DisposableStore>());
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	clearAllFontInfos(): void {
		this._cache = new WeakMap();
		for (const targetWindow of this._eviction.keys()) {
			this._eviction.deleteAndDispose(targetWindow);
		}
		this._onDidChange.fire();
	}

	/** Undefined keeps persisted readings intact until this window measures a font. */
	serializeFontInfo(targetWindow: Window): ISerializedFontInfo[] | undefined {
		const cache = this.cacheFor(targetWindow);
		if (cache.restored && !cache.measured) return undefined;
		return [...cache.values.values()].filter(fontInfo => fontInfo.isTrusted);
	}

	restoreFontInfo(targetWindow: Window, savedFontInfos: ISerializedFontInfo[]): void {
		for (const saved of savedFontInfos) {
			if (!isSerializedFontInfo(saved)) continue;
			const fontInfo = new FontInfo(saved, false);
			this.cacheFor(targetWindow).restored = true;
			this.write(targetWindow, fontInfo, fontInfo);
		}
	}

	readFontInfo(targetWindow: Window, bareFontInfo: BareFontInfo): FontInfo {
		const cache = this.cacheFor(targetWindow);
		const cached = cache.values.get(bareFontInfo.getId());
		if (cached) return cached;
		let fontInfo = this.measure(targetWindow, bareFontInfo);
		if (minimumWidth(fontInfo) <= 2) fontInfo = clampUnreliableFontInfo(fontInfo);
		cache.measured = true;
		this.write(targetWindow, bareFontInfo, fontInfo);
		return fontInfo;
	}

	private cacheFor(targetWindow: Window): FontCache {
		let cache = this._cache.get(targetWindow);
		if (!cache) {
			cache = { values: new Map(), restored: false, measured: false };
			this._cache.set(targetWindow, cache);
		}
		return cache;
	}

	private write(targetWindow: Window, key: BareFontInfo, value: FontInfo): void {
		this.cacheFor(targetWindow).values.set(key.getId(), value);
		if (value.isTrusted || this._eviction.has(targetWindow)) return;
		const eviction = this._eviction.set(targetWindow, new DisposableStore());
		eviction.add(addDisposableListener(targetWindow, 'pagehide', () => {
			this._cache.delete(targetWindow);
			this._eviction.deleteAndDispose(targetWindow);
		}));
		eviction.add(disposableWindowTimeout(targetWindow, () => {
			this._eviction.deleteAndDispose(targetWindow);
			const cache = this.cacheFor(targetWindow).values;
			let changed = false;
			for (const [id, fontInfo] of cache) {
				if (fontInfo.isTrusted) continue;
				cache.delete(id);
				changed = true;
			}
			if (changed) this._onDidChange.fire();
		}, 5_000));
	}

	private measure(targetWindow: Window, bareFontInfo: BareFontInfo): FontInfo {
		const requests: CharWidthRequest[] = [];
		const monospace: CharWidthRequest[] = [];
		const add = (chr: string, type = CharWidthRequestType.Regular, compareMonospace = false): CharWidthRequest => {
			const request = new CharWidthRequest(chr, type);
			requests.push(request);
			if (compareMonospace) monospace.push(request);
			return request;
		};
		const halfwidth = add('n', CharWidthRequestType.Regular, true);
		const fullwidth = add('\uff4d');
		const space = add(' ', CharWidthRequestType.Regular, true);
		const digits = [...'0123456789'].map(chr => add(chr, CharWidthRequestType.Regular, true));
		const arrow = add('\u2192', CharWidthRequestType.Regular, true);
		const halfArrow = add('\uffeb');
		const middot = add('\u00b7', CharWidthRequestType.Regular, true);
		const wordSeparatorMiddot = add('\u2e31');
		for (const chr of '|/-_ilm%') {
			add(chr, CharWidthRequestType.Regular, true);
			add(chr, CharWidthRequestType.Italic, true);
			add(chr, CharWidthRequestType.Bold, true);
		}
		readCharWidths(targetWindow, bareFontInfo, requests);
		const referenceWidth = monospace[0]!.width;
		const isMonospace = bareFontInfo.fontFeatureSettings === EditorFontLigatures.OFF
			&& monospace.every(request => Math.abs(request.width - referenceWidth) <= 0.001);
		const canUseHalfwidthRightwardsArrow = (!isMonospace || halfArrow.width === referenceWidth)
			&& halfArrow.width <= arrow.width;
		return new FontInfo({
			pixelRatio: PixelRatio.getInstance(targetWindow).value,
			fontFamily: bareFontInfo.fontFamily,
			fontWeight: bareFontInfo.fontWeight,
			fontSize: bareFontInfo.fontSize,
			fontFeatureSettings: bareFontInfo.fontFeatureSettings,
			fontVariationSettings: bareFontInfo.fontVariationSettings,
			lineHeight: bareFontInfo.lineHeight,
			letterSpacing: bareFontInfo.letterSpacing,
			isMonospace,
			typicalHalfwidthCharacterWidth: halfwidth.width,
			typicalFullwidthCharacterWidth: fullwidth.width,
			canUseHalfwidthRightwardsArrow,
			spaceWidth: space.width,
			middotWidth: middot.width,
			wsmiddotWidth: wordSeparatorMiddot.width,
			maxDigitWidth: Math.max(...digits.map(request => request.width)),
		}, true);
	}
}

function isSerializedFontInfo(value: unknown): value is ISerializedFontInfo {
	if (!isRecord(value) || value.version !== SERIALIZED_FONT_INFO_VERSION) return false;
	if (typeof value.isMonospace !== 'boolean' || typeof value.canUseHalfwidthRightwardsArrow !== 'boolean') return false;
	for (const key of ['fontFamily', 'fontWeight', 'fontFeatureSettings', 'fontVariationSettings']) {
		if (typeof value[key] !== 'string') return false;
	}
	for (const key of ['pixelRatio', 'fontSize', 'lineHeight', 'typicalHalfwidthCharacterWidth', 'typicalFullwidthCharacterWidth', 'spaceWidth', 'maxDigitWidth']) {
		if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] <= 0) return false;
	}
	for (const key of ['middotWidth', 'wsmiddotWidth']) {
		if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0) return false;
	}
	return typeof value.letterSpacing === 'number' && Number.isFinite(value.letterSpacing);
}

function minimumWidth(fontInfo: FontInfo): number {
	return Math.min(fontInfo.typicalHalfwidthCharacterWidth, fontInfo.typicalFullwidthCharacterWidth, fontInfo.spaceWidth, fontInfo.maxDigitWidth);
}

function clampUnreliableFontInfo(fontInfo: FontInfo): FontInfo {
	return new FontInfo({
		...fontInfo,
		typicalHalfwidthCharacterWidth: Math.max(5, fontInfo.typicalHalfwidthCharacterWidth),
		typicalFullwidthCharacterWidth: Math.max(5, fontInfo.typicalFullwidthCharacterWidth),
		spaceWidth: Math.max(5, fontInfo.spaceWidth),
		middotWidth: Math.max(5, fontInfo.middotWidth),
		wsmiddotWidth: Math.max(5, fontInfo.wsmiddotWidth),
		maxDigitWidth: Math.max(5, fontInfo.maxDigitWidth),
	}, false);
}

export const FontMeasurements = new FontMeasurementsImpl();
