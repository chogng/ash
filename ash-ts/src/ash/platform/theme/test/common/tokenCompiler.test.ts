import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "mocha";
import { compileDesignTokenArtifacts } from "../../common/tokenCompiler.js";
import { colorIdentifiers, sizeIdentifiers } from "../../common/colorTheme.js";
import { parseUserColorTheme } from "../../common/userColorTheme.js";

test("design token compiler emits deterministic validated artifacts", () => {
	const first = compileDesignTokenArtifacts();
	const second = compileDesignTokenArtifacts();
	assert.deepEqual(first, second);
	const manifest = JSON.parse(first.manifest) as { colors: unknown[]; sizes: unknown[] };
	assert.deepEqual((manifest.colors as Array<{ id: string }>).map(({ id }) => id), colorIdentifiers);
	assert.deepEqual((manifest.sizes as Array<{ id: string }>).map(({ id }) => id), sizeIdentifiers);
	assert.match(first.catalog, /Generated design token catalog/);
	assert.equal(parseUserColorTheme(first.userThemeTemplate).id, "my-custom-theme");
});

test("browser resolver matches the shared cross-runtime conformance fixture", () => {
	const fixture = JSON.parse(readFileSync(resolve(process.cwd(), "../resources/design-tokens/theme-conformance.json"), "utf8")) as { theme: unknown; expected: Record<string, string> };
	const theme = parseUserColorTheme(JSON.stringify(fixture.theme));
	for (const [token, expected] of Object.entries(fixture.expected)) assert.equal(theme.getColorCss(token), expected, token);
});
