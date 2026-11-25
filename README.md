# Task Hub

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Every command your project can run, one click away.** Task Hub is a sidebar that finds the scripts, targets and services in your workspace (npm, Makefile, docker-compose, Maven, Gradle, shell and PowerShell scripts, VS Code tasks and more) and runs them without opening or typing into a terminal.

> **Status: early development.** npm-family scripts, Makefile, justfile, Taskfile, docker compose, VS Code tasks, scripts and saved commands work today (milestones 0.1 and 0.2); Python, Maven, Gradle and groups arrive next (see [Roadmap](#roadmap)). The full design is in [docs/DESIGN.md](docs/DESIGN.md).

## Features

- **Finds commands automatically**, including monorepos, nested `package.json` files and multi-root workspaces.
- **Run, stop and restart** with one click. Stop kills the whole process tree, so dev servers really stop.
- **Live status** per command: running, passed, failed (with exit code), how long it took.
- **Port links.** A dev-server URL in the output becomes an **Open** button.
- **Script arguments.** `.ps1` `param()` blocks and `.sh` usage lines, `getopts` and `case "$1"` become pick lists and text boxes before a run.
- **Groups** start several commands in order, waiting for each to be ready.
- **Saved commands, groups and favorites** live in `.vscode/task-hub.json`, so a team can share them.
- **Restricted Mode aware.** In an untrusted workspace commands are listed but not run.

## Command sources

| Source | Read from |
| --- | --- |
| npm, pnpm, yarn, bun | Every `package.json` (nested ones too); the package manager comes from the lockfile or `packageManager` |
| Make, just, Task | `Makefile`, `justfile`, `Taskfile.yml` |
| Docker Compose | `compose.yaml` / `docker-compose.yml` services: up, stop, logs |
| VS Code tasks | `.vscode/tasks.json` |
| Saved commands | `.vscode/task-hub.json` |
| Scripts | `*.sh`, `*.bash`, `*.ps1`, `*.bat`, `*.cmd`, with their arguments |
| Python | `manage.py` (Django), Poe and PDM tasks in `pyproject.toml` |
| Maven, Gradle | `pom.xml`, `build.gradle(.kts)`, multi-module projects, wrappers |

## Using it

Open the **Task Hub** icon in the activity bar. Each `package.json` with scripts gets a heading; hover a script and click ▶ to run it.

| Row shows | Meaning | Buttons |
| --- | --- | --- |
| ○ | Not run yet | Run |
| ⟳ `running · :5173` | Running; a dev-server URL was found | Open in Browser, Stop, Restart |
| ✓ `passed · 3.2s` | Exited with code 0 | Run |
| ✗ `failed (exit 1)` | Exited with an error | Run, Show Output |
| ■ `stopped` | Stopped by you | Run |
| ▣ `running` (compose) | The service is up, whoever started it | Logs, Stop Service |
| ⚠ `needs bash` | The program the script needs isn't installed | — |

Clicking a row only selects it; nothing runs until you click ▶. Right-click a row for **Run with Arguments…**, **Show Output**, **Go to Definition**, **Copy Command** and **Save as Command…**. Output stays out of the way: a terminal opens only when you ask for it or a command fails.

**Scripts that take arguments** show what they take on their row (`env (staging, prod) [--dry-run]`), and ▶ asks for each value first: a pick list when the choices are known, a text box otherwise, filled with what you used last. Task Hub reads PowerShell `param()` blocks, and in shell scripts a `# Usage:` line, `getopts`, `case "$1"` and the `$1`…`$9` the script uses. Press Escape to cancel.

**Saved commands** go in `.vscode/task-hub.json`, so you can commit them for your team:

```jsonc
{
  "commands": [
    { "id": "django", "label": "Django server", "command": "python manage.py runserver", "cwd": "backend", "longRunning": true }
  ]
}
```

Add one with **+** in the view's title bar, or right-click any command → **Save as Command…** to keep it with its arguments (e.g. *Deploy to staging*). Set `taskHub.storage` to `private` to keep them on your machine instead.

## Extension Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `taskHub.sources` | all | Which detectors are on |
| `taskHub.exclude` | `node_modules`, `.venv`, `dist`, `target`, `build`, `.vscode-test` | Folders never scanned (folders hidden by `files.exclude` are skipped too) |
| `taskHub.longRunningNames` | `dev`, `start`, `serve`, `watch`, `run`, `bootRun`, `spring-boot:run` | Names treated as long-running |
| `taskHub.revealTerminal` | `onFailure` | `never`, `onFailure` or `always` |
| `taskHub.notify` | `failures` | `failures`, `all` or `never` |
| `taskHub.openUrlIn` | `externalBrowser` | Or `simpleBrowser` (inside VS Code) |
| `taskHub.storage` | `workspaceFile` | `.vscode/task-hub.json`, or `private` |
| `taskHub.scripts.include` | `*.sh`, `*.bash`, `*.ps1`, `*.bat`, `*.cmd` | Which files count as scripts |
| `taskHub.scripts.runFrom` | `scriptFolder` | Or `workspaceRoot` |
| `taskHub.scripts.maxFiles` | `200` | Stop listing scripts after this many |
| `taskHub.gradle.defaultTasks` | `build`, `test`, `clean`, `assemble` | Tasks shown before **Load all tasks** |

## Roadmap

| Version | Adds |
| --- | --- |
| 0.1 | Activity bar view, npm / pnpm / yarn / bun scripts, run and stop, live status |
| 0.2 | Makefile, justfile, Taskfile, docker-compose, `.vscode/tasks.json`, saved commands, scripts with argument prompts |
| 0.3 | Port detection and Open button, restart, favorites, status bar item, quick-pick runner, run history |
| 0.4 | Groups; Django, Poe and PDM; Maven and Gradle |
| 1.0 | Restricted Mode handling, Windows and macOS testing, Marketplace listing |

## Requirements

- The tools your commands use (Node.js, make, Docker, Java, Python, …) installed and on your `PATH`.
- `.sh` scripts on Windows need Git Bash or WSL; `.ps1` scripts on Linux and macOS need PowerShell 7 (`pwsh`).

## Installation

Install from the VS Code Marketplace or Open VSX once published, or from a `.vsix` file attached to a [GitHub release](https://github.com/Rajan694/task-hub/releases): see [INSTALL_FROM_VSIX.md](INSTALL_FROM_VSIX.md).

## Development

Requires Node.js 22 or later.

```bash
npm install
npm run compile     # type-check, lint, bundle to dist/
npm test            # extension tests in a downloaded VS Code
```

Press `F5` in VS Code to open a window with the extension loaded. Packaging and publishing are described in [RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE)
