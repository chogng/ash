import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { noneDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { OpenerService } from '../../../browser/services/openerService.js';
import { ICodeEditorService } from '../../../browser/services/codeEditorService.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('opener service validates and prioritizes registered openers', async () => {
	using services = new InstantiationService();
	services.registerInstance(ICodeEditorService, editorService());
	using service = services.createInstance(OpenerService);
	using validator = service.registerValidator({ shouldOpen: async target => !target.toString().includes('blocked') });
	using opener = service.registerOpener({ open: async target => target.toString().includes('handled') });
	assert.equal(await service.open(URI.parse('test:handled')), true);
	assert.equal(await service.open(URI.parse('test:blocked')), false);
	assert.equal(await service.open(URI.parse('test:other')), false);
});

test('opener service resolves and delegates external resources explicitly', async () => {
	using services = new InstantiationService();
	services.registerInstance(ICodeEditorService, editorService());
	using service = services.createInstance(OpenerService);
	const opened: string[] = [];
	using resolver = service.registerExternalUriResolver({
		resolveExternalUri: async resource => ({ resolved: URI.parse(`https://proxy.invalid/?target=${encodeURIComponent(resource.toString())}`), ...noneDisposable }),
	});
	service.setDefaultExternalOpener({
		openExternal: async href => {
			opened.push(href);
			return true;
		},
	});
	assert.equal(await service.open('https://example.invalid/path'), true);
	assert.equal(opened.length, 1);
	assert.match(opened[0]!, /^https:\/\/proxy\.invalid\//);
});

function editorService(): ICodeEditorService {
	return {
		getFocusedCodeEditor: () => null,
		openCodeEditor: async () => null,
	} as unknown as ICodeEditorService;
}

test('opener service requires its editor dependency at creation', () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(OpenerService), /codeEditorService/);
});
