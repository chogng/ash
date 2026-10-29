import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'mocha';
import ts from 'typescript';
import { findDesktopRoot } from './testPaths.js';

const desktopRoot = findDesktopRoot(import.meta.dirname);
const sourceRoot = resolve(desktopRoot, 'src/ash');
// Tasks keeps its shared domain API with the contribution, not in a second services owner.
const taskContracts = [
	join(sourceRoot, 'workbench/contrib/tasks/common/taskService.ts'),
	join(sourceRoot, 'workbench/contrib/tasks/common/tasks.ts'),
	join(sourceRoot, 'workbench/contrib/tasks/common/problemMatcher.ts'),
];

test('Base and Platform production imports preserve the layer direction', () => {
	const violations: string[] = [];
	const baseRoot = join(sourceRoot, 'base');
	// NLS is a shared root entry point used by every frontend layer.
	const nlsRoot = join(sourceRoot, 'nls.ts');
	assert.equal(existsSync(nlsRoot), true, 'shared NLS root');
	assert.equal(existsSync(join(baseRoot, 'common/nls.ts')), false, 'NLS has one root owner');
	for (const target of localImports(nlsRoot)) {
		if (!target.startsWith(`${baseRoot}${sep}`)) violations.push(`${sourceName(nlsRoot)} -> ${sourceName(target)}`);
	}
	for (const file of productionTypeScriptFiles(join(sourceRoot, 'base'))) {
		for (const target of localImports(file)) {
			if (target.startsWith(sourceRoot) && target !== nlsRoot && !target.startsWith(`${baseRoot}${sep}`))
				violations.push(`${sourceName(file)} -> ${sourceName(target)}`);
		}
	}
	for (const file of productionTypeScriptFiles(join(sourceRoot, 'platform'))) {
		for (const target of localImports(file)) {
			if (
				target.startsWith(join(sourceRoot, 'workbench')) ||
				target.startsWith(join(sourceRoot, 'editor')) ||
				target.startsWith(join(sourceRoot, 'code'))
			)
				violations.push(`${sourceName(file)} -> ${sourceName(target)}`);
		}
	}
	assert.deepEqual(violations, []);
});

test('Workbench services do not depend on contribution implementations', () => {
	const contributionRoot = join(sourceRoot, 'workbench/contrib');
	// Debug and Tasks own cross-feature contracts in their contribution's common layer.
	// Admit these exact public entry points, never their browser implementations.
	const contracts = new Set([join(contributionRoot, 'debug/common/debug.ts'), ...taskContracts]);
	const violations = productionTypeScriptFiles(join(sourceRoot, 'workbench/services')).flatMap(file =>
		localImports(file)
			.filter(target => target.startsWith(contributionRoot) && !contracts.has(target))
			.map(target => `${sourceName(file)} -> ${sourceName(target)}`),
	);
	assert.deepEqual(violations, []);
});

test('Feature settings cross the Preferences boundary as data, never renderer implementations', () => {
	const contributions = join(sourceRoot, 'workbench/contrib');
	const preferences = join(contributions, 'preferences/browser');
	const dataContract = join(preferences, 'settingsTreeModels.ts');
	const violations: string[] = [];
	for (const file of productionTypeScriptFiles(contributions)) {
		if (file.startsWith(join(contributions, 'preferences') + sep)) continue;
		for (const target of localImports(file)) {
			if (target.startsWith(preferences + sep) && target !== dataContract) {
				violations.push(`${sourceName(file)} -> ${sourceName(target)}`);
			}
		}
	}
	assert.deepEqual(violations, []);
	assert.doesNotMatch(readFileSync(dataContract, 'utf8'), /\b(?:HTMLElement|SettingsContentItem|titleDomNode)\b/);
});

test('Terminal and Tasks contracts cannot reach contribution implementations through type imports or re-exports', () => {
	const terminalRoot = join(sourceRoot, 'workbench/services/terminal');
	const contributionRoot = join(sourceRoot, 'workbench/contrib');
	const violations: string[] = [];
	for (const entry of [...productionTypeScriptFiles(terminalRoot), ...taskContracts]) {
		const contracts = new Set(taskContracts.includes(entry) ? taskContracts : []);
		const visited = new Set<string>();
		const visit = (file: string): void => {
			if (visited.has(file)) return;
			visited.add(file);
			for (const target of localImports(file)) {
				if (
					(target.startsWith(contributionRoot) && !contracts.has(target)) ||
					(entry.includes(`${sep}common${sep}`) && target.includes(`${sep}browser${sep}`))
				) {
					violations.push(`${sourceName(entry)} via ${sourceName(file)} -> ${sourceName(target)}`);
				} else if (target.startsWith(sourceRoot) && existsSync(target)) {
					visit(target);
				}
			}
		};
		visit(entry);
	}
	assert.deepEqual(violations, []);
});

test('Terminal and Tasks domain service identifiers have one owner', () => {
	const owners = new Map([
		['ITaskService', 'workbench/contrib/tasks/common/taskService.ts'],
		['ITerminalService', 'workbench/contrib/terminal/browser/terminal.ts'],
		['ITerminalProfileService', 'workbench/contrib/terminal/common/terminal.ts'],
		['ITerminalProfileResolverService', 'workbench/contrib/terminal/common/terminal.ts'],
	]);
	const declarations = new Map(
		[...owners.keys()].map(name => [
			name,
			{ identifiers: [] as string[], contracts: [] as string[], reexports: [] as string[] },
		]),
	);
	for (const file of productionTypeScriptFiles(sourceRoot)) {
		const source = ts.createSourceFile(
			file,
			readFileSync(file, 'utf8'),
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
		source.forEachChild(node => {
			if (ts.isInterfaceDeclaration(node)) declarations.get(node.name.text)?.contracts.push(sourceName(file));
			if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
				for (const exported of node.exportClause.elements)
					declarations.get(exported.name.text)?.reexports.push(sourceName(file));
			}
			if (
				ts.isExportDeclaration(node) &&
				!node.exportClause &&
				node.moduleSpecifier &&
				ts.isStringLiteral(node.moduleSpecifier)
			) {
				const target = resolve(dirname(file), node.moduleSpecifier.text.replace(/\.js$/u, '.ts'));
				for (const [name, owner] of owners) {
					if (target === join(sourceRoot, owner)) declarations.get(name)!.reexports.push(sourceName(file));
				}
			}
			if (!ts.isVariableStatement(node)) return;
			for (const declaration of node.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name))
					declarations.get(declaration.name.text)?.identifiers.push(sourceName(file));
			}
		});
	}
	for (const [name, owner] of owners)
		assert.deepEqual(declarations.get(name), { identifiers: [owner], contracts: [owner], reexports: [] }, name);
});

test('Workbench production imports do not depend on Sessions', () => {
	const sessionsRoot = join(sourceRoot, 'sessions');
	const violations = productionTypeScriptFiles(join(sourceRoot, 'workbench')).flatMap(file =>
		localImports(file)
			.filter(target => target.startsWith(`${sessionsRoot}${sep}`))
			.map(target => `${sourceName(file)} -> ${sourceName(target)}`),
	);
	assert.deepEqual(violations, []);
});

test('Sessions owns canonical Session management independently from Workbench contributions', () => {
	const sessionsServicesRoot = join(sourceRoot, 'sessions/services');
	const contributionRoot = join(sourceRoot, 'workbench/contrib');
	// Provider capabilities share the Chat automation contract, never its Workbench implementation.
	const providerContract = join(sessionsServicesRoot, 'sessions/common/sessionsProvider.ts');
	const automationContract = join(contributionRoot, 'chat/common/automations/automationService.ts');
	const appToolsContract = join(sessionsServicesRoot, 'appTools/browser/appTools.ts');
	const taskModels = join(contributionRoot, 'tasks/common/tasks.ts');
	const violations = productionTypeScriptFiles(sessionsServicesRoot).flatMap(file =>
		localImportEdges(file)
			.filter(
				({ target, typeOnly }) =>
					target.startsWith(contributionRoot) &&
					!(file === providerContract && target === automationContract) &&
					// App Tools shares task descriptions and output types without loading the task runtime.
					!(file === appToolsContract && target === taskModels && typeOnly),
			)
			.map(({ target }) => `${sourceName(file)} -> ${sourceName(target)}`),
	);
	assert.equal(existsSync(join(sessionsServicesRoot, 'sessions/common/session.ts')), true);
	assert.equal(existsSync(join(sessionsServicesRoot, 'sessions/common/sessionsManagement.ts')), true);
	assert.equal(existsSync(join(sessionsServicesRoot, 'sessions/browser/sessionsManagementService.ts')), true);
	assert.equal(existsSync(join(sourceRoot, 'workbench/services/sessions/common/sessionService.ts')), false);
	assert.equal(existsSync(join(sourceRoot, 'workbench/browser/defaultWorkbenchSession.ts')), false);
	assert.equal(existsSync(join(sourceRoot, 'workbench/browser/defaultWorkbenchProfile.ts')), false);
	assert.equal(existsSync(join(sourceRoot, 'workbench/browser/workbenchProfile.ts')), false);
	assert.deepEqual(violations, []);
});

test('Frontend common service contracts do not import browser implementations', () => {
	const workbenchRoot = join(sourceRoot, 'workbench');
	const sessionsRoot = join(sourceRoot, 'sessions');
	const platformRoot = join(sourceRoot, 'platform');
	const candidates = [
		...productionTypeScriptFiles(join(sessionsRoot, 'services')),
		...productionTypeScriptFiles(join(workbenchRoot, 'services')),
	].filter(file => /services[/\\][^/\\]+[/\\]common[/\\]/u.test(file));
	candidates.push(join(workbenchRoot, 'contrib/debug/common/debug.ts'));
	candidates.push(...taskContracts);
	const violations = candidates.flatMap(file =>
		localImports(file)
			.filter(
				target =>
					(target.startsWith(sessionsRoot) ||
						target.startsWith(workbenchRoot) ||
						target.startsWith(platformRoot)) &&
					target.includes(`${sep}browser${sep}`),
			)
			.map(target => `${sourceName(file)} -> ${sourceName(target)}`),
	);
	assert.deepEqual(violations, []);
});

test('Workbench contributions consume frontend services rather than Host aggregates or wire DTOs', () => {
	const violations: string[] = [];
	for (const file of productionTypeScriptFiles(join(sourceRoot, 'workbench/contrib'))) {
		const source = readFileSync(file, 'utf8');
		if (/rendererHost|platform\/renderer\/common\/rendererHost|generated\/app-server\/types/u.test(source))
			violations.push(sourceName(file));
	}
	assert.deepEqual(violations, []);
});

test('Frontend common service contracts own their domain types', () => {
	const candidates = [
		...productionTypeScriptFiles(join(sourceRoot, 'sessions/services')).filter(file =>
			/services[/\\][^/\\]+[/\\]common[/\\]/u.test(file),
		),
		...productionTypeScriptFiles(join(sourceRoot, 'workbench/services')).filter(file =>
			/services[/\\][^/\\]+[/\\]common[/\\]/u.test(file),
		),
		...productionTypeScriptFiles(join(sourceRoot, 'platform')).filter(file =>
			/common[/\\][^/\\]*Service\.ts$/u.test(file),
		),
		join(sourceRoot, 'workbench/contrib/debug/common/debug.ts'),
		...taskContracts,
	];
	const violations = candidates
		.filter(file => /generated\/app-server\/types/u.test(readFileSync(file, 'utf8')))
		.map(sourceName);
	assert.deepEqual(violations, []);
});

test('Configuration service and host transport contracts remain separate', () => {
	const commonRoot = join(sourceRoot, 'platform/configuration/common');
	const service = readFileSync(join(commonRoot, 'configuration.ts'), 'utf8');
	const implementation = readFileSync(join(commonRoot, 'configurationService.ts'), 'utf8');
	const models = readFileSync(join(commonRoot, 'configurationModels.ts'), 'utf8');
	assert.doesNotMatch(service, /JsonValue|CHANNEL|IConfigurationApi|IConfigurationDocument/u);
	assert.match(implementation, /@IFileService/u);
	assert.match(implementation, /new UserSettings/u);
	assert.doesNotMatch(implementation + models, /configurationIpc|configurationResourceService|IConfigurationApi/u);
});

test('Layer boundary scanning distinguishes erased type references from runtime imports', () => {
	const cases: [string, boolean][] = [
		['import type { Task } from "./tasks.js";', true],
		['import { type Task } from "./tasks.js";', true],
		['export type { Task } from "./tasks.js";', true],
		['export { type Task } from "./tasks.js";', true],
		['type Task = import("./tasks.js").Task;', true],
		['type Tasks = typeof import("./tasks.js");', true],
		['import { runTask } from "./tasks.js";', false],
		['import { runTask, type Task } from "./tasks.js";', false],
		['import Tasks, { type Task } from "./tasks.js";', false],
		['import "./tasks.js";', false],
		['export { runTask } from "./tasks.js";', false],
		['export * from "./tasks.js";', false],
		['void import("./tasks.js");', false],
	];
	for (const [source, typeOnly] of cases) {
		assert.deepEqual(
			localImportEdges(join(sourceRoot, 'entry.ts'), source),
			[{ target: join(sourceRoot, 'tasks.ts'), typeOnly }],
			source,
		);
	}
});

function productionTypeScriptFiles(directory: string): string[] {
	return collectFiles(directory).filter(file => file.endsWith('.ts') && !file.includes(`${sep}test${sep}`));
}

function collectFiles(directory: string): string[] {
	const result: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...collectFiles(path));
		else result.push(path);
	}
	return result;
}

function localImports(file: string): string[] {
	return localImportEdges(file).map(({ target }) => target);
}

function localImportEdges(file: string, source = readFileSync(file, 'utf8')): { target: string; typeOnly: boolean }[] {
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const targets: { target: string; typeOnly: boolean }[] = [];
	const visit = (node: ts.Node): void => {
		const module =
			ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
				? node.moduleSpecifier
				: ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
					? node.argument.literal
					: ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
						? node.arguments[0]
						: undefined;
		if (module && ts.isStringLiteral(module) && module.text.startsWith('.')) {
			let typeOnly = ts.isImportTypeNode(node);
			if (ts.isImportDeclaration(node) && node.importClause) {
				const clause = node.importClause;
				typeOnly =
					clause.isTypeOnly ||
					(!clause.name &&
						!!clause.namedBindings &&
						ts.isNamedImports(clause.namedBindings) &&
						clause.namedBindings.elements.length > 0 &&
						clause.namedBindings.elements.every(element => element.isTypeOnly));
			} else if (ts.isExportDeclaration(node)) {
				typeOnly =
					node.isTypeOnly ||
					(!!node.exportClause &&
						ts.isNamedExports(node.exportClause) &&
						node.exportClause.elements.length > 0 &&
						node.exportClause.elements.every(element => element.isTypeOnly));
			}
			targets.push({ target: resolve(dirname(file), module.text.replace(/\.js$/u, '.ts')), typeOnly });
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return targets;
}

function sourceName(file: string): string {
	return relative(sourceRoot, file).replaceAll('\\', '/');
}

test('Design editor stays within its Sessions contribution and keeps document code independent from the page', () => {
	const designRoot = join(sourceRoot, 'sessions/contrib/creator');
	const canvasRoot = join(sourceRoot, 'sessions/contrib/canvas');
	const commonRoot = join(designRoot, 'common');
	const coreRoot = join(commonRoot, 'core');
	const violations: string[] = [];
	for (const file of productionTypeScriptFiles(commonRoot)) {
		for (const target of localImports(file)) {
			if (
				target.includes(`${sep}browser${sep}`) ||
				target.startsWith(join(sourceRoot, 'workbench')) ||
				target.startsWith(join(sourceRoot, 'editor'))
			) {
				violations.push(`${sourceName(file)} -> ${sourceName(target)}`);
			}
			if (
				file.startsWith(`${coreRoot}${sep}`) &&
				target.startsWith(designRoot) &&
				!target.startsWith(`${coreRoot}${sep}`)
			) {
				violations.push(`${sourceName(file)} -> ${sourceName(target)}`);
			}
		}
	}
	const widget = join(designRoot, 'browser/widget/designEditorWidget.ts');
	for (const target of localImports(widget)) {
		if (
			target.startsWith(join(sourceRoot, 'sessions')) &&
			!target.startsWith(`${designRoot}${sep}`) &&
			!target.startsWith(`${canvasRoot}${sep}`)
		) {
			violations.push(`${sourceName(widget)} -> ${sourceName(target)}`);
		}
	}
	const sharedBrowserFiles = [
		...productionTypeScriptFiles(join(designRoot, 'browser/widget')),
		...productionTypeScriptFiles(join(designRoot, 'browser/controller')),
		join(designRoot, 'browser/view.ts'),
		join(designRoot, 'browser/designEditorBrowser.ts'),
	];
	for (const file of sharedBrowserFiles) {
		for (const target of localImports(file)) {
			if (target.startsWith(join(designRoot, 'contrib')) || target === join(designRoot, 'design.main.ts')) {
				violations.push(`${sourceName(file)} -> ${sourceName(target)}`);
			}
		}
	}
	assert.deepEqual(violations, []);
});

test('Shared canvas does not depend on Creator modes or Sessions composition', () => {
	const canvasRoot = join(sourceRoot, 'sessions/contrib/canvas');
	const violations: string[] = [];
	for (const file of productionTypeScriptFiles(canvasRoot)) {
		for (const target of localImports(file)) {
			if (target.startsWith(join(sourceRoot, 'sessions')) && !target.startsWith(`${canvasRoot}${sep}`)) {
				violations.push(`${sourceName(file)} -> ${sourceName(target)}`);
			}
			if (file.startsWith(join(canvasRoot, 'common')) && target.includes(`${sep}browser${sep}`)) {
				violations.push(`${sourceName(file)} -> ${sourceName(target)}`);
			}
		}
	}
	assert.deepEqual(violations, []);
});

test("Creator host consumes mode contracts and modes do not import each other's implementations", () => {
	const root = join(sourceRoot, 'sessions/contrib/creator');
	const modes = ['design', 'whiteboard', 'slides', 'brand', 'sites', 'make', 'prototype'];
	const roots = modes.map(mode => join(root, 'contrib', mode));
	const violations: string[] = [];
	for (const file of [join(root, 'browser/creatorPage.ts'), join(root, 'browser/creatorWorkspace.ts')]) {
		for (const target of localImports(file)) {
			if (roots.some(modeRoot => target.startsWith(modeRoot + sep)))
				violations.push(sourceName(file) + ' -> ' + sourceName(target));
		}
	}
	for (const modeRoot of roots) {
		for (const file of productionTypeScriptFiles(modeRoot)) {
			for (const target of localImports(file)) {
				if (roots.some(other => other !== modeRoot && target.startsWith(other + sep)))
					violations.push(sourceName(file) + ' -> ' + sourceName(target));
			}
		}
	}
	assert.deepEqual(violations, []);
});
