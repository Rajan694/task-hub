import * as fs from 'fs';
import * as path from 'path';

/**
 * How to start a build tool from a project root: its wrapper when the root has one
 * (`./mvnw`, `mvnw.cmd`, `./gradlew`, `gradlew.bat`), else the tool on PATH. A wrapper that
 * lost its executable bit (common after a checkout on Windows) runs through `sh`.
 */
export function buildToolProgram(root: string, wrapper: 'mvnw' | 'gradlew', fallback: string): { program: string; wrapped: boolean } {
	if (process.platform === 'win32') {
		const script = wrapper === 'mvnw' ? 'mvnw.cmd' : 'gradlew.bat';
		return fs.existsSync(path.join(root, script)) ? { program: script, wrapped: true } : { program: fallback, wrapped: false };
	}
	const file = path.join(root, wrapper);
	if (!fs.existsSync(file)) {
		return { program: fallback, wrapped: false };
	}
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return { program: `./${wrapper}`, wrapped: true };
	} catch {
		return { program: `sh ${wrapper}`, wrapped: true };
	}
}

/** Modification times of the files a cached task list depends on, as one string. */
export function filesSignature(files: readonly string[]): string {
	return files
		.map((file) => {
			try {
				return `${file}@${fs.statSync(file).mtimeMs}`;
			} catch {
				return `${file}@-`;
			}
		})
		.join('|');
}
