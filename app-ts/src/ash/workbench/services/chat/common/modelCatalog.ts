import { isRecord } from '../../../../base/common/types.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import type { ModelRef } from '../../../../sessions/services/sessions/common/session.js';

const MaximumHiddenModels = 2_048;
const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

export type ModelAccess = 'apiKey' | 'subscription' | 'local' | 'enterprise' | 'unknown';
export type ModelOutputTransport = 'nativeStreaming' | 'unary';

export interface ModelCatalogEntry {
	readonly model: ModelRef;
	readonly displayName: string;
	readonly access: ModelAccess;
	readonly outputTransport: ModelOutputTransport;
}

export function modelAccessLabel(entry: Pick<ModelCatalogEntry, 'access' | 'model'>): string {
	switch (entry.access) {
		case 'apiKey': return 'API key';
		case 'subscription': return entry.model.provider === 'openai' ? 'ChatGPT subscription' : 'Subscription';
		case 'local': return 'Local';
		case 'enterprise': return 'Enterprise';
		case 'unknown': return 'Unknown';
	}
}

/** User-owned presentation preferences for the shared model catalog. */
export const ModelCatalogConfiguration = Object.freeze({
	hiddenModels: configurationRegistry.registerConfiguration<readonly ModelRef[]>({
		key: 'models.hidden',
		defaultValue: Object.freeze([]),
		parse: parseHiddenModels,
		serialize: models => models.map(model => ({ provider: model.provider, model: model.model })),
	}),
});

export function modelRefIdentity(model: ModelRef): string {
	return `${model.provider}\0${model.model}`;
}

function parseHiddenModels(value: unknown): readonly ModelRef[] {
	if (!Array.isArray(value)) throw new TypeError('Hidden models must be an array');
	if (value.length > MaximumHiddenModels) throw new RangeError(`Hidden models must contain at most ${MaximumHiddenModels} entries`);
	const models = new Map<string, ModelRef>();
	for (const candidate of value) {
		if (!isRecord(candidate)) throw new TypeError('Hidden model entries must be objects');
		const provider = modelIdentifier(candidate.provider, 'provider');
		const model = modelIdentifier(candidate.model, 'model');
		const reference = Object.freeze({ provider, model });
		models.set(modelRefIdentity(reference), reference);
	}
	return Object.freeze([...models.values()].sort(compareModelRefs));
}

function modelIdentifier(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`Model ${label} must not be empty`);
	return value;
}

function compareModelRefs(left: ModelRef, right: ModelRef): number {
	if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1;
	if (left.model === right.model) return 0;
	return left.model < right.model ? -1 : 1;
}
