import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { AccessibilitySupport, CONTEXT_ACCESSIBILITY_MODE_ENABLED } from '../../../../../platform/accessibility/common/accessibility.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import type { INativeHostApi } from '../../../../../platform/native/common/nativeHost.js';
import { INativeHostService } from '../../../../common/services.js';
import { NativeAccessibilityService } from '../../electron-browser/accessibilityService.js';

test('desktop accessibility resolves its required window services and reads initial system support', async () => {
	const environment = new JSDOM('<!doctype html><html><body></body></html>');
	using windowLifetime = toDisposable(() => environment.window.close());
	using changes = new Emitter<boolean>();
	using configuration = new InMemoryConfigurationService();
	using contextKeys = new ContextKeyService();
	using services = new InstantiationService();
	const root = environment.window.document.body;
	assert.throws(() => services.createInstance(NativeAccessibilityService, root), /nativeHostService/);
	services.registerInstance(INativeHostService, {
		onDidChangeAccessibilitySupport: changes.event,
		isAccessibilitySupportEnabled: async () => true,
	} as unknown as INativeHostApi);
	assert.throws(() => services.createInstance(NativeAccessibilityService, root), /contextKeyService/);
	services.registerInstance(IContextKeyService, contextKeys);
	assert.throws(() => services.createInstance(NativeAccessibilityService, root), /configurationService/);
	services.registerInstance(IConfigurationService, configuration);
	using service = services.createInstance(NativeAccessibilityService, root);
	await Promise.resolve();
	assert.equal(service.getAccessibilitySupport(), AccessibilitySupport.Enabled);
	assert.equal(contextKeys.getValue(CONTEXT_ACCESSIBILITY_MODE_ENABLED.key), true);
	changes.fire(false);
	assert.equal(service.isScreenReaderOptimized(), false);
	assert.equal(contextKeys.getValue(CONTEXT_ACCESSIBILITY_MODE_ENABLED.key), false);
});

test('desktop accessibility keeps the newer system event when its initial read arrives late', async () => {
	const environment = new JSDOM('<!doctype html><html><body></body></html>');
	using windowLifetime = toDisposable(() => environment.window.close());
	using changes = new Emitter<boolean>();
	using configuration = new InMemoryConfigurationService();
	using contextKeys = new ContextKeyService();
	using services = new InstantiationService();
	const initial = new DeferredPromise<boolean>();
	services.registerInstance(INativeHostService, {
		onDidChangeAccessibilitySupport: changes.event,
		isAccessibilitySupportEnabled: () => initial.p,
	} as unknown as INativeHostApi);
	services.registerInstance(IContextKeyService, contextKeys);
	services.registerInstance(IConfigurationService, configuration);
	using service = services.createInstance(NativeAccessibilityService, environment.window.document.body);
	changes.fire(true);
	await initial.complete(false);
	assert.equal(service.getAccessibilitySupport(), AccessibilitySupport.Enabled);
	assert.equal(contextKeys.getValue(CONTEXT_ACCESSIBILITY_MODE_ENABLED.key), true);
	service.dispose();
	assert.equal(changes.hasListeners(), false);
	changes.fire(false);
	assert.equal(contextKeys.getValue(CONTEXT_ACCESSIBILITY_MODE_ENABLED.key), false);
});

test('closing a desktop window releases system events and ignores its pending accessibility read', async () => {
	const environment = new JSDOM('<!doctype html><html><body></body></html>');
	using windowLifetime = toDisposable(() => environment.window.close());
	using changes = new Emitter<boolean>();
	using configuration = new InMemoryConfigurationService();
	using contextKeys = new ContextKeyService();
	using services = new InstantiationService();
	const initial = new DeferredPromise<boolean>();
	services.registerInstance(INativeHostService, {
		onDidChangeAccessibilitySupport: changes.event,
		isAccessibilitySupportEnabled: () => initial.p,
	} as unknown as INativeHostApi);
	services.registerInstance(IContextKeyService, contextKeys);
	services.registerInstance(IConfigurationService, configuration);
	using service = services.createInstance(NativeAccessibilityService, environment.window.document.body);
	assert.equal(changes.hasListeners(), true);
	service.dispose();
	await initial.complete(true);
	assert.equal(changes.hasListeners(), false);
	assert.equal(service.getAccessibilitySupport(), AccessibilitySupport.Unknown);
	assert.equal(contextKeys.getValue(CONTEXT_ACCESSIBILITY_MODE_ENABLED.key), false);
});
