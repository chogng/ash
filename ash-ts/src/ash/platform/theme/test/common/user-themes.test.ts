import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "mocha";
import { ColorId, lightColorTheme } from "../../../../platform/theme/common/colorTheme.js";
import { parseUserColorTheme, serializeUserColorThemeDraft } from "../../../../platform/theme/common/userColorTheme.js";
import { validateUserThemeFileDeleteRequest, validateUserThemeFileWriteRequest } from "../../../../platform/theme/common/userThemeFiles.js";
import { UserThemeFileService } from "../../../../platform/theme/node/userThemeFileService.js";
import { WorkbenchThemesRegistry } from "../../../../workbench/common/theme.js";
import { loadUserThemes } from "../../../../workbench/electron-browser/userThemes.js";

const validTheme = {
	$schema: "https://ash.dev/schemas/color-theme.schema.json",
	version: 1,
	id: "test-user-aurora",
	label: "Test User Aurora",
	colorScheme: "dark",
	colors: {
		[ColorId.editorBackground]: "#101525",
		[ColorId.panelBackground]: ColorId.editorBackground,
		[ColorId.toolbarHoverBackground]: {
			op: "transparent",
			value: "#ffffff",
			factor: 0.2,
		},
	},
} as const;

test("user theme JSON compiles aliases and transforms into a complete snapshot", () => {
	const theme = parseUserColorTheme(JSON.stringify(validTheme));
	assert.equal(theme.id, "test-user-aurora");
	assert.equal(theme.getColorCss(ColorId.editorBackground), "#101525");
	assert.equal(theme.getColorCss(ColorId.panelBackground), "#101525");
	assert.equal(theme.getColorCss(ColorId.toolbarHoverBackground), "#ffffff33");
	assert.equal(theme.getColorCss(ColorId.foreground), "#cccccc");
});

test("Desktop owns its theme template and resolver examples", async () => {
	const template = await readFile(join(process.cwd(), "resources/theme/color-theme.template.json"), "utf8");
	assert.equal(parseUserColorTheme(template).id, "my-custom-theme");
	const fixture = JSON.parse(await readFile(join(process.cwd(), "src/ash/platform/theme/test/common/fixtures/resolver.json"), "utf8")) as { theme: unknown; expected: Record<string, string> };
	const theme = parseUserColorTheme(JSON.stringify(fixture.theme));
	for (const [token, expected] of Object.entries(fixture.expected)) {
		assert.equal(theme.getColorCss(token), expected, token);
	}
});

test("Desktop rejects a Rust GUI theme schema", () => {
	assert.throws(() => parseUserColorTheme(JSON.stringify({
		...validTheme,
		$schema: "https://ash.dev/schemas/app/color-theme.schema.json",
	})), /User theme \$schema must be/);
});

test("resolved Light themes become complete editable user theme drafts", () => {
	const source = serializeUserColorThemeDraft(lightColorTheme, "test-light-copy", "Test Light Copy");
	const document = JSON.parse(source) as { colorScheme: string; colors: Record<string, string> };
	const theme = parseUserColorTheme(source);
	assert.equal(document.colorScheme, "light");
	assert.equal(Object.keys(document.colors).length, lightColorTheme.colorEntries.length);
	assert.equal(theme.getColorCss(ColorId.editorBackground), lightColorTheme.getColorCss(ColorId.editorBackground));
});

test("user theme JSON rejects unknown fields, tokens, malformed colors, and transform factors", () => {
	assert.throws(() => parseUserColorTheme(JSON.stringify({ ...validTheme, extra: true })), /unknown fields/);
	assert.throws(() => parseUserColorTheme(JSON.stringify({ ...validTheme, colors: { "missing.color": "#ffffff" } })), /Unknown color token override/);
	assert.throws(() => parseUserColorTheme(JSON.stringify({ ...validTheme, colors: { [ColorId.editorBackground]: "red" } })), /Unknown color token reference/);
	assert.throws(() => parseUserColorTheme(JSON.stringify({ ...validTheme, colors: { [ColorId.editorBackground]: { op: "lighten", value: "#000000", factor: 2 } } })), /between 0 and 1/);
});

test("user theme writes reject traversal, unknown operations, and oversized content", () => {
	assert.throws(() => validateUserThemeFileWriteRequest({ content: "{}", file: "../theme.json", operation: "create" }), /filename/);
	assert.throws(() => validateUserThemeFileWriteRequest({ content: "{}", file: "theme.json", operation: "overwrite" }), /operation/);
	assert.throws(() => validateUserThemeFileWriteRequest({ content: "x".repeat(1_048_577), file: "theme.json", operation: "create" }), /1 MiB/);
	assert.throws(() => validateUserThemeFileDeleteRequest({ file: "..\\theme.json", themeId: "theme" }), /filename/);
});

test("user theme file discovery is bounded to regular JSON files", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ash-user-themes-"));
	try {
		await writeFile(join(directory, "b.json"), JSON.stringify(validTheme), "utf8");
		await writeFile(join(directory, "a.json"), "{}", "utf8");
		await writeFile(join(directory, "ignored.txt"), "{}", "utf8");
		const result = await new UserThemeFileService(directory).list();
		assert.equal(result.directory, directory);
		assert.deepEqual(result.files.map(({ name }) => name), ["a.json", "b.json"]);
		assert.equal(result.files.every(({ content }) => typeof content === "string"), true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("user theme loading isolates invalid files and releases registrations", async () => {
	const registration = await loadUserThemes({
		delete: async () => {
			throw new Error("Unexpected delete");
		},
		list: async () => ({
			directory: "C:\\themes",
			files: [
				{ name: "aurora.json", content: JSON.stringify(validTheme) },
				{ name: "broken.json", content: "{" },
				{ name: "unreadable.json", error: "Unable to read theme file" },
			],
		}),
		write: async () => {
			throw new Error("Unexpected write");
		},
	});
	assert.equal(WorkbenchThemesRegistry.getColorTheme(validTheme.id)?.label, validTheme.label);
	assert.equal(registration.sourceFor(validTheme.id)?.file, "aurora.json");
	assert.deepEqual(registration.issues.map(({ file }) => file), ["broken.json", "unreadable.json"]);
	registration.dispose();
	assert.equal(WorkbenchThemesRegistry.getColorTheme(validTheme.id), undefined);
});

test("user theme service saves new themes and replaces loaded JSON immediately", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ash-user-theme-save-"));
	const files = new UserThemeFileService(directory);
	const service = await loadUserThemes({
		delete: (request) => files.delete(request),
		list: () => files.list(),
		write: (request) => files.write(request),
	});
	try {
		const createdSource = JSON.stringify({
			...validTheme,
			id: "test-save-as-theme",
			label: "Test Save As Theme",
		}, null, 2);
		const created = await service.saveAs(createdSource);
		assert.equal(created.file, "test-save-as-theme.json");
		assert.equal(WorkbenchThemesRegistry.getColorTheme(created.theme.id)?.label, "Test Save As Theme");
		assert.equal(await readFile(join(directory, created.file), "utf8"), createdSource);

		const replacedSource = JSON.stringify({
			...validTheme,
			id: "test-save-as-theme",
			label: "Test Replaced Theme",
			colors: { [ColorId.editorBackground]: "#202530" },
		}, null, 2);
		const replaced = await service.save(created.theme.id, replacedSource);
		assert.equal(replaced.theme.label, "Test Replaced Theme");
		assert.equal(replaced.theme.getColorCss(ColorId.editorBackground), "#202530");
		assert.equal(await readFile(join(directory, created.file), "utf8"), replacedSource);

		const deleted = await service.delete(replaced.theme.id);
		assert.equal(deleted.file, created.file);
		assert.equal(deleted.colorScheme, replaced.theme.colorScheme);
		assert.equal(WorkbenchThemesRegistry.getColorTheme(replaced.theme.id), undefined);
		await assert.rejects(readFile(join(directory, created.file), "utf8"));
	} finally {
		service.dispose();
		await rm(directory, { recursive: true, force: true });
	}
});
