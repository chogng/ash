import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import type { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import '../../browser/accessibilityConfiguration.js';
import { AccessibleViewService } from '../../browser/accessibleView.js';

test('Explorer accessibility hint follows the verbosity setting', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	using configuration = new InMemoryConfigurationService();
	using contextKeys = new ContextKeyService();
	using services = new ServiceContainer();
	using accessibleView = new AccessibleViewService({ mainContainer: browser.window.document.body } as ILayoutService, contextKeys, configuration, services);
	try {
		assert.match(accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Explorer) ?? '', /Alt\+F1/);
		await configuration.updateValue(AccessibilityVerbositySettingId.Explorer, false);
		assert.equal(accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Explorer), undefined);
		await configuration.updateValue(AccessibilityVerbositySettingId.Explorer, true);
		assert.match(accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Explorer) ?? '', /Alt\+F1/);
		assert.match(accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.OpenEditors) ?? '', /Alt\+F1/);
		await configuration.updateValue(AccessibilityVerbositySettingId.OpenEditors, false);
		assert.equal(accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.OpenEditors), undefined);
	} finally {
		browser.window.close();
	}
});
