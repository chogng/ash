import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "mocha";
import ts from "typescript";
import { findDesktopRoot } from "./testPaths.js";

const desktopRoot = findDesktopRoot(import.meta.dirname);
const sourceRoot = resolve(desktopRoot, "src/ash");

test("Base and Platform production imports preserve the layer direction", () => {
	const violations: string[] = [];
	const baseRoot = join(sourceRoot, "base");
	// NLS is a shared root entry point used by every frontend layer.
	const nlsRoot = join(sourceRoot, "nls.ts");
	assert.equal(existsSync(nlsRoot), true, "shared NLS root");
	assert.equal(existsSync(join(baseRoot, "common/nls.ts")), false, "NLS has one root owner");
	for (const target of localImports(nlsRoot)) {
		if (!target.startsWith(`${baseRoot}${sep}`)) violations.push(`${sourceName(nlsRoot)} -> ${sourceName(target)}`);
	}
	for (const file of productionTypeScriptFiles(join(sourceRoot, "base"))) {
		for (const target of localImports(file)) {
			if (target.startsWith(sourceRoot) && target !== nlsRoot && !target.startsWith(`${baseRoot}${sep}`)) violations.push(`${sourceName(file)} -> ${sourceName(target)}`);
		}
	}
	for (const file of productionTypeScriptFiles(join(sourceRoot, "platform"))) {
		for (const target of localImports(file)) {
			if (target.startsWith(join(sourceRoot, "workbench")) || target.startsWith(join(sourceRoot, "editor")) || target.startsWith(join(sourceRoot, "code"))) violations.push(`${sourceName(file)} -> ${sourceName(target)}`);
		}
	}
	assert.deepEqual(violations, []);
});

test("Workbench service implementations do not depend on Workbench contributions", () => {
	const contributionRoot = join(sourceRoot, "workbench/contrib");
	const violations = productionTypeScriptFiles(join(sourceRoot, "workbench/services")).flatMap(file => localImports(file).filter(target => target.startsWith(contributionRoot)).map(target => `${sourceName(file)} -> ${sourceName(target)}`));
	assert.deepEqual(violations, []);
});

test("Sessions owns canonical Session management independently from Workbench contributions", () => {
	const sessionsServicesRoot = join(sourceRoot, "sessions/services");
	const contributionRoot = join(sourceRoot, "workbench/contrib");
	const violations = productionTypeScriptFiles(sessionsServicesRoot).flatMap(file => localImports(file).filter(target => target.startsWith(contributionRoot)).map(target => `${sourceName(file)} -> ${sourceName(target)}`));
	assert.equal(existsSync(join(sessionsServicesRoot, "sessions/common/session.ts")), true);
	assert.equal(existsSync(join(sessionsServicesRoot, "sessions/common/sessionsManagementService.ts")), true);
	assert.equal(existsSync(join(sessionsServicesRoot, "sessions/browser/appServerSessionsManagementService.ts")), true);
	assert.equal(existsSync(join(sourceRoot, "workbench/services/sessions/common/sessionService.ts")), false);
	assert.equal(existsSync(join(sourceRoot, "workbench/browser/defaultWorkbenchSession.ts")), false);
	assert.equal(existsSync(join(sourceRoot, "workbench/browser/defaultWorkbenchProfile.ts")), false);
	assert.equal(existsSync(join(sourceRoot, "workbench/browser/workbenchProfile.ts")), false);
	assert.deepEqual(violations, []);
});

test("Frontend common service contracts do not import browser implementations", () => {
	const workbenchRoot = join(sourceRoot, "workbench");
	const sessionsRoot = join(sourceRoot, "sessions");
	const platformRoot = join(sourceRoot, "platform");
	const candidates = [
		...productionTypeScriptFiles(join(sessionsRoot, "services")),
		...productionTypeScriptFiles(join(workbenchRoot, "services")),
	].filter(file => /services[/\\][^/\\]+[/\\]common[/\\]/u.test(file));
	const violations = candidates.flatMap(file => localImports(file).filter(target => (target.startsWith(sessionsRoot) || target.startsWith(workbenchRoot) || target.startsWith(platformRoot)) && target.includes(`${sep}browser${sep}`)).map(target => `${sourceName(file)} -> ${sourceName(target)}`));
	assert.deepEqual(violations, []);
});

test("Workbench contributions consume frontend services rather than Host aggregates or wire DTOs", () => {
	const violations: string[] = [];
	for (const file of productionTypeScriptFiles(join(sourceRoot, "workbench/contrib"))) {
		const source = readFileSync(file, "utf8");
		if (/rendererHost|platform\/renderer\/common\/rendererHost|generated\/app-server\/types/u.test(source)) violations.push(sourceName(file));
	}
	assert.deepEqual(violations, []);
});

test("Frontend common service contracts own their domain types", () => {
	const candidates = [
		...productionTypeScriptFiles(join(sourceRoot, "sessions/services")).filter(file => /services[/\\][^/\\]+[/\\]common[/\\]/u.test(file)),
		...productionTypeScriptFiles(join(sourceRoot, "workbench/services")).filter(file => /services[/\\][^/\\]+[/\\]common[/\\]/u.test(file)),
		...productionTypeScriptFiles(join(sourceRoot, "platform")).filter(file => /common[/\\][^/\\]*Service\.ts$/u.test(file)),
	];
	const violations = candidates.filter(file => /generated\/app-server\/types/u.test(readFileSync(file, "utf8"))).map(sourceName);
	assert.deepEqual(violations, []);
});

test("Configuration service and host transport contracts remain separate", () => {
	const commonRoot = join(sourceRoot, "platform/configuration/common");
	const service = readFileSync(join(commonRoot, "configuration.ts"), "utf8");
	const transport = readFileSync(join(commonRoot, "configurationIpc.ts"), "utf8");
	assert.equal(existsSync(join(commonRoot, "configurationService.ts")), false);
	assert.doesNotMatch(service, /JsonValue|CHANNEL|IConfigurationApi|IConfigurationDocument/u);
	assert.doesNotMatch(transport, /createServiceIdentifier|IConfigurationService|IConfigurationKey/u);
});

function productionTypeScriptFiles(directory: string): string[] {
	return collectFiles(directory).filter(file => file.endsWith(".ts") && !file.includes(`${sep}test${sep}`));
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
	const source = readFileSync(file, "utf8");
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const targets: string[] = [];
	sourceFile.forEachChild(node => {
		if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || !node.moduleSpecifier.text.startsWith(".")) return;
		const target = resolve(dirname(file), node.moduleSpecifier.text.replace(/\.js$/u, ".ts"));
		targets.push(target);
	});
	return targets;
}

function sourceName(file: string): string {
	return relative(sourceRoot, file).replaceAll("\\", "/");
}
