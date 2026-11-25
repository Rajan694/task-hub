import type { CommandDetector } from '../model';
import type { SavedStore } from '../saved';
import { composeDetector } from './compose';
import { createGradleDetector, type GradleTaskCache } from './gradle';
import { justDetector } from './just';
import { makeDetector } from './make';
import { mavenDetector } from './maven';
import { npmDetector } from './npm';
import { pythonDetector } from './python';
import { createSavedDetector } from './saved';
import { scriptsDetector } from './scripts';
import { taskfileDetector } from './taskfile';
import { vscodeTasksDetector } from './vscodeTasks';

/** Every detector, in the order their headings appear in the sidebar. A new source is one more file here. */
export function createDetectors(saved: SavedStore, gradleTasks: GradleTaskCache): readonly CommandDetector[] {
	return [
		npmDetector,
		makeDetector,
		justDetector,
		taskfileDetector,
		composeDetector,
		pythonDetector,
		mavenDetector,
		createGradleDetector(gradleTasks),
		scriptsDetector,
		vscodeTasksDetector,
		createSavedDetector(saved),
	];
}
