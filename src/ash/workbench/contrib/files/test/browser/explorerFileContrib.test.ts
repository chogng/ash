import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ExplorerFileContributionRegistry } from '../../browser/explorerFileContrib.js';

test('Explorer file contributions are created per row and disposed with the row', () => {
	using registry = new ExplorerFileContributionRegistry();
	using row = new DisposableStore();
	const document = new JSDOM('<!doctype html><body></body>').window.document;
	const container = document.createElement('span');
	const resources: string[] = [];
	let registered = 0;
	let disposed = 0;
	registry.onDidRegisterDescriptor(() => registered++);
	registry.register({
		create: (_instantiationService, host) => {
			const badge = document.createElement('span');
			host.append(badge);
			return {
				setResource(resource) {
					badge.textContent = resource?.path ?? '';
					resources.push(badge.textContent);
				},
				dispose() {
					disposed++;
					badge.remove();
				},
				[Symbol.dispose]() {
					this.dispose();
				},
			};
		},
	});
	assert.equal(registered, 1);
	const [contribution] = registry.create({} as IInstantiationService, container, row);
	assert.ok(contribution);
	contribution.setResource(URI.file('/project/app.ts'));
	assert.deepEqual(resources, ['/project/app.ts']);
	assert.equal(container.textContent, '/project/app.ts');
	row.clear();
	assert.equal(disposed, 1);
	assert.equal(container.textContent, '');
});
