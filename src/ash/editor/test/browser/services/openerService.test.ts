import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { StandaloneCommandService } from '../../../standalone/browser/standaloneServices.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { noneDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { defaultExternalUriOpenerId } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import { OpenerService } from '../../../browser/services/openerService.js';
import { ICodeEditorService } from '../../../browser/services/codeEditorService.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('opener service validates and prioritizes registered openers', async () => {
	using services = new InstantiationService();
	services.registerInstance(ICodeEditorService, editorService());
	services.registerSingleton(ICommandService, () => services.createInstance(StandaloneCommandService));
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
	services.registerSingleton(ICommandService, () => services.createInstance(StandaloneCommandService));
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

test('explicit default selection bypasses all contributed handlers and releases a failed resolution', async () => {
	using services = new InstantiationService();
	services.registerInstance(ICodeEditorService, editorService());
	services.registerSingleton(ICommandService, () => services.createInstance(StandaloneCommandService));
	using opener = services.createInstance(OpenerService);
	const calls: string[] = [];
	using registered = opener.registerExternalOpener({ openExternal: async () => { assert.fail('Default selection must bypass contributed handlers'); } });
	using resolver = opener.registerExternalUriResolver({ resolveExternalUri: async () => ({ resolved: URI.parse('https://proxy.test/'), ...toDisposable(() => calls.push('release')) }) });
	opener.setDefaultExternalOpener({ openExternal: async href => { calls.push(href); throw new Error('host failed'); } });
	await assert.rejects(opener.open('https://example.test/', { allowContributedOpeners: defaultExternalUriOpenerId }), /host failed/u);
	assert.deepEqual(calls, ['https://proxy.test/', 'release']);
});

test('opener passes a file URI and decoded selection to its code editor service', async () => {
	using services = new InstantiationService();
	const editors = editorService();
	const opened: unknown[] = [];
	editors.openCodeEditor = async input => { opened.push(input); return null; };
	services.registerInstance(ICodeEditorService, editors);
	services.registerSingleton(ICommandService, () => services.createInstance(StandaloneCommandService));
	using opener = services.createInstance(OpenerService);
	await opener.open('file:///workspace/file.ts#12,7');
	assert.deepEqual(opened, [{ resource: URI.file('/workspace/file.ts'), options: { selection: { startLineNumber: 12, startColumn: 7, endLineNumber: undefined, endColumn: undefined } } }]);
});


test('command links execute decoded object, positional, scalar and empty arguments through the command service', async () => {
	using services = new InstantiationService();
	services.registerInstance(ICodeEditorService, editorService());
	services.registerSingleton(ICommandService, () => services.createInstance(StandaloneCommandService));
	using opener = services.createInstance(OpenerService);
	const calls: unknown[][] = [];
	using command = CommandsRegistry.register('test.opener.command', (_accessor, ...args) => calls.push([...args]));
	for (const value of [{ commands: ['first', 'second'], text: '%20 中文' }, ['one', 2], null, false, 0]) {
		assert.equal(await opener.open(`command:test.opener.command?${encodeURIComponent(JSON.stringify(value))}`, { allowCommands: true }), true);
	}
	await opener.open('command:///test.opener.command', { allowCommands: ['test.opener.command'] });
	assert.deepEqual(calls, [[{ commands: ['first', 'second'], text: '%20 中文' }], ['one', 2], [null], [false], [0], []]);
	await assert.rejects(opener.open('command:test.opener.command?not-json', { allowCommands: true }), SyntaxError);
	assert.equal(calls.length, 6);
});

test('command link permissions and validators prevent command, editor and external side effects', async () => {
	using services = new InstantiationService();
	services.registerInstance(ICodeEditorService, { ...editorService(), openCodeEditor: async () => { assert.fail('Commands must not open an editor'); } });
	services.registerSingleton(ICommandService, () => services.createInstance(StandaloneCommandService));
	using opener = services.createInstance(OpenerService);
	opener.setDefaultExternalOpener({ openExternal: async () => { assert.fail('Commands must not open externally'); } });
	let calls = 0;
	using command = CommandsRegistry.register('test.opener.permissions', () => calls++);
	const target = 'command:test.opener.permissions';
	assert.equal(await opener.open(target, { openExternal: true }), true);
	assert.equal(await opener.open(target, { allowCommands: false }), true);
	assert.equal(await opener.open(target, { allowCommands: ['other'] }), true);
	assert.equal(calls, 0);
	await opener.open(target, { allowCommands: ['test.opener.permissions'] });
	assert.equal(calls, 1);
	using validator = opener.registerValidator({ shouldOpen: async () => false });
	assert.equal(await opener.open(target, { allowCommands: true }), false);
	assert.equal(calls, 1);
});

test('opener service requires its command dependency at creation', () => {
	using services = new InstantiationService();
	services.registerInstance(ICodeEditorService, editorService());
	assert.throws(() => services.createInstance(OpenerService), /commandService/);
});
