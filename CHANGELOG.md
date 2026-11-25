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
- **Makefile** targets (`GNUmakefile`, `makefile`, `Makefile`, whichever make would use), with a `## comment` after the target as its description. Special targets, pattern rules, file targets and assignments are left out.
- **justfile** recipes, with the comment or `[doc()]` above each as its description; private recipes are left out. Recipe parameters are asked for before a run.
- **Taskfile** tasks with their `desc`; `internal: true` tasks are left out.
- **docker compose** services (`compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml`): Run starts a service with `up -d`; a service that `docker compose ps` reports as running shows *running* with **Logs** and **Stop Service** buttons. The state refreshes after each compose command and every 15 seconds while the view is visible.
- **VS Code tasks** from `.vscode/tasks.json` (comments allowed; `hide: true` tasks left out). They run through VS Code's own task system and report their exit code.
- **Scripts** (`taskHub.scripts.include`, at most `taskHub.scripts.maxFiles`): `.sh` / `.bash` with bash (Git Bash on Windows), `.ps1` with `pwsh` (Windows PowerShell on Windows when PowerShell 7 is missing), and `.bat` / `.cmd` on Windows. One heading per folder; each runs in its own folder, or the workspace root with `taskHub.scripts.runFrom`. A row shows *needs bash* or *needs pwsh* when the program is missing.
- **Script arguments**, shown on each row and asked for before a run: PowerShell `param()` blocks (`Mandatory`, defaults, `[ValidateSet()]` as a pick list, `[switch]`), shell `# Usage:` lines, `getopts` option strings, `case "$1"` branches as a pick list, and the `$1`…`$9` a script reads (named and defaulted from lines like `env=${1:-staging}`). Switches are one multi-select; the last answers are filled in next time. Scripts with nothing known get one optional text box. Arguments are passed as a list, never through a shell string.
- When PowerShell's execution policy blocks a script, Task Hub offers to run it once with `-ExecutionPolicy Bypass`.
- **My commands**: saved commands in `.vscode/task-hub.json` (shared with the team), or on this machine only with `taskHub.storage: private`. The **+** button adds one; right-click **Save as Command…** saves any command with its last arguments; **Delete Saved Command** removes one. Edits keep the file's comments.
- Right-click **Run with Arguments…** adds words after the command line (`-- --watch`). **Restart**, **Run Again** and **Copy Command** reuse the last arguments.
- **Favorites**: right-click **Add to Favorites** pins a command under a **Favorites** heading at the top of the view, which shows where each one comes from (`apps/web — running · :5173`). Saved as `favorites` in `.vscode/task-hub.json` (or privately with `taskHub.storage: private`).
- **Status bar item**: *⟳ 2 running* while commands run (a play icon otherwise); its tooltip lists them, and a click opens the quick-pick runner.
- **Task Hub: Run Command…**: every command in one searchable list, with Running, Favorites and Recent sections first. Enter runs a command, or offers Stop, Restart, Show Output and Open in Browser for a running one; row buttons stop, restart, show output or run with arguments without leaving the list. **Stop All** appears when more than one command runs.
- **Task Hub: Stop All Commands** in the Command Palette.
- **Run history survives a reload**: each command's last status, exit code, duration, finish time and arguments are kept in the workspace state (the last 500 commands). A command still running when the window closed comes back as stopped, and Restart reuses its arguments.
- **Groups**: several commands started in order with one click, from `groups` in `.vscode/task-hub.json` (or private storage), under a **Groups** heading below Favorites and in the quick pick. Each step waits before the next starts: until its command exits with code 0 (`exit`), shows a local URL or its `readyPattern` (`ready`, 120 s unless `timeoutSec` says otherwise), or has started (`running`). A failing or timed-out step stops the group there, with a notification naming the step. **Stop Group** stops its running commands in reverse order. Right-click a command → **Add to Group…** to build one.
- **Python**: Django's `manage.py` (runserver, migrate, makemigrations, test) with the project's `.venv` / `venv` Python, Poe the Poet tasks (`[tool.poe.tasks]`) and PDM scripts (`[tool.pdm.scripts]`) from `pyproject.toml`, with their `help` text.
- **Maven**: every `pom.xml`, one heading per module (clean, compile, test, package, install, verify, and `spring-boot:run` with the Spring Boot plugin). Commands run from the project root with `./mvnw` (or `mvnw.cmd`, else `mvn`), naming a module with `-pl`.
- **Gradle**: the root project and every `include`d subproject, with `taskHub.gradle.defaultTasks`, plus `run` (application plugin) and `bootRun` (Spring Boot). Commands run from the root with `./gradlew` (or `gradlew.bat`, else `gradle`), e.g. `./gradlew :api:test`. **Load All Tasks** on a project heading fetches its whole task list once and keeps it until a build file changes.

## [0.1.0] - 2026-11-25

- Project setup: TypeScript + esbuild build, tests, packaging and release scripts.
