import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Schema {
	readonly markdownDescription: string;
	readonly default: unknown;
	readonly [key: string]: unknown;
}

/** Refreshes the public server settings contract from the pinned binary, retaining translations. */
export function rustSettings(schema: unknown): {
	properties: Record<string, unknown>;
	messages: Record<string, string>;
} {
	if (!Array.isArray(schema) || schema.length === 0)
		throw new TypeError('Expected the rust-analyzer configuration schema');
	const properties: Record<string, unknown> = {};
	const messages: Record<string, string> = {};
	for (const group of schema) {
		if (!group || typeof group !== 'object' || !group.properties || typeof group.properties !== 'object')
			throw new TypeError('Invalid rust-analyzer configuration group');
		for (const [key, value] of Object.entries(group.properties)) {
			const setting = value as Schema;
			if (
				!/^rust-analyzer\.[a-zA-Z][\w.]*$/u.test(key) ||
				Object.hasOwn(properties, key) ||
				!setting ||
				typeof setting.markdownDescription !== 'string' ||
				!Object.hasOwn(setting, 'default')
			)
				throw new TypeError(`Invalid or duplicate Rust setting: ${key}`);
			const id = key.slice('rust-analyzer.'.length);
			const title = id
				.split('.')
				.map(part => part.replace(/([a-z])([A-Z])/gu, '$1 $2').replace(/^./u, char => char.toUpperCase()))
				.join(': ');
			messages[`${id}.title`] = title;
			messages[`${id}.description`] = setting.markdownDescription;
			const entry: Record<string, unknown> = {
				...structuredClone(setting),
				title: `%${id}.title%`,
				markdownDescription: `%${id}.description%`,
				scope: 'resource',
			};
			if (id === 'cachePriming.enable') {
				entry.default = false;
				messages[`${id}.description`] =
					'Warm up Rust analysis caches when loading a project. Disabled by default to reduce memory use in large workspaces; analysis is computed on demand and retained in process memory. Enabling this can make the first language requests faster at the cost of more startup work and memory. Restarting the server rebuilds the cache; this setting does not save analysis to disk.';
			}
			if (id === 'lru.capacity') {
				messages[`${id}.title`] = 'Cache: Syntax tree capacity';
				messages[`${id}.description`] =
					'Number of syntax trees rust-analyzer keeps in memory. Automatic uses the server default of 128. This counts entries, not megabytes, and does not limit total server memory. Lower values can require more reparsing.';
			}
			if (id === 'lru.query.capacities') {
				messages[`${id}.description`] =
					'In-memory LRU capacity for each named query. Values count entries, not bytes or disk space. Lower capacities can require more analysis to be recomputed.';
			}
			if (id === 'numThreads') {
				messages[`${id}.description`] =
					'Number of worker threads in the main loop. Automatic lets the server choose. Fewer threads reduce parallel work; this does not set a limit on retained analysis memory.';
			}
			if (Array.isArray(setting.enumDescriptions)) {
				entry.enumDescriptions = setting.enumDescriptions.map((description, index) => {
					if (typeof description !== 'string') throw new TypeError(`Invalid Rust enum description: ${key}`);
					messages[`${id}.enum.${index}`] = description;
					return `%${id}.enum.${index}%`;
				});
			}
			const localizeNested = (value: unknown, path: readonly string[]): unknown => {
				if (Array.isArray(value))
					return value.map((item, index) => localizeNested(item, [...path, String(index)]));
				if (!value || typeof value !== 'object') return value;
				return Object.fromEntries(
					Object.entries(value).map(([field, item]) => {
						if (field === 'default') return [field, item];
						if (field === 'enumDescriptions' && Array.isArray(item))
							return [
								field,
								item.map((description, index) => {
									if (typeof description !== 'string')
										throw new TypeError(`Invalid Rust enum description: ${key}`);
									const message = `${id}.${path.join('.')}.enum.${index}`;
									messages[message] = description;
									return `%${message}%`;
								}),
							];
						return [field, localizeNested(item, [...path, field])];
					}),
				);
			};
			for (const [field, value] of Object.entries(entry)) {
				if (field !== 'default') entry[field] = localizeNested(value, [field]);
			}
			properties[key] = entry;
		}
	}
	return { properties, messages };
}

async function main(): Promise<void> {
	const [binary, flag, ...extra] = process.argv.slice(2);
	if (!binary || extra.length || (flag !== undefined && flag !== '--check'))
		throw new Error('Usage: node build/builtin/rustSettings.ts <pinned-rust-analyzer> [--check]');
	const root = resolve(import.meta.dirname, '../..');
	const packagePath = resolve(root, 'extensions/rust/package.json');
	const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
	const actual = execFileSync(binary, ['--version'], { encoding: 'utf8' });
	// The weekly release tag is one day after this binary's source commit date.
	const expected = 'rust-analyzer 0.3.3081-standalone (2ad81e72b7 2026-10-11)';
	if (actual.trim() !== expected) throw new Error(`Expected ${expected}, got ${actual.trim()}`);
	const output = rustSettings(
		JSON.parse(execFileSync(binary, ['--print-config-schema'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })),
	);
	const englishPath = resolve(root, 'extensions/rust/package.nls.json');
	const chinese = JSON.parse(await readFile(resolve(root, 'extensions/rust/package.nls.zh-CN.json'), 'utf8'));
	const missing = Object.keys(output.messages).filter(
		key => typeof chinese[key] !== 'string' || !chinese[key].trim(),
	);
	if (missing.length) throw new Error(`Missing Chinese Rust messages: ${missing.join(', ')}`);
	const english = {
		displayName: 'Rust',
		description: 'Rust language configuration, syntax highlighting and language server support.',
		...output.messages,
	};
	manifest.contributes.configuration = { title: 'Rust', properties: output.properties };
	for (const [path, value] of [
		[packagePath, manifest],
		[englishPath, english],
	] as const) {
		const source = JSON.stringify(value, null, 2) + '\n';
		if (flag === '--check') {
			if ((await readFile(path, 'utf8')) !== source) throw new Error(`Rust configuration is stale: ${path}`);
		} else await writeFile(path, source);
	}
	console.log(
		`${Object.keys(output.properties).length} Rust server settings ${flag === '--check' ? 'verified' : 'updated'}.`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
