import { strict as assert } from "node:assert";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "mocha";

const sharedInteractionSelector = /\.ash-(?:action-bar|button|tab(?:\b|-)|view-pane(?:\b|-))/;
const ariaStateSelector = /\[aria-(?:checked|pressed|selected)\b/;
const actionIdentitySelector = /\[data-action-id(?:\b|=)/;
const negatedProjectedStateSelector = /:not\(\.(?:active|checked|selected)\)/;

test("Workbench Part CSS does not reach into shared interaction controls", async () => {
	const sourceRoot = join(process.cwd(), "src", "ash");
	const violations: string[] = [];
	for (const file of await partCssFiles(sourceRoot)) {
		const source = await readFile(file, "utf8");
		const name = relative(sourceRoot, file).replaceAll("\\", "/");
		for (const [index, line] of source.split(/\r?\n/).entries()) {
			if (sharedInteractionSelector.test(line)) violations.push(`${name}:${index + 1}: ${line.trim()}`);
		}
	}
	assert.deepEqual(violations, []);
});

test("Modern UI contribution owns the conditional Workbench appearance CSS", async () => {
	const sourceRoot = join(process.cwd(), "src", "ash");
	const modernUIRoot = join(sourceRoot, "workbench", "contrib", "modernUI", "browser");
	const contribution = await readFile(join(modernUIRoot, "modernUI.contribution.ts"), "utf8");
	const mediaFiles = await cssFiles(join(modernUIRoot, "media"));

	assert.ok(mediaFiles.length > 0);
	for (const file of mediaFiles) {
		const source = await readFile(file, "utf8");
		assert.match(source, /\.modern-ui\b/, relative(sourceRoot, file));
		assert.match(contribution, new RegExp(`import './media/${file.split(/[\\/]/).at(-1)?.replace(".", "\\.")}';`));
	}

	for (const file of await cssFiles(join(sourceRoot, "workbench", "browser", "parts"))) {
		const source = await readFile(file, "utf8");
		assert.doesNotMatch(source, /\b(?:data-layout-style|modern-ui)\b/, relative(sourceRoot, file));
	}
});

test("CSS uses state classes instead of ARIA attributes as visual selectors", async () => {
	const sourceRoot = join(process.cwd(), "src", "ash");
	const violations: string[] = [];
	for (const file of await cssFiles(sourceRoot)) {
		const source = await readFile(file, "utf8");
		const name = relative(sourceRoot, file).replaceAll("\\", "/");
		for (const [index, line] of source.split(/\r?\n/).entries()) {
			if (ariaStateSelector.test(line)) violations.push(`${name}:${index + 1}: ${line.trim()}`);
		}
	}
	assert.deepEqual(violations, []);
});

test("CSS state precedence does not negate projected state classes", async () => {
	const sourceRoot = join(process.cwd(), "src", "ash");
	const violations: string[] = [];
	for (const file of await cssFiles(sourceRoot)) {
		const source = await readFile(file, "utf8");
		const name = relative(sourceRoot, file).replaceAll("\\", "/");
		for (const [index, line] of source.split(/\r?\n/).entries()) {
			if (negatedProjectedStateSelector.test(line)) violations.push(`${name}:${index + 1}: ${line.trim()}`);
		}
	}
	assert.deepEqual(violations, []);
});

test("CSS does not style action identity attributes", async () => {
	const sourceRoot = join(process.cwd(), "src", "ash");
	const violations: string[] = [];
	for (const file of await cssFiles(sourceRoot)) {
		const source = await readFile(file, "utf8");
		const name = relative(sourceRoot, file).replaceAll("\\", "/");
		for (const [index, line] of source.split(/\r?\n/).entries()) {
			if (actionIdentitySelector.test(line)) violations.push(`${name}:${index + 1}: ${line.trim()}`);
		}
	}
	assert.deepEqual(violations, []);
});

test("Workbench owns the horizontal ActionBar hover skin", async () => {
	const sourceRoot = join(process.cwd(), "src", "ash");
	const actionBarCss = await readFile(join(sourceRoot, "base", "browser", "ui", "actionbar", "actionbar.css"), "utf8");
	const workbenchCss = await readFile(join(sourceRoot, "workbench", "browser", "media", "style.css"), "utf8");

	assert.doesNotMatch(actionBarCss, /:hover/);
	assert.match(workbenchCss, /\.ash-workbench :where\(\.ash-action-bar:not\(\.vertical\).*\.ash-button:not\(:disabled\):hover\)/);
	assert.match(workbenchCss, /\.ash-workbench :where\(\.ash-action-bar:not\(\.vertical\).*\.ash-action-label:not\(:disabled\):hover\)/);
	assert.match(workbenchCss, /background: var\(--ash-toolbar-hover-background\)/);
});

test("ToolBar icon actions use the 22px borderless VS Code geometry", async () => {
	const sizeSource = await readFile(join(process.cwd(), "src", "ash", "platform", "theme", "common", "sizes", "baseSizes.ts"), "utf8");
	const toolbarCss = await readFile(join(process.cwd(), "src", "ash", "base", "browser", "ui", "toolbar", "toolbar.css"), "utf8");
	const tabListCss = await readFile(join(process.cwd(), "src", "ash", "base", "browser", "ui", "tablist", "tablist.css"), "utf8");
	const compositeBarCss = await readFile(join(process.cwd(), "src", "ash", "workbench", "browser", "parts", "compositebar", "compositebar.css"), "utf8");

	assert.match(sizeSource, /dimension\("toolbar\.actionSize", 22,/);
	assert.match(
		toolbarCss,
		/\.ash-toolbar \.ash-action-view-item\.icon > \.ash-button \{[^}]*width: var\(--ash-toolbar-action-size\);[^}]*border: 0;[^}]*padding: 3px;/s,
	);
	assert.match(tabListCss, /\.ash-tab-actions \.ash-action-view-item\.icon \.ash-button \{[^}]*width: var\(--ash-toolbar-action-size\);[^}]*padding: 3px;[^}]*border: 0;/s);
	assert.match(compositeBarCss, /\.ash-composite-bar-overflow > \.ash-composite-bar-action \{[^}]*width: var\(--ash-toolbar-action-size\);[^}]*height: var\(--ash-toolbar-action-size\);[^}]*padding: 3px;[^}]*border: 0;/s);
});

test("TabList and CompositeBar each own their pointer interaction styling", async () => {
	const sourceRoot = join(process.cwd(), "src", "ash");
	const tabListCss = await readFile(join(sourceRoot, "base", "browser", "ui", "tablist", "tablist.css"), "utf8");
	const compositeBarCss = await readFile(join(sourceRoot, "workbench", "browser", "parts", "compositebar", "compositebar.css"), "utf8");
	const editorTabsCss = await readFile(join(sourceRoot, "workbench", "browser", "parts", "editor", "media", "multiEditorTabsControl.css"), "utf8");

	assert.match(tabListCss, /\.ash-tab\s*\{[^}]*cursor: pointer;/s);
	assert.match(tabListCss, /\.ash-tab\.ash-dnd-draggable\s*\{[^}]*cursor: pointer;/s);
	assert.match(tabListCss, /\.ash-tab\.ash-dnd-draggable:active\s*\{[^}]*cursor: grabbing;/s);
	assert.match(tabListCss, /\.ash-tab-label\s*\{[^}]*cursor: inherit;/s);
	assert.match(compositeBarCss, /\.ash-composite-bar-item\s*\{[^}]*cursor: pointer;/s);
	assert.match(compositeBarCss, /\.ash-composite-bar-item\.ash-dnd-draggable:active\s*\{[^}]*cursor: grabbing;/s);
	assert.match(compositeBarCss, /\.ash-composite-bar-action\s*\{[^}]*cursor: inherit;/s);
	assert.doesNotMatch(compositeBarCss, /\.ash-tab(?:\W|$)/);
	assert.doesNotMatch(editorTabsCss, /\.ash-multi-editor-tabs-control \.ash-tab-label\s*\{[^}]*cursor:/s);
});

test("TabList preserves the standard close-action hover background", async () => {
	const sourceRoot = join(process.cwd(), "src", "ash");
	const tabListCss = await readFile(join(sourceRoot, "base", "browser", "ui", "tablist", "tablist.css"), "utf8");
	const editorTabsCss = await readFile(join(sourceRoot, "workbench", "browser", "parts", "editor", "media", "multiEditorTabsControl.css"), "utf8");
	const chatTabsCss = await readFile(join(sourceRoot, "workbench", "contrib", "chat", "browser", "view", "multiChatTabsControl.css"), "utf8");

	assert.match(tabListCss, /\.ash-tab-actions \.ash-action-view-item\.icon \.ash-button:hover\s*\{[^}]*background: var\(--ash-toolbar-hover-background\);/s);
	assert.doesNotMatch(editorTabsCss, /--ash-tab-list-(?:checked-)?action-hover-background/);
	assert.doesNotMatch(chatTabsCss, /--ash-tab-list-(?:checked-)?action-hover-background/);
});

test("Menubar icon actions hide only their text label", async () => {
	const menubarCss = await readFile(join(process.cwd(), "src", "ash", "workbench", "browser", "parts", "titlebar", "menubarControl.css"), "utf8");

	assert.doesNotMatch(menubarCss, /\.ash-menubar \.ash-menubar-item > span\s*\{[^}]*display:\s*none/s);
	assert.match(menubarCss, /\.ash-menubar \.ash-menubar-item \.ash-button-label\s*\{[^}]*display:\s*none/s);
});

test("Split actions own their joined geometry outside Terminal", async () => {
	const sourceRoot = join(process.cwd(), "src", "ash");
	const dropdownCss = await readFile(join(sourceRoot, "base", "browser", "ui", "dropdown", "dropdown.css"), "utf8");
	const terminalCss = await readFile(join(sourceRoot, "workbench", "contrib", "terminal", "browser", "view", "media", "terminal.css"), "utf8");
	const workbenchCss = await readFile(join(sourceRoot, "workbench", "browser", "media", "style.css"), "utf8");

	assert.match(dropdownCss, /\.ash-dropdown-with-primary-action-view-item\s*\{[^}]*display: flex;[^}]*gap: 0;[^}]*border-radius: 4px;/s);
	assert.match(workbenchCss, /\.ash-dropdown-with-primary-action-view-item:not\(\.disabled\):hover/);
	assert.doesNotMatch(terminalCss, /ash-terminal-(?:new|profile)-action/);
	assert.doesNotMatch(terminalCss, /margin-right:\s*-2px/);
});

async function partCssFiles(directory: string): Promise<string[]> {
	return (await cssFiles(directory)).filter((file) => /part\.css$/i.test(file));
}

async function cssFiles(directory: string): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...await cssFiles(path));
		else if (entry.name.endsWith(".css")) result.push(path);
	}
	return result;
}
