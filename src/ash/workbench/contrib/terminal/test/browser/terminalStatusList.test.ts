import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import Severity from '../../../../../base/common/severity.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TerminalStatusList } from '../../browser/terminalStatusList.js';
import type { ITerminalStatus } from '../../common/terminal.js';

suite('Terminal status notifications', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('secondary status updates notify consumers while the primary error remains selected', () => {
		using statuses = new TerminalStatusList();
		const error = { id: 'process-error', severity: Severity.Error, tooltip: 'Process failed' };
		statuses.add(error);
		const events: [string, ITerminalStatus][] = [];
		const primaryChanges: (ITerminalStatus | undefined)[] = [];
		using added = statuses.onDidAddStatus(status => events.push(['add', status]));
		using removed = statuses.onDidRemoveStatus(status => events.push(['remove', status]));
		using primary = statuses.onDidChangePrimaryStatus(status => primaryChanges.push(status));
		const original = { id: 'integration', severity: Severity.Info, tooltip: 'Basic' };
		const updated = { ...original, tooltip: 'Rich' };
		statuses.add(original);
		statuses.add(updated);
		statuses.add(updated);
		statuses.remove(original.id);
		statuses.remove(original.id);
		assert.deepEqual(events, [
			['add', original],
			['remove', original],
			['add', updated],
			['remove', updated],
		]);
		assert.deepEqual(primaryChanges, []);
		assert.equal(statuses.primary, error);
		assert.deepEqual(statuses.statuses, [error]);
	});

	test('replacement wins an equal-severity tie and events expose committed state', () => {
		using statuses = new TerminalStatusList();
		const first = { id: 'first', severity: Severity.Warning, tooltip: 'First' };
		const second = { id: 'second', severity: Severity.Warning, tooltip: 'Second' };
		statuses.add(first);
		statuses.add(second);
		assert.equal(statuses.primary, second);
		const updated = { ...first, tooltip: 'Updated' };
		using listener = statuses.onDidAddStatus(status => {
			assert.equal(status, updated);
			assert.equal(statuses.primary, updated);
			assert.deepEqual(statuses.statuses, [second, updated]);
		});
		statuses.add(updated);
		assert.equal(statuses.primary, updated);
	});
});
