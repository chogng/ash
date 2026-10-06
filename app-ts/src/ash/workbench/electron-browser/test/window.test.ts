import { initializeTestLocalization } from '../../services/localization/test/common/localizationTestUtils.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../base/common/event.js';
import { InMemoryConfigurationService } from '../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { OpenerService } from '../../../editor/browser/services/openerService.js';
import { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import { StandaloneCodeEditorService } from '../../../editor/standalone/browser/standaloneCodeEditorService.js';
import type { INativeHostApi } from '../../../platform/native/common/nativeHost.js';
import type { IThemeService } from '../../../platform/theme/common/themeService.js';
import { WINDOW_ZOOM_LEVEL_SETTING } from '../../../platform/window/common/window.js';
import '../desktop.contribution.js';
import { NativeWindow } from '../window.js';
import { bindWindowControlTheme } from '../parts/titlebar/titlebarPart.js';
import { Event } from '../../../base/common/event.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IMainProcessService } from '../../../platform/ipc/common/mainProcessService.js';
import { INativeHostService } from '../../common/services.js';
import { IIntegrityService } from '../../services/integrity/common/integrity.js';
import { IntegrityService } from '../../services/integrity/electron-browser/integrityService.js';
import { ITitleService } from '../../services/title/browser/titleService.js';
import type { ITitleProperties } from '../../browser/parts/titlebar/titlebarPart.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { NotificationService } from '../../services/notification/common/notificationService.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IEditorService } from '../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../services/editor/common/editorGroupsService.js';
import { ElectronWindow } from '../window.js';
import { URI } from '../../../base/common/uri.js';

test('desktop initialization reads privileges and installation proofs through injected services', async () => {
	using services = new InstantiationService();
	using notifications = new NotificationService();
	let reply: unknown = { isBuilt: false, proof: [] };
	const requests: string[] = [];
	services.registerInstance(IMainProcessService, {
		_serviceBrand: undefined,
		getChannel: name => {
			assert.equal(name, 'checksum');
			return { call: async <T>(command: string) => { requests.push(command); return reply as T; }, listen: () => Event.None };
		},
		registerChannel: () => { throw new Error('Unexpected channel registration'); },
	});
	const integrity = services.createInstance(IntegrityService);
	services.registerInstance(IIntegrityService, integrity);
	services.registerInstance(INativeHostService, { isAdmin: async () => true } as INativeHostApi);
	services.registerInstance(INotificationService, notifications);
	const errors: unknown[][] = [];
	services.registerInstance(ILogService, { trace() { }, debug() { }, info() { }, warn() { }, error: (...args: unknown[]) => { errors.push(args); } });
	services.registerInstance(IEditorService, {} as import('../../services/editor/common/editorService.js').IEditorService);
	services.registerInstance(IEditorGroupsService, { onDidChangeGroups: Event.None } as import('../../services/editor/common/editorGroupsService.js').IEditorGroupsService);
	const properties: ITitleProperties[] = [];
	let updated!: () => void;
	services.registerInstance(ITitleService, { updateProperties: (value: ITitleProperties) => { properties.push(value); if ('isPure' in value) { updated(); } } } as unknown as import('../../services/title/browser/titleService.js').ITitleService);
	const ipc = {
		invoke: async <T>() => undefined as T,
		subscribe: () => ({ dispose() { } }),
	};
	const development = new Promise<void>(resolve => { updated = resolve; });
	using desktop = services.createInstance(ElectronWindow, ipc);
	await desktop.initialize();
	await development;
	assert.deepEqual({ properties, warnings: notifications.getNotifications().length }, { properties: [{ isAdmin: true }, { isPure: undefined }], warnings: 0 });

	reply = { isBuilt: true, proof: [{ uri: URI.file('/installation/dist/main.js').toJSON(), expected: '0'.repeat(64), actual: null }] };
	const warning = new Promise<string>(resolve => {
		const subscription = notifications.onDidAdd(item => { subscription.dispose(); resolve(item.message); });
	});
	using packaged = services.createInstance(ElectronWindow, ipc);
	await packaged.initialize();
	assert.match(await warning, /installation files have changed or are missing/);
	assert.deepEqual(properties.slice(-2), [{ isAdmin: true }, { isPure: false }]);
	assert.deepEqual(requests, ['getApplicationChecksums', 'getApplicationChecksums']);
	assert.equal((await integrity.isPure()).proof[0]!.uri.fsPath, URI.file('/installation/dist/main.js').fsPath);
	assert.equal(errors.length, 0);
	initializeTestLocalization('zh-CN');
	try {
		const translated = new Promise<string>(resolve => {
			const subscription = notifications.onDidAdd(item => { subscription.dispose(); resolve(item.message); });
		});
		using chinese = services.createInstance(ElectronWindow, ipc);
		await chinese.initialize();
		assert.equal(await translated, 'Ash 的安装文件已被修改或缺失，请重新安装 Ash 以恢复发布时的文件。');
		reply = { isBuilt: true, proof: [] };
		const failed = new Promise<string>(resolve => {
			const subscription = notifications.onDidAdd(item => { subscription.dispose(); resolve(item.message); });
		});
		using invalid = services.createInstance(ElectronWindow, ipc);
		await invalid.initialize();
		assert.equal(await failed, 'Ash 无法验证桌面运行环境，请查看日志了解详情。');
		assert.equal(errors.length, 1);
	} finally {
		initializeTestLocalization('en');
	}
	for (const malformed of [{ isBuilt: true, proof: [] }, { isBuilt: false, proof: [{ uri: {}, expected: 42 }] }]) {
		reply = malformed;
		await assert.rejects(integrity.isPure(), /checksum/);
	}
});

test('desktop disposal prevents pending environment reads from updating titles', async () => {
	using services = new InstantiationService();
	let finish!: (value: boolean) => void;
	services.registerInstance(INativeHostService, { isAdmin: () => new Promise<boolean>(resolve => { finish = resolve; }) } as INativeHostApi);
	services.registerInstance(IIntegrityService, { _serviceBrand: undefined, isPure: async () => { assert.fail('Disposed window must not start an installation scan'); } });
	services.registerInstance(ITitleService, { updateProperties: () => assert.fail('Disposed window must not update titles') } as unknown as import('../../services/title/browser/titleService.js').ITitleService);
	using notifications = new NotificationService();
	services.registerInstance(INotificationService, notifications);
	services.registerInstance(ILogService, { trace() { }, debug() { }, info() { }, warn() { }, error() { } });
	services.registerInstance(IEditorService, {} as import('../../services/editor/common/editorService.js').IEditorService);
	services.registerInstance(IEditorGroupsService, { onDidChangeGroups: Event.None } as import('../../services/editor/common/editorGroupsService.js').IEditorGroupsService);
	using desktop = services.createInstance(ElectronWindow, { invoke: async () => undefined, subscribe: () => ({ dispose() { } }) });
	await desktop.initialize();
	desktop.dispose();
	finish(true);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(notifications.getNotifications().length, 0);
});

test('desktop zoom follows the profile setting and persists a window zoom change', async () => {
	using configuration = new InMemoryConfigurationService();
	await configuration.updateValue(WINDOW_ZOOM_LEVEL_SETTING, 2);
	let zoom = 0;
	let changed: ((level: number) => void) | undefined;
	let applied!: (level: number) => void;
	const firstApplied = new Promise<number>(resolve => { applied = resolve; });
	const host = {
		getZoomLevel: async () => zoom,
		setZoomLevel: async (level: number) => { zoom = level; changed?.(level); applied(level); },
		onDidChangeZoomLevel: (listener: (level: number) => void) => { changed = listener; return { dispose: () => { changed = undefined; } }; },
		onDidRequestOpenExternalUri: () => ({ dispose() { } }),
	} as unknown as INativeHostApi;
	using services = new InstantiationService();
	using codeEditors = new StandaloneCodeEditorService();
	services.registerInstance(ICodeEditorService, codeEditors);
	using opener = services.createInstance(OpenerService);
	services.registerInstance(IOpenerService, opener);
	services.registerInstance(INativeHostService, host);
	services.registerInstance(IConfigurationService, configuration);
	using window = services.createInstance(NativeWindow);
	assert.equal(await firstApplied, 2);
	await new Promise<void>(resolve => setImmediate(resolve));
	const persisted = new Promise<void>(resolve => {
		const subscription = configuration.onDidChangeConfiguration(() => {
			if (configuration.getValue<number>(WINDOW_ZOOM_LEVEL_SETTING) === 3) {
				subscription.dispose();
				resolve();
			}
		});
	});
	zoom = 3;
	changed?.(3);
	await persisted;
	assert.equal(configuration.getValue<number>(WINDOW_ZOOM_LEVEL_SETTING), 3);
});

test('window controls follow theme changes and release their theme listener', () => {
	using changes = new Emitter<never>();
	let color = '#ffffff';
	const themes: unknown[] = [];
	const themeService = {
		getColorTheme: () => ({ id: 'test', getColorCss: () => color }),
		onDidColorThemeChange: changes.event,
	} as unknown as IThemeService;
	const host = { setWindowTheme: async (theme: unknown) => { themes.push(theme); } } as INativeHostApi;
	const binding = bindWindowControlTheme(themeService, host);
	assert.deepEqual(themes, [{ backgroundColor: '#ffffff', symbolColor: '#ffffff', backdropColor: '#ffffff' }]);
	color = '#000000';
	changes.fire(undefined as never);
	assert.deepEqual(themes[1], { backgroundColor: '#000000', symbolColor: '#000000', backdropColor: '#000000' });
	binding.dispose();
	changes.fire(undefined as never);
	assert.equal(themes.length, 2);
});
