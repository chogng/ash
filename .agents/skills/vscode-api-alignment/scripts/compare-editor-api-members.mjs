import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '../../../../app-ts/node_modules/typescript/lib/typescript.js';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const ashEditorRoot = resolve(repositoryRoot, 'app-ts/src/ash/editor');
const vscodeEditorRoot = resolve(repositoryRoot, '../vscode/src/vs/editor');
const ledgerPath = resolve(ashEditorRoot, 'api-alignment-status.md');
const sourceCache = new Map();
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const ledger = readFileSync(ledgerPath, 'utf8');
	const declarations = readDeclarations(ledger, '尚未补齐的同名契约');
	const results = declarations.map(({ file, declaration }) => compareDeclaration(file, declaration)).sort((left, right) => {
		const difference = value => value.missing.length + value.extra.length;
		return difference(left) - difference(right) || left.file.localeCompare(right.file) || left.declaration.localeCompare(right.declaration);
	});

	for (const result of results) {
		const differenceCount = result.missing.length + result.extra.length;
		process.stdout.write(`${String(differenceCount).padStart(3)} ${result.file}::${result.declaration} [${result.kind}]\n`);
		if (result.missing.length > 0) process.stdout.write(`    missing: ${result.missing.join(', ')}\n`);
		if (result.extra.length > 0) process.stdout.write(`    extra:   ${result.extra.join(', ')}\n`);
	}
}

function compareDeclaration(file, declaration) {
	const localFile = resolve(ashEditorRoot, file);
	const upstreamFile = resolve(vscodeEditorRoot, file);
	if (!existsSync(localFile) || !existsSync(upstreamFile)) {
		return {
			file,
			declaration,
			kind: !existsSync(localFile) ? 'missing-local-file' : 'missing-upstream-file',
			missing: [],
			extra: [],
		};
	}
	const local = readDeclaration(localFile, declaration, ashEditorRoot);
	const upstream = readDeclaration(upstreamFile, declaration, vscodeEditorRoot);
	if (!local || !upstream) {
		return {
			file,
			declaration,
			kind: !local ? 'missing-local-declaration' : 'missing-upstream-declaration',
			missing: [],
			extra: [],
		};
	}
	const missing = upstream.declaredMembers.filter(member => !local.members.includes(member));
	const extra = local.declaredMembers.filter(member => !upstream.declaredMembers.includes(member));
	return { file, declaration, kind: `${local.kind}/${upstream.kind}`, missing, extra };
}

export function readDeclaration(file, declarationName, editorRoot = dirname(file)) {
	const source = readSource(file);
	const declarations = source.statements
		.filter(node => hasName(node, declarationName))
		.map(node => ({
			kind: ts.SyntaxKind[node.kind],
			declaredMembers: readDeclaredMembers(node),
			members: readMembers(node, file, source, editorRoot, new Set([`${file}::${declarationName}`])),
		}));
	const preferred = declarations.filter(declaration => declaration.kind !== 'VariableDeclaration');
	const candidates = preferred.length > 0 ? preferred : declarations;
	if (candidates.length !== 1) return undefined;
	return candidates[0];
}

function hasName(node, name) {
	if (!('name' in node) || !node.name) return false;
	return node.name.getText() === name;
}

function readMembers(node, file, source, editorRoot, seen) {
	const directMembers = readDeclaredMembers(node);
	const inheritedMembers = ts.isClassDeclaration(node)
		? readInheritedMembers(node, file, source, editorRoot, seen)
		: [];
	return [...new Set([...directMembers, ...inheritedMembers])].sort();
}

function readDeclaredMembers(node) {
	if (ts.isFunctionDeclaration(node)) return [`(${node.parameters.length})`];
	if (ts.isVariableDeclaration(node)) return readObjectMembers(node.initializer);
	if (!('members' in node) || !node.members) return [];
	return node.members.filter(member => !hasModifier(member, ts.SyntaxKind.PrivateKeyword)).flatMap(member => {
		const name = memberName(member);
		if (!ts.isConstructorDeclaration(member)) return name ? [name] : [];
		const properties = member.parameters
			.filter(parameter => ts.isParameterPropertyDeclaration(parameter, member) && !hasModifier(parameter, ts.SyntaxKind.PrivateKeyword))
			.map(parameter => parameter.name.getText());
		return [name, ...properties];
	}).filter(Boolean).sort();
}

function readInheritedMembers(node, file, source, editorRoot, seen) {
	const heritage = node.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword);
	if (!heritage || heritage.types.length !== 1) return [];
	const resolved = resolveHeritageDeclaration(heritage.types[0].expression, file, source, editorRoot);
	if (!resolved) return [];
	const key = `${resolved.file}::${resolved.node.name?.getText() ?? ''}`;
	if (seen.has(key)) return [];
	seen.add(key);
	return readMembers(resolved.node, resolved.file, resolved.source, editorRoot, seen)
		.filter(member => member !== 'constructor');
}

function resolveHeritageDeclaration(expression, file, source, editorRoot) {
	if (!ts.isIdentifier(expression)) return undefined;
	const local = source.statements.find(node => ts.isClassDeclaration(node) && hasName(node, expression.text));
	if (local) return { file, source, node: local };

	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		if (!statement.moduleSpecifier.text.startsWith('.')) continue;
		const importedName = importedDeclarationName(statement, expression.text);
		if (!importedName) continue;
		const importedFile = resolveImportedFile(file, statement.moduleSpecifier.text);
		if (!importedFile || !isWithin(importedFile, editorRoot)) return undefined;
		const importedSource = readSource(importedFile);
		const imported = importedSource.statements.find(node => ts.isClassDeclaration(node) && hasName(node, importedName));
		if (imported) return { file: importedFile, source: importedSource, node: imported };
	}
	return undefined;
}

function importedDeclarationName(statement, localName) {
	const clause = statement.importClause;
	if (!clause) return undefined;
	if (clause.name?.text === localName) return 'default';
	if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return undefined;
	const element = clause.namedBindings.elements.find(candidate => candidate.name.text === localName);
	return element ? element.propertyName?.text ?? element.name.text : undefined;
}

function resolveImportedFile(containingFile, specifier) {
	const base = resolve(dirname(containingFile), specifier);
	const candidates = [
		base,
		base.replace(/\.js$/u, '.ts'),
		`${base}.ts`,
		resolve(base, 'index.ts'),
	];
	return candidates.find(candidate => existsSync(candidate));
}

function isWithin(file, root) {
	const path = relative(resolve(root), resolve(file));
	return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function readSource(file) {
	let source = sourceCache.get(file);
	if (!source) {
		source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		sourceCache.set(file, source);
	}
	return source;
}

function hasModifier(node, kind) {
	return node.modifiers?.some(modifier => modifier.kind === kind) ?? false;
}

function readObjectMembers(initializer) {
	if (!initializer || !ts.isObjectLiteralExpression(initializer)) return [];
	return initializer.properties.map(memberName).filter(Boolean).sort();
}

function memberName(member) {
	if (ts.isConstructorDeclaration(member)) return 'constructor';
	if (!('name' in member) || !member.name) return undefined;
	return member.name.getText();
}

function readDeclarations(markdown, heading) {
	const start = markdown.indexOf(`## ${heading}`);
	if (start < 0) throw new Error(`Missing ledger heading: ${heading}`);
	const sectionStart = markdown.indexOf('\n', start);
	const nextHeading = markdown.indexOf('\n## ', sectionStart + 1);
	const section = markdown.slice(sectionStart, nextHeading < 0 ? markdown.length : nextHeading);
	const result = [];
	for (const line of section.split(/\r?\n/u)) {
		if (!line.startsWith('| `')) continue;
		const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
		if (cells.length < 2) continue;
		const file = unwrapCode(cells[0]);
		for (const declaration of cells[1].split('、').map(unwrapCode)) result.push({ file, declaration });
	}
	return result;
}

function unwrapCode(value) {
	return value.startsWith('`') && value.endsWith('`') ? value.slice(1, -1) : value;
}
