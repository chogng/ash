import { startStandaloneWebWorker, type StandaloneWorkerContext } from '../../../src/ash/editor/standalone/browser/standaloneWebWorker.js';

startStandaloneWebWorker(self, (context: StandaloneWorkerContext) => ({
	readModels: () => context.getMirrorModels().map(model => ({ uri: model.uri.toString(), version: model.version, value: model.getValue() })),
	callHost: (value: string) => context.callHost('echo', value),
}));
