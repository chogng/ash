import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue, type IReader } from '../../../../base/common/observable.js';
import type { IChecksOperationService } from '../common/checksOperationService.js';

export class ChecksOperationService extends Disposable implements IChecksOperationService {
	private readonly operations = observableValue<ReadonlyMap<string, 'writing' | 'uncertain'>>(this, new Map());

	public isBlocked(key: string, reader?: IReader): boolean {
		return this.operations.read(reader).has(key);
	}

	public tryStart(key: string): boolean {
		if (this.isBlocked(key)) return false;
		this.set(key, 'writing');
		return true;
	}

	public markUncertain(key: string): void {
		this.set(key, 'uncertain');
	}

	public finish(key: string): void {
		// An unconfirmed submission must keep blocking after its original caller retires.
		if (this.operations.get().get(key) === 'writing') this.set(key, undefined);
	}

	private set(key: string, value: 'writing' | 'uncertain' | undefined): void {
		const operations = new Map(this.operations.get());
		if (value === undefined) operations.delete(key);
		else operations.set(key, value);
		this.operations.set(operations, undefined);
	}
}
