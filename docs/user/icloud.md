# Connect iCloud Drive with rclone

[Русский](icloud.ru.md) · [Getting started](getting-started.md) · [All documentation](../README.md)

This integration is experimental. Install current [rclone](https://rclone.org/downloads/)
separately; it is not bundled with OpenSCP. Apple's system iCloud client is not required.
Real-account and platform acceptance checks remain open.

## Set up rclone in OpenSCP

1. Download rclone for your system and extract it into a permanent folder.
2. Open **Settings → Advanced → iCloud Drive / rclone**.
3. Select the executable or its folder using **Choose rclone…**, then save. On
   Windows, for example, select `C:\Tools\rclone\rclone.exe`. Leaving the path empty
   enables automatic detection.
4. Check the status. Once rclone can run, the iCloud Drive connection type becomes
   available even if no iCloud connection is configured yet.

Use this settings window to configure the executable. Its path is saved only on
this computer and is not included in profile exports. Finish sign-in and active
iCloud transfers before changing it.

## Sign in to your existing Apple Account

1. Open **Connections → Connection → iCloud Drive** and choose Apple Account sign-in.
2. Name the OpenSCP profile and enter your existing account's email and regular
   Apple Account password. Apple app-specific passwords are not accepted.
3. Choose **Save profile** or **Test connection**. OpenSCP runs rclone setup in the
   background and presents its sign-in steps.
4. Approve sign-in on your trusted Apple device and enter the verification code.
   **Send code by SMS** lets you select an available trusted phone number.
5. Wait for setup to finish, then test and save the profile. Select it above either
   panel and use the normal file operations and transfer queue.

The rclone connection name is derived from the account email. That email is part
of the profile metadata and exports; the password is not.

If you already have an iCloud connection in rclone, choose **Use an existing rclone
connection** and select it from the list. **Refresh connections** reads the list
again. Only iCloud Drive connections are listed. **Check rclone** in Advanced
settings refreshes the local availability check without signing in to Apple or
testing the network. The default initial directory is `/`.

Profiles with an unavailable rclone connection remain editable in Connections,
but are hidden from panel source pickers until the connection is found again.

## Sign-in and local data

rclone performs Apple sign-in and 2FA; OpenSCP presents the prompts. Existing
rclone connections are not overwritten. Canceling setup attempts to remove the
unfinished connection. A successful rclone connection remains even if you later
cancel profile editing. Sign-in has a ten-minute limit; an unexpected application
exit may leave unfinished configuration behind.

A session can expire and require sign-in again. If access stops working, check
the error and the [rclone authentication guidance](https://rclone.org/iclouddrive/).
With Advanced Data Protection, web access to iCloud data and approval on a trusted
device may be required.

rclone keeps credentials in its own configuration. Its ordinary password
obfuscation is not password protection; protect that configuration and your device.
OpenSCP does not copy the configuration or its password into its database, exports
or diagnostics. An imported profile requires the corresponding rclone connection
on the other computer. Deleting an OpenSCP profile does not remove it from rclone.

## Limitations

- Operations start external processes, so browsing may have noticeable latency.
  OpenSCP does not install or update rclone automatically.
- The integration uses iCloud web services through rclone. Apple changes may
  require a rclone update; this is not a public Apple API for the whole of iCloud Drive.
- Interrupted transfers restart from zero. Offset resume, server-side copy and
  attribute changes are not supported.
- Failed uploads normally clean up their temporary file, but an outage or process
  exit can leave `.openscp-upload-*` or `.openscp-part-*` files.
- Conflict checks against another client are not atomic. Try a separate test
  folder first and avoid editing the same files concurrently on another device.
- Deletion is performed by rclone. Recovery from trash is not guaranteed and
  changes affect the account's other devices.
- A directory listing has a 16 MiB metadata limit. Configuration and network checks
  do not establish real-account or Advanced Data Protection acceptance.
