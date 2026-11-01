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
export function planAffectedTests(root: string, base: string, tests: readonly string[], options: { head?: string; preloads?: readonly string[]; } = {}): TestPlan {
	const git = (args: string[], input?: string): Buffer => execFileSync('git', args, {
		cwd: root, input, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
	});
	// Resolve user input before it can become an option to another Git command.
	const revision = git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).toString().trim();
	const target = options.head ? git(['rev-parse', '--verify', '--end-of-options', `${options.head}^{commit}`]).toString().trim() : undefined;
	const comparison = git(['merge-base', revision, target ?? 'HEAD']).toString().trim();
	const split = (value: Buffer): string[] => value.toString().split('\0').filter(Boolean);
	const changed = new Set(split(git(['diff', '--name-only', '--no-renames', '-z', comparison, ...(target ? [target] : []), '--'])));
	if (!target) for (const path of split(git(['ls-files', '--others', '--exclude-standard', '-z']))) changed.add(path);
	const full = (reason: string): TestPlan => ({ files: tests, full: true, reason });
	if (changed.size === 0) return { files: [], full: false, reason: 'no changed inputs' };
	// Documentation can still be read by opaque filesystem tests below. Markdown
	// fixtures remain unknown inputs, rather than being dismissed as documentation.
	const documentation = (path: string): boolean => path.endsWith('.md') && !/(?:^|\/)(?:test|tests|fixtures|test-data|testData|__snapshots__)(?:\/|$)/u.test(path);
	// The dependency graph cannot describe toolchains, generated contracts, preload code,
	// packages or test data loaded through arbitrary filesystem paths.
	const outside = [...changed].find(path => /(?:^|\/)(?:package(?:-lock)?|tsconfig[^/]*)\.json$/u.test(path)
		|| (!documentation(path) && !/^(?:src\/|extensions\/).*\.(?:[cm]?tsx?|[cm]?jsx?|css|json)$/u.test(path)));
	if (outside) return full(`input outside the source graph: ${outside}`);

	// Git object IDs identify immutable contents across both graphs. Share their
	// text and preprocessing work without sharing snapshot-specific resolution.
	const blobs = new Map<string, string>();
	const sourceFacts = new Map<string, { text: string; facts: ts.PreProcessedFileInfo; }>();
	try {
		const before = snapshot(comparison);
		const deleted = target ? new Set<string>() : new Set(split(git(['ls-files', '--deleted', '-z'])));
		const after = target ? snapshot(target) : {
			paths: new Set(split(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).filter(path => !deleted.has(path))),
			read: (path: string) => readFileSync(resolve(root, path), 'utf8'),
		};
		const sources = tests.map(path => path.replace(/\.js$/u, '.ts'));
		const affected = new Set<string>();
		const reached = new Set<string>();
		// Narrow only edits whose module initialization and import surface are
		// unchanged. Everything else keeps the existing file-level propagation.
		const declarations = new Map<string, ReadonlySet<string>>();
		for (const file of changed) {
			if (!/\.[cm]?[jt]sx?$/u.test(file) || !before.paths.has(file) || !after.paths.has(file)) continue;
			const names = changedExports(file, before.read(file), after.read(file));
			if (names) declarations.set(file, names);
		}
		for (const tree of [before, after]) {
			const config = JSON.parse(tree.read('tsconfig.base.json'));
			const compiler = ts.convertCompilerOptionsFromJson(config.compilerOptions ?? {}, root);
			if (compiler.errors.length) throw new Error('cannot resolve compiler options');
			const local = (path: string): string => relative(root, path).replaceAll('\\', '/');
			const host: ts.ModuleResolutionHost = {
				getCurrentDirectory: () => root,
				fileExists: path => tree.paths.has(local(path)),
				readFile: path => tree.paths.has(local(path)) ? tree.read(local(path)) : undefined,
			};
			const cache = ts.createModuleResolutionCache(root, path => path, compiler.options);
			const importers = new Map<string, Set<string>>();
			const referencesByEdge = new Map<string, Set<string>>();
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
				let cached = sourceFacts.get(file);
				if (cached?.text !== text) {
					cached = { text, facts: ts.preProcessFile(text, true, true) };
					sourceFacts.set(file, cached);
				}
				const facts = cached.facts;
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
					if (!parents) importers.set(target, parents = new Set());
					parents.add(file);
					const edge = `${target}\0${file}`;
					let specifiers = referencesByEdge.get(edge);
					if (!specifiers) referencesByEdge.set(edge, specifiers = new Set());
					specifiers.add(reference);
					pending.push(target);
				}
			}
			const seen = dependents(changed);
			for (const file of seen) if (visited.has(file)) reached.add(file);
			if ([...preloads].some(file => seen.has(file))) return full('a shared test preload is affected');
			// Rendered pages, filesystem readers and computed loads have dependencies
			// outside import edges. Keep their tests even for a seemingly unrelated edit.
			const uncertain = dependents(opaque);
			const selected = dependents(changed, true);
			for (const file of sources) if (selected.has(file) || uncertain.has(file)) affected.add(file);

			function dependents(seeds: Iterable<string>, narrow = false): Set<string> {
				const queue = [...seeds].map(file => ({ file, names: narrow ? declarations.get(file) : undefined }));
				const seen = new Set<string>();
				const processed = new Set<string>();
				while (queue.length) {
					const { file, names } = queue.pop()!;
					// A dependency edit reaching this same file must upgrade its own
					// declaration slice to the complete module, irrespective of queue order.
					const key = `${file}\0${names ? 'slice' : 'file'}`;
					if (processed.has(key)) continue;
					processed.add(key);
					seen.add(file);
					for (const parent of importers.get(file) ?? []) {
						if (names && !importsChangedExport(parent, tree.read(parent), referencesByEdge.get(`${file}\0${parent}`)!, names)) continue;
						queue.push({ file: parent, names: undefined });
					}
				}
				return seen;
			}
		}
		const unknown = [...changed].find(path => !documentation(path) && !reached.has(path));
		if (unknown) return full(`no known test dependency for: ${unknown}`);
		// Architecture tests inspect source text and directories instead of importing the
		// implementation, so runtime or type import edges cannot select them reliably.
		const files = tests.filter((path, index) => affected.has(sources[index]) || path.startsWith('test/architecture/'));
		return { files, full: false, reason: `${changed.size} changed inputs; ${files.length} of ${tests.length} test files, including architecture checks${declarations.size ? `; declaration slices in ${declarations.size} files` : ''}` };
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
		const ids = [...new Set([...entries].filter(([path, oid]) => /\.(?:[cm]?[jt]sx?|json)$/u.test(path) && !blobs.has(oid)).map(([, oid]) => oid))];
		const contents = ids.length ? git(['cat-file', '--batch'], ids.join('\n') + '\n') : Buffer.alloc(0);
		let offset = 0;
		for (const oid of ids) {
			const end = contents.indexOf(10, offset);
			const [actual, kind, size] = contents.subarray(offset, end).toString().split(' ');
			const length = Number(size);
			if (actual !== oid || kind !== 'blob' || !Number.isSafeInteger(length) || length < 0 || end < offset || end + length + 1 >= contents.length) throw new Error('incomplete Git source snapshot');
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

/**
 * A conservative declaration slice, including type references. Unchanged imports,
 * declaration order and all load-time code are prerequisites, not purity guesses.
 * Classes, mutable state and executable initializers reached by an edit fall back
 * to the file graph. Identifier references deliberately over-approximate binding
 * (including shadowed names and property names) rather than risk dropping an edge.
 */
function changedExports(file: string, before: string, after: string): ReadonlySet<string> | undefined {
	if (before === after) return new Set();
	const deferredOrLiteral = (value: ts.Expression | undefined): boolean => !!value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)
		|| ts.isStringLiteral(value) || ts.isNumericLiteral(value) || value.kind === ts.SyntaxKind.TrueKeyword
		|| value.kind === ts.SyntaxKind.FalseKeyword || value.kind === ts.SyntaxKind.NullKeyword);
	const parse = (text: string) => {
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
		// preprocess alone accepts malformed files; declaration selection must not.
		if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[]; }).parseDiagnostics.length) throw new Error(`cannot parse ${file}`);
		const records = [];
		for (const statement of source.statements) {
			const names: string[] = [];
			const exports = new Map<string, string>();
			let passive = false;
			if (ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
				if (!statement.name) return undefined;
				names.push(statement.name.text);
				passive = ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
				if (!passive) {
					// An unchanged class may coexist with a function edit, but evaluating
					// heritage, decorators, computed keys or arbitrary static code can
					// observe that function without a local identifier reference.
					if (!ts.isClassDeclaration(statement) || statement.heritageClauses?.some(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)
						|| statement.members.some(member => ts.isClassStaticBlockDeclaration(member) || (member.name && ts.isComputedPropertyName(member.name))
							|| (ts.isPropertyDeclaration(member) && ts.getModifiers(member)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)
								&& member.initializer && !deferredOrLiteral(member.initializer)))) return undefined;
				}
			} else if (ts.isVariableStatement(statement)) {
				for (const declaration of statement.declarationList.declarations) {
					if (!ts.isIdentifier(declaration.name)) return undefined;
					names.push(declaration.name.text);
				}
				passive = !!(statement.declarationList.flags & ts.NodeFlags.Const) && statement.declarationList.declarations.every(declaration => deferredOrLiteral(declaration.initializer));
				if (!passive) return undefined;
			} else if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
				passive = true;
				for (const entry of statement.exportClause.elements) exports.set(entry.name.text, (entry.propertyName ?? entry.name).text);
			} else if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) {
				// Unknown load-time work stays file-level even if its source is
				// unchanged: it may inspect exports through an external callback.
				return undefined;
			}
			if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
				const isDefault = ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);
				for (const name of names) exports.set(isDefault ? 'default' : name, name);
			}
			const references = new Set<string>();
			let reflective = false;
			const visit = (node: ts.Node): void => {
				if (ts.isDecorator(node)) reflective = true;
				if (ts.isIdentifier(node)) {
					references.add(node.text);
					// These can refer to local declarations without an identifier edge.
					if (node.text === 'eval' || node.text === 'Function') reflective = true;
				}
				ts.forEachChild(node, visit);
			};
			visit(statement);
			if (reflective) return undefined;
			records.push({ names, exports, references, passive, text: statement.getText(source), kind: statement.kind });
		}
		return records;
	};
	const old = parse(before);
	const current = parse(after);
	if (!old || !current || old.length !== current.length) return undefined;
	const changed = new Set<string>();
	for (let index = 0; index < current.length; index++) {
		const a = old[index];
		const b = current[index];
		if (a.kind !== b.kind || a.names.join('\0') !== b.names.join('\0')) return undefined;
		if (a.text === b.text) continue;
		if (!a.passive || !b.passive || b.names.length === 0) return undefined;
		for (const name of b.names) changed.add(name);
	}
	// Both versions matter when an edit removes a reference to a changed helper.
	let grew = true;
	while (grew) {
		grew = false;
		for (const record of [...old, ...current]) {
			if (![...record.references].some(name => changed.has(name))) continue;
			if (!record.passive) return undefined;
			for (const name of record.names) if (!changed.has(name)) { changed.add(name); grew = true; }
		}
	}
	const exports = new Set<string>();
	for (const record of [...old, ...current]) for (const [name, local] of record.exports) if (changed.has(local)) exports.add(name);
	return exports;
}

function importsChangedExport(file: string, text: string, specifiers: ReadonlySet<string>, names: ReadonlySet<string>): boolean {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
	if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[]; }).parseDiagnostics.length) throw new Error(`cannot parse ${file}`);
	const matched = new Set<string>();
	let wholeModule = source.referencedFiles.some(reference => specifiers.has(reference.fileName));
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
			const argument = node.arguments[0];
			if (argument && ts.isStringLiteral(argument) && specifiers.has(argument.text)) wholeModule = true;
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	if (wholeModule) return true;
	for (const statement of source.statements) {
		if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const specifier = statement.moduleSpecifier.text;
		if (!specifiers.has(specifier)) continue;
		matched.add(specifier);
		if (ts.isImportDeclaration(statement)) {
			const clause = statement.importClause;
			if (!clause || (clause.name && names.has('default'))) return true;
			const bindings = clause.namedBindings;
			if (bindings && (!ts.isNamedImports(bindings) || bindings.elements.some(entry => names.has((entry.propertyName ?? entry.name).text)))) return true;
		} else {
			const bindings = statement.exportClause;
			if (!bindings || !ts.isNamedExports(bindings) || bindings.elements.some(entry => names.has((entry.propertyName ?? entry.name).text))) return true;
		}
	}
	// require(), dynamic imports, triple-slash references and preload conventions
	// have no statically named import clause and retain their file-level edge.
	return [...specifiers].some(specifier => !matched.has(specifier));
}
