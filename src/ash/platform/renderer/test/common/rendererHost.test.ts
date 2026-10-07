import assert from "node:assert/strict";
import { test } from "mocha";
import { type IDebugAdapterProcessService } from "../../../debug/common/debugAdapterProcessService.js";
import { mergeRendererHostCapabilities } from "../../common/rendererHost.js";

test("renderer host capabilities compose empty and independent contributions", () => {
	const debugAdapter = {} as IDebugAdapterProcessService;
	assert.deepEqual(mergeRendererHostCapabilities([]), {});
	assert.deepEqual(mergeRendererHostCapabilities([{}, { debugAdapter }]), { debugAdapter });
});

test("renderer host capabilities reject duplicate owners", () => {
	const debugAdapter = {} as IDebugAdapterProcessService;
	assert.throws(() => mergeRendererHostCapabilities([{ debugAdapter }, { debugAdapter }]), /contributed more than once/);
});
