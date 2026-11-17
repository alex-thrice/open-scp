import { z } from 'zod';

export const sshTerminalClientSchema = z.enum(['openssh', 'putty']);
export type SshTerminalClient = z.infer<typeof sshTerminalClientSchema>;

export const readSshTerminalClient = (
  value: string | undefined,
  configuredPuttyPath: string | null | undefined,
): SshTerminalClient => {
  const parsed = sshTerminalClientSchema.safeParse(value);
  return parsed.success ? parsed.data : configuredPuttyPath?.trim() ? 'putty' : 'openssh';
};
