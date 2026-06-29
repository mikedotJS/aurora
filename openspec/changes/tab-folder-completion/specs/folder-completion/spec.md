## ADDED Requirements

### Requirement: Tab triggers filesystem folder completion
Pressing **Tab** in the prompt SHALL perform filesystem folder completion on the path token under
the cursor whenever that token is in argument position (i.e. it is not the bare command word, or
it contains a path separator such as `/`, `~`, or a leading `.`/`..`). This SHALL happen
independently of the ghost-autocomplete and Claude-suggestion engines, so folders are completed
even when no ghost or Claude suggestion is present.

#### Scenario: Tab lists folders with no ghost or suggestion
- **WHEN** the user has typed a path-argument prefix that the ghost engine produced no suggestion for (e.g. `cd ` with the cwd containing several folders) and presses Tab
- **THEN** the prompt SHALL compute the matching folders from the filesystem and present them, rather than doing nothing

#### Scenario: Command word is not folder-completed
- **WHEN** the cursor is on the bare command word with no preceding space and no path separator (e.g. typing `gi`) and the user presses Tab
- **THEN** folder completion SHALL NOT engage, and existing command/ghost behavior SHALL apply

### Requirement: Single-match inline completion
When exactly one folder matches the path token's leaf prefix, Tab SHALL complete the token inline
by appending the remainder of the folder name and a trailing `/`, without opening a list.

#### Scenario: Unique prefix completes inline
- **WHEN** the user types `cd De` and exactly one cwd folder (`Desktop`) starts with `De` and presses Tab
- **THEN** the input SHALL become `cd Desktop/` and no completion list SHALL be shown

### Requirement: Multiple matches present a selectable list
When more than one folder matches the leaf prefix, Tab SHALL first complete the longest common
prefix shared by all matches (if it extends the current token), then SHALL present a selectable
list of the matching folders. Each listed folder SHALL be shown with a trailing `/` to indicate it
is a directory.

#### Scenario: Ambiguous prefix lists folders
- **WHEN** the user types `cd D` and the cwd contains `Desktop`, `Documents`, and `Downloads`, and presses Tab
- **THEN** a selectable list of `Desktop/`, `Documents/`, `Downloads/` SHALL be shown

#### Scenario: Common prefix is completed before listing
- **WHEN** the user types `cd Do` and the cwd contains `Documents` and `Downloads`, and presses Tab
- **THEN** the token SHALL complete to the common prefix `Do…` only where the matches agree, and the list of remaining candidates SHALL be shown

### Requirement: No-match is a no-op
When no folder matches the leaf prefix, Tab SHALL make no change to the input, show no list, and
report no error.

#### Scenario: Unmatched prefix does nothing
- **WHEN** the user types `cd zzz` with no cwd folder starting with `zzz` and presses Tab
- **THEN** the input SHALL be unchanged and no list or error SHALL appear

### Requirement: Completion list navigation and acceptance
While the completion list is open, the prompt SHALL let the user move the highlight with ↑/↓,
accept the highlighted folder with Tab or ↵ (inserting its name + trailing `/` into the token),
and dismiss the list with Esc. Editing the input (typing or Backspace) SHALL dismiss or refilter
the list rather than leaving a stale list open.

#### Scenario: Navigate and accept from the list
- **WHEN** a completion list is open and the user presses ↓ then ↵
- **THEN** the highlighted folder SHALL be inserted into the path token with a trailing `/` and the list SHALL close

#### Scenario: Dismiss the list
- **WHEN** a completion list is open and the user presses Esc
- **THEN** the list SHALL close and the input SHALL be left as it was

#### Scenario: Accepting in the list does not submit the command
- **WHEN** a completion list is open and the user presses ↵ to accept a folder
- **THEN** the command SHALL NOT be executed in the shell; only the input SHALL be updated

### Requirement: Path token and base-directory resolution
Folder completion SHALL resolve the path token under the cursor into a base directory and a leaf
prefix, and list folders from the base directory. It SHALL support the current working directory
(no separator → base is the cwd), relative paths (`src/com` → base is `<cwd>/src`), parent and
home-relative paths (`../`, `~/`), and absolute paths (`/usr/lo`). Hidden (dot-prefixed) folders
SHALL be excluded unless the leaf prefix itself begins with `.`.

#### Scenario: Nested relative path completes against its base directory
- **WHEN** the user types `cd src/com` and `<cwd>/src` contains a folder `components` and presses Tab
- **THEN** the token SHALL complete to `cd src/components/`

#### Scenario: Hidden folders excluded by default
- **WHEN** the user types `cd ` and the cwd contains `.git` and `src` and presses Tab
- **THEN** the listed folders SHALL include `src/` and SHALL exclude `.git`

#### Scenario: Dot prefix reveals hidden folders
- **WHEN** the user types `cd .gi` and the cwd contains `.git` and presses Tab
- **THEN** `.git/` SHALL be eligible as a completion match

### Requirement: Precedence with ghost autocomplete and pending fixes
Folder completion SHALL coordinate with the existing prompt behaviors so no behavior is lost: a
pending typo fix SHALL still take Tab first; when a completion list is open it SHALL take Tab next;
for a path-argument token folder completion SHALL run ahead of blindly accepting a ghost (so an
ambiguous prefix lists folders instead of silently accepting only the first); and for non-path
tokens the existing ghost-accept behavior SHALL remain. The → (Right Arrow) key SHALL continue to
accept the ghost regardless.

#### Scenario: Ambiguous path prefix lists instead of accepting the first ghost
- **WHEN** the ghost engine shows the first folder (`Desktop`) as a ghost for `cd D` but `Documents` and `Downloads` also match, and the user presses Tab
- **THEN** the completion list SHALL be shown rather than only `Desktop` being accepted

#### Scenario: Pending fix still wins Tab
- **WHEN** a pending typo fix is present and the user presses Tab
- **THEN** the typo fix SHALL be applied and folder completion SHALL NOT run

#### Scenario: Non-path ghost still accepts on Tab
- **WHEN** the user types `git stat` with a subcommand ghost (`us`) and presses Tab
- **THEN** the ghost SHALL be accepted (input becomes `git status`) and no folder list SHALL appear
