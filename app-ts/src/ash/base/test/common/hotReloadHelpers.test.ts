import assert from "node:assert/strict";
import { test } from "mocha";
import { enableHotReload } from "../../common/hotReload.js";
import { createHotClass } from "../../common/hotReloadHelpers.js";
import { readHotReloadableExport } from "../../common/hotReloadHelpers.js";
import type { IObservable } from "../../common/observable.js";
import type { IReader } from "../../common/observable.js";
import type { IDisposable } from "../../common/lifecycle.js";

type HotReloadGlobal = typeof globalThis & {
	$hotReload_applyNewExports?: (request: { readonly oldExports: Record<string, unknown>; readonly newSrc: string }) => ((newExports: Record<string, unknown>) => boolean) | undefined;
};

enableHotReload();

test("readHotReloadableExport invalidates its reader when the defining module reloads", () => {
	const exported = () => "before";
	using reader = new TestReader();
	assert.equal(readHotReloadableExport(exported, reader), exported);

	const accept = (globalThis as HotReloadGlobal).$hotReload_applyNewExports?.({ oldExports: { exported }, newSrc: "feature.ts" });
	assert.ok(accept);
	assert.equal(accept({ exported: () => "after" }), true);
	assert.equal(reader.invalidations, 1);
});

test("readHotReloadableExport ignores unrelated module replacements", () => {
	const exported = () => "tracked";
	using reader = new TestReader();
	readHotReloadableExport(exported, reader);

	const accept = (globalThis as HotReloadGlobal).$hotReload_applyNewExports?.({ oldExports: { unrelated: () => undefined }, newSrc: "other.ts" });
	assert.equal(accept, undefined);
	assert.equal(reader.invalidations, 0);
});

test("createHotClass retains one observable slot across class replacement", async () => {
	const Original = class HotReloadHelpersFixture {};
	const original = createHotClass(Original);
	const Replacement = class HotReloadHelpersFixture {};
	const replacement = createHotClass(Replacement);

	assert.equal(replacement, original);
	assert.notEqual(original.get(), Replacement);
	const accept = (globalThis as HotReloadGlobal).$hotReload_applyNewExports?.({ oldExports: { HotReloadHelpersFixture: Original }, newSrc: "hotClass.ts" });
	assert.ok(accept);
	assert.equal(accept({ HotReloadHelpersFixture: Replacement }), true);
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(original.get(), Replacement);
});

class TestReader implements IReader, IDisposable {
	private registration: IDisposable | undefined;
	invalidations = 0;

	readObservable<T>(observable: IObservable<T>): T {
		this.registration?.dispose();
		this.registration = observable.onDidChange(() => this.invalidations += 1);
		return observable.get();
	}

	dispose(): void {
		this.registration?.dispose();
	}

	[Symbol.dispose](): void {
		this.dispose();
	}
}
