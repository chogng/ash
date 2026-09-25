import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { ExplorerService } from '../../browser/explorerService.js';
import { ExplorerItem } from '../../common/explorerModel.js';

test('Explorer service exposes the current view and releases it on disposal', () => {
	const service = new ExplorerService();
	const selected = new ExplorerItem(URI.file('/project/main.ts'), 'main.ts', FileKind.File);
	let focused = 0;
	assert.deepEqual(service.getContext(), []);
	assert.equal(service.getAccessibleContent(), undefined);
	const view = {
		getContext: () => [selected],
		getAccessibleContent: () => 'main.ts',
		focus: () => { focused++; },
	};
	const registration = service.registerView(view);
	assert.deepEqual(service.getContext(), [selected]);
	assert.equal(service.getAccessibleContent(), 'main.ts');
	service.focus();
	assert.equal(focused, 1);
	assert.throws(() => service.registerView(view), /already registered/);
	registration.dispose();
	assert.deepEqual(service.getContext(), []);
	assert.equal(service.getAccessibleContent(), undefined);
	using next = service.registerView(view);
	assert.deepEqual(service.getContext(), [selected]);
});
