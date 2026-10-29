import assert from 'node:assert/strict';
import { test } from 'mocha';
import manifest from '../../../../../../../extensions/git/package.json' with { type: 'json' };
import { Emitter } from '../../../../../base/common/event.js';
import { ConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { CommandsRegistry, type ICommandService } from '../../../../../platform/commands/common/commands.js';
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
import type { ServerNotification } from '../../../../../../../.build/protocol/typescript/index.js';
import { parseExtensionManifest } from '../../../../services/extensions/common/extensionManifest.js';
import { ExtensionSettingBinding } from '../../browser/extensionSettingBinding.js';

// Git policy and history cases run against the standalone Rust executable and the
// shared Git runtime. These units retain the Settings client's public binding contract.
for (const [key, property, write, initial, next] of [
	['git.autofetch', 'autoFetch', 'git.updateAutoFetch', false, 'all'],
	['git.autofetchPeriod', 'autoFetchPeriod', 'git.updateAutoFetchPeriod', 180, 60],
	['git.rebaseWhenSync', 'rebaseWhenSync', 'git.updateRebaseWhenSync', false, true],
] as const)
	test(`${key} uses its Rust extension command binding and retains saved state on failure`, async () => {
		const registry = new ConfigurationRegistry();
		registry.updateConfigurations({
			add: [
				...parseExtensionManifest(JSON.stringify(manifest), {
					id: 'ash.git',
					name: 'git',
					publisher: 'ash',
					version: '0.1.0',
				}).contributes.configuration,
			],
			remove: [],
		});
		let saved: unknown = initial,
			fail = false;
		const calls: { id: string; value: unknown }[] = [];
		using command = CommandsRegistry.register('git.readSettings', () => ({ [property]: saved }));
		using events = new Emitter<ServerNotification>();
		const commands = {
			async executeCommand(id: string, ...args: unknown[]) {
				if (id === 'git.readSettings') return { [property]: saved };
				assert.equal(id, write);
				calls.push({ id, value: args[0] });
				if (fail) throw new Error('Shared settings conflict');
				saved = args[0];
				return undefined;
			},
		} as ICommandService;
		using binding = new ExtensionSettingBinding(
			registry.getConfiguration(key)!,
			commands,
			{ subscribe: listener => events.event(listener) },
			new NullLoggerService(),
		);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(binding.getValue(), initial);
		await binding.updateValue(next);
		assert.equal(saved, next);
		assert.equal(binding.getValue(), next);
		fail = true;
		await assert.rejects(binding.resetValue(), /Shared settings conflict/);
		assert.equal(binding.getValue(), next);
		assert.equal(saved, next);
		fail = false;
		await binding.resetValue();
		assert.equal(binding.getValue(), initial);
		const before = calls.length;
		await assert.rejects(binding.updateValue({ invalid: true }), TypeError);
		assert.equal(calls.length, before, 'invalid values never reach the extension');
	});
