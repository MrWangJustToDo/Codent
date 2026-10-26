# workspace-editor-handoff Specification

## Purpose

Opening the workspace browser's selected file in the user's own terminal editor: the action and its
capability gate, editor command resolution, the alternate-screen handoff, and the workspace refresh on
resume.

## Requirements

### Requirement: Open the selected file in an external editor

The workspace browser SHALL offer an action that opens the selected row in the user's own terminal editor,
suspending the TUI for the duration of the edit.

The action SHALL be available only when the host adapter provides the capability. The editor SHALL receive
the absolute path of the selected file, and a line number when the caller has one (a diff or preview
position). Invoking the action on a directory SHALL be a no-op.

#### Scenario: File opens in the editor

- **WHEN** the user presses the open-in-editor key with a file selected in the workspace browser
- **AND** the host adapter implements the capability
- **THEN** the TUI is suspended and the editor is started on that file's absolute path
- **AND** when the editor exits the TUI is resumed with the file still selected

#### Scenario: A line target is carried through

- **WHEN** the action is invoked from a view that knows a line number
- **THEN** the editor is started positioned at that line

#### Scenario: Directory rows are inert

- **WHEN** the selected row is a directory
- **THEN** the action does nothing and the panel stays open

#### Scenario: Host without the capability

- **WHEN** the host adapter does not implement the capability (browser and WebContainer hosts)
- **THEN** the panel does not advertise the action
- **AND** the key is not bound

#### Scenario: Remote workspace refuses

- **WHEN** the workspace is remote (`--remote-env` or `--remote-session`)
- **THEN** the action is refused with an explanation instead of suspending the TUI
- **AND** no local editor is started against a path that does not exist on this machine

### Requirement: Editor command resolution

The host SHALL resolve the editor from `$VISUAL`, then `$EDITOR`, then the platform default (`nvim`, then
`vi` on POSIX; `notepad` on Windows). Arguments embedded in the environment variable SHALL be honoured.

When the editor cannot be started, the failure SHALL be reported to the user after the TUI resumes — never
swallowed, and never by writing to the terminal the editor was supposed to own.

#### Scenario: Environment variable wins

- **WHEN** `$VISUAL` is set
- **THEN** it is used and `$EDITOR` is ignored

#### Scenario: Missing binary

- **WHEN** the resolved editor executable is not found
- **THEN** the TUI resumes and shows a notice naming the executable
- **AND** the workspace panel remains usable

#### Scenario: Non-zero exit

- **WHEN** the editor exits with a non-zero status
- **THEN** the status is reported as a notice after resume
- **AND** the edit is not treated as a failure of the session

### Requirement: Suspend leaves the alternate screen cleanly

The handoff SHALL leave the alternate screen the workspace panel owns before the editor starts, so the
editor runs on the normal screen and the chat underneath it is never repainted during the handoff.

#### Scenario: Normal screen is preserved

- **WHEN** the editor is opened from the workspace panel
- **THEN** the panel leaves the alternate screen before the editor is spawned
- **AND** the chat content on the normal screen is unchanged while the editor runs
- **AND** on resume the panel re-enters the alternate screen and renders current state

#### Scenario: Quitting inside the editor restores the TUI

- **WHEN** the user exits the editor
- **THEN** the TUI re-renders on the screen the editor left
- **AND** no stale frame of the editor remains visible

### Requirement: Resume refreshes workspace state

Because the editor may have written to disk, resuming SHALL invalidate the caches that describe the
workspace: file content, per-file diff, git status and the tree rows.

#### Scenario: Edited file shows new content

- **WHEN** the user saves a change in the editor and exits
- **THEN** the preview/diff for that file shows the new content without a manual refresh

#### Scenario: Git status follows the edit

- **WHEN** the edit modifies a tracked file
- **THEN** the file appears as changed in the diff view and the tree after resume
