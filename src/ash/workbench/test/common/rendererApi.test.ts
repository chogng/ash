import assert from 'node:assert/strict';
import { test } from 'mocha';
import { type IDebugAdapterProcessService } from '../../../platform/debug/common/debugAdapterProcessService.js';
import { mergeWorkbenchHostCapabilities } from '../../browser/rendererApi.js';

test('Workbench startup capabilities compose empty and independent contributions', () => {
	const debugAdapter = {} as IDebugAdapterProcessService;
	assert.deepEqual(mergeWorkbenchHostCapabilities([]), {});
	assert.deepEqual(mergeWorkbenchHostCapabilities([{}, { debugAdapter }]), { debugAdapter });
});

test('Workbench startup capabilities reject duplicate owners', () => {
	const debugAdapter = {} as IDebugAdapterProcessService;
	assert.throws(() => mergeWorkbenchHostCapabilities([{ debugAdapter }, { debugAdapter }]), /contributed more than once/);
});
