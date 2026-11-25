import * as fs from 'fs';
import * as path from 'path';

const found = new Map<string, string | undefined>();

/** The full path of a program on PATH (with PATHEXT on Windows), or undefined. Cached per name. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
	const cacheKey = `${platform}:${name}`;
	if (found.has(cacheKey)) {
		return found.get(cacheKey);
	}
	const pathValue = env.PATH ?? env.Path ?? '';
	const extensions = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
	let result: string | undefined;
	outer: for (const dir of pathValue.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
		for (const ext of extensions) {
			const candidate = path.join(dir, name + ext);
			if (isFile(candidate)) {
				result = candidate;
				break outer;
			}
		}
	}
	found.set(cacheKey, result);
	return result;
}

/** bash for .sh scripts. On Windows, Git Bash (WSL's bash.exe also works, through PATH). */
export function bashPath(): string | undefined {
	if (process.platform === 'win32') {
		const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')];
		for (const root of roots) {
			const candidate = root && path.join(root, 'Git', 'bin', 'bash.exe');
			if (candidate && isFile(candidate)) {
				return candidate;
			}
		}
	}
	return findOnPath('bash');
}

/** PowerShell 7 (`pwsh`), or Windows PowerShell on Windows when PowerShell 7 isn't installed. */
export function powershellPath(): string | undefined {
	return findOnPath('pwsh') ?? (process.platform === 'win32' ? findOnPath('powershell') : undefined);
}

function isFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}
