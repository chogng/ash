import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import ts from 'typescript';
import { build, normalizePath, type Plugin } from 'vite';

const repositoryRoot = normalizePath(await realpath(resolve(import.meta.dirname, '../..')));
const hostFile = normalizePath(resolve(repositoryRoot, 'src/ash/workbench/services/extensions/browser/editorClientHost.ts'));
const sha256 = (bytes: string): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Independent client resources for a product-authorized editor package, without Ash business modules. */
export async function compileEditorClient(packageRoot: string): Promise<{ resources: Record<string, string>; client: Record<string, string | number>; }> {
	packageRoot = normalizePath(await realpath(resolve(packageRoot)));
	const hostSource = ts.createSourceFile(hostFile, await readFile(hostFile, 'utf8'), ts.ScriptTarget.Latest, true);
	const bindings = new Map<string, string[]>();
	for (const statement of hostSource.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		if (statement.moduleSpecifier.text.endsWith('.css')) continue;
		const binding = statement.importClause?.namedBindings;
		if (!binding || !ts.isNamedImports(binding)) throw new Error('Editor host bindings must be named imports');
		const path = normalizePath(resolve(dirname(hostFile), statement.moduleSpecifier.text)).replace(/\.js$/u, '.ts');
		bindings.set(path, binding.elements.map(element => (element.propertyName ?? element.name).text));
	}
	const inputs: string[] = [];
	async function collect(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = normalizePath(resolve(directory, entry.name));
			if (entry.isDirectory()) await collect(path);
			else if (entry.isFile() && /\.(?:ts|css)$/u.test(path)) inputs.push(path);
		}
	}
	await collect(resolve(packageRoot, 'browser'));
	await collect(resolve(packageRoot, 'common'));
	inputs.sort();
	const sourceDigest = sha256((await Promise.all(inputs.map(async path => `${relative(packageRoot, path).replaceAll('\\', '/')}\0${await readFile(path, 'utf8')}\0`))).join(''));
	// Vite owns its PostCSS version; resolve that dependency rather than adding a second compiler.
	const require = createRequire(import.meta.url);
	const postcss = require(createRequire(require.resolve('vite/package.json')).resolve('postcss')) as { parse(css: string): { walkRules(visitor: (rule: { parent?: { type: string; name?: string; }; selectors: string[]; }) => void): void; toString(): string; }; };
	const hostId = (path: string): string => relative(resolve(repositoryRoot, 'src/ash'), path).replaceAll('\\', '/').replace(/\.ts$/u, '.js');
	const assertClientSource = (id: string): string => {
		const path = normalizePath(id).split('?')[0];
		if (isAbsolute(path) && !path.startsWith(packageRoot + '/')) throw new Error(`Editor client dependency escapes its package: ${path}`);
		if (path.startsWith(packageRoot + '/') && path !== `${packageRoot}/package.json` && !/\.(?:ts|css)$/u.test(path)) {
			throw new Error(`Editor client source is outside its TS/CSS contract: ${path}`);
		}
		return path;
	};
	const plugin: Plugin = {
		name: 'ash-editor-client-boundary',
		enforce: 'pre',
		async resolveId(source, importer) {
			if (!importer) return;
			if (!source.startsWith('.') && !isAbsolute(source)) throw new Error(`Unsupported editor client dependency: ${source}`);
			const path = normalizePath(resolve(dirname(normalizePath(importer).split('?')[0]), source)).replace(/\.js$/u, '.ts');
			if (path.startsWith(normalizePath(resolve(repositoryRoot, 'src')) + '/')) {
				if (['base/browser/ui/selectbox/selectbox.css', 'base/browser/ui/dropdown/dropdown.css'].includes(normalizePath(relative(resolve(repositoryRoot, 'src/ash'), path)))) return '\0ash-editor-host-style';
				if (!bindings.has(path)) throw new Error(`Editor client import is outside its host contract: ${source}`);
				return { id: `ash-editor-host:${hostId(path)}`, external: true };
			}
			if (!path.startsWith(packageRoot + '/')) throw new Error(`Editor client dependency escapes its package: ${source}`);
		},
		load(id) {
			if (id === '\0ash-editor-host-style') return '';
			assertClientSource(id);
		},
		transform(code, id) {
			id = assertClientSource(id);
			if (!id.startsWith(packageRoot + '/') || !id.endsWith('.ts')) return;
			const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);
			const rejectDynamicImports = (node: ts.Node): void => {
				if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error('Editor clients must use closed static dependencies');
				ts.forEachChild(node, rejectDynamicImports);
			};
			rejectDynamicImports(source);
			for (const statement of source.statements) {
				if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
				const path = normalizePath(resolve(dirname(id), statement.moduleSpecifier.text)).replace(/\.js$/u, '.ts');
				const names = bindings.get(path);
				if (!names) continue;
				const imported = statement.importClause?.namedBindings;
				if (!imported || !ts.isNamedImports(imported) || statement.importClause?.name) throw new Error('Editor host imports must use named bindings');
				for (const element of imported.elements) {
					if (!element.isTypeOnly && !names.includes((element.propertyName ?? element.name).text)) throw new Error(`Unsupported editor host binding: ${element.name.text}`);
				}
			}
		},
	};
	const output = await build({
		configFile: false, logLevel: 'error', plugins: [plugin],
		build: {
			write: false, minify: true, assetsInlineLimit: Infinity,
			lib: { entry: resolve(packageRoot, 'browser/editor.ts'), formats: ['iife'], name: 'editorClient' },
			rolldownOptions: { output: { globals: id => `host[${JSON.stringify(id.slice('ash-editor-host:'.length))}]` } },
		},
	});
	const outputs = Array.isArray(output) ? output.flatMap(value => value.output) : 'output' in output ? output.output : [];
	const chunks = outputs.filter(file => file.type === 'chunk');
	if (chunks.length !== 1 || chunks[0].dynamicImports.length !== 0 || chunks[0].imports.some(id => !id.startsWith('ash-editor-host:'))) throw new Error('Editor clients must be a single closed module');
	const script = `export function createEditorModule(host) {\n${chunks[0].code}\nreturn editorClient;\n}\n`;
	const css = outputs.flatMap(file => file.type === 'asset' && file.fileName.endsWith('.css') ? [String(file.source)] : []).join('\n');
	const sheet = postcss.parse(css);
	const scope = `:where([data-ash-editor-client="${sourceDigest}"])`;
	sheet.walkRules(rule => {
		if (rule.parent?.type === 'rule') return;
		if (rule.parent?.type === 'atrule' && /keyframes$/u.test(rule.parent.name ?? '')) return;
		rule.selectors = rule.selectors.map(selector => `${scope} ${selector}`);
	});
	const style = sheet.toString();
	return {
		resources: { 'dist/editor.js': script, 'dist/editor.css': style },
		client: { apiVersion: 1, entry: 'dist/editor.js', digest: sha256(script), style: 'dist/editor.css', styleDigest: sha256(style), sourceDigest },
	};
}
