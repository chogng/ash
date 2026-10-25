import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { ICommandService } from '../../../../../platform/commands/common/commands.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import type { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import type { IModelPickerDelegate } from '../../browser/widget/input/modelPicker/modelPickerActionItem.js';
import { ModelPickerWidget } from '../../browser/widget/input/modelPicker/modelPickerWidget.js';

test('An unavailable selection keeps its exact ID and disabled controls remain disabled through first render', () => {
	const dom = new JSDOM('<body></body>');
	try {
		using resources = new DisposableStore();
		const changes = resources.add(new Emitter<void>());
		let automatic = false;
		const delegate = { onDidChangePresentation: changes.event, getModels: () => [], getSelectedModel: () => ({ provider: 'custom-endpoint', model: 'retired' }), isAutomaticModel: () => automatic } as unknown as IModelPickerDelegate;
		const picker = resources.add(new ModelPickerWidget(delegate, {} as IActionWidgetService, {} as IAccessibleViewService,
			{ createInstance: () => ({ dispose() { }, [Symbol.dispose]() { }, renderButton() { }, show() { } }) } as unknown as IInstantiationService, {} as ICommandService));
		picker.setEnabled(false);
		picker.render(dom.window.document.body);
		const button = dom.window.document.querySelector<HTMLElement>('.ash-chat-input-model-action')!;
		assert.equal(button.textContent, 'custom-endpoint/retired');
		assert.equal(button.getAttribute('aria-label'), 'custom-endpoint/retired');
		assert.equal(button.getAttribute('aria-disabled'), 'true');
		assert.equal(button.tabIndex, -1);
		automatic = true; changes.fire();
		assert.equal(button.textContent, 'Auto');
		assert.equal(button.getAttribute('aria-disabled'), 'true');
	} finally { dom.window.close(); }
});
