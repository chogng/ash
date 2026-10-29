import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { TestConfigurationService } from '../../../../../services/configuration/test/common/testServices.js';
import type { ITerminalInstance, IXtermTerminal, TerminalInstanceState } from '../../../../terminal/browser/terminal.js';
import { TerminalExtensionsRegistry } from '../../../../terminal/browser/terminalExtensions.js';
import { TerminalWidgetManager } from '../../../../terminal/browser/widgets/widgetManager.js';
import { TerminalResizeDimensionsOverlaySettingId } from '../../common/terminalResizeDimensionsOverlayConfiguration.js';
import '../../../../terminal/common/terminalConfiguration.js';
import '../../browser/terminal.resizeDimensionsOverlay.contribution.js';

ensureNoDisposablesAreLeakedInTestSuite();

function fixture(resources: DisposableStore) {
	const dom = new JSDOM('<div id="screen"></div><button>Other focus target</button>');
	resources.add(toDisposable(() => dom.window.close()));
	const element = dom.window.document.querySelector<HTMLDivElement>('#screen')!;
	const widgets = resources.add(new TerminalWidgetManager());
	widgets.attachToElement(element);
	const resized = resources.add(new Emitter<{ cols: number; rows: number; }>());
	const state = resources.add(new Emitter<TerminalInstanceState>());
	const configuration = resources.add(new TestConfigurationService());
	const services = resources.add(new InstantiationService());
	services.registerInstance(IConfigurationService, configuration);
	const screen = {
		element, raw: { onResize: resized.event }, isDisposed: false,
		attachWidget: widgets.attachWidget.bind(widgets),
	} as unknown as IXtermTerminal;
	const definition = TerminalExtensionsRegistry.getTerminalContributions().find(value => value.id === 'terminal.resizeDimensionsOverlay');
	assert.ok(definition);
	const contribution = resources.add(services.createInstance(definition.ctor, {
		instance: { onDidChangeState: state.event } as ITerminalInstance,
	}));
	contribution.xtermReady!(screen);
	const label = () => element.querySelector<HTMLSpanElement>('.ash-terminal-resize-dimensions-overlay');
	return { dom, element, resized, state, configuration, contribution, label };
}

test('Terminal dimensions overlay follows committed grid changes after startup and hides after the final resize', () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		using resources = new DisposableStore();
		const { dom, resized, label } = fixture(resources);
		const other = dom.window.document.querySelector('button')!;
		other.focus();
		resized.fire({ cols: 80, rows: 24 });
		assert.equal(label(), null);
		mock.timers.tick(999);
		assert.equal(resized.hasListeners(), false);
		mock.timers.tick(1);
		assert.equal(label()?.hidden, true);
		resized.fire({ cols: 92, rows: 28 });
		assert.equal(label()?.textContent, '92 columns × 28 rows');
		assert.equal(label()?.hidden, false);
		assert.equal(label()?.getAttribute('aria-hidden'), 'true');
		assert.equal(dom.window.document.activeElement, other);
		mock.timers.tick(499);
		resized.fire({ cols: 94, rows: 30 });
		mock.timers.tick(499);
		assert.equal(label()?.textContent, '94 columns × 30 rows');
		assert.equal(label()?.hidden, false);
		mock.timers.tick(1);
		assert.equal(label()?.hidden, true);
	} finally { mock.timers.reset(); }
});

test('Terminal dimensions overlay setting releases its widget and listener immediately and can be enabled again', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		using resources = new DisposableStore();
		const { configuration, resized, label, contribution } = fixture(resources);
		mock.timers.tick(1000);
		resized.fire({ cols: 90, rows: 25 });
		assert.equal(label()?.hidden, false);
		await configuration.updateValue(TerminalResizeDimensionsOverlaySettingId.Enabled, false);
		assert.equal(label(), null);
		assert.equal(resized.hasListeners(), false);
		mock.timers.tick(1000);
		resized.fire({ cols: 100, rows: 30 });
		assert.equal(label(), null);
		await configuration.updateValue(TerminalResizeDimensionsOverlaySettingId.Enabled, true);
		assert.equal(label()?.hidden, true);
		resized.fire({ cols: 110, rows: 35 });
		assert.equal(label()?.textContent, '110 columns × 35 rows');
		contribution.dispose();
		assert.equal(label(), null);
		assert.equal(resized.hasListeners(), false);
		mock.timers.tick(1000);
		assert.equal(label(), null);
	} finally { mock.timers.reset(); }
});

test('Terminal dimensions overlay ignores hidden-screen restoration and reconnect startup, and cancels delayed attachment on disposal', () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		using resources = new DisposableStore();
		const { element, resized, state, contribution, label } = fixture(resources);
		mock.timers.tick(1000);
		element.hidden = true;
		resized.fire({ cols: 100, rows: 30 });
		assert.equal(label()?.hidden, true);
		element.hidden = false;
		state.fire('reconnecting');
		assert.equal(label(), null);
		assert.equal(resized.hasListeners(), false);
		mock.timers.tick(1000);
		assert.equal(label(), null);
		state.fire('running');
		mock.timers.tick(999);
		assert.equal(label(), null);
		mock.timers.tick(1);
		resized.fire({ cols: 110, rows: 35 });
		assert.equal(label()?.hidden, false);
		state.fire('reconnecting');
		state.fire('running');
		contribution.dispose();
		mock.timers.tick(1000);
		assert.equal(label(), null);
		assert.equal(resized.hasListeners(), false);
	} finally { mock.timers.reset(); }
});
