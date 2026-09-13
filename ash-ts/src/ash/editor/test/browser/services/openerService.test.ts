import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { OpenerService } from '../../../browser/services/openerService.js';
import { type ICodeEditorService } from '../../../browser/services/codeEditorService.js';

test('opener service validates and prioritizes registered openers', async () => {
	const service = new OpenerService(editorService());
	using validator = service.registerValidator({ shouldOpen: target => !target.toString().includes('blocked') });
	using opener = service.registerOpener({ open: target => target.toString().includes('handled') });
	assert.equal(await service.open(URI.parse('test:handled')), true);
	assert.equal(await service.open(URI.parse('test:blocked')), false);
	assert.equal(await service.open(URI.parse('test:other')), false);
	service.dispose();
});

test('opener service resolves and delegates external resources explicitly', async () => {
	const service = new OpenerService(editorService());
	const opened: string[] = [];
	using resolver = service.registerExternalUriResolver({
		resolveExternalUri: resource => ({ resolved: URI.parse(`https://proxy.invalid/?target=${encodeURIComponent(resource.toString())}`) }),
	});
	service.setDefaultExternalOpener({
		openExternal: href => {
			opened.push(href);
			return true;
		},
	});
	assert.equal(await service.open('https://example.invalid/path'), true);
	assert.equal(opened.length, 1);
	assert.match(opened[0]!, /^https:\/\/proxy\.invalid\//);
	service.dispose();
});

function editorService(): ICodeEditorService {
	return {
		getFocusedCodeEditor: () => null,
		openCodeEditor: async () => null,
	} as unknown as ICodeEditorService;
}
