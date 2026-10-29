import assert from 'node:assert/strict';
import { test } from 'mocha';
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { InMemoryConfigurationService } from '../../../configuration/common/inMemoryConfigurationService.js';
import { ConfigurationRegistry } from '../../../configuration/common/configurationRegistry.js';
import { ContextKeyService } from '../../../contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../contextkey/common/contextkey.js';
import { bindContextKey, observableConfigValue } from '../../common/platformObservableUtils.js';

test('configuration observables read current values and ignore unrelated settings after disposal', async () => {
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: 'scm.workingSets.enabled', defaultValue: false, parse: value => Boolean(value) });
	registry.registerConfiguration({ key: 'editor.fontSize', defaultValue: 14, parse: value => Number(value) });
	using configuration = new InMemoryConfigurationService(registry);
	const value = observableConfigValue('scm.workingSets.enabled', false, configuration);
	const observed: boolean[] = [];
	using reaction = autorun(reader => observed.push(value.read(reader)));
	await configuration.updateValue('editor.fontSize', 18);
	await configuration.updateValue('scm.workingSets.enabled', true);
	await configuration.updateValue('scm.workingSets.enabled', undefined);
	reaction.dispose();
	await configuration.updateValue('scm.workingSets.enabled', true);
	assert.deepEqual({ observed, current: value.get() }, { observed: [false, true, false], current: true });
});

test('context bindings follow computed state and stop updating when their owner disposes', () => {
	using contexts = new ContextKeyService();
	const visible = observableValue('visible', false);
	const enabled = observableValue('enabled', true);
	const key = new RawContextKey('inlineSuggestionVisible', false);
	using binding = bindContextKey(key, contexts, reader => visible.read(reader) && enabled.read(reader));
	visible.set(true);
	assert.equal(contexts.getValue(key.key), true);
	enabled.set(false);
	assert.equal(contexts.getValue(key.key), false);
	binding.dispose();
	enabled.set(true);
	assert.equal(contexts.getValue(key.key), false);
});
