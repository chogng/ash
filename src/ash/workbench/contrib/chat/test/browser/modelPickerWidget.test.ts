import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import type { IModelPickerDelegate } from '../../browser/widget/input/modelPicker/modelPickerActionItem.js';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { ModelPickerWidget } from '../../browser/widget/input/modelPicker/modelPickerWidget.js';
import { setIconResolver } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { getIconDefinition } from '../../../../../platform/theme/common/iconRegistry.js';

test('An unavailable selection keeps its exact ID and disabled controls remain disabled through first render', () => {
	const dom = new JSDOM('<body></body>');
	setIconResolver(dom.window.document, icon => getIconDefinition(icon));
	try {
		using resources = new DisposableStore();
		const changes = resources.add(new Emitter<void>());
		let automatic = false;
		let models: ModelCatalogEntry[] = [];
		const selected = { provider: 'custom-endpoint', model: 'vendor/retired' };
		const delegate = { onDidChangePresentation: changes.event, getModels: () => models, getSelectedModel: () => selected, getSelectedReasoningEffort: () => undefined, isAutomaticModel: () => automatic } as unknown as IModelPickerDelegate;
		const picker = resources.add(new ModelPickerWidget(delegate,
			{ createInstance: () => ({ dispose() { }, [Symbol.dispose]() { }, show() { }, hide() { } }) } as unknown as IInstantiationService,
			{ getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService));
		picker.setEnabled(false);
		picker.render(dom.window.document.body);
		const button = dom.window.document.querySelector<HTMLElement>('.ash-chat-input-model-action')!;
		assert.equal(button.textContent, 'vendor/retired');
		assert.equal(button.getAttribute('aria-label'), 'vendor/retired');
		assert.equal(button.getAttribute('aria-disabled'), 'true');
		assert.equal(button.tabIndex, -1);
		models = [{ model: selected, displayName: 'Retired Model', longContext: null }];
		changes.fire();
		assert.equal(button.textContent, 'vendor/retired');
		assert.equal(button.getAttribute('aria-label'), 'vendor/retired');
		automatic = true; changes.fire();
		assert.equal(button.textContent, 'Auto');
		assert.equal(button.getAttribute('aria-disabled'), 'true');
	} finally { dom.window.close(); }
});
