import { WebWorkerServer } from '../../../../base/common/worker/webWorker.js';
import { start } from '../../../../editor/editor.worker.start.js';
import { ImageEncoderWorker } from './imageEncoderWorker.js';

start(({ port, resources }) => {
	resources.add(new WebWorkerServer(port, () => new ImageEncoderWorker()));
});
