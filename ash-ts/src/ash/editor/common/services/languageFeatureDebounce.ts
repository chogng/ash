import { clamp } from '../../../base/common/numbers.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import type { LanguageFeatureRegistry } from '../languageFeatureRegistry.js';
import type { ITextModel } from '../model.js';

export const ILanguageFeatureDebounceService = createDecorator<ILanguageFeatureDebounceService>('ILanguageFeatureDebounceService');

export interface ILanguageFeatureDebounceService {
	readonly _serviceBrand: undefined;
	for(feature: LanguageFeatureRegistry<object>, debugName: string, config?: { min?: number; max?: number; salt?: string }): IFeatureDebounceInformation;
}

export interface IFeatureDebounceInformation {
	get(model: ITextModel): number;
	update(model: ITextModel, value: number): number;
	default(): number;
}

export class LanguageFeatureDebounceService implements ILanguageFeatureDebounceService {
	readonly _serviceBrand = undefined;
	private readonly features = new WeakMap<LanguageFeatureRegistry<object>, Map<string, IFeatureDebounceInformation>>();

	for(feature: LanguageFeatureRegistry<object>, debugName: string, config?: { min?: number; max?: number; salt?: string }): IFeatureDebounceInformation {
		const min = config?.min ?? 50;
		const max = config?.max ?? Math.max(min, 500);
		if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
			throw new RangeError(`${debugName}: debounce bounds must be finite and satisfy 0 <= min <= max`);
		}
		let configurations = this.features.get(feature);
		if (!configurations) {
			configurations = new Map();
			this.features.set(feature, configurations);
		}
		const key = JSON.stringify([min, max, config?.salt]);
		let information = configurations.get(key);
		if (!information) {
			information = new FeatureDebounceInformation(feature, min, max);
			configurations.set(key, information);
		}
		return information;
	}
}

interface ModelTiming {
	readonly languageId: string;
	readonly providers: readonly WeakRef<object>[];
	delay: number | undefined;
}

class FeatureDebounceInformation implements IFeatureDebounceInformation {
	private readonly timings = new WeakMap<ITextModel, ModelTiming>();

	constructor(private readonly feature: LanguageFeatureRegistry<object>, private readonly min: number, private readonly max: number) {}

	get(model: ITextModel): number {
		return this.timing(model)?.delay ?? this.default();
	}

	update(model: ITextModel, value: number): number {
		if (!Number.isFinite(value) || value < 0) {
			throw new RangeError('Language feature duration must be a non-negative finite number');
		}
		const timing = this.timing(model);
		if (!timing) {
			return this.default();
		}
		const sample = clamp(value, this.min, this.max);
		timing.delay = timing.delay === undefined ? sample : (timing.delay + sample) / 2;
		return timing.delay;
	}

	default(): number {
		return this.min;
	}

	private timing(model: ITextModel): ModelTiming | undefined {
		if (model.isDisposed()) {
			this.timings.delete(model);
			return undefined;
		}
		const languageId = model.getLanguageId();
		const providers = this.feature.ordered(model);
		let timing = this.timings.get(model);
		if (!timing
			|| timing.languageId !== languageId
			|| timing.providers.length !== providers.length
			|| timing.providers.some((provider, index) => provider.deref() !== providers[index])) {
			timing = { languageId, providers: providers.map(provider => new WeakRef(provider)), delay: undefined };
			this.timings.set(model, timing);
		}
		return timing;
	}
}
