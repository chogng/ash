import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { TabbedActionListWidget } from '../../../../../platform/actionWidget/browser/tabbedActionListWidget.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { ILanguageModelsService } from '../../common/languageModels.js';
import type { IModelPickerDelegate } from '../../browser/widget/input/modelPicker/modelPickerActionItem.js';
import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../../services/chat/common/modelCatalog.js';
import { ChatModelSliderWidget } from '../../browser/widget/input/modelPicker/chatModelSliderWidget.js';
import { ModelPickerWidget } from '../../browser/widget/input/modelPicker/modelPickerWidget.js';
import { ChatInputModelSelectionController } from '../../browser/widget/input/chatInputModelSelectionController.js';
import { setIconResolver } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { getIconDefinition } from '../../../../../platform/theme/common/iconRegistry.js';

test('The model trigger uses catalog metadata even when the selected model is hidden', () => {
	const dom = new JSDOM('<body></body>');
	setIconResolver(dom.window.document, icon => getIconDefinition(icon));
	try {
		using resources = new DisposableStore();
		const changes = resources.add(new Emitter<void>());
		let automatic = false;
		let selectedEntry: ModelCatalogEntry | undefined;
		const selected = { provider: 'custom-endpoint', model: 'vendor/retired' };
		const delegate = {
			configureInMenu: true, onDidChangePresentation: changes.event, getModels: () => [],
			getSelectedModel: () => selected, getSelectedModelEntry: () => selectedEntry,
			getSelectedReasoningEffort: () => undefined, isAutomaticModel: () => automatic,
		} as unknown as IModelPickerDelegate;
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
		selectedEntry = {
			model: selected, displayName: 'Retired Model', longContext: null,
			defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ effort: 'high' }],
		};
		changes.fire();
		assert.equal(button.querySelector('.ash-chat-input-picker-label')?.textContent, 'Retired Model');
		assert.equal(button.querySelector('.ash-chat-input-model-effort')?.textContent, 'High');
		assert.equal(button.getAttribute('aria-label'), 'Retired Model High');
		automatic = true; changes.fire();
		assert.equal(button.textContent, 'Auto');
		assert.equal(button.getAttribute('aria-disabled'), 'true');
	} finally { dom.window.close(); }
});

test('The Chat slider displays effective native reasoning effort and adjusts it with the keyboard', async () => {
	const dom = new JSDOM('<body><button></button><div></div></body>');
	const { document } = dom.window;
	setIconResolver(document, icon => getIconDefinition(icon));
	try {
		using resources = new DisposableStore();
		const model: ModelCatalogEntry = {
			model: { provider: 'openai', model: 'gpt-6-luna' }, displayName: 'GPT-6 Luna', longContext: null,
			supportedReasoningEfforts: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
			defaultReasoningEffort: 'low', effectiveReasoningEffort: 'medium',
		};
		let selected: ModelReasoningEffort | undefined;
		const delegate: IModelPickerDelegate = {
			onDidChangePresentation: Event.None,
			getModels: () => [model], getSelectedModel: () => model.model, isAutomaticModel: () => false,
			getSelectedModelEntry: () => model,
			getSelectedReasoningEffort: () => selected, getModelsError: () => undefined,
			selectModel: async () => { }, openSettings: async () => { },
			selectReasoningEffort: async effort => { selected = effort; },
		};
		const panel = document.querySelector('div')!;
		const picker = resources.add(new ChatModelSliderWidget(delegate, resources.add(new ChatInputModelSelectionController()), {
			createInstance: () => ({
				showContent: (options: Parameters<TabbedActionListWidget['showContent']>[0]) => resources.add(options.render(panel, () => { })),
				dispose() { },
				[Symbol.dispose]() { },
			}),
		} as unknown as IInstantiationService, {} as ILanguageModelsService, {} as INotificationService));
		picker.show(document.querySelector('button')!);
		const slider = () => panel.querySelector<HTMLElement>('[role="slider"]')!;
		assert.equal(slider().getAttribute('aria-valuetext'), 'Medium');
		slider().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(selected, 'high');
		assert.equal(slider().getAttribute('aria-valuetext'), 'High');
		assert.equal(document.activeElement, slider());
	} finally { dom.window.close(); }
});
