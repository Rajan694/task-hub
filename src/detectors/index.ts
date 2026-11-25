import type { CommandDetector } from '../model';
import type { SavedStore } from '../saved';
import { composeDetector } from './compose';
import { justDetector } from './just';
import { makeDetector } from './make';
import { npmDetector } from './npm';
import { createSavedDetector } from './saved';
import { scriptsDetector } from './scripts';
import { taskfileDetector } from './taskfile';
import { vscodeTasksDetector } from './vscodeTasks';

/** Every detector, in the order their headings appear in the sidebar. A new source is one more file here. */
export function createDetectors(saved: SavedStore): readonly CommandDetector[] {
	return [npmDetector, makeDetector, justDetector, taskfileDetector, composeDetector, scriptsDetector, vscodeTasksDetector, createSavedDetector(saved)];
}
