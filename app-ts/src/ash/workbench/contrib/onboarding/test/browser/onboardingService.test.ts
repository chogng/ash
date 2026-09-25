import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { getWindows } from '../../../../../base/browser/window.js';
import { Event } from '../../../../../base/common/event.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { OnboardingScenarioService } from '../../browser/onboardingService.js';
import { registerOnboardingTargetProvider } from '../../browser/spotlight/onboardingTarget.js';
import { registerOnboardingScenario } from '../../common/onboardingRegistry.js';

suite('OnboardingScenarioService', () => {
	test('starts a pending guide when its owned target appears', async () => {
		const dom = new JSDOM('<!doctype html><body><main><button id="target">Target</button></main></body>', { url: 'https://ash.invalid/' });
		const previousWindow = globalThis.window;
		const previousHTMLElement = globalThis.HTMLElement;
		Object.assign(globalThis, { window: dom.window, HTMLElement: dom.window.HTMLElement });
		getWindows();
		try {
			const container = dom.window.document.querySelector('main')!;
			using services = new ServiceContainer();
			using context = new ContextKeyService();
			services.registerInstance(IConfigurationService, { getValue: () => true, onDidChangeConfiguration: Event.None } as unknown as IConfigurationService);
			services.registerInstance(IContextKeyService, context);
			services.registerInstance(ILayoutService, { mainContainer: container } as ILayoutService);
			services.registerInstance(IStorageService, { getBoolean: () => false, store() {}, remove() {} } as unknown as IStorageService);
			using scenario = registerOnboardingScenario({ id: 'test.lateTarget', steps: [{ target: 'test.lateTarget.control', title: 'Late target', description: 'Appeared after startup' }] });
			using service = services.createInstance(OnboardingScenarioService);
			service.start();
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(container.querySelector('[role="dialog"]'), null);
			using provider = registerOnboardingTargetProvider('test.lateTarget.control', () => dom.window.document.querySelector<HTMLElement>('#target')!);
			await new Promise<void>(resolve => {
				const observer = new dom.window.MutationObserver(() => {
					if (!container.querySelector('[role="dialog"]')) return;
					observer.disconnect();
					resolve();
				});
				observer.observe(container, { childList: true, subtree: true });
			});
			assert.equal(container.querySelector('[role="dialog"] h2')?.textContent, 'Late target');
			container.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click();
			await new Promise<void>(resolve => setImmediate(resolve));
		} finally {
			Object.assign(globalThis, { window: previousWindow, HTMLElement: previousHTMLElement });
			dom.window.close();
		}
	});

	test('shows an eligible guide once and saves its shown state', async () => {
		const dom = new JSDOM('<!doctype html><body><main><button id="target">Target</button></main></body>', { url: 'https://ash.invalid/' });
		const previousWindow = globalThis.window;
		const previousHTMLElement = globalThis.HTMLElement;
		Object.assign(globalThis, { window: dom.window, HTMLElement: dom.window.HTMLElement });
		getWindows();
		try {
			const container = dom.window.document.querySelector('main')!;
			const target = dom.window.document.querySelector<HTMLButtonElement>('#target')!;
			const values = new Map<string, boolean>();
			using services = new ServiceContainer();
			using context = new ContextKeyService();
			services.registerInstance(IConfigurationService, {
				getValue: () => true,
				onDidChangeConfiguration: Event.None,
			} as unknown as IConfigurationService);
			services.registerInstance(IContextKeyService, context);
			services.registerInstance(ILayoutService, { mainContainer: container } as ILayoutService);
			services.registerInstance(IStorageService, {
				getBoolean: (key: string, scope: StorageScope) => scope === StorageScope.PROFILE && values.get(key) === true,
				store: (key: string, value: boolean) => { values.set(key, value); },
				remove: (key: string) => { values.delete(key); },
			} as unknown as IStorageService);
			using scenario = registerOnboardingScenario({
				id: 'test.automatic',
				steps: [{ target: 'test.automatic.target', title: 'Automatic', description: 'Follow this guide' }],
			});
			using targetProvider = registerOnboardingTargetProvider('test.automatic.target', () => target);
			using service = services.createInstance(OnboardingScenarioService);
			service.start();
			await new Promise<void>(resolve => {
				const observer = new dom.window.MutationObserver(() => {
					if (!container.querySelector('[role="dialog"]')) return;
					observer.disconnect();
					resolve();
				});
				observer.observe(container, { childList: true, subtree: true });
			});
			assert.equal(container.querySelector('[role="dialog"] h2')?.textContent, 'Automatic');
			container.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click();
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepEqual({ shown: values.get('onboarding.shown.test.automatic'), dialogs: container.querySelectorAll('[role="dialog"]').length }, { shown: true, dialogs: 0 });
		} finally {
			Object.assign(globalThis, { window: previousWindow, HTMLElement: previousHTMLElement });
			dom.window.close();
		}
	});
});
