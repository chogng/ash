import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { StandaloneCommandService } from '../../../../../editor/standalone/browser/standaloneServices.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IServerChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { OpenerService } from '../../../../../editor/browser/services/openerService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import type { INativeHostApi } from '../../../../../platform/native/common/nativeHost.js';
import { URLHandlerChannel } from '../../../../../platform/url/common/urlIpc.js';
import { INativeHostService } from '../../../../common/services.js';
import { RelayURLService } from '../../electron-browser/urlService.js';

suite('Desktop URL service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('opener relays through Main and handles the returning callback before focusing its window', async () => {
		using services = new InstantiationService();
		services.registerInstance(ICodeEditorService, { getFocusedCodeEditor: () => null, openCodeEditor: async () => null } as unknown as ICodeEditorService);
		services.registerSingleton(ICommandService, () => services.createInstance(StandaloneCommandService));
		using opener = services.createInstance(OpenerService);
		services.registerInstance(IOpenerService, opener);
		const calls: unknown[] = [];
		let rendererChannel!: IServerChannel;
		const mainChannel = new URLHandlerChannel({
			handleURL: async (uri, options) => {
				calls.push(['main', uri.toString(), options]);
				return rendererChannel.call<boolean>('main', 'handleURL', [uri.toString(), options]);
			}
		});
		services.registerInstance(IMainProcessService, {
			_serviceBrand: undefined,
			getChannel: name => { assert.equal(name, 'url'); return { call: (command, arg) => mainChannel.call('window:7', command, arg), listen: () => Event.None }; },
			registerChannel: (name, channel) => { assert.equal(name, 'urlHandler'); rendererChannel = channel; },
		});
		services.registerInstance(INativeHostService, { focusWindow: async () => { calls.push(['focus']); } } as unknown as INativeHostApi);
		using service = services.createInstance(RelayURLService, 7);
		using handler = service.registerHandler({ handleURL: async (uri, options) => { calls.push(['handler', uri.toString(), options]); return true; } });
		const uri = service.create({ authority: 'callback', path: 'result', query: 'state=你好&windowId=1', fragment: 'done' });
		assert.equal(uri.scheme, 'ash');
		assert.equal(uri.path, '/result');
		assert.deepEqual([...new URL(uri.toString()).searchParams], [['state', '你好'], ['windowId', '7']]);
		assert.equal(await opener.open(uri), true);
		assert.deepEqual(calls, [['main', uri.toString(), { trusted: true, originalUrl: undefined }], ['handler', uri.toString(), { trusted: true, originalUrl: undefined }], ['focus']]);
		calls.length = 0;
		assert.equal(await rendererChannel.call('main', 'handleURL', [uri.toString(), { originalUrl: uri.toString() }]), true);
		assert.deepEqual(calls, [['handler', uri.toString(), { originalUrl: uri.toString() }], ['focus']]);
		handler.dispose();
		calls.length = 0;
		assert.equal(await service.handleURL(uri), false);
		assert.deepEqual(calls, []);
		assert.equal(await service.open('https://example.test'), false);
		assert.equal(await service.open(uri, { openExternal: true }), false);
	});
});
