import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { GoogleConnectionProfile } from '../../src/shared/models/connection-profile';
import { GoogleConnection } from '../../src/main/providers/google/google-connection';
import { GoogleProvider } from '../../src/main/providers/google/google-provider';
import { startICloudFixture } from './icloud-harness';

export const googleFixtureProfile = (remote = 'google'): GoogleConnectionProfile => ({
  id: randomUUID(),
  name: 'Fixture Google Drive',
  kind: 'google',
  remote,
  initialDirectory: '/',
  timeout: 3000,
});

export const startGoogleFixture = async () => {
  const fixture = await startICloudFixture();
  await mkdir(join(fixture.root, 'google'));
  await mkdir(join(fixture.root, 'google-work'));
  const commands: (readonly string[])[] = [];
  const launch: typeof fixture.launch = (args, input) => {
    commands.push(args);
    return fixture.launch(args, input);
  };
  const create = (remote = 'google') =>
    new GoogleProvider(new GoogleConnection(googleFixtureProfile(remote), launch));
  return { ...fixture, launch, create, commands };
};
