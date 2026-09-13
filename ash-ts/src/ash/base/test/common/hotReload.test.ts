import assert from "node:assert/strict";
import { test } from "mocha";
import { enableHotReload, isHotReloadEnabled, registerHotReloadHandler } from "../../common/hotReload.js";

type HotReloadGlobal = typeof globalThis & {
	$hotReload_applyNewExports?: (request: { readonly oldExports: Record<string, unknown>; readonly newSrc: string; readonly config?: { readonly mode?: "patch-prototype" } }) => ((newExports: Record<string, unknown>) => boolean) | undefined;
};

test("hot reload patches existing class instances and preserves canonical exports", () => {
	class Initial {
		value(): string { return "initial"; }
		stale(): string { return "stale"; }
	}
	class Replacement {
		value(): string { return "replacement"; }
		added(): string { return "added"; }
	}

	enableHotReload();
	assert.equal(isHotReloadEnabled(), true);
	const oldExports: Record<string, unknown> = { Example: Initial };
	const newExports: Record<string, unknown> = { Example: Replacement };
	const accept = hotReloadGlobal().$hotReload_applyNewExports?.({ oldExports, newSrc: "test/example.ts", config: { mode: "patch-prototype" } });
	const instance = new Initial() as Initial & { added(): string; stale?: () => string };

	assert.equal(accept?.(newExports), true);
	assert.equal(instance.value(), "replacement");
	assert.equal(instance.added(), "added");
	assert.equal(instance.stale, undefined);
	assert.equal(newExports.Example, Initial);
});

test("hot reload rejects incompatible prototype and export shapes", () => {
	class FirstBase {}
	class SecondBase {}
	class Initial extends FirstBase {}
	class Replacement extends SecondBase {}
	const apply = hotReloadGlobal().$hotReload_applyNewExports;

	const incompatible = apply?.({ oldExports: { Example: Initial }, newSrc: "test/incompatible.ts", config: { mode: "patch-prototype" } });
	assert.equal(incompatible?.({ Example: Replacement }), false);
	const changedExports = apply?.({ oldExports: { Example: Initial }, newSrc: "test/shape.ts", config: { mode: "patch-prototype" } });
	assert.equal(changedExports?.({ Example: Initial, Added: Replacement }), false);
});

test("hot reload composes registered handlers and releases them", () => {
	let calls = 0;
	const registration = registerHotReloadHandler(({ config }) => {
		if (config.mode !== undefined) return undefined;
		return () => {
			calls += 1;
			return true;
		};
	});
	const apply = hotReloadGlobal().$hotReload_applyNewExports;
	const accept = apply?.({ oldExports: {}, newSrc: "test/custom.ts" });
	assert.equal(accept?.({}), true);
	assert.equal(calls, 1);
	registration.dispose();
	assert.equal(apply?.({ oldExports: {}, newSrc: "test/custom.ts" }), undefined);
});

function hotReloadGlobal(): HotReloadGlobal {
	return globalThis as HotReloadGlobal;
}
