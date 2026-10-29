import { localize } from '../../../nls.js';
import { URI, isUriComponents } from '../../../base/common/uri.js';
import type { EnvironmentVariableScope, IEnvironmentVariableCollection, IEnvironmentVariableCollectionDescription, IEnvironmentVariableMutator, ISerializableEnvironmentDescriptionMap, ISerializableEnvironmentVariableCollection, ISerializableEnvironmentVariableCollections } from './environmentVariable.js';

export function serializeEnvironmentVariableCollections(collections: ReadonlyMap<string, IEnvironmentVariableCollection>): ISerializableEnvironmentVariableCollections {
	return [...collections].map(([extension, collection]) => [extension, serializeEnvironmentVariableCollection(collection.map), collection.descriptionMap ? serializeEnvironmentDescriptionMap(collection.descriptionMap) : []]);
}

/** Validates persisted launch metadata independently of the current extension registry. */
export function deserializeEnvironmentVariableCollections(value: unknown): Map<string, IEnvironmentVariableCollection> {
	if (!Array.isArray(value) || value.length > 256) throw invalid();
	const collections = new Map<string, IEnvironmentVariableCollection>();
	for (const entry of value) {
		if (!Array.isArray(entry) || entry.length < 2 || entry.length > 3 || typeof entry[0] !== 'string' || !entry[0] || entry[0].length > 1024 || /[\x00-\x1f]/.test(entry[0]) || collections.has(entry[0])) throw invalid();
		collections.set(entry[0], { map: deserializeEnvironmentVariableCollection(entry[1]), descriptionMap: deserializeEnvironmentDescriptionMap(entry[2] ?? []) });
	}
	return collections;
}

export function serializeEnvironmentVariableCollection(collection: ReadonlyMap<string, IEnvironmentVariableMutator>): ISerializableEnvironmentVariableCollection {
	return [...collection].map(([key, mutator]) => [key, { ...mutator, ...(mutator.options ? { options: { ...mutator.options } } : {}), ...(mutator.scope ? { scope: { workspaceFolder: mutator.scope.workspaceFolder && { ...mutator.scope.workspaceFolder } } } : {}) }]);
}

/** Decodes external callback and persisted JSON at their shared boundary. */
export function deserializeEnvironmentVariableCollection(value: unknown): Map<string, IEnvironmentVariableMutator> {
	if (!Array.isArray(value) || value.length > 1024) throw new TypeError(localize('terminal.environment.invalidCollection', 'Invalid terminal environment collection.'));
	const map = new Map<string, IEnvironmentVariableMutator>();
	for (const entry of value) {
		if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError(localize('terminal.environment.invalidCollection', 'Invalid terminal environment collection.'));
		const [key, mutator] = entry;
		if (typeof key !== 'string' || !key || key.length > 32768 || /[=\0]/.test(key) || map.has(key)
			|| !mutator || typeof mutator !== 'object' || typeof mutator.value !== 'string'
			|| mutator.value.length > 32768 || mutator.value.includes('\0')
			|| (mutator.variable !== undefined && (typeof mutator.variable !== 'string' || !mutator.variable || mutator.variable.length > 32768 || /[=\0]/.test(mutator.variable)))
			|| ![1, 2, 3].includes(mutator.type) || Object.keys(mutator).some(key => !['value', 'type', 'variable', 'scope', 'options'].includes(key))) {
			throw new TypeError(localize('terminal.environment.invalidCollection', 'Invalid terminal environment collection.'));
		}
		// Earlier Ash snapshots omitted variable. Normalize them once here;
		// serialization always emits the current representation.
		const scope = deserializeScope(mutator.scope);
		const options = mutator.options;
		if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options)
			|| Object.keys(options).some(key => !['applyAtProcessCreation', 'applyAtShellIntegration'].includes(key))
			|| Object.values(options).some(value => value !== undefined && typeof value !== 'boolean'))) throw invalid();
		map.set(key, Object.freeze({ variable: mutator.variable ?? key, value: mutator.value, type: mutator.type, ...(scope ? { scope } : {}), ...(options ? { options: Object.freeze({ ...options }) } : {}) }));
	}
	return map;
}

export function serializeEnvironmentDescriptionMap(descriptions: ReadonlyMap<string, IEnvironmentVariableCollectionDescription>): ISerializableEnvironmentDescriptionMap {
	return [...descriptions].map(([key, description]) => [key, { ...description }]);
}

export function deserializeEnvironmentDescriptionMap(value: unknown): Map<string, IEnvironmentVariableCollectionDescription> {
	if (!Array.isArray(value) || value.length > 256) throw invalid();
	const result = new Map<string, IEnvironmentVariableCollectionDescription>();
	for (const entry of value) {
		if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || entry[0].length > 32768 || result.has(entry[0])) throw invalid();
		const description = entry[1];
		if (!description || typeof description !== 'object' || Array.isArray(description) || Object.keys(description).some(key => !['description', 'scope'].includes(key))
			|| (description.description !== undefined && (typeof description.description !== 'string' || description.description.length > 32768 || description.description.includes('\0')))) throw invalid();
		const scope = deserializeScope(description.scope);
		result.set(entry[0], Object.freeze({ description: description.description, ...(scope ? { scope } : {}) }));
	}
	return result;
}

function deserializeScope(value: unknown): EnvironmentVariableScope | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'workspaceFolder')) throw invalid();
	const folder = (value as { workspaceFolder?: unknown; }).workspaceFolder;
	if (folder === undefined) return Object.freeze({});
	if (!folder || typeof folder !== 'object' || Array.isArray(folder) || Object.keys(folder).some(key => !['uri', 'name', 'index'].includes(key))) throw invalid();
	const data = folder as { uri?: unknown; name?: unknown; index?: unknown; };
	if (!isUriComponents(data.uri) || typeof data.name !== 'string' || !data.name || data.name.length > 4096 || !Number.isSafeInteger(data.index) || (data.index as number) < 0) throw invalid();
	return Object.freeze({ workspaceFolder: Object.freeze({ uri: URI.revive(data.uri), name: data.name, index: data.index as number }) });
}

function invalid(): TypeError { return new TypeError(localize('terminal.environment.invalidCollection', 'Invalid terminal environment collection.')); }
