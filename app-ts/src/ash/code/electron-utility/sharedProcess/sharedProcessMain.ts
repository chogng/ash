import { Client } from '../../../base/parts/ipc/common/ipc.mp.js';
import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { DisposableMap, DisposableStore } from '../../../base/common/lifecycle.js';
import { IBrowserViewGroupService } from '../../../platform/browserView/common/browserViewGroup.js';
import { PlaywrightService } from '../../../platform/browserView/node/playwrightService.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../platform/instantiation/common/serviceCollection.js';

// Main supplies both the port and its window identity; renderers cannot address another window.
const connections = new DisposableMap<string, DisposableStore>();
process.parentPort.on('message', (event: Electron.MessageEvent) => {
	const { context } = event.data as { context: string };
	const [port] = event.ports;
	if (!port || typeof context !== 'string') { throw new TypeError('Invalid shared-process connection'); }
	const resources = new DisposableStore();
	connections.set(context, resources);
	const client = resources.add(new Client({
		postMessage: data => port.postMessage(data), start: () => port.start(), close: () => port.close(),
		addEventListener: (type, listener) => type === 'message' ? port.on('message', listener) : port.on('close', listener as () => void), removeEventListener: (type, listener) => type === 'message' ? port.off('message', listener) : port.off('close', listener as () => void),
	}, context));
	const services = resources.add(new InstantiationService(new ServiceCollection([IBrowserViewGroupService,
		ProxyChannel.toService<IBrowserViewGroupService>(client.getChannel('browserViewGroup'))])));
	const playwright = resources.add(services.createInstance(PlaywrightService));
	client.registerChannel('playwright', ProxyChannel.fromService(playwright, resources));
	port.once('close', () => { if (connections.get(context) === resources) { connections.deleteAndDispose(context); } });
});
process.once('exit', () => connections.dispose());
