import { browserEnvironment } from '../../../../editor/test/browser/testEditorDom.js';
import '../../../../workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AccessibilitySupport, IAccessibilityService } from '../../../accessibility/common/accessibility.js';
import { IConfigurationService } from '../../../configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../configuration/common/inMemoryConfigurationService.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../log/common/log.js';
import { resetNlsResolver } from '../../../../nls.js';
import { initializeTestLocalization } from '../../../../workbench/services/localization/test/common/localizationTestUtils.js';
import { AccessibilitySignal, AccessibilitySignalService, IAccessibilitySignalService } from '../../browser/accessibilitySignalService.js';
import { AccessibilityProgressSignalScheduler } from '../../browser/progressAccessibilitySignalScheduler.js';

suite('Accessibility signals', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createServices(owner: DisposableStore): { services: InstantiationService; configuration: InMemoryConfigurationService; accessibility: IAccessibilityService; announcements: string[]; } {
		const configuration = owner.add(new InMemoryConfigurationService());
		const changed = owner.add(new Emitter<void>());
		let support = AccessibilitySupport.Disabled;
		const announcements: string[] = [];
		const accessibility: IAccessibilityService = {
			onDidChangeScreenReaderOptimized: changed.event,
			onDidChangeReducedMotion: Event.None, onDidChangeReducedTransparency: Event.None, onDidChangeLinkUnderlines: Event.None,
			alwaysUnderlineAccessKeys: async () => false,
			isScreenReaderOptimized: () => support === AccessibilitySupport.Enabled,
			isMotionReduced: () => false, isTransparencyReduced: () => false,
			getAccessibilitySupport: () => support,
			setAccessibilitySupport: value => { support = value; changed.fire(); },
			alert: message => announcements.push(`alert: ${message}`), status: message => announcements.push(message),
		};
		const services = owner.add(new InstantiationService());
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IAccessibilityService, accessibility);
		services.registerInstance(ILogService, new NullLoggerService());
		services.registerInstance(IAccessibilitySignalService, owner.add(services.createInstance(AccessibilitySignalService)));
		return { services, configuration, accessibility, announcements };
	}

	test('auto follows screen-reader changes and updates volume and sound policy during playback', async () => {
		using owner = new DisposableStore();
		const { services, configuration, accessibility, announcements } = createServices(owner);
		const plays: number[] = [];
		let audio: HTMLMediaElement | undefined;
		const media = browserEnvironment.window.HTMLMediaElement.prototype;
		const play = mock.method(media, 'play', async function (this: HTMLMediaElement) { audio = this; plays.push(this.volume); });
		const pause = mock.method(media, 'pause', () => { });
		const load = mock.method(media, 'load', () => { });
		try {
			const service = services.get(IAccessibilitySignalService);
			await service.playSignal(AccessibilitySignal.progress);
			assert.deepEqual(plays, []);
			accessibility.setAccessibilitySupport(AccessibilitySupport.Enabled);
			await service.playSignal(AccessibilitySignal.progress);
			assert.deepEqual(plays, [0.7]);
			await service.playSignal(AccessibilitySignal.progress);
			assert.equal(plays.length, 1, 'overlapping sounds are suppressed');
			await configuration.updateValue('accessibility.signalOptions.volume', 25);
			assert.equal(audio!.volume, 0.25);
			accessibility.setAccessibilitySupport(AccessibilitySupport.Disabled);
			assert.equal(pause.mock.callCount(), 1);
			await configuration.updateValue(AccessibilitySignal.progress.settingsKey, { sound: 'on', announcement: 'auto' });
			await service.playSignal(AccessibilitySignal.progress);
			assert.deepEqual(plays, [0.7, 0.25]);
			assert.deepEqual(announcements, []);
			accessibility.setAccessibilitySupport(AccessibilitySupport.Enabled);
			await configuration.updateValue('accessibility.signalOptions.volume', 0);
			await service.playSignal(AccessibilitySignal.progress);
			assert.deepEqual({ plays, announcements }, { plays: [0.7, 0.25], announcements: ['Progress'] });
			owner.dispose();
			assert.equal(audio!.getAttribute('src'), null);
			assert.equal(load.mock.callCount(), 1);
		} finally {
			owner.dispose();
			play.mock.restore(); pause.mock.restore(); load.mock.restore();
		}
	});

	test('delayed progress stops before its first cue, after a cue, and when the service is disposed', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		using owner = new DisposableStore();
		const { services, configuration, accessibility, announcements } = createServices(owner);
		try {
			accessibility.setAccessibilitySupport(AccessibilitySupport.Enabled);
			await configuration.updateValue(AccessibilitySignal.progress.settingsKey, { sound: 'off', announcement: 'auto' });
			using early = services.createInstance(AccessibilityProgressSignalScheduler, 5000, 1000);
			mock.timers.tick(4999);
			early.dispose();
			mock.timers.tick(10000);
			assert.deepEqual(announcements, []);
			using running = services.createInstance(AccessibilityProgressSignalScheduler, 5000, 1000);
			mock.timers.tick(5000);
			mock.timers.tick(1000);
			assert.deepEqual(announcements, ['Progress', 'Progress']);
			running.dispose();
			mock.timers.tick(10000);
			assert.equal(announcements.length, 2);
			using loop = services.get(IAccessibilitySignalService).playSignalLoop(AccessibilitySignal.progress, 1000);
			owner.dispose();
			mock.timers.tick(10000);
			assert.equal(announcements.length, 3);
		} finally { mock.timers.reset(); }
	});

	test('rejects invalid configuration and keeps the last policy', async () => {
		using owner = new DisposableStore();
		const { configuration } = createServices(owner);
		for (const value of [null, {}, { sound: ['auto'], announcement: 'off' }, { sound: 'on', announcement: 'on' }, { sound: 'on', announcement: 'off', extra: true }]) {
			await assert.rejects(configuration.updateValue(AccessibilitySignal.progress.settingsKey, value));
		}
		for (const value of [-1, 101, NaN, '70']) {
			await assert.rejects(configuration.updateValue('accessibility.signalOptions.volume', value));
		}
		assert.deepEqual(configuration.getValue(AccessibilitySignal.progress.settingsKey), { sound: 'auto', announcement: 'off' });
		for (const signal of AccessibilitySignal.allAccessibilitySignals) {
			await assert.rejects(configuration.updateValue(signal.settingsKey, { sound: 'invalid' }));
			if (!signal.announcementMessage) {
				await assert.rejects(configuration.updateValue(signal.settingsKey, { sound: 'on', announcement: 'auto' }));
				await configuration.updateValue(signal.settingsKey, { sound: 'on' });
			}
		}
	});

	test('independent policies and loops release their own audio while volume changes apply to all sounds', async () => {
		using owner = new DisposableStore();
		const { services, configuration } = createServices(owner);
		const audios = new Map<string, HTMLMediaElement>();
		const media = browserEnvironment.window.HTMLMediaElement.prototype;
		const play = mock.method(media, 'play', async function (this: HTMLMediaElement) { audios.set(this.src.split('/').pop()!, this); });
		const paused: string[] = [];
		const pause = mock.method(media, 'pause', function (this: HTMLMediaElement) { paused.push(this.src.split('/').pop()!); });
		const load = mock.method(media, 'load', () => { });
		try {
			for (const signal of [AccessibilitySignal.progress, AccessibilitySignal.taskCompleted]) {
				await configuration.updateValue(signal.settingsKey, { sound: 'on', announcement: 'off' });
			}
			const service = services.get(IAccessibilitySignalService);
			using progress = service.playSignalLoop(AccessibilitySignal.progress, 5000);
			using completed = service.playSignalLoop(AccessibilitySignal.taskCompleted, 5000);
			await configuration.updateValue('accessibility.signalOptions.volume', 25);
			assert.deepEqual([...audios.values()].map(audio => audio.volume), [0.25, 0.25]);
			progress.dispose();
			assert.deepEqual(paused, ['progress.mp3']);
			await configuration.updateValue(AccessibilitySignal.taskCompleted.settingsKey, { sound: 'off', announcement: 'off' });
			assert.deepEqual(paused, ['progress.mp3', 'success.mp3']);
			completed.dispose();
			owner.dispose();
			assert.equal(load.mock.callCount(), 2);
			assert.deepEqual([...audios.values()].map(audio => audio.getAttribute('src')), [null, null]);
		} finally {
			owner.dispose();
			play.mock.restore(); pause.mock.restore(); load.mock.restore();
		}
	});

	test('all supported announcements are translated and sound-only cues never add speech', async () => {
		using locale = toDisposable(resetNlsResolver);
		initializeTestLocalization('zh-CN');
		using owner = new DisposableStore();
		const { services, configuration, accessibility, announcements } = createServices(owner);
		accessibility.setAccessibilitySupport(AccessibilitySupport.Enabled);
		for (const signal of AccessibilitySignal.allAccessibilitySignals) {
			await configuration.updateValue(signal.settingsKey, signal.announcementMessage ? { sound: 'off', announcement: 'auto' } : { sound: 'off' });
			await services.get(IAccessibilitySignalService).playSignal(signal);
		}
		assert.deepEqual(announcements, ['进行中', '任务已完成', '任务失败', '命令执行成功', '命令执行失败', '终端响铃', '文件已保存', '格式化已完成', '终端已清空', '已发送对话请求', '对话需要你操作', '调试器已暂停', '光标位置有错误', '光标位置有警告', '当前行有错误', '当前行有警告', '当前行有断点', '折叠区域', '对话已修改文件', '已保留修改', '已撤销修改', '已触发代码操作', '已应用代码操作']);
	});

	test('a canceled play promise cannot clear a newer cue', async () => {
		using owner = new DisposableStore();
		const { services, configuration } = createServices(owner);
		await configuration.updateValue(AccessibilitySignal.progress.settingsKey, { sound: 'on', announcement: 'off' });
		const first = new DeferredPromise<void>();
		let attempts = 0;
		const media = browserEnvironment.window.HTMLMediaElement.prototype;
		const play = mock.method(media, 'play', async () => { if (++attempts === 1) { await first.p; } });
		const pause = mock.method(media, 'pause', () => { });
		const load = mock.method(media, 'load', () => { });
		try {
			const service = services.get(IAccessibilitySignalService);
			const pending = service.playSignal(AccessibilitySignal.progress);
			await configuration.updateValue(AccessibilitySignal.progress.settingsKey, { sound: 'off', announcement: 'off' });
			await configuration.updateValue(AccessibilitySignal.progress.settingsKey, { sound: 'on', announcement: 'off' });
			await service.playSignal(AccessibilitySignal.progress);
			await first.error(new DOMException('Paused', 'AbortError'));
			await pending;
			await service.playSignal(AccessibilitySignal.progress);
			assert.equal(attempts, 2, 'the new cue still suppresses overlapping playback');
		} finally {
			owner.dispose();
			play.mock.restore(); pause.mock.restore(); load.mock.restore();
		}
	});

	test('announces progress in Chinese and retries after autoplay rejection', async () => {
		using locale = toDisposable(resetNlsResolver);
		initializeTestLocalization('zh-CN');
		using owner = new DisposableStore();
		const { services, configuration, accessibility, announcements } = createServices(owner);
		accessibility.setAccessibilitySupport(AccessibilitySupport.Enabled);
		await configuration.updateValue(AccessibilitySignal.progress.settingsKey, { sound: 'auto', announcement: 'auto' });
		const media = browserEnvironment.window.HTMLMediaElement.prototype;
		const play = mock.method(media, 'play', async () => { throw new DOMException('Gesture required', 'NotAllowedError'); });
		const pause = mock.method(media, 'pause', () => { });
		const load = mock.method(media, 'load', () => { });
		try {
			await services.get(IAccessibilitySignalService).playSignal(AccessibilitySignal.progress);
			await services.get(IAccessibilitySignalService).playSignal(AccessibilitySignal.progress);
			assert.deepEqual({ attempts: play.mock.callCount(), announcements }, { attempts: 2, announcements: ['进行中', '进行中'] });
		} finally {
			owner.dispose();
			play.mock.restore(); pause.mock.restore(); load.mock.restore();
		}
	});
});
