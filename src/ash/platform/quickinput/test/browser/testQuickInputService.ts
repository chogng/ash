import { Event } from '../../../../base/common/event.js';
import { ContextKeyService, type IContextKeyService } from '../../../contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { BrowserLayoutService, type ILayoutService } from '../../../layout/browser/layoutService.js';
import { IQuickInputService } from '../../common/quickInput.js';
import { QuickInputService } from '../../browser/quickInputService.js';

/** Test scope owner; every operation still runs through the production service and controller. */
export class TestQuickInputService extends QuickInputService {
	constructor(options: {
		readonly container: HTMLElement;
		readonly contextKeyService?: IContextKeyService;
		readonly layoutService?: ILayoutService;
		readonly instantiationService?: InstantiationService;
	}) {
		const scope = options.instantiationService ?? new InstantiationService();
		const contexts = options.contextKeyService ?? new ContextKeyService();
		const layout = options.layoutService ?? new BrowserLayoutService({ root: options.container });
		super(scope, contexts, layout);
		if (!options.instantiationService) {
			this._register(scope);
			scope.registerInstance(IQuickInputService, this);
		}
		if (!options.contextKeyService) this._register(contexts as ContextKeyService);
		if (!options.layoutService) this._register(layout as BrowserLayoutService);
	}
}

/** Unused service controls fail loudly in headless tests of input/pick consumers. */
export const quickInputServiceTestControls: Omit<IQuickInputService, 'input' | 'createQuickPick'> = {
	quickAccess: { onDidChangeVisibility: Event.None, show() { throw new Error('Unexpected Quick Access'); } },
	onShow: Event.None, onHide: Event.None, currentQuickInput: undefined,
	focus() { throw new Error('Unexpected Quick Input focus'); },
	toggle() { throw new Error('Unexpected Quick Input toggle'); },
	navigate() { throw new Error('Unexpected Quick Input navigation'); },
	async accept() { throw new Error('Unexpected Quick Input acceptance'); },
	async cancel() { throw new Error('Unexpected Quick Input cancellation'); },
};
