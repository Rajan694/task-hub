import type { CommandDetector } from '../model';
import { npmDetector } from './npm';

/** Every detector, in the order their groups appear in the sidebar. A new source is one more file here. */
export const DETECTORS: readonly CommandDetector[] = [npmDetector];
