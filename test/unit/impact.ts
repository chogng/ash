import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

interface TestPlan {
	readonly files: readonly string[];
	readonly reason: string;
	readonly full: boolean;
}

interface Snapshot {
	readonly paths: ReadonlySet<string>;
	read(path: string): string;
}

/** Local feedback only: filesystem scans and computed loads need the full CI suites. */
export function planAffectedTests(root: string, base: string, tests: readonly string[], options: { head?: string; preloads?: readonly string[] } = {}): TestPlan {
	const git = (args: string[], input?: string): Buffer =>
		execFileSync('git', args, {
			cwd: root,
			input,
			maxBuffer: 256 * 1024 * 1024,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
	// Resolve user input before it can become an option to another Git command.
	const revision = git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])
		.toString()
		.trim();
	const target = options.head
		? git(['rev-parse', '--verify', '--end-of-options', `${options.head}^{commit}`])
				.toString()
				.trim()
		: undefined;
	const comparison = git(['merge-base', revision, target ?? 'HEAD'])
		.toString()
		.trim();
	const split = (value: Buffer): string[] => value.toString().split('\0').filter(Boolean);
	const changed = new Set(split(git(['diff', '--name-only', '--no-renames', '-z', comparison, ...(target ? [target] : []), '--'])));
	if (!target) for (const path of split(git(['ls-files', '--others', '--exclude-standard', '-z']))) changed.add(path);
	const full = (reason: string): TestPlan => ({ files: tests, full: true, reason });
	if (changed.size === 0) return full('no changed inputs; running the complete suite');
	// The dependency graph cannot describe toolchains, generated contracts, preload code,
	// packages or test data loaded through arbitrary filesystem paths.
	const outside = [...changed].find(path => /(?:^|\/)(?:package(?:-lock)?|tsconfig[^/]*)\.json$/u.test(path) || !/^(?:src\/|extensions\/).*\.(?:[cm]?tsx?|[cm]?jsx?|css|json)$/u.test(path));
	if (outside) return full(`input outside the source graph: ${outside}`);

	try {
		const before = snapshot(comparison);
		const after = target
			? snapshot(target)
			: {
					paths: new Set(split(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']))),
					read: (path: string) => readFileSync(resolve(root, path), 'utf8'),
				};
		const sources = tests.map(path => path.replace(/\.js$/u, '.ts'));
		const affected = new Set<string>();
		const reached = new Set<string>();
		for (const tree of [before, after]) {
			const config = JSON.parse(tree.read('tsconfig.base.json'));
			const compiler = ts.convertCompilerOptionsFromJson(config.compilerOptions ?? {}, root);
			if (compiler.errors.length) throw new Error('cannot resolve compiler options');
			const local = (path: string): string => relative(root, path).replaceAll('\\', '/');
			const host: ts.ModuleResolutionHost = {
				getCurrentDirectory: () => root,
				fileExists: path => tree.paths.has(local(path)),
				readFile: path => (tree.paths.has(local(path)) ? tree.read(local(path)) : undefined),
			};
			const cache = ts.createModuleResolutionCache(root, path => path, compiler.options);
			const importers = new Map<string, Set<string>>();
			const preloads = new Set(options.preloads ?? []);
			const pending = [...sources, ...preloads];
			const opaque = new Set(['test/unit/browser/context.ts']);
			const visited = new Set<string>();
			while (pending.length) {
				const file = pending.pop()!;
				if (visited.has(file) || !tree.paths.has(file)) continue;
				visited.add(file);
				if (!/\.[cm]?[jt]sx?$/u.test(file)) continue;
				const text = tree.read(file);
				const facts = ts.preProcessFile(text, true, true);
				if (/\b(?:import|require)\s*\((?!\s*['"])/u.test(text)) opaque.add(file);
				const references = [...facts.importedFiles, ...facts.referencedFiles].map(reference => reference.fileName);
				if (preloads.has(file)) {
					// The preload loads compiled modules under its `src/ash` output root.
					// Read its literal entry paths so its implementation remains the owner.
					for (const match of text.matchAll(/['"]((?:base|platform|workbench|sessions|editor|code)\/[^'"]+\.js)['"]/gu)) {
						references.push(relative(dirname(file), `src/ash/${match[1]}`).replaceAll('\\', '/'));
					}
				}
				for (const reference of references) {
					if (/^(?:node:)?(?:fs(?:\/|$)|child_process$|worker_threads$|vm$)/u.test(reference)) opaque.add(file);
					const module = ts.resolveModuleName(reference, resolve(root, file), compiler.options, host, cache).resolvedModule;
					// CSS and other assets use ambient declarations, rather than TS modules.
					const asset = local(resolve(root, dirname(file), reference));
					const target = module ? local(module.resolvedFileName) : reference.startsWith('.') && tree.paths.has(asset) ? asset : undefined;
					if (!target) continue;
					let parents = importers.get(target);
					if (!parents) importers.set(target, (parents = new Set()));
					parents.add(file);
					pending.push(target);
				}
			}
			const seen = dependents(changed);
			for (const file of seen) if (visited.has(file)) reached.add(file);
			if ([...preloads].some(file => seen.has(file))) return full('a shared test preload is affected');
			// Rendered pages, filesystem readers and computed loads have dependencies
			// outside import edges. Keep their tests even for a seemingly unrelated edit.
			const uncertain = dependents(opaque);
			for (const file of sources) if (seen.has(file) || uncertain.has(file)) affected.add(file);

			function dependents(seeds: Iterable<string>): Set<string> {
				const queue = [...seeds];
				const seen = new Set<string>();
				while (queue.length) {
					const file = queue.pop()!;
					if (seen.has(file)) continue;
					seen.add(file);
					for (const parent of importers.get(file) ?? []) queue.push(parent);
				}
				return seen;
			}
		}
		const unknown = [...changed].find(path => !reached.has(path));
		if (unknown) return full(`no known test dependency for: ${unknown}`);
		if (affected.size === 0) return full('no known affected tests; running the complete suite');
		// Architecture tests inspect source text and directories instead of importing the
		// implementation, so runtime or type import edges cannot select them reliably.
		const files = tests.filter((path, index) => affected.has(sources[index]) || path.startsWith('test/architecture/'));
		if (files.length > tests.length / 2) return full('more than half of the test files are affected');
		return {
			files,
			full: false,
			reason: `${changed.size} changed inputs; ${files.length} of ${tests.length} test files, including architecture checks`,
		};
	} catch (error) {
		return full(`dependency analysis unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}

	function snapshot(ref: string): Snapshot {
		const entries = new Map<string, string>();
		for (const record of split(git(['ls-tree', '-r', '-z', ref]))) {
			const tab = record.indexOf('\t');
			const [, kind, oid] = record.slice(0, tab).split(' ');
			if (kind === 'blob') entries.set(record.slice(tab + 1), oid);
		}
		const ids = [...new Set([...entries].filter(([path]) => /\.(?:[cm]?[jt]sx?|json)$/u.test(path)).map(([, oid]) => oid))];
		const contents = git(['cat-file', '--batch'], ids.join('\n') + '\n');
		const blobs = new Map<string, string>();
		let offset = 0;
		for (const oid of ids) {
			const end = contents.indexOf(10, offset);
			const [actual, kind, size] = contents.subarray(offset, end).toString().split(' ');
			const length = Number(size);
			if (actual !== oid || kind !== 'blob' || !Number.isSafeInteger(length) || length < 0 || end < offset || end + length + 1 >= contents.length)
				throw new Error('incomplete Git source snapshot');
			offset = end + 1;
			blobs.set(oid, contents.subarray(offset, offset + length).toString());
			offset += length + 1;
		}
		return {
			paths: new Set(entries.keys()),
			read(path) {
				const contents = blobs.get(entries.get(path) ?? '');
				if (contents === undefined) throw new Error(`source missing from snapshot: ${path}`);
				return contents;
			},
		};
	}
}
