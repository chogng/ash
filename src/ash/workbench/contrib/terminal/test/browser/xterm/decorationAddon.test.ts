import { BrowserClipboardService } from '../../../../../../platform/clipboard/browser/clipboardService.js';
import type { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { createColorTheme, lightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { TerminalCapabilityStore } from '../../../../../../platform/terminal/common/capabilities/terminalCapabilityStore.js';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { setIconResolver } from '../../../../../../base/browser/ui/lxicons/lxicon.js';
import { getIconDefinition } from '../../../../../../platform/theme/common/iconRegistry.js';
import type { Terminal, IMarker, IDecorationOptions } from '@xterm/xterm';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { DecorationAddon } from '../../../browser/xterm/decorationAddon.js';
import { TerminalCapability, type ICommandDetectionCapability, type ITerminalCommand } from '../../../../../../platform/terminal/common/capabilities/capabilities.js';
import { BufferMarkCapability } from '../../../../../../platform/terminal/common/capabilities/bufferMarkCapability.js';
import { TestConfigurationService } from '../../../../../services/configuration/test/common/testServices.js';
import '../../../common/terminalConfiguration.js';

const menus: IContextMenuService = { contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu() { assert.fail('Unexpected command menu'); }, hideContextMenu() { } };

function rendererBoundary(lifetime: DisposableStore) {
	const created: { marker: IMarker; trimmed: Emitter<void>; render: Emitter<HTMLElement>; disposed: boolean; options?: IDecorationOptions; }[] = [];
	const terminal = {
		registerMarker() {
			const trimmed = lifetime.add(new Emitter<void>());
			const render = lifetime.add(new Emitter<HTMLElement>());
			let isDisposed = false;
			const marker: IMarker = {
				id: created.length + 1, line: created.length,
				get isDisposed() { return isDisposed; }, onDispose: trimmed.event,
				dispose() { if (!isDisposed) { isDisposed = true; trimmed.fire(); } },
			};
			created.push({ marker, trimmed, render, disposed: false });
			return marker;
		},
		refresh() { }, rows: 24,
		registerDecoration(options: IDecorationOptions) {
			const item = created.find(item => item.marker === options.marker)!;
			item.options = options;
			return { options, element: undefined, onRender: item.render.event, dispose() { item.disposed = true; } };
		},
	};
	return { terminal: terminal as unknown as Terminal, created };
}

suite('Terminal command decoration lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('replacing a decoration element releases its old handlers and trimming closes the current menu', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using lifetime = new DisposableStore();
			setIconResolver(dom.window.document, icon => getIconDefinition(icon));
			const boundary = rendererBoundary(lifetime);
			const capabilities = lifetime.add(new TerminalCapabilityStore());
			capabilities.add(TerminalCapability.BufferMarkDetection, lifetime.add(new BufferMarkCapability(boundary.terminal)));
			const marker = boundary.terminal.registerMarker(0)!;
			lifetime.add(toDisposable(() => marker.dispose()));
			const command = { marker, id: 'one', command: 'echo test', getOutput: () => undefined } as ITerminalCommand;
			capabilities.add(TerminalCapability.CommandDetection, { commands: [command] } as unknown as ICommandDetectionCapability);
			let shown = 0;
			let hidden = 0;
			let closeMenu: (() => void) | undefined;
			const contextMenus: IContextMenuService = {
				...menus,
				showContextMenu: delegate => { shown++; closeMenu?.(); closeMenu = () => delegate.onHide?.(false); },
				hideContextMenu: () => { hidden++; closeMenu?.(); closeMenu = undefined; },
			};
			const addon = lifetime.add(new DecorationAddon(capabilities, lifetime.add(new TestConfigurationService()), lifetime.add(new TestThemeService(lightColorTheme)), lifetime.add(new BrowserClipboardService(undefined)), contextMenus));
			addon.activate(boundary.terminal);
			addon.registerCommandDecoration({ commandId: 'one', status: 'succeeded', exitCode: 0 }, 10, marker);
			const first = dom.window.document.createElement('div');
			const second = dom.window.document.createElement('div');
			boundary.created[0]!.render.fire(first);
			boundary.created[0]!.render.fire(second);
			boundary.created[0]!.render.fire(second);
			first.click();
			assert.equal(shown, 0);
			second.click();
			assert.equal(shown, 1);
			second.click();
			assert.equal(shown, 2);
			marker.dispose();
			assert.equal(hidden, 1);
			second.click();
			assert.equal(shown, 2);
		} finally {
			dom.window.close();
		}
	});

	test('overview marks follow command status and theme changes without replacing their screen marker', () => {
		using lifetime = new DisposableStore();
		const boundary = rendererBoundary(lifetime);
		const capabilities = lifetime.add(new TerminalCapabilityStore());
		capabilities.add(TerminalCapability.BufferMarkDetection, lifetime.add(new BufferMarkCapability(boundary.terminal)));
		const themes = lifetime.add(new TestThemeService(lightColorTheme));
		const addon = lifetime.add(new DecorationAddon(capabilities, lifetime.add(new TestConfigurationService()), themes, lifetime.add(new BrowserClipboardService(undefined)), menus));
		addon.activate(boundary.terminal);
		const marker = boundary.terminal.registerMarker(0)!;
		lifetime.add(toDisposable(() => marker.dispose()));
		addon.registerCommandDecoration(undefined, 10, marker);
		assert.equal(boundary.created[0]!.options?.overviewRulerOptions?.position, 'left');
		addon.registerCommandDecoration({ commandId: '1', status: 'failed', exitCode: 7 }, 10, marker);
		assert.deepEqual(boundary.created[0]!.options?.overviewRulerOptions, { color: '#cf222e', position: 'right' });
		themes.setColorTheme(createColorTheme({ id: 'overview-test', label: 'Overview test', colorScheme: lightColorTheme.colorScheme, colorOverrides: { 'terminalCommandDecoration.errorBackground': '#123456' } }));
		assert.deepEqual(boundary.created[0]!.options?.overviewRulerOptions, { color: '#123456', position: 'right' });
		addon.registerCommandDecoration({ commandId: '1', status: 'succeeded', exitCode: 0 }, 10, marker);
		assert.deepEqual(boundary.created[0]!.options?.overviewRulerOptions, { color: '#0969da', position: 'left' });
		assert.deepEqual(addon.markers, [marker]);
	});

	test('buffer mark indexing withdraws trimmed marks and distinguishes created from borrowed markers', () => {
		using lifetime = new DisposableStore();
		const boundary = rendererBoundary(lifetime);
		const capability = lifetime.add(new BufferMarkCapability(boundary.terminal));
		const observed: IMarker[] = [];
		lifetime.add(capability.onMarkAdded(mark => observed.push(mark.marker!)));
		capability.addMark({ id: 'owned', hidden: true });
		const owned = capability.getMark('owned')!;
		const borrowed = boundary.terminal.registerMarker(0)!;
		capability.addMark({ id: 'borrowed', marker: borrowed });
		assert.deepEqual([...capability.markers()], [owned, borrowed]);
		assert.deepEqual(observed, [owned, borrowed]);
		borrowed.dispose();
		assert.equal(capability.getMark('borrowed'), undefined);
		assert.equal(boundary.created[1]!.trimmed.hasListeners(), false);
		const external = boundary.terminal.registerMarker(0)!;
		capability.addMark({ id: 'external', marker: external });
		capability.dispose();
		assert.equal(owned.isDisposed, true);
		assert.equal(external.isDisposed, false);
		assert.equal(boundary.created[2]!.trimmed.hasListeners(), false);
		assert.deepEqual([...capability.markers()], []);
		external.dispose();
	});

	test('replacing a named mark releases its original listener without stale disposal withdrawing the replacement', () => {
		using lifetime = new DisposableStore();
		const boundary = rendererBoundary(lifetime);
		const capability = lifetime.add(new BufferMarkCapability(boundary.terminal));
		const first = boundary.terminal.registerMarker(0)!;
		const replacement = boundary.terminal.registerMarker(0)!;
		capability.addMark({ id: 'same', marker: first });
		capability.addMark({ id: 'same', marker: replacement });
		assert.equal(boundary.created[0]!.trimmed.hasListeners(), false);
		first.dispose();
		assert.equal(capability.getMark('same'), replacement);
		replacement.dispose();
		assert.equal(capability.getMark('same'), undefined);
	});
	test('xterm trimming removes screen positions and releases callbacks immediately', () => {
		using lifetime = new DisposableStore();
		const boundary = rendererBoundary(lifetime);
		const capabilities = lifetime.add(new TerminalCapabilityStore());
		capabilities.add(TerminalCapability.BufferMarkDetection, lifetime.add(new BufferMarkCapability(boundary.terminal)));
		const addon = lifetime.add(new DecorationAddon(capabilities, lifetime.add(new TestConfigurationService()), lifetime.add(new TestThemeService(lightColorTheme)), lifetime.add(new BrowserClipboardService(undefined)), menus));
		addon.activate(boundary.terminal);
		const first = boundary.terminal.registerMarker(0)!;
		lifetime.add(toDisposable(() => first.dispose()));
		addon.registerCommandDecoration({ commandId: '1', status: 'running', exitCode: undefined }, 10, first);
		const item = boundary.created[0]!;
		assert.equal(item.trimmed.hasListeners(), true);
		assert.equal(item.render.hasListeners(), true);
		item.marker.dispose();
		assert.equal(addon.markers.length, 0);
		assert.equal(item.trimmed.hasListeners(), false);
		assert.equal(item.render.hasListeners(), false);
		assert.equal(item.disposed, true);
	});

	test('screen shutdown releases both PTY incarnations of a reused command ID', () => {
		using lifetime = new DisposableStore();
		const boundary = rendererBoundary(lifetime);
		const capabilities = lifetime.add(new TerminalCapabilityStore());
		capabilities.add(TerminalCapability.BufferMarkDetection, lifetime.add(new BufferMarkCapability(boundary.terminal)));
		const addon = lifetime.add(new DecorationAddon(capabilities, lifetime.add(new TestConfigurationService()), lifetime.add(new TestThemeService(lightColorTheme)), lifetime.add(new BrowserClipboardService(undefined)), menus));
		addon.activate(boundary.terminal);
		const first = boundary.terminal.registerMarker(0)!;
		lifetime.add(toDisposable(() => first.dispose()));
		addon.registerCommandDecoration({ commandId: '1', status: 'running', exitCode: undefined }, 10, first);
		addon.registerCommandDecoration({ commandId: '1', status: 'succeeded', exitCode: 0 }, 10, first);
		const second = boundary.terminal.registerMarker(0)!;
		lifetime.add(toDisposable(() => second.dispose()));
		addon.registerCommandDecoration({ commandId: '1', status: 'failed', exitCode: 3 }, 11, second);
		assert.equal(addon.markers.length, 2);
		addon.dispose();
		assert.equal(addon.markers.length, 0);
		assert.equal(first.isDisposed, false);
		assert.equal(second.isDisposed, false);
		lifetime.dispose();
		for (const item of boundary.created) {
			assert.equal(item.marker.isDisposed, true);
			assert.equal(item.render.hasListeners(), false);
			assert.equal(item.trimmed.hasListeners(), false);
			assert.equal(item.disposed, true);
		}
	});
});
