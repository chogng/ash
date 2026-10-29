import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ShellEnvDetectionCapability } from '../../../common/capabilities/shellEnvDetectionCapability.js';

suite('Shell environment transactions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('publishes atomically, suppresses unchanged snapshots and does not lend mutable state', () => {
		using capability = new ShellEnvDetectionCapability();
		const events: unknown[] = [];
		using listener = capability.onDidChangeEnv(value => events.push(value));
		const values = { PATH: '/initial' };
		capability.setEnvironment(values, true);
		values.PATH = '/outside';
		capability.startEnvironmentSingleVar(true, true);
		capability.setEnvironmentSingleVar('PATH', '/current', true);
		assert.deepEqual(capability.env, { value: { PATH: '/initial' }, isTrusted: true });
		capability.endEnvironmentSingleVar(true);
		assert.deepEqual(capability.env, { value: { PATH: '/current' }, isTrusted: true });
		capability.setEnvironment({ PATH: '/current' }, true);
		assert.equal(events.length, 2);
		assert.throws(() => {
			capability.env.value!.PATH = 'outside';
		});
	});

	test('a forged fragment or end cannot regain trust, and abort clears an incomplete transaction', () => {
		using capability = new ShellEnvDetectionCapability();
		capability.setEnvironment({ FIRST: 'one', REMOVE: 'two' }, true);
		capability.startEnvironmentSingleVar(false, true);
		capability.setEnvironmentSingleVar('FIRST', 'changed', false);
		capability.deleteEnvironmentSingleVar('REMOVE', 'two', true);
		capability.endEnvironmentSingleVar(true);
		assert.deepEqual(capability.env, { value: { FIRST: 'changed' }, isTrusted: false });
		capability.startEnvironmentSingleVar(true, true);
		capability.setEnvironmentSingleVar('PARTIAL', 'secret', true);
		capability.setEnvironment(undefined, false);
		capability.endEnvironmentSingleVar(true);
		assert.deepEqual(capability.env, { value: undefined, isTrusted: false });
		capability.startEnvironmentSingleVar(true, true);
		capability.setEnvironmentSingleVar('NEXT', 'ready', true);
		capability.endEnvironmentSingleVar(false);
		assert.deepEqual(capability.env, { value: { NEXT: 'ready' }, isTrusted: false });
	});
});
