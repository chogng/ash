import { builtinModules } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const environments = new Set([
	'common',
	'browser',
	'worker',
	'node',
	'electron-browser',
	'electron-main',
	'electron-utility',
]);
const webEnvironments = new Set(['common', 'browser', 'worker', 'electron-browser']);
const nodeModules = new Set(builtinModules.map(name => name.replace(/^node:/u, '')));
const hostGlobals = new Set([
	'process',
	'Buffer',
	'require',
	'module',
	'exports',
	'__filename',
	'__dirname',
	'setImmediate',
	'clearImmediate',
	'global',
	'NodeJS',
	'Electron',
]);
// These are separately compiled sandbox scripts; ordinary renderer code uses their bridges.
const preloads = new Set([
	'base/parts/sandbox/electron-browser/preload.cts',
	'platform/browserView/electron-browser/preload-browserView.ts',
]);

interface ILayerViolation {
	readonly fileName: string;
	readonly line: number;
	readonly character: number;
	readonly message: string;
}

function environmentFor(path: string): string {
	if (path.endsWith('WorkerMain.ts') || path.includes('.worker.')) return 'worker';
	const environment = path.split('/').find(part => environments.has(part));
	if (environment) return environment;
	if (path.includes('.desktop.main')) return 'electron-browser';
	return path === 'nls.ts' ? 'common' : 'browser';
}

function importedModule(node: ts.Node): ts.StringLiteralLike | undefined {
	if (
		(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
		node.moduleSpecifier &&
		ts.isStringLiteralLike(node.moduleSpecifier)
	)
		return node.moduleSpecifier;
	if (
		ts.isImportEqualsDeclaration(node) &&
		ts.isExternalModuleReference(node.moduleReference) &&
		node.moduleReference.expression &&
		ts.isStringLiteralLike(node.moduleReference.expression)
	)
		return node.moduleReference.expression;
	if (
		ts.isImportTypeNode(node) &&
		ts.isLiteralTypeNode(node.argument) &&
		ts.isStringLiteralLike(node.argument.literal)
	)
		return node.argument.literal;
	if (
		ts.isCallExpression(node) &&
		(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
			(ts.isIdentifier(node.expression) && node.expression.text === 'require'))
	) {
		const argument = node.arguments[0];
		if (argument && ts.isStringLiteralLike(argument)) return argument;
	}
	return undefined;
}

/** Checks explicit runtime imports and native IPC references, including aliases and inferred receivers. */
export function checkLayers(tsconfigPath: string, sourceRoot: string): readonly ILayerViolation[] {
	const config = ts.getParsedCommandLineOfConfigFile(
		tsconfigPath,
		{ noEmit: true },
		{
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: diagnostic => {
				throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
			},
		},
	);
	if (!config || config.errors.length)
		throw new Error(
			config?.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n') ??
				`Cannot read ${tsconfigPath}`,
		);
	const files = ts.sys
		.readDirectory(sourceRoot, ['.ts', '.tsx', '.cts', '.mts'], ['**/test/**', '**/fixtures/**'], ['**/*'])
		.sort();
	if (files.length === 0) throw new Error(`No production TypeScript sources in ${sourceRoot}`);
	const program = ts.createProgram(files, config.options);
	const checker = program.getTypeChecker();
	const contractPath = resolve(sourceRoot, 'platform/ipc/common/mainProcessService.ts');
	const contract = program.getSourceFile(contractPath);
	const moduleSymbol = contract && checker.getSymbolAtLocation(contract);
	const nativeIPC =
		moduleSymbol && checker.getExportsOfModule(moduleSymbol).find(symbol => symbol.name === 'IMainProcessService');
	if (!nativeIPC) throw new Error(`Missing IMainProcessService contract: ${contractPath}`);
	const nativeTypes = new Map<ts.Type, boolean>();
	const violations: ILayerViolation[] = [];

	function isNativeType(type: ts.Type): boolean {
		const cached = nativeTypes.get(type);
		if (cached !== undefined) return cached;
		// Break recursive interface/type-argument cycles before following their dependencies.
		nativeTypes.set(type, false);
		let result = type.getSymbol() === nativeIPC || type.aliasSymbol === nativeIPC;
		if (!result && type.isUnionOrIntersection()) result = type.types.some(isNativeType);
		if (!result && type.aliasTypeArguments) result = type.aliasTypeArguments.some(isNativeType);
		if (!result && type.flags & ts.TypeFlags.Object) {
			const object = type as ts.ObjectType;
			if (object.objectFlags & ts.ObjectFlags.Reference)
				result = checker.getTypeArguments(object as ts.TypeReference).some(isNativeType);
			if (!result && object.objectFlags & (ts.ObjectFlags.Class | ts.ObjectFlags.Interface))
				result = checker.getBaseTypes(object as ts.InterfaceType).some(isNativeType);
		}
		nativeTypes.set(type, result);
		return result;
	}

	for (const source of program.getSourceFiles()) {
		const path = relative(sourceRoot, source.fileName).replaceAll('\\', '/');
		if (
			isAbsolute(path) ||
			path === '..' ||
			path.startsWith('../') ||
			path.split('/').some(part => part === 'test' || part === 'fixtures')
		)
			continue;
		const environment = environmentFor(path);
		const restrictNativeIPC = ['common', 'browser', 'worker'].includes(environment) && source !== contract;
		const restrictHostGlobals = webEnvironments.has(environment) && !preloads.has(path);
		const report = (node: ts.Node, message: string): void => {
			const position = source.getLineAndCharacterOfPosition(node.getStart(source));
			violations.push({
				fileName: source.fileName,
				line: position.line + 1,
				character: position.character + 1,
				message,
			});
		};
		function visit(node: ts.Node): void {
			const specifier = importedModule(node);
			if (specifier && webEnvironments.has(environment)) {
				const name = specifier.text;
				if (
					name.startsWith('node:') ||
					nodeModules.has(name) ||
					((name === 'electron' || name.startsWith('electron/')) && !preloads.has(path))
				) {
					report(specifier, `Module '${name}' is unavailable in the ${environment} layer.`);
				}
				const target = checker.getSymbolAtLocation(specifier)?.declarations?.find(ts.isSourceFile);
				if (target) {
					const targetPath = relative(sourceRoot, target.fileName).replaceAll('\\', '/');
					if (
						!isAbsolute(targetPath) &&
						!targetPath.startsWith('../') &&
						['node', 'electron-main', 'electron-utility'].includes(environmentFor(targetPath))
					) {
						report(specifier, `Host module '${name}' is unavailable in the ${environment} layer.`);
					}
				}
			}
			if (ts.isIdentifier(node) && (restrictNativeIPC || restrictHostGlobals)) {
				let symbol = checker.getSymbolAtLocation(node);
				if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
				if (restrictNativeIPC && symbol === nativeIPC)
					report(
						node,
						`IMainProcessService is only available to Electron host adapters, not ${environment} code.`,
					);
				// Dependencies can bring Node globals into an otherwise isolated browser compilation.
				// Resolve their origin so a same-named local variable or property remains legal.
				if (
					restrictHostGlobals &&
					hostGlobals.has(node.text) &&
					symbol?.declarations?.some(declaration =>
						/\/node_modules\/(?:@types\/node|electron)\//u.test(
							declaration.getSourceFile().fileName.replaceAll('\\', '/'),
						),
					)
				) {
					report(node, `Host global '${node.text}' is unavailable in the ${environment} layer.`);
				}
			} else if (
				restrictNativeIPC &&
				(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
				isNativeType(checker.getTypeAtLocation(node.expression))
			) {
				report(node, `Inferred IMainProcessService access is unavailable in the ${environment} layer.`);
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
	}
	return violations.sort(
		(left, right) =>
			left.fileName.localeCompare(right.fileName) || left.line - right.line || left.character - right.character,
	);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	try {
		if (process.argv.length !== 2) throw new Error('Usage: node build/checker/layersChecker.ts');
		const violations = checkLayers(
			resolve(repositoryRoot, 'tsconfig.renderer.json'),
			resolve(repositoryRoot, 'src/ash'),
		);
		for (const violation of violations)
			console.error(
				`${relative(repositoryRoot, violation.fileName)}:${violation.line}:${violation.character}: ${violation.message}`,
			);
		console.log(`Layer references: ${violations.length} violations.`);
		process.exitCode = violations.length ? 1 : 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
