import assert from 'node:assert/strict';
import { test } from 'mocha';
import { NullRenameSymbolTrackerService } from '../../../browser/services/renameSymbolTrackerService.js';

test('null rename tracker exposes one stable empty observable', () => {
	const service = new NullRenameSymbolTrackerService();
	assert.equal(service.trackedWord.get(), undefined);
	let changes = 0;
	using listener = service.trackedWord.onDidChange(() => changes++);
	assert.equal(service.trackedWord.get(), undefined);
	assert.equal(changes, 0);
});
