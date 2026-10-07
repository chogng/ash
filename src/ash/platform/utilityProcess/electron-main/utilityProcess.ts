import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess as ElectronUtilityProcess } from 'electron/main';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';

export interface IUtilityProcessConfiguration {
	readonly name: string;
	readonly entryPoint: string;
}

/** An application-owned child, started on first use; a process failure retires its connections. */
export class UtilityProcess extends Disposable {
	private child: ElectronUtilityProcess | undefined;
	private failed = false;
	private readonly ports = new Set<MessagePortMain>();
	constructor(private readonly configuration: IUtilityProcessConfiguration) { super(); }
	public connect(context: string): MessagePortMain {
		this.assertNotDisposed();
		if (this.failed) { throw new Error('Utility process unavailable'); }
		if (!this.child) {
			const child = utilityProcess.fork(this.configuration.entryPoint, [], { serviceName: this.configuration.name });
			this.child = child;
			const exit = (): void => {
				this.failed = true;
				for (const port of this.ports) { port.close(); }
				this.ports.clear();
			};
			child.on('exit', exit);
			this._register(toDisposable(() => { child.off('exit', exit); child.kill(); }));
		}
		const { port1, port2 } = new MessageChannelMain();
		this.ports.add(port1);
		port1.once('close', () => this.ports.delete(port1));
		this.child.postMessage({ context }, [port2]);
		return port1;
	}
	protected override disposeCore(): void {
		for (const port of this.ports) { port.close(); }
		this.ports.clear();
		super.disposeCore();
	}
}
