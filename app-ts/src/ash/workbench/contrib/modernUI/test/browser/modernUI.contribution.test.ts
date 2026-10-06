import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { h } from '../../../../../base/browser/dom.js';
import type { AuxiliaryWindowOpenOptions, IAuxiliaryWindow, IAuxiliaryWindowService as IAuxiliaryWindowServiceContract } from '../../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import type { WorkbenchLayoutStyle } from '../../../../common/configuration.js';
import type { IWorkbenchLayoutService as IWorkbenchLayoutServiceContract } from '../../../../services/layout/browser/layoutService.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
Object.defineProperty(globalThis, 'window', { configurable: true, value: browserEnvironment.window });
Object.defineProperty(globalThis, 'document', { configurable: true, value: browserEnvironment.window.document });

const { Emitter, Event } = await import('../../../../../base/common/event.js');
const { Disposable } = await import('../../../../../base/common/lifecycle.js');
const { IConfigurationService } = await import('../../../../../platform/configuration/common/configuration.js');
const { InstantiationService } = await import('../../../../../platform/instantiation/common/instantiationService.js');
const { WorkbenchConfiguration } = await import('../../../../common/configuration.js');
const { WorkbenchContributionsRegistry, WorkbenchPhase } = await import('../../../../common/contributions.js');
const { IAuxiliaryWindowService } = await import('../../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js');
const { WorkbenchConfigurationService } = await import('../../../../services/configuration/browser/configurationService.js');
const { IWorkbenchLayoutService } = await import('../../../../services/layout/browser/layoutService.js');
const { BrowserLayoutService } = await import('../../../../../platform/layout/browser/layoutService.js');
await import('../../browser/modernUI.contribution.js');

class TestWorkbenchLayoutService extends BrowserLayoutService implements IWorkbenchLayoutServiceContract {
	public readonly styles: WorkbenchLayoutStyle[] = [];
	public readonly onDidChangePartVisibility = Event.None;

	constructor(container: HTMLElement) { super({ root: container }); }
	isPartVisible(): boolean { return false; }
	isPanelMaximized(): boolean { return false; }
	toggleMaximizedPanel(): void { }
	showPart(): void { }
	showParts(): void { }
	hidePart(): void { }
	hideParts(): void { }
	getPartSize() { return { width: 0, height: 0 }; }
	resizePart(): void { }

	public setLayoutStyle(style: WorkbenchLayoutStyle): void {
		this.styles.push(style);
	}
}

class TestAuxiliaryWindowService extends Disposable implements IAuxiliaryWindowServiceContract {
	private readonly openEmitter = this._register(new Emitter<IAuxiliaryWindow>());
	public readonly onDidOpenWindow = this.openEmitter.event;

	public publish(window: IAuxiliaryWindow): void {
		this.openEmitter.fire(window);
	}

	public open(_options?: AuxiliaryWindowOpenOptions): Promise<IAuxiliaryWindow> {
		throw new Error('Not implemented');
	}

	public getWindow(_id: number): IAuxiliaryWindow | undefined {
		return undefined;
	}
}

test('Modern UI contribution starts at restore and owns live window layout style', async () => {
	const dom = new JSDOM('<!doctype html><body><aside></aside></body>');
	const auxiliaryContainer = dom.window.document.querySelector('aside');
	assert.ok(auxiliaryContainer);
	using configuration = new WorkbenchConfigurationService();
	using auxiliaryWindows = new TestAuxiliaryWindowService();
	using layout = new TestWorkbenchLayoutService(h(dom.window.document, 'main'));
	dom.window.document.body.append(layout.mainContainer);
	using services = new InstantiationService();
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IWorkbenchLayoutService, layout);
	services.registerInstance(IAuxiliaryWindowService, auxiliaryWindows);
	using closeEmitter = new Emitter<void>();
	const auxiliaryWindow = {
		id: 1,
		window: dom.window,
		container: auxiliaryContainer,
		onDidLayout: Event.None,
		onBeforeUnload: Event.None,
		onDidClose: closeEmitter.event,
		layout(): void { },
		dispose(): void { closeEmitter.fire(); },
		[Symbol.dispose](): void { closeEmitter.fire(); },
	} as unknown as IAuxiliaryWindow;

	using host = WorkbenchContributionsRegistry.createHost(services);
	host.advance(WorkbenchPhase.BlockStartup);
	assert.deepEqual(layout.styles, []);

	host.advance(WorkbenchPhase.BlockRestore);
	assert.deepEqual(layout.styles, ['modern']);
	assert.equal(layout.mainContainer.dataset.layoutStyle, 'modern');
	assert.equal(layout.mainContainer.classList.contains('modern-ui'), true);
	auxiliaryWindows.publish(auxiliaryWindow);
	assert.equal(auxiliaryContainer.dataset.layoutStyle, 'modern');
	assert.equal(auxiliaryContainer.classList.contains('modern-ui'), true);

	await configuration.updateValue(WorkbenchConfiguration.layoutStyle, 'flat');
	assert.deepEqual(layout.styles, ['modern', 'flat']);
	assert.equal(layout.mainContainer.dataset.layoutStyle, 'flat');
	assert.equal(layout.mainContainer.classList.contains('modern-ui'), false);
	assert.equal(auxiliaryContainer.dataset.layoutStyle, 'flat');
	assert.equal(auxiliaryContainer.classList.contains('modern-ui'), false);

	host.dispose();
	assert.equal(layout.mainContainer.hasAttribute('data-layout-style'), false);
	assert.equal(layout.mainContainer.classList.contains('modern-ui'), false);
	assert.equal(auxiliaryContainer.hasAttribute('data-layout-style'), false);
	assert.equal(auxiliaryContainer.classList.contains('modern-ui'), false);
	dom.window.close();
});
