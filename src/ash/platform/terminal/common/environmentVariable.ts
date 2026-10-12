/** Mutations applied to the execution host's inherited environment before spawning a shell. */
export const enum EnvironmentVariableMutatorType {
	Replace = 1,
	Append = 2,
	Prepend = 3,
}

export interface IEnvironmentVariableMutator {
	readonly value: string;
	readonly type: EnvironmentVariableMutatorType;
}

export interface IEnvironmentVariableCollection {
	readonly map: ReadonlyMap<string, IEnvironmentVariableMutator>;
}

export interface IMergedEnvironmentVariableCollection {
	applyToProcessEnvironment(env: Record<string, string | null>, inherited: Readonly<Record<string, string>>, caseSensitive: boolean, resolve: (value: string) => Promise<string>): Promise<void>;
}
