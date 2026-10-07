import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import type { IExpression } from '../../../base/common/glob.js';
import { URI } from '../../../base/common/uri.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { InMemoryConfigurationService } from '../../../platform/configuration/common/inMemoryConfigurationService.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { ResourceGlobMatcher } from '../../common/resources.js';
import { WorkspaceContextService } from '../../services/workspaces/browser/workspaceContextService.js';

function registry(): ConfigurationRegistry {
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: 'test.expression', defaultValue: {} as IExpression, parse: value => value as IExpression });
	return registry;
}

suite('ResourceGlobMatcher', () => {
	test('resolves folder rules, nested roots and resources outside the workspace', () => {
		using workspace = new WorkspaceContextService({ id: 'multi', folders: [
			{ id: 'first', name: 'first', index: 0, uri: URI.file('/first') },
			{ id: 'nested', name: 'nested', index: 1, uri: URI.file('/first/nested') },
			{ id: 'second', name: 'second', index: 2, uri: URI.file('/second') },
		] });
		using configuration = new InMemoryConfigurationService(registry());
		using services = new InstantiationService();
		services.registerInstance(IWorkspaceContextService, workspace);
		services.registerInstance(IConfigurationService, configuration);
		using matcher = services.createInstance(ResourceGlobMatcher, (folder?: URI): IExpression => folder?.path === '/first' ? { 'src/**': true } : folder?.path === '/first/nested' ? { '*.json': true } : { '**/*.log': true }, () => true);
		assert.deepEqual(['/first/src/main.ts', '/first/nested/main.ts', '/first/nested/config.json', '/second/a.log', '/outside/a.log', '/outside/a.ts'].map(path => matcher.matches(URI.file(path))), [true, false, true, true, true, false]);
	});

	test('matches absolute Windows and non-file paths alongside relative rules', () => {
		using workspace = new WorkspaceContextService({ id: 'win', uri: URI.file('C:\\project') });
		using configuration = new InMemoryConfigurationService(registry());
		using matcher = new ResourceGlobMatcher(() => ({ 'C:\\project\\generated\\**': true, 'src/**': true, '/remote/**': true }), () => true, workspace, configuration);
		assert.deepEqual([
			matcher.matches(URI.file('C:\\project\\generated\\a.ts')),
			matcher.matches(URI.file('C:\\project\\src\\a.ts')),
			matcher.matches(URI.from({ scheme: 'test-resource', path: '/remote/a.ts' })),
		], [true, true, true]);
	});

	test('announces effective changes, discards removed roots and releases listeners', async () => {
		using workspace = new WorkspaceContextService({ id: 'first', uri: URI.file('/first') });
		using configuration = new InMemoryConfigurationService(registry());
		const matcher = new ResourceGlobMatcher(() => configuration.getValue<IExpression>('test.expression'), event => event.affectsConfiguration('test.expression'), workspace, configuration);
		let changes = 0;
		using listener = matcher.onExpressionChange(() => changes++);
		await configuration.updateValue('test.expression', { 'src/**': true });
		assert.equal(matcher.matches(URI.file('/first/src/main.ts')), true);
		await configuration.updateValue('test.expression', { 'src/**': true });
		workspace.updateWorkspace({ id: 'second', uri: URI.file('/second') });
		assert.deepEqual([matcher.matches(URI.file('/first/src/main.ts')), matcher.matches(URI.file('/second/src/main.ts')), changes], [false, true, 2]);
		matcher.dispose();
		await configuration.updateValue('test.expression', {});
		assert.equal(changes, 2);
	});

	test('checks sibling conditions without retaining caller-owned expressions', async () => {
		using workspace = new WorkspaceContextService({ id: 'root', uri: URI.file('/root') });
		using configuration = new InMemoryConfigurationService(registry());
		const expression: IExpression = { '**/*.js': { when: '$(basename).ts' } };
		using matcher = new ResourceGlobMatcher(() => expression, () => true, workspace, configuration);
		(expression['**/*.js'] as { when: string }).when = 'other.ts';
		assert.equal(matcher.matches(URI.file('/root/main.js'), name => name === 'main.ts'), true);
		await configuration.updateValue('test.expression', { 'changed': true });
		assert.equal(matcher.matches(URI.file('/root/main.js'), name => name === 'main.ts'), false);
	});
});
