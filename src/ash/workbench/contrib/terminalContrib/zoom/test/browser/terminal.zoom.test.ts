import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { addDisposableListener } from '../../../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { TestConfigurationService } from '../../../../../services/configuration/test/common/testServices.js';
import { TerminalConfigurationService } from '../../../../terminal/browser/terminalConfigurationService.js';
import type { ITerminalInstance, IXtermTerminal } from '../../../../terminal/browser/terminal.js';
import { TerminalExtensionsRegistry } from '../../../../terminal/browser/terminalExtensions.js';
import { TerminalZoomCommandId, TerminalZoomSettingId } from '../../common/terminal.zoom.js';
import '../../browser/terminal.zoom.contribution.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('Terminal font commands update the shared effective configuration and persisted user setting', async () => {
	using resources = new DisposableStore();
	const configuration = resources.add(new TestConfigurationService());
	const services = resources.add(new InstantiationService());
	services.registerInstance(IConfigurationService, configuration);
	const terminalConfiguration = resources.add(services.createInstance(TerminalConfigurationService));
	await configuration.updateValue('terminal.integrated.fontSize', 18);
	const observed: number[] = [];
	resources.add(terminalConfiguration.onConfigChanged(() => observed.push(terminalConfiguration.config.fontSize)));

	await services.invokeFunction(CommandsRegistry.getCommand(TerminalZoomCommandId.FontZoomIn)!);
	assert.equal(terminalConfiguration.config.fontSize, 19);
	await services.invokeFunction(CommandsRegistry.getCommand(TerminalZoomCommandId.FontZoomOut)!);
	assert.equal(terminalConfiguration.config.fontSize, 18);
	assert.deepEqual(observed, [19, 18]);
	assert.equal(JSON.parse((await configuration.read()).source)['terminal.integrated.fontSize'], 18);
	await configuration.reloadConfiguration();
	assert.equal(terminalConfiguration.config.fontSize, 18);
});

test('Terminal font commands respect bounds and reset to the registered platform default', async () => {
	using resources = new DisposableStore();
	const configuration = resources.add(new TestConfigurationService());
	const services = resources.add(new InstantiationService());
	services.registerInstance(IConfigurationService, configuration);
	const run = (id: TerminalZoomCommandId) => services.invokeFunction(CommandsRegistry.getCommand(id)!);

	await configuration.updateValue('terminal.integrated.fontSize', 6);
	await run(TerminalZoomCommandId.FontZoomOut);
	assert.equal(configuration.getValue('terminal.integrated.fontSize'), 6);
	await configuration.updateValue('terminal.integrated.fontSize', 100);
	await run(TerminalZoomCommandId.FontZoomIn);
	assert.equal(configuration.getValue('terminal.integrated.fontSize'), 100);
	await run(TerminalZoomCommandId.FontZoomReset);
	assert.equal(configuration.getValue('terminal.integrated.fontSize'), configuration.inspect('terminal.integrated.fontSize').defaultValue);
});

function wheelFixture(resources: DisposableStore) {
	const dom = new JSDOM('');
	resources.add(toDisposable(() => dom.window.close()));
	const configuration = resources.add(new TestConfigurationService());
	const services = resources.add(new InstantiationService());
	services.registerInstance(IConfigurationService, configuration);
	const definition = TerminalExtensionsRegistry.getTerminalContributions().find(value => value.id === 'terminal.mouseWheelZoom');
	assert.ok(definition);
	const createScreen = () => {
		const element = dom.window.document.createElement('div');
		const viewport = dom.window.document.createElement('div');
		element.append(viewport);
		const contribution = resources.add(services.createInstance(definition.ctor, { instance: {} as ITerminalInstance }));
		contribution.xtermReady!({ raw: { element }, isDisposed: false } as unknown as IXtermTerminal);
		return { viewport, contribution };
	};
	const wheel = (viewport: HTMLElement, timeStamp: number, deltaY: number, options: WheelEventInit = {}) => {
		const event = new dom.window.WheelEvent('wheel', {
			bubbles: true,
			cancelable: true,
			deltaY,
			ctrlKey: true,
			...options,
		});
		Object.defineProperty(event, 'timeStamp', { value: timeStamp });
		viewport.dispatchEvent(event);
		return event;
	};
	return {
		configuration,
		createScreen,
		wheel,
		run: (id: TerminalZoomCommandId) => services.invokeFunction(CommandsRegistry.getCommand(id)!),
	};
}

test('Terminal wheel zoom takes effect immediately when enabled and leaves ordinary scrolling available', async () => {
	using resources = new DisposableStore();
	const { configuration, createScreen, wheel, run } = wheelFixture(resources);
	const { viewport } = createScreen();
	await configuration.updateValue('terminal.integrated.fontSize', 18);
	let scrolled = 0;
	resources.add(addDisposableListener(viewport, 'wheel', () => scrolled++));
	assert.equal(wheel(viewport, 100, -100).defaultPrevented, false);
	assert.equal(scrolled, 1);
	await configuration.updateValue(TerminalZoomSettingId.MouseWheelZoom, true);
	assert.equal(wheel(viewport, 200, -100).defaultPrevented, true);
	assert.equal(scrolled, 1);
	// A following keyboard command shares the same persisted font-size owner.
	await run(TerminalZoomCommandId.FontZoomIn);
	assert.equal(configuration.getValue('terminal.integrated.fontSize'), 20);
	await configuration.updateValue(TerminalZoomSettingId.MouseWheelZoom, false);
	assert.equal(wheel(viewport, 300, -100).defaultPrevented, false);
	await run(TerminalZoomCommandId.FontZoomOut);
	assert.equal(configuration.getValue('terminal.integrated.fontSize'), 19);
});

test('Terminal wheel zoom accumulates small pixels and does not capture scroll inertia or extra modifiers', async () => {
	using resources = new DisposableStore();
	const { configuration, createScreen, wheel, run } = wheelFixture(resources);
	const { viewport } = createScreen();
	await configuration.updateValue('terminal.integrated.fontSize', 18);
	await configuration.updateValue(TerminalZoomSettingId.MouseWheelZoom, true);
	for (const time of [100, 110, 120]) assert.equal(wheel(viewport, time, -2).defaultPrevented, true);
	await run(TerminalZoomCommandId.FontZoomOut);
	assert.equal(configuration.getValue('terminal.integrated.fontSize'), 18);

	assert.equal(wheel(viewport, 200, -100, { ctrlKey: false }).defaultPrevented, false);
	assert.equal(wheel(viewport, 210, -100).defaultPrevented, false);
	assert.equal(wheel(viewport, 240, -100).defaultPrevented, false);
	assert.equal(wheel(viewport, 300, -100, { altKey: true }).defaultPrevented, false);
	assert.equal(wheel(viewport, 400, -100, { shiftKey: true }).defaultPrevented, false);
	assert.equal(wheel(viewport, 500, -100, { ctrlKey: false, metaKey: true }).defaultPrevented, isMacintosh);
	await run(TerminalZoomCommandId.FontZoomIn);
	assert.equal(configuration.getValue('terminal.integrated.fontSize'), isMacintosh ? 20 : 19);
});

test('Terminal wheel events from split panes serialize writes and stop after contribution disposal', async () => {
	using resources = new DisposableStore();
	const { configuration, createScreen, wheel, run } = wheelFixture(resources);
	const first = createScreen();
	const second = createScreen();
	await configuration.updateValue('terminal.integrated.fontSize', 18);
	await configuration.updateValue(TerminalZoomSettingId.MouseWheelZoom, true);
	wheel(first.viewport, 100, -100, { deltaMode: 1 });
	wheel(second.viewport, 100, -100, { deltaMode: 1 });
	await run(TerminalZoomCommandId.FontZoomOut);
	assert.equal(configuration.getValue('terminal.integrated.fontSize'), 19);
	first.contribution.dispose();
	assert.equal(wheel(first.viewport, 200, -100).defaultPrevented, false);

	wheel(second.viewport, 300, -100);
	wheel(second.viewport, 310, -100);
	second.contribution.dispose();
	await run(TerminalZoomCommandId.FontZoomOut);
	// The first operation had already started. The queued operation was canceled
	// with its contribution, and cannot change settings after terminal disposal.
	assert.equal(configuration.getValue('terminal.integrated.fontSize'), 19);
});
