import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "mocha";
import { findDesktopRoot } from "./testPaths.js";

const desktopRoot = findDesktopRoot(import.meta.dirname);

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
