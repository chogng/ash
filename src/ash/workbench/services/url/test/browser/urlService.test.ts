import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { StandaloneCommandService } from '../../../../../editor/standalone/browser/standaloneServices.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { OpenerService } from '../../../../../editor/browser/services/openerService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { BrowserURLService } from '../../browser/urlService.js';

suite('Browser URL service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('opener product links and host callbacks reach the same handlers with distinct trust', async () => {
		using services = new InstantiationService();
		services.registerInstance(ICodeEditorService, { getFocusedCodeEditor: () => null, openCodeEditor: async () => null } as unknown as ICodeEditorService);
		services.registerSingleton(ICommandService, () => services.createInstance(StandaloneCommandService));
		using opener = services.createInstance(OpenerService);
		services.registerInstance(IOpenerService, opener);
		using callbacks = new Emitter<URI>();
		let callbackOptions: unknown;
		using service = services.createInstance(BrowserURLService, {
			onCallback: callbacks.event,
			create: (options: unknown) => { callbackOptions = options; return URI.parse('https://host.test/callback'); },
		});
		const received: unknown[] = [];
		using handler = service.registerHandler({ handleURL: async (uri, options) => { received.push([uri.toString(), options]); return true; } });
		const uri = URI.parse('ash://callback/result?code=a%26b');
		assert.equal(await opener.open(uri), true);
		callbacks.fire(uri);
		callbacks.fire(URI.parse('https://other.test/callback'));
		assert.deepEqual(received, [[uri.toString(), { trusted: true }], [uri.toString(), undefined]]);
		assert.equal(service.create({ authority: 'callback', query: 'state=abc' }).toString(), 'https://host.test/callback');
		assert.deepEqual(callbackOptions, { authority: 'callback', query: 'state=abc' });
		service.dispose();
		callbacks.fire(uri);
		assert.equal(await opener.open(uri), false);
		assert.equal(received.length, 2);
	});

	test('creation requires the opener and callback URL creation requires a host provider', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(BrowserURLService, undefined), /openerService/);
		services.registerInstance(ICodeEditorService, { getFocusedCodeEditor: () => null, openCodeEditor: async () => null } as unknown as ICodeEditorService);
		services.registerSingleton(ICommandService, () => services.createInstance(StandaloneCommandService));
		using opener = services.createInstance(OpenerService);
		services.registerInstance(IOpenerService, opener);
		using service = services.createInstance(BrowserURLService, undefined);
		assert.throws(() => service.create(), /no URL callback provider/);
	});
});
