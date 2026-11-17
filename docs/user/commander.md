# Files, tabs and keyboard shortcuts

[Русский](commander.ru.md) · [Getting started](getting-started.md) · [All documentation](../README.md)

## Panels and connections

Each tab has two independent panels. Either can show local folders or a supported
server or cloud connection. The source picker lists drives, saved profiles,
profile folders and search. Drive icons use the operating system's icons when
available.

Use **+** or Ctrl/Command+T to add a tab. Its title combines the left folder with
the right folder or connection name. Close a connected tab to disconnect it;
its remote source picker stays locked while connected. A close confirmation is
enabled by default and can be disabled in Settings. Closing the last remote tab
returns to a local workspace.

**Test connection** saves the profile and checks sign-in and read access to its
initial location, leaving the editor open. For S3 it checks the bucket and prefix,
or lists buckets if none is set. It does not create files or test write permission,
and does not disturb connected panels. A new SSH host key requires explicit
fingerprint approval; a changed key blocks connection. Correct credentials and
retry in the same form. **All connections** returns to the library without saving
subsequent edits.

## Keyboard and file operations

| Shortcut                            | Action                                      |
| ----------------------------------- | ------------------------------------------- |
| F6                                  | Switch the active panel                     |
| Arrows, Home/End, PageUp/PageDown   | Move focus through the list                 |
| Enter / Backspace                   | Open a folder / go up                       |
| Shift + arrows or click             | Select a range                              |
| Ctrl/Command + click, Space, Insert | Toggle selection                            |
| Ctrl/Command+A                      | Select all entries                          |
| Typing                              | Open quick search in the active panel       |
| F5                                  | Copy selected entries to the other panel    |
| Ctrl+F5                             | Refresh the current listing                 |
| F2 / F7 / Delete                    | Rename / create a folder / confirm deletion |
| F4                                  | Open a file in an external editor           |
| Ctrl/Command+T / W                  | Add / close a tab                           |

Command shortcuts, apart from list navigation and selection, can be reassigned in
**Settings → Keyboard shortcuts**. A shortcut cannot belong to two actions.

Each panel has folder creation, copy, rename and delete icons with tooltips and
shortcuts. Copy targets the opposite panel's folder. Connect remote sources on
both sides to transfer between them. Use Ctrl+F5 or the refresh icon beside the
path to refresh a listing.

Typing opens quick search. Edit the query, use up/down to move through matches,
Enter to open an entry and Escape to close search. Double-clicking a local file
opens its default system application; double-clicking a folder opens it in the panel.

## Drag files to another application

Drag local files into a system file manager or another application that accepts
file drops. Multiple files and drops between OpenSCP panels are supported.

For SFTP, FTP or S3 files, choose **Prepare files for another application** from
the toolbar or context menu. After downloading, drag the resulting drag button
to the other window. Preparation shows progress and can be canceled. It supports
up to 100 regular files; folders and symlinks can only be dragged between OpenSCP
panels. Temporary copies remain available after hiding the indicator or closing
OpenSCP. Copies older than a day are cleaned up on the first preparation after
the next application launch.

## SSH terminal and external editing

A connected SFTP panel offers **Open SSH terminal**. On Windows, choose OpenSSH
or PuTTY in **Settings → Advanced → SSH terminal**. OpenSSH is the default;
a previously saved PuTTY path preserves that client until you change the selection.
macOS and Linux use a system terminal with OpenSSH. Host, port, username and a
compatible private key come from the profile; the session starts in the panel's
current folder. Passwords and key passphrases are not passed as command-line
arguments. The client may prompt for credentials and server fingerprint confirmation.
The client choice does not affect SFTP browsing or file transfers.
See [setup and key compatibility](getting-started.md#ssh-terminal-on-windows-openssh-or-putty).

F4 opens a regular local file directly in an external editor. Defaults are Notepad
on Windows, TextEdit on macOS and an available system editor on Linux. Choose an
editor in **Settings → Advanced**. On macOS, select the application `.app` itself.

For SFTP, S3 and FTP, OpenSCP creates a protected temporary copy and offers to upload
it after modification. Before uploading it checks the remote metadata and SHA-256
again. A concurrent remote change requires separate overwrite confirmation.
Unfinished temporary edits can be recovered after an unexpected restart.

## Copy conflicts and remembered folders

Drag and drop, including files from the system file manager, uses the transfer
queue. A copy starts immediately unless the destination already exists. The
conflict dialog shows source and destination. Overwrite, skip or keep both can
apply to one conflict or the remaining conflicts in that operation. Other queued
operations can continue while a conflict awaits your decision.

The last successfully opened local folder is remembered per panel and drive;
remote folders are remembered per profile. On the next launch or connection, that
folder is restored. If it disappeared, OpenSCP uses the nearest accessible parent,
the profile's initial folder or the root and shows a notice. A failed navigation
does not replace the last working path. **Remember session paths** is enabled by
default; disabling it clears path history and stops saving it.

An SFTP connection shows its current stage and can be canceled. Network, host-key
and authentication errors are distinguished. An absent or rejected password opens
a retry prompt. It is saved to protected storage only when you choose to save it
and the connection succeeds.

S3 prefixes are not ordinary folders. Rename copies objects then removes originals,
so it is not atomic. Deletion warns about compatible-server limitations. Avoid
concurrent writes to a prefix being deleted.

Plain FTP does not encrypt passwords, names or file content, and does not verify
the server's identity. It has a separate warning and icon. FTP currently uses
passive mode and username/password, including explicitly configured anonymous
profiles. FTPS is not supported. Without MLSD it falls back to LIST, where dates
may be unavailable. FTP resume, permissions, symlinks and atomic rename are not
supported.

## After an interruption

After restarting, queued work does not run automatically. Check the source and
destination before restarting from zero or canceling. An unresolved conflict
remains paused. If a server might have completed a write before the interruption,
check the destination first. Leftover `.openscp-part-*` files are not automatically
removed. Suitable transfers can resume during the current run; S3 uploads restart
from zero.

Clear completed and canceled history with the queue's clear action; this does not
delete files. Closing a busy tab asks for confirmation. Canceled operations remain
in the shared history.

## Profiles, diagnostics and settings

**Connections** provides search, folders, editing, duplication, deletion and
import/export. Double-click or press Enter on a profile to open it in the active
local panel. SCP is not supported.

Exports include empty folders and connection details such as server names,
usernames, access key IDs and paths. They exclude passwords, tokens and private-key
contents. Review an export before sharing it, and enter credentials after importing.

Import trusted known_hosts files in **Settings → Advanced**. For hashed hostnames,
create SFTP profiles first so entries can be matched. Import does not replace a
different already trusted key. Patterns, certificates and marker lines are not
supported; the result reports skipped records. Verify a new fingerprint through
a trusted channel before accepting it.

The same settings area exports a technical diagnostic report without connection
data or secrets. It is not sent automatically.

Settings controls light/dark/system themes, list density, dotfile visibility and
language. Changes persist between launches; language also updates native menus.
Window position, size and maximized/full-screen state are restored. If a saved
monitor is missing, the window is moved to an available screen.
