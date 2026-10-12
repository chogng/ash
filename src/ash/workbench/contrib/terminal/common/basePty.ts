import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IProcessProperty, IProcessReadyEvent, ITerminalChildProcess } from '../../../../platform/terminal/common/terminal.js';

/** Owns the child-process event ports; transport and handle lifetime belong to the concrete PTY. */
export abstract class BasePty extends Disposable implements ITerminalChildProcess {
	private readonly output = this._register(new Emitter<string>());
	private readonly ready = this._register(new Emitter<IProcessReadyEvent>());
	private readonly properties = this._register(new Emitter<IProcessProperty>());
	private readonly exited = this._register(new Emitter<number | undefined>());
	readonly onProcessData = this.output.event;
	readonly onProcessReady = this.ready.event;
	readonly onDidChangeProperty = this.properties.event;
	readonly onProcessExit = this.exited.event;

	constructor(readonly id: number, readonly shouldPersist: boolean) { super(); }
	handleData(data: string): void { this.output.fire(data); }
	handleReady(ready: IProcessReadyEvent): void { this.ready.fire(ready); }
	handleDidChangeProperty(property: IProcessProperty): void { this.properties.fire(property); }
	handleExit(code: number | undefined): void { this.exited.fire(code); }
	abstract start(): Promise<void>;
	abstract shutdown(immediate: boolean): void;
}
