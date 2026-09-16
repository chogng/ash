import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../../base/common/uri.js";
import {
	SetiFileIconThemeService,
} from "../../browser/setiFileIconTheme.js";
import {
	darkColorTheme,
	lightColorTheme,
} from "../../common/colorTheme.js";
import { TestThemeService } from "../common/testThemeService.js";
import { h } from "../../../../base/browser/dom.js";

test("Seti resolves names, extensions, languages, and color schemes", () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	using themeService = new TestThemeService(darkColorTheme);
	using fileIconTheme = new SetiFileIconThemeService(themeService);

	const readme = renderIcon(
		fileIconTheme,
		browser.window.document,
		"C:\\project\\README.md",
	);
	const typescript = renderIcon(
		fileIconTheme,
		browser.window.document,
		"C:\\project\\main.ts",
	);
	const typescriptTest = renderIcon(
		fileIconTheme,
		browser.window.document,
		"C:\\project\\main.test.ts",
	);
	const rust = renderIcon(
		fileIconTheme,
		browser.window.document,
		"C:\\project\\main.rs",
	);
	const unknown = renderIcon(
		fileIconTheme,
		browser.window.document,
		"C:\\project\\source.unknown-extension",
	);

	assert.equal(readme.classList.contains("ash-seti-file-icon"), true);
	assert.notEqual(readme.textContent, "");
	assert.notEqual(typescript.textContent, unknown.textContent);
	assert.notEqual(
		iconSignature(typescriptTest),
		iconSignature(typescript),
	);
	assert.notEqual(rust.textContent, unknown.textContent);

	let themeChanges = 0;
	using listener = fileIconTheme.onDidFileIconThemeChange(() => {
		themeChanges += 1;
	});
	const darkTypeScriptColor = typescript.style.color;
	themeService.setColorTheme(lightColorTheme);
	const lightTypeScript = renderIcon(
		fileIconTheme,
		browser.window.document,
		"C:\\project\\main.ts",
	);
	assert.equal(themeChanges, 1);
	assert.notEqual(lightTypeScript.style.color, darkTypeScriptColor);

	browser.window.close();
});

function renderIcon(
	fileIconTheme: SetiFileIconThemeService,
	document: Document,
	path: string,
): HTMLSpanElement {
	const container = h(document, "span");
	fileIconTheme.renderFileIcon(URI.file(path), container);
	return container;
}

function iconSignature(icon: HTMLElement): string {
	return `${icon.textContent}:${icon.style.color}`;
}
