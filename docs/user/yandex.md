# Connect Yandex Disk

[Русский](yandex.ru.md) · [Getting started](getting-started.md) · [All documentation](../README.md)

## Sign in

1. Open **Connections → Connection → Yandex Disk** and name the profile.
2. Choose **Sign in to Yandex**.
3. Sign in to your existing Yandex ID and approve the requested access in your
   system browser. Do not enter your Yandex password in OpenSCP.
4. Return to OpenSCP and check the connected account. **Test connection** checks
   read access to the initial folder.
5. Save the profile and select it in either panel's source picker.

If sign-in is unavailable, check the release information. Account authorization
is handled by OpenSCP. Real-account acceptance checks remain open.

## Files and limitations

You can browse folders, create folders, rename, move, delete and transfer files
to or from local folders, Mail.ru, SFTP, FTP and S3. Deleting sends data to Disk's
trash. Asynchronous operations finish in OpenSCP after the service confirms them.

POSIX permissions, symlinks, offset-based resume, atomic rename and server-side
copy are not supported by this integration.

Cancellation or a connection failure may leave a `.openscp-part-…` file. Retrying
starts the transfer from zero. If publication of the final name is uncertain,
inspect both the final and temporary names in Disk before retrying. Writes are
not retried automatically. Read requests have bounded retries; quota and request
rate errors are reported separately.

## Sign out and revoke access

**Sign out** disconnects the profile's panels and removes its local tokens.
Authorization at Yandex remains until you remove OpenSCP's access in Yandex ID
settings. After revocation, another connection requires sign-in again.

Sign out before switching accounts. Duplicating or importing a profile requires
a separate sign-in. Profile exports contain connection settings without tokens.
