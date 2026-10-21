import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "mocha";
import { findDesktopRoot } from "./testPaths.js";

const desktopRoot = findDesktopRoot(import.meta.dirname);

test("Hot reload runtime stays independent of Vite and Workbench", () => {
	for (const file of ["hotReload.ts", "hotReloadHelpers.ts"]) {
		const source = readFileSync(resolve(desktopRoot, "src/ash/base/common", file), "utf8");
		assert.doesNotMatch(source, /from\s+["']vite["']|import\.meta\.hot|workbench/u, file);
	}
});
