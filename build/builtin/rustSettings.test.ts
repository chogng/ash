import assert from 'node:assert/strict';
import test from 'node:test';
import { rustSettings } from './rustSettings.ts';

test('Rust settings preserve server constraints, localize metadata and apply only the memory default', () => {
	const schema = [{
		properties: {
			'rust-analyzer.cachePriming.enable': { type: 'boolean', default: true, markdownDescription: 'Prime caches.' },
			'rust-analyzer.lru.capacity': { type: ['null', 'integer'], minimum: 0, default: null, markdownDescription: 'Cached syntax trees.' },
			'rust-analyzer.check.command': { type: 'string', default: 'check', enum: ['check', 'clippy'], enumDescriptions: ['Check', 'Lint'], markdownDescription: 'Check command.' },
			'rust-analyzer.numThreads': { default: null, markdownDescription: 'Worker threads.', anyOf: [{ type: 'null' }, { type: 'string', enum: ['physical'], enumDescriptions: ['Physical cores'] }] },
		}
	}];
	const { properties, messages } = rustSettings(schema);
	assert.deepEqual(properties['rust-analyzer.lru.capacity'], { type: ['null', 'integer'], minimum: 0, default: null, title: '%lru.capacity.title%', markdownDescription: '%lru.capacity.description%', scope: 'resource' });
	assert.equal((properties['rust-analyzer.cachePriming.enable'] as { default: boolean; }).default, false);
	assert.deepEqual((properties['rust-analyzer.check.command'] as { enumDescriptions: string[]; }).enumDescriptions, ['%check.command.enum.0%', '%check.command.enum.1%']);
	assert.equal(messages['check.command.enum.1'], 'Lint');
	assert.equal(messages['numThreads.anyOf.1.enum.0'], 'Physical cores');
	assert.match(messages['cachePriming.enable.description'], /does not save analysis to disk/u);
	assert.match(messages['lru.capacity.description'], /counts entries, not megabytes/u);
	assert.match(messages['numThreads.description'], /does not set a limit on retained analysis memory/u);
	assert.equal(schema[0].properties['rust-analyzer.cachePriming.enable'].default, true);
	assert.throws(() => rustSettings([schema[0], schema[0]]), /duplicate/u);
	assert.throws(() => rustSettings([{ properties: { 'server.path': {} } }]), /Invalid/u);
});
