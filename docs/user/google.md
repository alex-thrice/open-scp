# Connect Google Drive with rclone

[Русский](google.ru.md) · [Getting started](getting-started.md) · [All documentation](../README.md)

Google Drive uses a separately installed [rclone](https://rclone.org/downloads/)
and a Google Drive connection configured in rclone. OpenSCP does not provide its
own Google sign-in or bundle a Google OAuth client.

## Prepare your Google connection

1. Install current rclone in a permanent folder.
2. Configure a Google Drive remote for your existing Google Account using the
   [official rclone setup guide](https://rclone.org/drive/#making-your-own-client-id).
   Follow its instructions for your own OAuth client and complete Google sign-in
   in your browser. Never enter your Google password in OpenSCP.
3. Give each remote a distinct name, for example `google-personal` and
   `google-work`. A remote name is a connection label; it need not be your email.
4. In OpenSCP, open **Settings → Advanced → Google Drive / iCloud Drive / rclone**.
   Choose the rclone executable or its folder, save and check its status. An empty
   path enables automatic detection.

rclone warns that its shared Google OAuth client is being retired during 2026.
Use the current official instructions rather than relying on that shared client.
Your Google account, OAuth project and organization policies may impose access
limits; using rclone does not automatically remove Google's verification rules.

## Select the remote in OpenSCP

1. Open **Connections → Connection → Google Drive**.
2. Name the profile and select your configured **Google Drive connection in rclone**.
   Use **Refresh connections** after changing its configuration outside OpenSCP.
3. Set an initial folder if needed. `/` means the root exposed by that remote.
4. Test the connection and save the profile.
5. Select the profile above either panel. Open a destination in the other panel
   and press **F5** to copy files.

Only Google Drive remotes appear in this form. iCloud remains a separate
connection type. Several Google profiles can use different accounts or different
remote roots; the visible remote name does not verify the account's email.

## Supported operations and limits

OpenSCP lists ordinary files and folders, uploads, downloads, copies through your
computer, creates folders and renames items. Deletion sends Drive items to trash;
restore them or empty trash in Google Drive.

- Google Docs, Sheets, Slides and other native Google documents are hidden, as are
  shortcuts. The previous document export and native-document copy commands are
  unavailable in this integration.
- Duplicate file or folder names are rejected as ambiguous. Resolve duplicates
  using Google Drive before operating on that path in OpenSCP.
- Interrupted transfers restart from the beginning. Resuming at an offset and
  direct server-side copies are not supported by this adapter.
- The remote's configuration determines its accessible root. Account permissions,
  service quotas and rclone restrictions still apply.

## Existing profiles and removing access

After updating from the built-in Google integration, edit each existing Google
profile and select a rclone remote. Old OpenSCP Google OAuth credentials are
removed during migration. Initial folders and recent locations in the old
`gdrive:` format reset to `/`; choose the desired folder again.

rclone keeps its own credentials and configuration. Deleting an OpenSCP profile
does not delete that remote or revoke access at Google. Finish active transfers,
then manage the remote with rclone and revoke the corresponding OAuth app in
[Google Account connections](https://myaccount.google.com/connections) when
needed. You may also revoke the former OpenSCP authorization there.

If a remote is missing, check rclone's path and status, its configuration and its
Google Drive type, then refresh connections. If authentication expires, reconnect
using rclone's instructions and reconnect the OpenSCP panel.
