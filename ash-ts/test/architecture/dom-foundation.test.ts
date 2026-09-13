import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "mocha";
import ts from "typescript";
import { findDesktopRoot } from "./testPaths.js";

const desktopRoot = findDesktopRoot(import.meta.dirname);
const sourceRoot = resolve(desktopRoot, "src/ash");
const allowedNativeDomFiles = new Set([
	resolve(sourceRoot, "base/browser/dom.ts"),
	resolve(sourceRoot, "base/browser/reactiveDom.ts"),
]);
const allowedAnimationFrameFiles = new Set([
	resolve(sourceRoot, "base/browser/scheduler.ts"),
	resolve(desktopRoot, "test/automation/workbench.ts"),
]);
const baseUiRoot = resolve(sourceRoot, "base/browser/ui");
const allowedExplicitDocumentContracts = new Map<string, ReadonlySet<string>>([
	[resolve(sourceRoot, "base/browser/domSanitize.ts"), new Set(["HtmlSanitizerOptions"])],
	[resolve(sourceRoot, "base/browser/fileAccess.ts"), new Set(["FilePickerOptions"])],
	[resolve(sourceRoot, "base/browser/markdownRenderer.ts"), new Set(["MarkdownElementOptions", "MarkdownSanitizerOptions"])],
	[resolve(sourceRoot, "editor/browser/widget/richTextEditor/richTextEditorWidget.ts"), new Set(["NodeViewContext", "InlineNodeViewContext", "EditorToolbarActionContext"])],
	[resolve(sourceRoot, "editor/browser/view/renderingContext.ts"), new Set(["EditorOverlayContext"])],
	[resolve(sourceRoot, "workbench/services/keybinding/browser/keybindingService.ts"), new Set(["WorkbenchKeybindingServiceOptions"])],
]);
const allowedDocumentConstructors = new Map<string, ReadonlySet<string>>([
	[resolve(sourceRoot, "base/browser/domStylesheets.ts"), new Set(["ManagedStyleSheet"])],
	[resolve(sourceRoot, "base/browser/reactiveDom.ts"), new Set(["ReactiveElement"])],
	[resolve(sourceRoot, "base/browser/ui/aria/aria.ts"), new Set(["AriaLiveRegion"])],
]);

test("frontend TypeScript creates DOM only through the canonical foundations", () => {
	const violations: string[] = [];
	for (const file of frontendTypeScriptFiles()) {
		const source = readFileSync(file, "utf8");
		const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		visit(sourceFile, node => {
			if (!ts.isCallExpression(node)) return;
			const name = calledName(node.expression);
			if (ts.isPropertyAccessExpression(node.expression) && ["createElement", "createElementNS", "createTextNode", "createDocumentFragment"].includes(name ?? "") && !allowedNativeDomFiles.has(file)) {
				violations.push(location(file, sourceFile, node, name!));
			}
			if (["requestAnimationFrame", "cancelAnimationFrame"].includes(name ?? "") && !allowedAnimationFrameFiles.has(file)) {
				violations.push(location(file, sourceFile, node, name!));
			}
		});
	}
	assert.deepEqual(violations, []);
});

test("DOM context queries have one canonical owner", () => {
	const expectedSymbols = ["getWindow", "getDocument", "getActiveElement", "getActiveDocument"];
	const ownerFiles = [
		resolve(sourceRoot, "base/browser/dom.ts"),
		resolve(sourceRoot, "base/browser/focus.ts"),
		resolve(sourceRoot, "base/browser/window.ts"),
	];
	const owners = Object.fromEntries(expectedSymbols.map(symbol => [symbol, [] as string[]]));
	for (const file of ownerFiles) {
		const source = readFileSync(file, "utf8");
		const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		for (const statement of sourceFile.statements) {
			if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
			const matches = owners[statement.name.text];
			if (matches) matches.push(relative(desktopRoot, file).replaceAll("\\", "/"));
		}
	}
	assert.deepEqual(owners, Object.fromEntries(expectedSymbols.map(symbol => [symbol, ["src/ash/base/browser/dom.ts"]])));
});

test("FastDomNode managed writes stay behind the canonical wrapper", () => {
	const configPath = resolve(desktopRoot, "tsconfig.renderer.json");
	const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
	if (configFile.error) {
		throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
	}
	const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath));
	const program = ts.createProgram(config.fileNames, { ...config.options, noEmit: true });
	const checker = program.getTypeChecker();
	const violations: string[] = [];
	for (const sourceFile of program.getSourceFiles()) {
		if (
			!sourceFile.fileName.startsWith(sourceRoot) ||
			sourceFile.fileName === resolve(sourceRoot, "base/browser/fastDomNode.ts")
		) {
			continue;
		}
		visit(sourceFile, node => {
			if (!ts.isPropertyAccessExpression(node) || node.name.text !== "domNode") {
				return;
			}
			const mutation = fastDomNodeMutation(node, checker);
			if (mutation) {
				violations.push(location(sourceFile.fileName, sourceFile, node, mutation));
			}
		});
	}
	assert.deepEqual(violations, []);
});

test("the retired DOM builder and binding protocol stay removed", () => {
	assert.equal(existsSync(resolve(sourceRoot, "base/browser/domBuilder.ts")), false);
	const violations = frontendTypeScriptFiles().filter(file => /domBuilder\.js|\bReadableValue\b|\bbind(?:Text|Attribute|Class|Children)\b/u.test(readFileSync(file, "utf8"))).map(file => relative(desktopRoot, file).replaceAll("\\", "/"));
	assert.deepEqual(violations, []);
});

test("mounted UI derives its document from the host boundary", () => {
	const violations: string[] = [];
	for (const file of collectTypeScriptFiles(baseUiRoot)) {
		const source = readFileSync(file, "utf8");
		const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		visit(sourceFile, node => {
			if (!ts.isPropertySignature(node) && !ts.isParameter(node)) return;
			if (!ts.isIdentifier(node.name) || node.name.text !== "ownerDocument") return;
			if (ts.isPropertySignature(node)) {
				violations.push(location(file, sourceFile, node, "ownerDocument option on mounted UI"));
			}
			if (ts.isParameter(node)) {
				if (node.questionToken) violations.push(location(file, sourceFile, node, "optional ownerDocument"));
				if (node.initializer) violations.push(location(file, sourceFile, node, "default ownerDocument"));
			}
		});
	}
	assert.deepEqual(violations, []);
});

test("frontend component contracts do not carry a redundant document", () => {
	const violations: string[] = [];
	for (const file of productionTypeScriptFiles()) {
		const source = readFileSync(file, "utf8");
		const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		visit(sourceFile, node => {
			if (ts.isPropertySignature(node) && ts.isIdentifier(node.name) && node.name.text === "ownerDocument") {
				const contractName = containingDeclarationName(node);
				if (!contractName || !allowedExplicitDocumentContracts.get(file)?.has(contractName)) {
					violations.push(location(file, sourceFile, node, `ownerDocument on ${contractName ?? "anonymous contract"}`));
				}
			}
			if (!ts.isConstructorDeclaration(node)) return;
			const className = ts.isClassDeclaration(node.parent) ? node.parent.name?.text : undefined;
			for (const parameter of node.parameters) {
				if (parameter.type?.getText(sourceFile) !== "Document") continue;
				if (!className || !allowedDocumentConstructors.get(file)?.has(className)) {
					violations.push(location(file, sourceFile, parameter, `Document constructor parameter on ${className ?? "anonymous class"}`));
				}
			}
		});
	}
	assert.deepEqual(violations, []);
});

function frontendTypeScriptFiles(): string[] {
	return [resolve(sourceRoot), resolve(desktopRoot, "test")].flatMap(collectTypeScriptFiles);
}

function productionTypeScriptFiles(): string[] {
	return collectTypeScriptFiles(sourceRoot).filter(file => !/[\\/](?:test|tests)[\\/]|\.test\.tsx?$/u.test(file));
}

function collectTypeScriptFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...collectTypeScriptFiles(path));
		else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(path);
	}
	return files;
}

function visit(node: ts.Node, accept: (node: ts.Node) => void): void {
	accept(node);
	ts.forEachChild(node, child => visit(child, accept));
}

function calledName(expression: ts.LeftHandSideExpression): string | undefined {
	if (ts.isIdentifier(expression)) return expression.text;
	if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
	return undefined;
}

function fastDomNodeMutation(node: ts.PropertyAccessExpression, checker: ts.TypeChecker): string | undefined {
	if (!isFastDomNodeType(checker.getTypeAtLocation(node.expression))) {
		return undefined;
	}
	const member = node.parent;
	if (!ts.isPropertyAccessExpression(member) || member.expression !== node) {
		return undefined;
	}
	if (member.name.text === "className" && isAssignmentTarget(member)) {
		return member.name.text;
	}
	if (member.name.text === "classList") {
		const operation = member.parent;
		if (ts.isPropertyAccessExpression(operation) && operation.expression === member) {
			if (isAssignmentTarget(operation)) {
				return `classList.${operation.name.text}`;
			}
			if (
				["add", "remove", "replace", "toggle"].includes(operation.name.text) &&
				ts.isCallExpression(operation.parent) &&
				operation.parent.expression === operation
			) {
				return `classList.${operation.name.text}`;
			}
		}
	}
	if (member.name.text === "style") {
		const operation = member.parent;
		if (ts.isPropertyAccessExpression(operation) && operation.expression === member) {
			if (
				(operation.name.text === "cssText" || managedStyleProperties.has(operation.name.text)) &&
				isAssignmentTarget(operation)
			) {
				return `style.${operation.name.text}`;
			}
			if (
				["removeProperty", "setProperty"].includes(operation.name.text) &&
				ts.isCallExpression(operation.parent) &&
				operation.parent.expression === operation
			) {
				const property = stringLiteralValue(operation.parent.arguments[0]);
				if (property && managedStyleProperties.has(property)) {
					return `style.${operation.name.text}(${property})`;
				}
			}
		}
	}
	if (
		["removeAttribute", "setAttribute", "toggleAttribute"].includes(member.name.text) &&
		ts.isCallExpression(member.parent) &&
		member.parent.expression === member
	) {
		const attribute = stringLiteralValue(member.parent.arguments[0])?.toLowerCase();
		if (attribute && managedAttributes.has(attribute)) {
			return `${member.name.text}(${attribute})`;
		}
	}
	return undefined;
}

const managedStyleProperties = new Set([
	"bottom",
	"box-shadow",
	"boxShadow",
	"height",
	"left",
	"line-height",
	"lineHeight",
	"right",
	"top",
	"transform",
	"width",
]);
const managedAttributes = new Set(["class", "style"]);

function isFastDomNodeType(type: ts.Type): boolean {
	if ((type.aliasSymbol ?? type.getSymbol())?.getName() === "FastDomNode") {
		return true;
	}
	return type.isUnionOrIntersection() && type.types.some(isFastDomNodeType);
}

function isAssignmentTarget(node: ts.Node): boolean {
	if (ts.isPostfixUnaryExpression(node.parent) || ts.isPrefixUnaryExpression(node.parent)) {
		return node.parent.operator === ts.SyntaxKind.PlusPlusToken || node.parent.operator === ts.SyntaxKind.MinusMinusToken;
	}
	return ts.isBinaryExpression(node.parent) &&
		node.parent.left === node &&
		node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
		node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
}

function stringLiteralValue(node: ts.Expression | undefined): string | undefined {
	return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function containingDeclarationName(node: ts.Node): string | undefined {
	for (let current = node.parent; current; current = current.parent) {
		if (ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current) || ts.isClassDeclaration(current)) return current.name?.text;
	}
	return undefined;
}

function location(file: string, sourceFile: ts.SourceFile, node: ts.Node, operation: string): string {
	const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
	return `${relative(desktopRoot, file).replaceAll("\\", "/")}:${line}: ${operation}`;
}
