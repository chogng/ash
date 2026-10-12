import { EnvironmentVariableMutatorType, type IEnvironmentVariableMutator } from '../../../../platform/terminal/common/environmentVariable.js';

/** Only writes mutated keys: copying a partial execution-host environment would erase inherited values. */
export async function createTerminalEnvironment(
	overrides: Readonly<Record<string, string | null>>,
	inherited: Readonly<Record<string, string>>,
	mutations: Iterable<readonly [string, IEnvironmentVariableMutator]>,
	caseSensitive: boolean,
	resolve: (value: string) => Promise<string>,
): Promise<Record<string, string | null>> {
	const env = { ...overrides };
	for (const [name, mutator] of mutations) {
		const key = caseSensitive ? name : Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase()) ?? Object.keys(inherited).find(key => key.toLowerCase() === name.toLowerCase()) ?? name;
		const value = await resolve(mutator.value);
		const current = Object.hasOwn(env, key) ? env[key] ?? '' : Object.hasOwn(inherited, key) ? inherited[key]! : '';
		const result = mutator.type === EnvironmentVariableMutatorType.Replace ? value : mutator.type === EnvironmentVariableMutatorType.Append ? current + value : value + current;
		Object.defineProperty(env, key, { value: result, enumerable: true, configurable: true, writable: true });
	}
	return env;
}
