import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import type { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { FileService } from '../../../files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../files/common/inMemoryFilesystemProvider.js';
import { NullLoggerService } from '../../../log/common/log.js';
import { FilePolicyService } from '../../common/filePolicyService.js';
import { AbstractPolicyService, NullPolicyService, PolicyValueSource, validatePolicyDefinitions } from '../../common/policy.js';
import { MultiplexPolicyService } from '../../common/multiplexPolicyService.js';
import { PolicyChannel, PolicyChannelClient } from '../../common/policyIpc.js';
import { SystemPolicyService } from '../../node/systemPolicyService.js';
import { ConfigurationRegistry } from '../../../configuration/common/configurationRegistry.js';
import { PolicyConfiguration } from '../../../configuration/common/configurations.js';

const log = new NullLoggerService();

class MutablePolicySource extends AbstractPolicyService {
	private candidate: Record<string, import('../../../../base/common/policy.js').PolicyValue> = {};
	private origin = PolicyValueSource.Device;
	replace(values: typeof this.candidate, source = this.origin): void {
		this.candidate = values;
		this.origin = source;
		this.accept(values, source);
	}
	protected async refresh(): Promise<void> { this.accept(this.candidate, this.origin); }
}

test('Policy serialization removes callbacks, detaches metadata and includes unset definitions', async () => {
	using source = new MutablePolicySource();
	await source.updatePolicyDefinitions({
		Mapped: { type: 'boolean', managedSettings: { flag: { type: 'boolean' } }, value: () => true },
		Unset: { type: 'string' },
	});
	source.replace({ Mapped: false }, PolicyValueSource.ServerManagedSettings);
	const snapshot = source.serialize();
	assert.deepEqual(structuredClone(snapshot), {
		Mapped: { definition: { type: 'boolean', managedSettings: { flag: { type: 'boolean' } } }, value: false },
		Unset: { definition: { type: 'string' }, value: undefined },
	});
	assert.notEqual(snapshot.Mapped!.definition.managedSettings, source.policyDefinitions.Mapped!.managedSettings);
	snapshot.Mapped = { definition: { type: 'number' }, value: 5 };
	assert.equal(source.getPolicyValue('Mapped'), false);
	assert.equal(source.getPolicyValueSource('Unset'), undefined);
	assert.equal(new NullPolicyService().serialize(), undefined);
});

test('Equal policy values still notify when precedence changes their source', async () => {
	using device = new MutablePolicySource();
	using account = new MutablePolicySource();
	device.replace({ Enabled: false });
	account.replace({ Enabled: false }, PolicyValueSource.ServerManagedSettings);
	using combined = new MultiplexPolicyService([device, account]);
	await combined.updatePolicyDefinitions({ Enabled: { type: 'boolean' } });
	const changes: (readonly string[])[] = [];
	using listener = combined.onDidChange(names => changes.push(names));
	assert.equal(combined.getPolicyValueSource('Enabled'), PolicyValueSource.Device);
	device.replace({});
	assert.equal(combined.getPolicyValue('Enabled'), false);
	assert.equal(combined.getPolicyValueSource('Enabled'), PolicyValueSource.ServerManagedSettings);
	account.replace({ Enabled: false }, PolicyValueSource.ServerManagedSettings);
	account.replace({});
	assert.equal(combined.getPolicyValueSource('Enabled'), undefined);
	assert.deepEqual(changes, [['Enabled'], ['Enabled']]);
});

test('Main IPC propagates source-only changes and rejects a malformed snapshot atomically', async () => {
	using source = new MutablePolicySource();
	source.replace({ Enabled: false });
	using server = new PolicyChannel(source);
	let malformed = false;
	const channel: IChannel = {
		call: async <T>(command: string, argument?: unknown) => malformed
			? { Enabled: { value: true, source: 'untrusted-source' } } as T
			: server.call<T>('window:1', command, argument),
		listen: event => server.listen('window:1', event),
	};
	using client = new PolicyChannelClient(channel);
	await client.updatePolicyDefinitions({ Enabled: { type: 'boolean' } });
	assert.equal(client.getPolicyValueSource('Enabled'), PolicyValueSource.Device);
	let changes = 0;
	using listener = client.onDidChange(() => changes++);
	source.replace({ Enabled: false }, PolicyValueSource.ServerManagedSettings);
	assert.equal(client.getPolicyValueSource('Enabled'), PolicyValueSource.ServerManagedSettings);
	assert.equal(changes, 1);
	malformed = true;
	await assert.rejects(client.updatePolicyDefinitions({}), /Invalid policy source/);
	assert.deepEqual([client.getPolicyValue('Enabled'), client.getPolicyValueSource('Enabled'), changes], [false, PolicyValueSource.ServerManagedSettings, 1]);
});

test('System file source crosses Main IPC and enforces a registered configuration policy', async () => {
	using provider = new InMemoryFileSystemProvider();
	using files = new FileService();
	using registration = files.registerProvider('file', provider);
	const file = URI.file('/etc/ash/policies.json');
	await files.createDirectory(URI.file('/etc/ash'));
	await files.writeFile({ resource: file, content: '{ "DesktopUpdateChannel": "never", "Unknown": false }' });
	using source = new FilePolicyService(file, files, log);
	using channel = new PolicyChannel(source);
	const clientChannel: IChannel = {
		call: (command, arg) => channel.call('window:1', command, arg),
		listen: event => channel.listen('window:1', event),
	};
	using client = new PolicyChannelClient(clientChannel);
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({
		key: 'update.policy', defaultValue: 'latest', policy: { name: 'DesktopUpdateChannel' }, parse: value => {
			if (value === 'latest' || value === 'stable' || value === 'never') return value;
			throw new TypeError('Invalid update channel');
		}
	});
	using policy = new PolicyConfiguration(registry, client, log);
	await policy.initialize();
	assert.equal(policy.configurationModel.getValue('update.policy'), 'never');
	await files.writeFile({ resource: file, content: '{ "DesktopUpdateChannel": 42 }' });
	await assert.rejects(client.updatePolicyDefinitions({ DesktopUpdateChannel: { type: 'string' } }), /Invalid policy value/);
	assert.equal(client.getPolicyValue('DesktopUpdateChannel'), 'never');
	await files.delete(file, 'error', 'fileOrEmptyDirectory');
	await client.updatePolicyDefinitions({ DesktopUpdateChannel: { type: 'string' } });
	assert.equal(policy.configurationModel.getValue('update.policy'), undefined);
});

test('Policy IPC refuses writes, malformed definitions and prototype keys', async () => {
	class Source extends AbstractPolicyService {
		protected async refresh(): Promise<void> { this.accept({}); }
	}
	using source = new Source();
	using channel = new PolicyChannel(source);
	assert.throws(() => channel.call('window:1', 'setPolicy', { DesktopUpdateChannel: 'never' }), /Unknown policy command/);
	assert.throws(() => channel.call('window:1', 'updatePolicyDefinitions', { DesktopUpdateChannel: { type: 'object' } }), /Invalid policy/);
	assert.throws(() => validatePolicyDefinitions(JSON.parse('{"__proto__":{"type":"string"}}')), /Invalid policy/);
	assert.equal(source.getPolicyValue('constructor'), undefined);
});

test('A notification during the initial policy snapshot preserves unchanged keys and newer removals', async () => {
	using notifications = new Emitter<unknown>();
	let finish!: (values: unknown) => void;
	const response = new Promise<unknown>(resolve => { finish = resolve; });
	const channel: IChannel = { call: async <T>() => await response as T, listen: <T>() => notifications.event as import('../../../../base/common/event.js').Event<T> };
	using client = new PolicyChannelClient(channel);
	const initializing = client.updatePolicyDefinitions({ First: { type: 'string' }, Second: { type: 'string' }, Removed: { type: 'boolean' } });
	notifications.fire({ Second: { value: 'new', source: PolicyValueSource.ServerManagedSettings }, Removed: null });
	finish({ First: { value: 'unchanged', source: PolicyValueSource.Device }, Second: { value: 'old', source: PolicyValueSource.Device }, Removed: { value: true, source: PolicyValueSource.Device } });
	await initializing;
	assert.deepEqual([client.getPolicyValue('First'), client.getPolicyValue('Second')], ['unchanged', 'new']);
	assert.deepEqual([client.getPolicyValueSource('First'), client.getPolicyValueSource('Second')], [PolicyValueSource.Device, PolicyValueSource.ServerManagedSettings]);
	assert.equal(client.getPolicyValue('Removed'), undefined);
	assert.equal(client.getPolicyValueSource('Removed'), undefined);
	notifications.fire({ Second: null });
	assert.equal(client.getPolicyValue('Second'), undefined);
	assert.equal(client.getPolicyValueSource('Second'), undefined);
});

test('System source retains the last valid snapshot on read failure and releases polling on disposal', async () => {
	let candidate: unknown = { Enabled: true };
	let reads = 0;
	using source = new SystemPolicyService(log, async () => { reads++; if (candidate instanceof Error) throw candidate; return candidate; }, 100000);
	await source.updatePolicyDefinitions({ Enabled: { type: 'boolean' } });
	assert.equal(source.getPolicyValue('Enabled'), true);
	candidate = new Error('Read failed');
	await assert.rejects(source.updatePolicyDefinitions({ Enabled: { type: 'boolean' } }), /Read failed/);
	assert.equal(source.getPolicyValue('Enabled'), true);
	source.dispose();
	await source.updatePolicyDefinitions({ Enabled: { type: 'boolean' } });
	assert.equal(reads, 2);
});

test('New definitions arriving during an OS read trigger a current complete snapshot', async () => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let reads = 0;
	using source = new SystemPolicyService(log, async definitions => {
		reads++;
		if (reads === 1) await gate;
		return Object.fromEntries(Object.keys(definitions).map(name => [name, true]));
	}, 100000);
	const first = source.updatePolicyDefinitions({ First: { type: 'boolean' } });
	const second = source.updatePolicyDefinitions({ Second: { type: 'boolean' } });
	release();
	await Promise.all([first, second]);
	assert.deepEqual([source.getPolicyValue('First'), source.getPolicyValue('Second'), reads], [true, true, 2]);
});

test('The production Windows reader can inspect its fixed registry location without changing it', async function () {
	if (process.platform !== 'win32') { this.skip(); return; }
	using source = new SystemPolicyService(log);
	const values = await source.updatePolicyDefinitions({ DesktopUpdateChannel: { type: 'string' } });
	assert.ok(!Object.hasOwn(values, 'DesktopUpdateChannel') || ['latest', 'stable', 'never'].includes(values.DesktopUpdateChannel as string));
});

test('Unavailable system policy reports its startup error and later recovers through the real configuration owner', async () => {
	let unavailable = true;
	const errors: unknown[] = [];
	using source = new SystemPolicyService(log, async () => {
		if (unavailable) throw new Error('System policy unavailable');
		return { ManagedStartup: true };
	}, 100000);
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: 'policy.startup', defaultValue: false, policy: { name: 'ManagedStartup' }, parse: value => value as boolean });
	using configuration = new PolicyConfiguration(registry, source, log, error => errors.push(error));
	await configuration.initialize();
	assert.equal(errors.length, 1);
	assert.equal(configuration.configurationModel.getValue('policy.startup'), undefined);
	unavailable = false;
	await source.updatePolicyDefinitions({});
	assert.equal(configuration.configurationModel.getValue('policy.startup'), true);
});
