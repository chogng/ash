import assert from "node:assert/strict";
import test from "node:test";

import { parsePackageManagerSpec, validatePackageManager } from "./packageManager.ts";

test("parses the root package manager contract", () => {
  assert.deepEqual(parsePackageManagerSpec("pnpm@11.17.0"), { name: "pnpm", version: "11.17.0" });
  assert.throws(() => parsePackageManagerSpec("pnpm"), /Invalid packageManager value/);
});

test("accepts only the pinned pnpm version", () => {
  const expected = parsePackageManagerSpec("pnpm@11.17.0");
  assert.doesNotThrow(() => validatePackageManager("pnpm/11.17.0 npm/? node/v24.14.0 win32 x64", expected));
  assert.throws(() => validatePackageManager("npm/11.0.0 node/v24.14.0 win32 x64", expected), /Use pnpm@11.17.0/);
  assert.throws(() => validatePackageManager("pnpm/11.16.0 npm/? node/v24.14.0 win32 x64", expected), {
    message: "Use pnpm@11.17.0; received pnpm/11.16.0. Install it with npm install -g pnpm@11.17.0.",
  });
});
