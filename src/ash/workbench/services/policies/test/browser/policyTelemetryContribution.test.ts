import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { test } from 'mocha';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { AbstractPolicyService, IPolicyService, NullPolicyService, PolicyValueSource } from '../../../../../platform/policy/common/policy.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryServiceShape } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { PolicyTelemetryContribution } from '../../browser/policyTelemetry.contribution.js';

class RecordingTelemetry extends NullTelemetryServiceShape {
	readonly events: { name: string; data: unknown; }[] = [];
	override publicLog2: ITelemetryService['publicLog2'] = (name, data) => { this.events.push({ name, data }); };
}

test('Policy diagnostics bucket all applied sources without exposing policy names, values or account data', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		using services = new InstantiationService();
		const telemetry = new RecordingTelemetry();
		services.registerInstance(ITelemetryService, telemetry);
		assert.throws(() => services.createInstance(PolicyTelemetryContribution), /Unknown service.*policyService/);
		class Source extends AbstractPolicyService {
			origin = PolicyValueSource.Device;
			protected async refresh(): Promise<void> {
				this.accept(Object.fromEntries(Object.keys(this.policyDefinitions).map(name => [name, 'private value'])), this.origin);
			}
		}
		using policies = new Source();
		await policies.updatePolicyDefinitions(Object.fromEntries(Array.from({ length: 23 }, (_, index) => [`PrivatePolicy${index}`, { type: 'string' as const }])));
		services.registerInstance(IPolicyService, policies);
		using contribution = services.createInstance(PolicyTelemetryContribution);
		mock.timers.tick(500);
		assert.deepEqual(telemetry.events, [...Object.values(PolicyValueSource), 'unknown'].map(source => ({
			name: 'policySourceCounts', data: { source, countBucket: source === PolicyValueSource.Device ? '21+' : '0' },
		})));
		policies.origin = PolicyValueSource.ServerManagedSettings;
		await policies.updatePolicyDefinitions({});
		mock.timers.tick(500);
		assert.deepEqual(telemetry.events.slice(8), [...Object.values(PolicyValueSource), 'unknown'].map(source => ({
			name: 'policySourceCounts', data: { source, countBucket: source === PolicyValueSource.ServerManagedSettings ? '21+' : '0' },
		})));
		await policies.updatePolicyDefinitions({});
		mock.timers.tick(500);
		assert.equal(telemetry.events.length, 16);
		contribution.dispose();
		policies.origin = PolicyValueSource.Device;
		await policies.updatePolicyDefinitions({});
		mock.timers.tick(500);
		assert.equal(telemetry.events.length, 16);
	} finally { mock.timers.reset(); }
});

test('An absent policy source reports empty buckets and disposal cancels the pending report', () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const telemetry = new RecordingTelemetry();
		using contribution = new PolicyTelemetryContribution(new NullPolicyService(), telemetry);
		mock.timers.tick(500);
		assert.deepEqual(telemetry.events, [...Object.values(PolicyValueSource), 'unknown'].map(source => ({ name: 'policySourceCounts', data: { source, countBucket: '0' } })));
		using cancelled = new PolicyTelemetryContribution(new NullPolicyService(), telemetry);
		cancelled.dispose();
		mock.timers.tick(500);
		assert.equal(telemetry.events.length, 8);
	} finally { mock.timers.reset(); }
});
