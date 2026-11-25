# Change Log

All notable changes to the "Task Hub" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/).
Write new entries under **[Unreleased]**. The publish script moves them under the new version number when you release.

## [Unreleased]

### Added

- **Task Hub** view in its own activity bar icon, listing the scripts of every `package.json` in the workspace, nested ones included, with one heading per package (`apps/web  package.json · pnpm`). Multi-root workspaces are supported.
- The package manager comes from the nearest `packageManager` field or lockfile (`pnpm-lock.yaml`, `yarn.lock`, `bun.lock(b)`, `package-lock.json`), walking up to the repository root, so a package inside a pnpm, yarn or bun workspace runs with that tool. npm is the default.
- **Run**, **Stop** and **Restart** buttons on each row. Commands run in their package's folder without opening a terminal; Stop ends the whole process tree (process group on Linux and macOS, `taskkill /T` on Windows), and running commands are stopped when VS Code closes.
- Live status per command: idle, running, ready, passed, failed (with exit code) and stopped, with built-in icons. A local dev-server URL in the output (`http://localhost:5173/`) marks the command ready, shows `:5173` on its row and adds an **Open in Browser** button (`taskHub.openUrlIn`).
- **Show Output** opens a terminal with the command's output so far, then follows it live; typed lines go to the process and Ctrl+C stops it. A failed command shows its terminal and a notification with **Show Output** and **Run Again** (`taskHub.revealTerminal`, `taskHub.notify`).
- Right-click: **Go to Definition** (opens package.json at the script) and **Copy Command**. Hover shows the full command line, the script, its folder and the last run.
- The list updates when a `package.json` or lockfile changes. `node_modules`, `taskHub.exclude` (now also `**/.vscode-test/**`) and folders hidden by `files.exclude` are skipped.
- Restricted Mode: commands are listed but not run.

## [0.1.0] - 2026-11-25

- Project setup: TypeScript + esbuild build, tests, packaging and release scripts.
