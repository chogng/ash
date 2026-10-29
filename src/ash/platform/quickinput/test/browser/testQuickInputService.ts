import { Event } from '../../../../base/common/event.js';
import { ContextKeyService, type IContextKeyService } from '../../../contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { BrowserLayoutService, type ILayoutService } from '../../../layout/browser/layoutService.js';
import { IQuickInputService } from '../../common/quickInput.js';
import { QuickInputService } from '../../browser/quickInputService.js';
import { IStorageService, StorageScope, StorageTarget, type StorageValue } from '../../../storage/common/storage.js';

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
		if (!scope.has(IStorageService)) scope.registerInstance(IStorageService, new TestStorageService());
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
	quickAccess: {
		onDidChangeVisibility: Event.None,
		show() {
			throw new Error('Unexpected Quick Access');
		},
	},
	onShow: Event.None,
	onHide: Event.None,
	currentQuickInput: undefined,
	focus() {
		throw new Error('Unexpected Quick Input focus');
	},
	toggle() {
		throw new Error('Unexpected Quick Input toggle');
	},
	setAlignment() {
		throw new Error('Unexpected Quick Input alignment');
	},
	navigate() {
		throw new Error('Unexpected Quick Input navigation');
	},
	async accept() {
		throw new Error('Unexpected Quick Input acceptance');
	},
	async cancel() {
		throw new Error('Unexpected Quick Input cancellation');
	},
};

/** Scope-local storage for tests that do not supply a persistence adapter. */
class TestStorageService implements IStorageService {
	readonly onDidChangeValue = Event.None;
	readonly onWillSaveState = Event.None;
	private readonly entries = new Map<string, { value: string; target: StorageTarget }>();
	get(key: string, scope: StorageScope, fallbackValue: string): string;
	get(key: string, scope: StorageScope): string | undefined;
	get(key: string, scope: StorageScope, fallbackValue?: string): string | undefined {
		return this.entries.get(`${scope}:${key}`)?.value ?? fallbackValue;
	}
	getBoolean(key: string, scope: StorageScope, fallbackValue: boolean): boolean;
	getBoolean(key: string, scope: StorageScope): boolean | undefined;
	getBoolean(key: string, scope: StorageScope, fallbackValue?: boolean): boolean | undefined {
		const value = this.get(key, scope);
		return value === undefined ? fallbackValue : value === 'true';
	}
	getNumber(key: string, scope: StorageScope, fallbackValue: number): number;
	getNumber(key: string, scope: StorageScope): number | undefined;
	getNumber(key: string, scope: StorageScope, fallbackValue?: number): number | undefined {
		const value = this.get(key, scope);
		return value === undefined ? fallbackValue : Number(value);
	}
	store(key: string, value: StorageValue, scope: StorageScope, target: StorageTarget): void {
		if (value === undefined || value === null) this.remove(key, scope);
		else this.entries.set(`${scope}:${key}`, { value: String(value), target });
	}
	remove(key: string, scope: StorageScope): void {
		this.entries.delete(`${scope}:${key}`);
	}
	keys(scope: StorageScope, target: StorageTarget): readonly string[] {
		return [...this.entries].filter(([key, entry]) => key.startsWith(`${scope}:`) && entry.target === target).map(([key]) => key.slice(scope.length + 1));
	}
	isNew(): boolean {
		return this.entries.size === 0;
	}
	async flush(): Promise<void> {}
}
