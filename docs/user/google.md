# Connect Google Drive

[Русский](google.ru.md) · [Getting started](getting-started.md) · [All documentation](../README.md)

## Sign in

1. Open **Connections → Connection → Google Drive**.
2. Name the profile and choose **Sign in to Google**.
3. Select your existing Google Account and review the requested access in your
   system browser. Enter your Google password only on Google's sign-in page.
4. Return to OpenSCP, test the connection and save the profile.
5. Select the profile in the source picker above the panel you want to connect.
6. Open a destination in the other panel and press F5 to copy files.

OpenSCP handles sign-in with your existing Google Account. Google verification is
pending, so access may currently be limited. If sign-in is unavailable, check the
release information and Google Drive support status.

## Files, documents and trash

The panel opens My Drive. File IDs distinguish items with identical names. A short
ID appears in the row; hover to see the full ID. If an overwrite is ambiguous,
select the destination ID in the queue. Rename and trash actions apply to the
selected object. Navigation follows saved IDs while the read-only address shows
readable folder names.

Use **Export document…** for Google Docs, Sheets, Slides and Drawings: choose a
format and transfer the exported file to the other panel. The export limit is
10 MiB. Uploading a binary file over a Google document is not supported. Shortcuts
are listed separately and are not followed.

When both panels are connected to Google, documents also support **Copy**. A name
ending in `.txt` may still belong to a Google document; its actual type appears
beside the ID in the tooltip. Within the same account, a new copy is created
directly. Between accounts, Docs, Sheets and Slides pass through DOCX, XLSX and
PPTX and are imported back into their original Google document type, keeping the
name. The export must fit within 10 MiB. Revision history and comments are not
transferred; formatting depends on Google's conversion. Source sharing permissions
are not changed automatically.

Shared Drives and a separate Shared with me tree are not supported. Available
commands respect object permissions and check them again before the operation.

**Move to trash** does not permanently delete a file. Restore files or empty trash
using Google Drive.

## Interrupted transfers and sign-out

Regular file uploads use chunks up to 1 MiB without an intermediate local copy.
**Resume** checks the source and the current upload session's offset. Use
**Restart** when the session has expired, the source has changed or the source
cannot safely resume from an offset. If finalization is uncertain, inspect the
destination before retrying. Interrupted transfers do not resume automatically
after an application restart.

**Sign out** removes local tokens and disconnects the profile's sessions. To revoke
authorization completely, remove OpenSCP from
[Google Account connections](https://myaccount.google.com/connections).
Sign out before switching accounts. Profile imports and duplicates do not carry
Google tokens or the account association.
