import { WebWorkerServer } from '../../../base/common/worker/webWorker.js';
import { start } from '../../editor.worker.start.js';
import { diffWorkerChannel, diffWorkerHandler } from './diffWorker.js';

start(({ port, resources }) => {
	resources.add(new WebWorkerServer(port, diffWorkerChannel, diffWorkerHandler));
});
