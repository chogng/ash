import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../storage/common/storage.js';
import type { IExtensionIdentifier, IGlobalExtensionEnablementService } from './extensionManagement.js';

const disabledExtensionsKey = 'extensionsIdentifiers/disabled';

export class GlobalExtensionEnablementService extends Disposable implements IGlobalExtensionEnablementService {
	private readonly changes = this._register(new Emitter<{ readonly source?: string; }>());
	public readonly onDidChangeEnablement = this.changes.event;

	constructor(@IStorageService private readonly storage: IStorageService) {
		super();
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key === disabledExtensionsKey) {
				this.changes.fire({ source: 'storage' });
			}
		}));
	}

	public getDisabledExtensions(): readonly IExtensionIdentifier[] {
		const values: unknown = JSON.parse(this.storage.get(disabledExtensionsKey, StorageScope.PROFILE, '[]'));
		if (!Array.isArray(values) || values.length > 10000) {
			throw new TypeError('Invalid disabled extension identifiers');
		}
		return values.map(value => {
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				throw new TypeError('Invalid disabled extension identifier');
			}
			return { id: extensionId(value.id) };
		});
	}

	public async enableExtension(extension: IExtensionIdentifier): Promise<boolean> {
		const id = extensionId(extension.id);
		const disabled = this.getDisabledExtensions();
		if (!disabled.some(extension => extension.id === id)) { return false; }
		this.storage.store(disabledExtensionsKey, JSON.stringify(disabled.filter(extension => extension.id !== id)), StorageScope.PROFILE, StorageTarget.USER);
		await this.storage.flush();
		return true;
	}

	public async disableExtension(extension: IExtensionIdentifier): Promise<boolean> {
		const id = extensionId(extension.id);
		const disabled = this.getDisabledExtensions();
		if (disabled.some(extension => extension.id === id)) { return false; }
		if (disabled.length >= 10000) { throw new RangeError('Disabled extension identifiers exceed their limit'); }
		this.storage.store(disabledExtensionsKey, JSON.stringify([...disabled, { id }]), StorageScope.PROFILE, StorageTarget.USER);
		await this.storage.flush();
		return true;
	}
}

function extensionId(value: unknown): string {
	if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(value)) {
		throw new TypeError('Invalid extension identifier');
	}
	return value.toLowerCase();
}
