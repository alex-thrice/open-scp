# Platform notes

[Русский](platforms.ru.md) · [Getting started](getting-started.md) · [All documentation](../README.md)

## Installation and paths

**Windows:** setup installs per user; portable runs without installation. Both
normally use `%APPDATA%/OpenSCP`, so portable does not make credentials portable.
Uninstalling preserves settings. Close all instances before updating. The drive
picker lists available drive letters; arbitrary UNC paths are not supported yet.

**macOS:** packages are arm64 DMG/ZIP. Current ad-hoc packages are not trusted
Developer ID releases. Application data is under
`~/Library/Application Support/OpenSCP`. Mounted disks are accessible through
`/Volumes`; protected folders depend on macOS permissions. Do not grant Full Disk
Access without a specific need.

An installed macOS build checks for a valid Developer ID Application signature.
Without one it can check GitHub and notify you about updates, but does not download
or install them automatically. The update action opens that release in your
browser; download and install its DMG manually. Automatic download and install
settings are unavailable in this mode.

**Linux:** use an x64 DEB or AppImage. Settings normally live in
`~/.config/OpenSCP`, subject to the desktop's configuration directory settings.
Mounted disks can be reached through `/`, `/mnt` and `/media`. AppImage needs
FUSE or extraction. The application needs GTK3, NSS, Secret Service and working
user namespaces for Chromium sandboxing. If policy or AppArmor blocks namespaces,
ask the system administrator to configure the environment. Do not run the file
client as root or with `--no-sandbox`. Support for every Linux desktop is not promised.

SFTP paths are POSIX paths; S3 keys are not local paths. Symlinks cannot bypass
local folder boundaries, and deleting a link does not delete its target. Windows
reserved names such as CON/NUL, alternate data streams, invalid characters and
trailing dots or spaces remain restricted even if a remote service accepts them.
POSIX permissions still apply. Case sensitivity depends on the volume, not just
the operating system. Check name conflicts when copying between file systems.

## Additional tools

| Feature                                  | Separate installation                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| iCloud Drive on Windows, macOS and Linux | [rclone](https://rclone.org/downloads/)                                                              |
| SSH terminal on Windows                  | [PuTTY](https://www.chiark.greenend.org.uk/~sgtatham/putty/latest.html), or a standalone `putty.exe` |

These programs are not bundled. Configure rclone in **Settings → Advanced →
iCloud Drive / rclone** and PuTTY in **Settings → Advanced → SSH terminal**.
An empty path enables automatic detection. PuTTY is only needed for a separate
terminal window; SFTP file transfers work without it. On macOS and Linux, the
external SSH terminal uses a system terminal and OpenSSH.
See the [installation steps](getting-started.md#additional-tools).

## Credentials

OpenSCP refuses to save secrets as plaintext when protected storage is unavailable.
On Linux, insecure or unknown keyring backends are rejected for reading and
writing secrets. Unlock GNOME Keyring or KWallet in your desktop session and retry.
Copying `settings.sqlite` does not guarantee that credentials will work on another
computer; you may need to enter them again.

Windows DPAPI protects against other users, but not malicious applications running
as the same user. macOS Keychain limits access by other apps unless you allow it;
a stable application signature matters for updates. On Linux, protection depends
on the selected secret store. See [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).

## SSH Agent and Pageant

With **SSH Agent**, OpenSCP uses the agent available to its launching session.
On macOS and Linux, start it from a session with access to the agent; key loading
and approval belong to that agent. Finder and desktop launchers may not inherit
the terminal session's agent. OpenSCP does not enable forwarding to the remote server.

On Windows it can use the OpenSSH Authentication Agent service. Configure the
service and load keys separately; OpenSCP does not change Windows services.

Pageant and Cygwin are not confirmed supported alternatives for packaged builds;
there is no Pageant option in the interface. Live SSH Agent use on macOS also needs
separate acceptance. If an agent does not work, use a private-key or password
profile while keeping host-key verification enabled.
