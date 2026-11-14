# Connect Mail.ru Cloud

[Русский](mailru.ru.md) · [Getting started](getting-started.md) · [All documentation](../README.md)

Use your existing Mail account and an application password with Cloud access.

## Prepare an application password

Open [Mail application passwords](https://account.mail.ru/user/2-step-auth/passwords/).
In Mail's website this is **Settings → All settings → Security → Application passwords**.
Create a password named OpenSCP, select **Full access to Cloud**
(Полный доступ к Облаку) and copy the generated password. Email-only access is not
sufficient. See [Mail's instructions](https://help.mail.ru/mail/login/mailer/) (Russian).

If you normally sign in through VK ID, use that sign-in to open Mail settings and
create the application password. Your regular password and VK ID password do not
work for this connection. WebDAV requires an application password.
See [Mail's WebDAV requirements](https://help.mail.ru/cloud/desktop/webdav/) (Russian).

## Connect in OpenSCP

1. Open **Connections → Connection → Mail.ru Cloud**.
2. Enter a profile name, the full mailbox email that owns the Cloud, and the
   application password. A phone number or VK profile name is not the mailbox address.
3. The blue marker beside **Application password** opens setup and VK ID guidance
   on hover, focus or click. Click again, press Escape or click outside to close it.
4. If needed, choose an initial directory and timeout under **Advanced**.
5. Choose **Test connection**. This saves the profile and checks read access to
   the root and initial directory. No mapped network drive or Mail desktop app is needed.
6. Save the profile and select it in the source picker above either panel.

An absent or rejected password prompts for an application password again. Choosing
to save it stores the corrected password in the operating system's protected
storage after a successful connection. Exports do not include the password; enter
it again on another computer.

## File operations and troubleshooting

Create folders, rename, delete and use F5 as with other sources. The other panel
can show local folders, SFTP, FTP, S3 or another Mail.ru profile. A conflict is
requested only when the destination already exists. The last directory is remembered
separately for each profile.

If access is refused, check the mailbox address, that the password belongs to the
same account, and that it grants Cloud access. A sign-in refusal alone does not
prove the password is wrong. If the credentials appear correct, check WebDAV access
using Mail's instructions. A refusal of one operation after connecting indicates
insufficient operation permissions and does not trigger another password prompt.

Interrupted transfers restart from zero. A `.openscp-part-…` file may remain;
remove it only after the operation using it has finished. If publishing the final
name was interrupted, inspect the destination before retrying.

Real-account acceptance remains open. Automated checks use a separate WebDAV
server and do not establish Mail.ru account or subscription restrictions.
