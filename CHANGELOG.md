# Change Log

All notable changes to the "Task Hub" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/).
Write new entries under **[Unreleased]**. The publish script moves them under the new version number when you release.

## [Unreleased]

## [1.0.0] - 2026-11-26

The first full release: every command source from the design, with groups, favorites and a quick-pick runner.

### Command sources

- **npm, pnpm, yarn and bun** scripts from every `package.json` (nested ones too), one heading per package (`apps/web  package.json · pnpm`). The package manager comes from the nearest `packageManager` field or lockfile, walking up to the repository root; npm is the default.
- **Makefile** targets (`GNUmakefile`, `makefile` or `Makefile`, whichever make would use), with a `## comment` after the target as its description. Special targets, pattern rules, file targets and assignments are left out.
- **justfile** recipes, with the comment or `[doc()]` above each as its description; private recipes are left out, and recipe parameters are asked for before a run.
- **Taskfile** tasks with their `desc`; `internal: true` tasks are left out.
- **docker compose** services: Run starts a service with `up -d`. A service that `docker compose ps` reports as running shows *running*, with **Logs** and **Stop Service** buttons; the state refreshes after each compose command and every 15 seconds while the view is visible.
- **Django** `manage.py` (runserver, migrate, makemigrations, test) with the project's `.venv` / `venv` Python; **Poe the Poet** tasks and **PDM** scripts from `pyproject.toml`, with their `help` text.
- **Maven**: one heading per module of every `pom.xml` (clean, compile, test, package, install, verify, and `spring-boot:run` with the Spring Boot plugin), run from the project root with `./mvnw` (or `mvnw.cmd`, else `mvn`) and `-pl <module>`.
- **Gradle**: the root project and every `include`d subproject, with `taskHub.gradle.defaultTasks`, plus `run` (application plugin) and `bootRun` (Spring Boot), run from the root with `./gradlew :api:test` (or `gradlew.bat`, else `gradle`). **Load All Tasks** on a project heading fetches its whole task list once and keeps it until a build file changes.
- **Scripts** (`taskHub.scripts.include`, at most `taskHub.scripts.maxFiles`): `.sh` / `.bash` with bash (Git Bash on Windows), `.ps1` with `pwsh` (Windows PowerShell when PowerShell 7 is missing on Windows), and `.bat` / `.cmd` on Windows (not the `mvnw.cmd` and `gradlew.bat` wrappers, which the Maven and Gradle sources run). One heading per folder; each runs in its own folder, or the workspace root with `taskHub.scripts.runFrom`. A row shows *needs bash* or *needs pwsh* when the program is missing.
- **VS Code tasks** from `.vscode/tasks.json` (comments allowed, `hide: true` tasks left out), run through VS Code's own task system with their exit code.
- **My commands**: saved commands in `.vscode/task-hub.json`, shared with the team, or on this machine only with `taskHub.storage: private`.
- The list updates when a watched file changes. `node_modules`, `taskHub.exclude` (which now also has `**/.vscode-test/**`) and folders hidden by `files.exclude` are skipped. Multi-root workspaces are supported.

### Running commands

- **Run**, **Stop** and **Restart** on each row. Commands run in their own folder without opening a terminal; Stop ends the whole process tree (the process group on Linux and macOS, `taskkill /T` on Windows), and running commands are stopped when VS Code closes.
- Live status: idle, running, ready, passed, failed (with the exit code) and stopped, with built-in icons. A local dev-server URL in the output marks a command ready, shows `:5173` on its row and adds **Open in Browser** (`taskHub.openUrlIn`).
- **Show Output** opens a terminal with the output so far, then follows it live; typed lines go to the process and Ctrl+C stops it. A failed command shows its terminal and a notification with **Show Output** and **Run Again** (`taskHub.revealTerminal`, `taskHub.notify`).
- **Script arguments**, shown on each row and asked for before a run: PowerShell `param()` blocks (`Mandatory`, defaults, `[ValidateSet()]` as a pick list, `[switch]`); usage lines in shell and PowerShell scripts, whether a `# Usage:` comment, printed (`echo "Usage: …"`, `printf`, `Write-Host "Usage: …"`, a heredoc), on the line after a lone `Usage:`, or a comment starting with the script's own name; `getopts` option strings, `case "$1"` branches as a pick list, and the `$1`…`$9` a script reads outside its functions (named and defaulted from lines like `env=${1:-staging}`). In a usage line, `[--fe=web|mobile]` is a pick list passed as `--fe=web`, `[-n|--dry-run]` is one switch, `<files>...` takes one or more values, and a group like `[--emulator[=<avd>]|--device=<serial>]` is a text box passed as typed. Switches are one multi-select, and the last answers are filled in next time. Scripts with nothing known get one optional text box. Arguments are passed as a list, never through a shell string.
- When PowerShell's execution policy blocks a script, Task Hub offers to run it once with `-ExecutionPolicy Bypass`.
- **Run with Arguments…** adds words after the command line (`-- --watch`). **Restart**, **Run Again** and **Copy Command** reuse the last arguments.
- **Run history survives a reload**: each command's last status, exit code, duration, finish time and arguments are kept in the workspace state (the last 500 commands). A command still running when the window closed comes back as stopped.
- **Restricted Mode**: commands are listed but not run, the view says so, and docker isn't asked about compose services until the workspace is trusted.

### Groups, favorites and the control panel

- **Groups** start several commands in order with one click, from `groups` in `.vscode/task-hub.json`, under a **Groups** heading and in the quick pick. Each step waits before the next starts: until its command exits with code 0 (`exit`), shows a local URL or its `readyPattern` (`ready`, 120 s unless `timeoutSec` says otherwise), or has started (`running`). A failing or timed-out step stops the group there, with a notification naming the step; **Stop Group** stops its commands in reverse order. Right-click a command → **Add to Group…** to build one.
- **Favorites**: right-click → **Add to Favorites** pins a command under a **Favorites** heading at the top, which shows where each comes from (`apps/web — running · :5173`).
- **Status bar item**: *⟳ 2 running* while commands run (a play icon otherwise); its tooltip lists them, and a click opens the quick-pick runner.
- **Task Hub: Run Command…**: every command in one searchable list, with Running, Favorites, Groups and Recent first. Enter runs a command, or offers Stop, Restart, Show Output and Open in Browser for a running one; row buttons work without leaving the list. **Stop All** appears when more than one command runs, and **Task Hub: Stop All Commands** is in the Command Palette.
- Saving: the **+** button adds a command; right-click **Save as Command…** keeps any command with its last arguments; **Delete Saved Command** and **Delete Group** remove them. Edits keep `task-hub.json`'s comments.
- Right-click **Go to Definition** opens the file at the command, and **Copy Command** copies its command line. Hover shows the command line, the script, its folder, its id and the last run.

## [0.1.0] - 2026-11-25

- Project setup: TypeScript + esbuild build, tests, packaging and release scripts.
