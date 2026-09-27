import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { readPersistedWorkbenchModeId } from '../../electron-main/readPersistedWorkbenchMode.js';
import { WorkbenchModeId } from '../../../workbench/common/workbenchMode.js';

test('persisted startup mode reads JSONC settings and accepts only a registered id', () => {
	const directory = mkdtempSync(join(tmpdir(), 'ash-mode-'));
	const filePath = join(directory, 'settings.json');
	try {
		assert.equal(readPersistedWorkbenchModeId(filePath, WorkbenchModeId.Code), WorkbenchModeId.Code);
		writeFileSync(filePath, '{\n\t// startup mode\n\t"workbench.mode": "academic",\n}\n');
		assert.equal(readPersistedWorkbenchModeId(filePath, WorkbenchModeId.Code), WorkbenchModeId.Academic);
		writeFileSync(filePath, '{ "workbench.mode": "unknown" }');
		assert.equal(readPersistedWorkbenchModeId(filePath, WorkbenchModeId.Code), WorkbenchModeId.Code);
		writeFileSync(filePath, '{ "version": 1, "values": { "workbench.mode": "academic" } }');
		assert.equal(readPersistedWorkbenchModeId(filePath, WorkbenchModeId.Code), WorkbenchModeId.Code);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
