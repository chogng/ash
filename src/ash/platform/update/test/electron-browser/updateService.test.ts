import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../configuration/common/inMemoryConfigurationService.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { IMainProcessService } from '../../../ipc/common/mainProcessService.js';
import { IMeteredConnectionService } from '../../../meteredConnection/common/meteredConnection.js';
import type { UpdateState } from '../../common/updateService.js';
import { ElectronUpdateService } from '../../electron-browser/updateService.js';

suite('Desktop update state', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const stateChangesBeforeSnapshot of [false, true]) {
		test(`restores restart readiness and follows the main owner (racing event: ${stateChangesBeforeSnapshot})`, async () => {
			using services = new InstantiationService();
			using configuration = new InMemoryConfigurationService();
			using changes = new Emitter<unknown>();
			const snapshot = new DeferredPromise<unknown>();
			services.registerInstance(IConfigurationService, configuration);
			services.registerInstance(IMeteredConnectionService, {
				_serviceBrand: undefined,
				isConnectionMetered: false,
				onDidChangeIsConnectionMetered: Event.None,
				whenConnectionStateInitialized: Promise.resolve(),
			});
			services.registerInstance(IMainProcessService, {
				_serviceBrand: undefined,
				getChannel: name => {
					assert.equal(name, 'update');
					return {
						call: <T>(command: string) => {
							assert.equal(command, 'state');
							return snapshot.p as Promise<T>;
						},
						listen: <T>(event: string) => {
							assert.equal(event, 'onDidChangeState');
							return changes.event as Event<T>;
						},
					};
				},
				registerChannel() {},
			});
			using update = services.createInstance(ElectronUpdateService);
			const states: UpdateState[] = [];
			using subscription = update.onDidChangeState(state => states.push(state));
			if (stateChangesBeforeSnapshot) changes.fire('ready');
			await snapshot.complete(stateChangesBeforeSnapshot ? 'downloading' : 'ready');
			await snapshot.p;
			assert.equal(update.state, 'ready');
			changes.fire('ready');
			changes.fire('installing');
			changes.fire('ready');
			assert.equal(update.state, 'ready');
			assert.deepEqual(states, ['ready', 'installing', 'ready']);
			update.dispose();
			changes.fire('idle');
			assert.deepEqual(states, ['ready', 'installing', 'ready']);
		});
	}
});
