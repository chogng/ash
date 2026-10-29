import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

/** Versioned allowlist shared by the portable compiler and SDK declarations. */
export interface EditorClientApi {
	readonly apiVersion: 1;
	readonly modules: Record<string, readonly string[]>;
	readonly types: readonly string[];
}

const typeModules = [
	'base/browser/contextmenu.js',
	'editor/common/core/2d/dimension.js',
	'editor/common/core/textChange.js',
	'workbench/common/editor.js',
	'workbench/services/documentCollaboration/common/documentCollaborationService.js',
	'workbench/services/documentEditor/browser/documentEditorProfile.js',
	'workbench/services/documentEditor/common/documentCodec.js',
];

/** Derive runtime bindings from the actual host; never maintain a second runtime export list. */
export async function readEditorClientApi(repository: string): Promise<EditorClientApi> {
	const host = resolve(repository, 'src/ash/workbench/services/extensions/browser/editorClientHost.ts');
	const source = ts.createSourceFile(host, await readFile(host, 'utf8'), ts.ScriptTarget.Latest, true);
	const modules: Record<string, string[]> = {};
	for (const statement of source.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier) ||
			statement.moduleSpecifier.text.endsWith('.css')
		)
			continue;
		const binding = statement.importClause?.namedBindings;
		if (!binding || !ts.isNamedImports(binding)) throw new Error('Editor host bindings must be named imports');
		const key = relative(
			resolve(repository, 'src/ash'),
			resolve(dirname(host), statement.moduleSpecifier.text),
		).replaceAll('\\', '/');
		modules[key] = binding.elements.map(element => (element.propertyName ?? element.name).text);
	}
	return { apiVersion: 1, modules, types: typeModules };
}

export function validateEditorClientApi(value: unknown): EditorClientApi {
	const api = value as EditorClientApi;
	if (
		!api ||
		api.apiVersion !== 1 ||
		!api.modules ||
		typeof api.modules !== 'object' ||
		Array.isArray(api.modules) ||
		!Array.isArray(api.types)
	)
		throw new Error('Unsupported editor client API');
	for (const key of [...Object.keys(api.modules), ...api.types]) {
		if (
			typeof key !== 'string' ||
			!/^[a-zA-Z0-9_./-]+\.js$/u.test(key) ||
			key.split('/').some((part: string) => !part || part === '.' || part === '..')
		)
			throw new Error('Invalid editor API module');
	}
	for (const names of Object.values(api.modules)) {
		if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !/^[A-Za-z_$][\w$]*$/u.test(name)))
			throw new Error('Invalid editor API binding');
	}
	return api;
}
