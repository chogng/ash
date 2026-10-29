import type { IProcessEnvironment } from '../../../base/common/platform.js';
import type { IWorkspaceFolderData } from '../../workspace/common/workspace.js';

/** Ordered mutations for process creation and shell startup. */
export const enum EnvironmentVariableMutatorType {
	Replace = 1,
	Append = 2,
	Prepend = 3,
}

export interface IEnvironmentVariableMutator {
	readonly variable: string;
	readonly value: string;
	readonly type: EnvironmentVariableMutatorType;
	readonly scope?: EnvironmentVariableScope;
	readonly options?: IEnvironmentVariableMutatorOptions;
}

export interface IEnvironmentVariableMutatorOptions {
	/** Omitted flags are false; omitting the options object uses process creation. */
	applyAtProcessCreation?: boolean;
	applyAtShellIntegration?: boolean;
}

export type EnvironmentVariableScope = { workspaceFolder?: IWorkspaceFolderData };

export interface IEnvironmentVariableCollectionDescription {
	readonly description: string | undefined;
	readonly scope?: EnvironmentVariableScope;
}

export interface IExtensionOwnedEnvironmentVariableMutator extends IEnvironmentVariableMutator {
	readonly extensionIdentifier: string;
}

export interface IMergedEnvironmentVariableCollectionDiff {
	added: ReadonlyMap<string, IExtensionOwnedEnvironmentVariableMutator[]>;
	changed: ReadonlyMap<string, IExtensionOwnedEnvironmentVariableMutator[]>;
	removed: ReadonlyMap<string, IExtensionOwnedEnvironmentVariableMutator[]>;
}

/** Ordered entries used at extension and persistence boundaries. */
export type ISerializableEnvironmentVariableCollection = [string, IEnvironmentVariableMutator][];
export type ISerializableEnvironmentDescriptionMap = [string, IEnvironmentVariableCollectionDescription][];

/** Immutable launch metadata; this does not contain the host's inherited environment. */
export type ISerializableEnvironmentVariableCollections = readonly (readonly [
	string,
	ISerializableEnvironmentVariableCollection,
	ISerializableEnvironmentDescriptionMap?,
])[];

export interface IEnvironmentVariableCollection {
	readonly map: ReadonlyMap<string, IEnvironmentVariableMutator>;
	readonly descriptionMap?: ReadonlyMap<string, IEnvironmentVariableCollectionDescription>;
}

export interface IMergedEnvironmentVariableCollection {
	readonly collections: ReadonlyMap<string, IEnvironmentVariableCollection>;
	getVariableMap(
		scope: EnvironmentVariableScope | undefined,
	): Map<string, IExtensionOwnedEnvironmentVariableMutator[]>;
	getDescriptionMap(scope: EnvironmentVariableScope | undefined): Map<string, string | undefined>;
	applyToProcessEnvironment(
		env: IProcessEnvironment,
		scope: EnvironmentVariableScope | undefined,
		variableResolver?: (value: string) => Promise<string>,
	): Promise<void>;
	diff(
		other: IMergedEnvironmentVariableCollection,
		scope: EnvironmentVariableScope | undefined,
	): IMergedEnvironmentVariableCollectionDiff | undefined;
}
