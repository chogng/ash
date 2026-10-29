import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Product defaults are explicit: adding translation sources must not enlarge every installation. */
export async function readPreinstalledLanguagePackIds(): Promise<ReadonlySet<string>> {
	const value: unknown = JSON.parse(
		await readFile(resolve(import.meta.dirname, '../../localization/preinstalled.json'), 'utf8'),
	);
	if (
		!Array.isArray(value) ||
		value.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u.test(id)) ||
		new Set(value).size !== value.length
	) {
		throw new Error('Invalid preinstalled language-pack selection');
	}
	return new Set(value);
}
