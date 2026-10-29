import type { IProcessEnvironment } from '../../../base/common/platform.js';
import { isWindows } from '../../../base/common/platform.js';
import {
	EnvironmentVariableMutatorType,
	type EnvironmentVariableScope,
	type IEnvironmentVariableCollection,
	type IMergedEnvironmentVariableCollection,
	type IMergedEnvironmentVariableCollectionDiff,
	type IExtensionOwnedEnvironmentVariableMutator,
} from './environmentVariable.js';

/** A launch snapshot; extension synchronization and process inheritance stay with their owners. */
export class MergedEnvironmentVariableCollection implements IMergedEnvironmentVariableCollection {
	readonly collections: ReadonlyMap<string, IEnvironmentVariableCollection>;

	constructor(
		collections: ReadonlyMap<string, IEnvironmentVariableCollection>,
		private readonly caseSensitive = !isWindows,
	) {
		this.collections = new Map(
			[...collections].map(([extension, collection]) => [
				extension,
				{
					map: new Map(
						[...collection.map].map(([key, mutator]) => [
							key,
							Object.freeze({
								...mutator,
								...(mutator.options ? { options: Object.freeze({ ...mutator.options }) } : {}),
								scope: snapshotScope(mutator.scope),
							}),
						]),
					),
					descriptionMap:
						collection.descriptionMap &&
						new Map(
							[...collection.descriptionMap].map(([key, description]) => [
								key,
								Object.freeze({ ...description, scope: snapshotScope(description.scope) }),
							]),
						),
				},
			]),
		);
	}

	getVariableMap(
		scope: EnvironmentVariableScope | undefined,
	): Map<string, IExtensionOwnedEnvironmentVariableMutator[]> {
		const result = new Map<string, IExtensionOwnedEnvironmentVariableMutator[]>();
		const groups = new Map<string, IExtensionOwnedEnvironmentVariableMutator[]>();
		for (const [extensionIdentifier, collection] of this.collections) {
			for (const mutator of collection.map.values()) {
				if (!inScope(mutator.scope, scope)) continue;
				const identity = JSON.stringify([
					this.caseSensitive ? mutator.variable : mutator.variable.toLowerCase(),
					mutator.scope?.workspaceFolder?.uri.toString(),
				]);
				let mutations = groups.get(identity);
				if (!mutations) groups.set(identity, (mutations = []));
				// Earlier extensions have priority. Their Replace cuts off lower
				// priority mutations in the same scope, while scoped entries remain
				// independent of the global mutation for the variable.
				if (mutations[0]?.type === EnvironmentVariableMutatorType.Replace) continue;
				mutations.unshift({ ...mutator, extensionIdentifier });
			}
		}
		for (const mutations of groups.values()) {
			const name = mutations[0]!.variable;
			const key = this.caseSensitive
				? name
				: ([...result.keys()].find(key => key.toLowerCase() === name.toLowerCase()) ?? name);
			result.set(key, [...(result.get(key) ?? []), ...mutations]);
		}
		return result;
	}

	getDescriptionMap(scope: EnvironmentVariableScope | undefined): Map<string, string | undefined> {
		const result = new Map<string, string | undefined>();
		for (const [extension, collection] of this.collections) {
			for (const description of collection.descriptionMap?.values() ?? []) {
				if (description.scope?.workspaceFolder?.uri.toString() === scope?.workspaceFolder?.uri.toString())
					result.set(extension, description.description);
			}
		}
		return result;
	}

	async applyToProcessEnvironment(
		env: IProcessEnvironment,
		scope: EnvironmentVariableScope | undefined,
		variableResolver?: (value: string) => Promise<string>,
	): Promise<void> {
		// Resolve into a working copy so cancellation or failed resolution cannot
		// partially change the caller's launch environment.
		const result = { ...env };
		const shellValues = new Map<string, { constant: string | undefined; prefix: string; suffix: string }>();
		for (const [name, mutations] of this.getVariableMap(scope)) {
			const key = this.caseSensitive
				? name
				: (Object.keys(result).find(key => key.toLowerCase() === name.toLowerCase()) ?? name);
			for (const mutator of mutations) {
				const creation = mutator.options === undefined || mutator.options.applyAtProcessCreation === true;
				const shell = mutator.options?.applyAtShellIntegration === true;
				if (!creation && !shell) continue;
				const value = variableResolver ? await variableResolver(mutator.value) : mutator.value;
				if (creation) {
					const current = result[key] ?? '';
					const next =
						mutator.type === EnvironmentVariableMutatorType.Replace
							? value
							: mutator.type === EnvironmentVariableMutatorType.Append
								? current + value
								: value + current;
					Object.defineProperty(result, key, {
						value: next,
						enumerable: true,
						configurable: true,
						writable: true,
					});
				}
				if (shell) {
					// Compose against an unknown post-RC value. A scoped Replace
					// cancels earlier edits rather than depending on metadata field order.
					const state = shellValues.get(key) ?? { constant: undefined, prefix: '', suffix: '' };
					if (mutator.type === EnvironmentVariableMutatorType.Replace) {
						state.constant = value;
						state.prefix = '';
						state.suffix = '';
					} else if (state.constant !== undefined) {
						state.constant =
							mutator.type === EnvironmentVariableMutatorType.Append
								? state.constant + value
								: value + state.constant;
					} else if (mutator.type === EnvironmentVariableMutatorType.Append) {
						state.suffix += value;
					} else {
						state.prefix = value + state.prefix;
					}
					shellValues.set(key, state);
				}
			}
		}
		// These names are the external shell integration metadata contract. Rust
		// consumes them once and writes literal assignments into its startup wrapper.
		const metadata = {
			VSCODE_ENV_REPLACE: [] as string[],
			VSCODE_ENV_PREPEND: [] as string[],
			VSCODE_ENV_APPEND: [] as string[],
		};
		for (const [name, state] of shellValues) {
			const entry = (value: string) => `${encodeShellMetadata(name)}=${encodeShellMetadata(value)}`;
			if (state.constant !== undefined) {
				metadata.VSCODE_ENV_REPLACE.push(entry(state.constant));
			} else {
				if (state.prefix) {
					metadata.VSCODE_ENV_PREPEND.push(entry(state.prefix));
				}
				if (state.suffix || !state.prefix) {
					metadata.VSCODE_ENV_APPEND.push(entry(state.suffix));
				}
			}
		}
		for (const [name, entries] of Object.entries(metadata)) {
			if (entries.length) {
				Object.defineProperty(result, name, {
					value: [result[name], ...entries].filter(value => value !== undefined && value !== '').join(':'),
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
		}
		for (const [key, value] of Object.entries(result)) {
			Object.defineProperty(env, key, { value, enumerable: true, configurable: true, writable: true });
		}
	}

	diff(
		other: IMergedEnvironmentVariableCollection,
		scope: EnvironmentVariableScope | undefined,
	): IMergedEnvironmentVariableCollectionDiff | undefined {
		const before = this.getVariableMap(scope);
		const after = other.getVariableMap(scope);
		const added = new Map<string, IExtensionOwnedEnvironmentVariableMutator[]>();
		const changed = new Map<string, IExtensionOwnedEnvironmentVariableMutator[]>();
		const removed = new Map<string, IExtensionOwnedEnvironmentVariableMutator[]>();
		for (const name of new Set([...before.keys(), ...after.keys()])) {
			const previous = before.get(name) ?? [];
			const next = after.get(name) ?? [];
			const additions = next.filter(mutation => !previous.some(old => sameOwner(old, mutation)));
			const removals = previous.filter(mutation => !next.some(current => sameOwner(current, mutation)));
			const changes = next.filter(mutation =>
				previous.some(
					old =>
						sameOwner(old, mutation) &&
						(old.type !== mutation.type || old.value !== mutation.value || !samePhases(old, mutation)),
				),
			);
			if (additions.length) added.set(name, additions);
			if (removals.length) removed.set(name, removals);
			if (changes.length) changed.set(name, changes);
		}
		return added.size || changed.size || removed.size ? { added, changed, removed } : undefined;
	}
}

function encodeShellMetadata(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll(':', '\\x3a');
}

function samePhases(
	a: IExtensionOwnedEnvironmentVariableMutator,
	b: IExtensionOwnedEnvironmentVariableMutator,
): boolean {
	return (
		(a.options === undefined || a.options.applyAtProcessCreation === true) ===
			(b.options === undefined || b.options.applyAtProcessCreation === true) &&
		(a.options?.applyAtShellIntegration === true) === (b.options?.applyAtShellIntegration === true)
	);
}

function sameOwner(
	a: IExtensionOwnedEnvironmentVariableMutator,
	b: IExtensionOwnedEnvironmentVariableMutator,
): boolean {
	return (
		a.extensionIdentifier === b.extensionIdentifier &&
		a.scope?.workspaceFolder?.uri.toString() === b.scope?.workspaceFolder?.uri.toString()
	);
}

function inScope(
	mutation: EnvironmentVariableScope | undefined,
	launch: EnvironmentVariableScope | undefined,
): boolean {
	return (
		!mutation?.workspaceFolder ||
		mutation.workspaceFolder.uri.toString() === launch?.workspaceFolder?.uri.toString()
	);
}

function snapshotScope(scope: EnvironmentVariableScope | undefined): EnvironmentVariableScope | undefined {
	return (
		scope &&
		Object.freeze({ workspaceFolder: scope.workspaceFolder && Object.freeze({ ...scope.workspaceFolder }) })
	);
}
