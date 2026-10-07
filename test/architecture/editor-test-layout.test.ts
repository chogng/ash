import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "mocha";
import { findDesktopRoot } from "./testPaths.js";

const desktopRoot = findDesktopRoot(import.meta.dirname);
const unitRoot = join(desktopRoot, "test/unit");
const editorRoot = join(desktopRoot, "src/ash/editor");
const browserIntegrationRoot = join(desktopRoot, "test/integration/browser");
const desktopPackage = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")) as { scripts?: Record<string, string>; };

test("Stanza unit tests follow the flat editor common, browser, and contrib layout", () => {
	assert.equal(exists(join(desktopRoot, "test/monaco")), false);
	assert.equal(exists(join(unitRoot, "editor.ts")), true);
	assert.equal(exists(join(editorRoot, "test/common/textModel.test.ts")), true);
	assert.equal(exists(join(desktopRoot, "src/ash/workbench/contrib/codeEditor/test/browser/codeEditorPane.test.ts")), true);
	assert.equal(exists(join(editorRoot, "contrib/find/test/browser/findController.test.ts")), true);
	assert.equal(exists(join(editorRoot, "test/common/textModelBlocks.test.ts")), true);
	assert.equal(exists(join(desktopRoot, "src/ash/workbench/contrib/documentEditor/test/browser/documentEditorPane.test.ts")), true);
});

test("Stanza browser integration is flat and named after concrete model mount points", () => {
	for (const file of ["textModel.html", "textModel.integration.ts", "textModel.integration.spec.ts", "academic.html", "academic.integration.ts", "academic.integration.spec.ts", "memoryTextFiles.ts", "playwright.config.ts", "vite.config.ts"]) {
		assert.equal(exists(join(browserIntegrationRoot, file)), true, file);
	}
	const textModelIntegration = readFileSync(join(browserIntegrationRoot, "textModel.integration.spec.ts"), "utf8");
	const academicIntegration = readFileSync(join(browserIntegrationRoot, "academic.integration.spec.ts"), "utf8");
	const config = readFileSync(join(browserIntegrationRoot, "playwright.config.ts"), "utf8");
	assert.match(textModelIntegration, /ashTextModelIntegration/u);
	assert.match(academicIntegration, /ashAcademicIntegration/u);
	assert.match(textModelIntegration, /axe-playwright/u);
	assert.match(academicIntegration, /axe-playwright/u);
	assert.match(config, /name:\s*"chromium"/u);
	assert.doesNotMatch(config, /firefox/u);
});

test("browser integrations import the stable API and required contributions", () => {
	const textModelIntegration = readFileSync(join(browserIntegrationRoot, "textModel.integration.ts"), "utf8");
	const academicIntegration = readFileSync(join(browserIntegrationRoot, "academic.integration.ts"), "utf8");
	assert.match(textModelIntegration, /editor\/editor\.api\.js/u);
	assert.match(textModelIntegration, /editor\/editor\.code\.all\.js/u);
	assert.doesNotMatch(textModelIntegration, /editor\.(?:main|academic\.all)\.js/u);
	assert.match(academicIntegration, /editor\/editor\.api\.js/u);
	assert.match(academicIntegration, /editor\/contrib\/documentEditor\.contribution\.js/u);
	assert.doesNotMatch(academicIntegration, /editor\.(?:main|code\.all)\.js/u);
});

test("desktop exposes editor and full browser integration entrypoints", () => {
	assert.match(desktopPackage.scripts?.["test:editor:browser"] ?? "", /run\.ts --editor$/u);
	assert.match(desktopPackage.scripts?.["test:browser:integration"] ?? "", /run\.ts$/u);
	assert.equal(exists(join(desktopRoot, "test/runner")), false);
	assert.equal(exists(join(unitRoot, "test-editor.ts")), false);
	assert.equal(exists(join(unitRoot, "pnpm-script.ts")), false);
});

test("browser integration entrypoints narrow file filters within their suite", () => {
	function list(editorOnly: boolean, file: string) {
		const result = spawnSync(process.execPath, [
			"test/integration/browser/run.ts",
			...(editorOnly ? ["--editor"] : []),
			file, "--project=chromium", "--list",
		], { cwd: desktopRoot, encoding: "utf8", timeout: 30_000, windowsHide: true });
		if (result.error) throw result.error;
		return { status: result.status, output: result.stdout + result.stderr };
	}
	const editor = list(true, "textModel.integration.spec.ts");
	assert.equal(editor.status, 0, editor.output);
	assert.match(editor.output, /textModel\.integration\.spec\.ts/u);
	assert.match(editor.output, /Total: \d+ tests in 1 file/u);
	assert.doesNotMatch(editor.output, /(?:academic|themes|tokenization)\.integration\.spec\.ts/u);
	const outsideEditor = list(true, "dialog.integration.spec.ts");
	assert.equal(outsideEditor.status, 1, outsideEditor.output);
	assert.match(outsideEditor.output, /No tests found/u);
	const allBrowser = list(false, "dialog.integration.spec.ts");
	assert.equal(allBrowser.status, 0, allBrowser.output);
	assert.match(allBrowser.output, /dialog\.integration\.spec\.ts/u);
	assert.match(allBrowser.output, /Total: \d+ tests in 1 file/u);
});

function exists(file: string): boolean {
	try {
		statSync(file);
		return true;
	} catch {
		return false;
	}
}
