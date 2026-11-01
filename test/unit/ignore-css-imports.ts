import { registerHooks } from 'node:module';
import { load, resolve } from './ignore-css-loader.ts';

// These hooks do no asynchronous work. Keep resolution on the test thread instead
// of starting a loader thread and crossing it for every module in every file.
registerHooks({ load, resolve });
