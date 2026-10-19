import { z } from 'zod';
import type { ICloudConnectionProfile } from '@shared/models/connection-profile';
import type { ICloudConfigurationResult } from '@shared/models/icloud-profile';
import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError } from '../../ipc/application-error';
import { RcloneProcess, type RcloneLauncher } from './rclone-process';

const responseSchema = z.object({
  State: z.string().max(65536),
  Error: z.string().optional(),
  Option: z
    .object({
      Name: z.string(),
      Advanced: z.boolean().optional(),
      Required: z.boolean().optional(),
      Sensitive: z.boolean().optional(),
      DefaultStr: z.string().optional(),
      Examples: z
        .array(z.object({ Value: z.string().max(128), Help: z.string().max(200) }))
        .max(20)
        .nullish(),
    })
    .nullish(),
});
type ConfigurationResponse = z.infer<typeof responseSchema>;
interface ConfigurationSession {
  readonly id: string;
  readonly remote: string;
  readonly runner: RcloneProcess;
  readonly controller: AbortController;
  readonly timer: ReturnType<typeof setTimeout>;
  ownsRemote: boolean;
  state: string;
  question?: Extract<ICloudConfigurationResult, { status: 'question' }>;
  pending?: Promise<ConfigurationResponse>;
  cleanup?: Promise<void>;
}

export class ICloudConfiguration {
  private current: ConfigurationSession | undefined;

  public constructor(
    private readonly launch: (profile: ICloudConnectionProfile) => RcloneLauncher,
  ) {}

  public get active(): boolean {
    return this.current !== undefined;
  }

  public async start(
    id: string,
    remote: string,
    appleId: string,
    password: string,
  ): Promise<ICloudConfigurationResult> {
    if (this.current) throw new ApplicationError(applicationErrorCodes.providerConflict);
    const profile: ICloudConnectionProfile = {
      id,
      remote,
      name: 'iCloud setup',
      kind: 'icloud',
      timeout: 60000,
    };
    const entry: ConfigurationSession = {
      id,
      remote,
      runner: new RcloneProcess(profile, this.launch(profile)),
      controller: new AbortController(),
      timer: setTimeout(
        () => {
          void this.cancel(id).catch(() => undefined);
        },
        10 * 60 * 1000,
      ),
      ownsRemote: false,
      state: '',
    };
    entry.timer.unref();
    this.current = entry;
    entry.pending = (async () => {
      const names = await entry.runner.output(['listremotes'], 'connect', entry.controller.signal);
      if (
        names
          .split(/\r?\n/u)
          .some((name) => name.trim().toLowerCase() === `${remote.toLowerCase()}:`)
      )
        throw new ApplicationError(applicationErrorCodes.rcloneRemoteExists);
      if (entry.controller.signal.aborted)
        throw new ApplicationError(applicationErrorCodes.providerCancelled);
      entry.ownsRemote = true;
      let response = this.parse(
        await entry.runner.json(
          ['config', 'create', remote, 'iclouddrive', '--all', '--non-interactive', '--obscure'],
          'connect',
          entry.controller.signal,
        ),
      );
      for (let count = 0; response.State && count < 16; count++) {
        const option = response.Option;
        let result: string;
        if (option?.Name === 'service') result = 'drive';
        else if (option?.Name === 'apple_id') result = appleId;
        else if (option?.Name === 'password') {
          // В режиме --all rclone сохраняет ответ поля пароля напрямую в конфигурацию.
          result = (
            await entry.runner.output(
              ['obscure', '-'],
              'connect',
              entry.controller.signal,
              undefined,
              password,
            )
          ).trim();
          if (!/^[A-Za-z0-9_-]{22,32768}$/u.test(result))
            throw new ApplicationError(applicationErrorCodes.rcloneConfiguration);
        } else if (option?.Name === 'config_fs_advanced') result = 'false';
        else if (option?.Advanced && !option.Required && !option.Sensitive)
          result = option.DefaultStr ?? '';
        else return response;
        if (response.Error) throw new ApplicationError(applicationErrorCodes.rcloneAuthentication);
        response = await this.answer(entry, response.State, result);
      }
      return response;
    })();
    try {
      return this.result(entry, await entry.pending);
    } catch (error) {
      const cancelled = entry.controller.signal.aborted;
      await this.cancel(id);
      if (cancelled) return { id, status: 'cancelled' };
      throw error;
    } finally {
      delete entry.pending;
    }
  }

  public async continue(id: string, answer: string): Promise<ICloudConfigurationResult> {
    const entry = this.current;
    if (!entry || entry.id !== id || !entry.question)
      throw new ApplicationError(applicationErrorCodes.rcloneSetupExpired);
    if (entry.pending || entry.cleanup)
      throw new ApplicationError(applicationErrorCodes.providerConflict);
    const question = entry.question;
    if (
      question.kind === 'phone'
        ? !question.choices.some((choice) => choice.value === answer)
        : !/^\d{4,10}$/u.test(answer) &&
          !(question.kind === 'verification-code' && answer === 'sms')
    )
      throw new ApplicationError(applicationErrorCodes.invalidIpcPayload);
    entry.pending = this.answer(entry, entry.state, answer);
    try {
      return this.result(entry, await entry.pending);
    } catch (error) {
      if (entry.controller.signal.aborted) return { id, status: 'cancelled' };
      throw error;
    } finally {
      delete entry.pending;
    }
  }

  private parse(value: unknown): ConfigurationResponse {
    const result = responseSchema.safeParse(value);
    if (!result.success) throw new ApplicationError(applicationErrorCodes.rcloneConfiguration);
    return result.data;
  }

  private async answer(
    entry: ConfigurationSession,
    state: string,
    result: string,
  ): Promise<ConfigurationResponse> {
    return this.parse(
      await entry.runner.json(
        ['config', 'update', entry.remote, '--all', '--non-interactive', '--continue', '--obscure'],
        'connect',
        entry.controller.signal,
        { state, result },
      ),
    );
  }

  private result(
    entry: ConfigurationSession,
    response: ConfigurationResponse,
  ): ICloudConfigurationResult {
    if (entry.controller.signal.aborted)
      throw new ApplicationError(applicationErrorCodes.providerCancelled);
    if (!response.State) {
      if (response.Error) throw new ApplicationError(applicationErrorCodes.rcloneAuthentication);
      clearTimeout(entry.timer);
      this.current = undefined;
      return { id: entry.id, status: 'complete' };
    }
    const name = response.Option?.Name;
    const kind =
      name === 'config_2fa'
        ? 'verification-code'
        : name === 'config_2fa_sms'
          ? 'sms-code'
          : name === 'config_2fa_phone'
            ? 'phone'
            : undefined;
    if (!kind) throw new ApplicationError(applicationErrorCodes.rcloneConfiguration);
    entry.state = response.State;
    entry.question = {
      id: entry.id,
      status: 'question',
      kind,
      retry: !!response.Error,
      choices:
        kind === 'phone'
          ? (response.Option?.Examples ?? []).map((choice) => ({
              value: choice.Value,
              label: choice.Help,
            }))
          : [],
    };
    return entry.question;
  }

  public async cancel(id: string): Promise<void> {
    const entry = this.current;
    if (!entry || entry.id !== id) return;
    if (entry.cleanup) return entry.cleanup;
    entry.controller.abort();
    clearTimeout(entry.timer);
    entry.cleanup = (async () => {
      await entry.pending?.catch(() => undefined);
      await entry.runner.close();
      try {
        if (entry.ownsRemote)
          await entry.runner.run(
            ['config', 'delete', entry.remote],
            'connect',
            AbortSignal.timeout(3000),
          );
      } finally {
        if (this.current === entry) this.current = undefined;
      }
    })();
    return entry.cleanup;
  }

  public dispose(): void {
    if (this.current) void this.cancel(this.current.id).catch(() => undefined);
  }
}
