import type { ConnectionProfile, SecretReference } from './connection-profile';

export const profileSecretReference = (profile: ConnectionProfile): SecretReference | undefined => {
  if (profile.kind === 's3') return profile.secret;
  const authentication = profile.authentication;
  if (authentication.method === 'password') return authentication.secret;
  return authentication.method === 'private-key' ? authentication.passphrase : undefined;
};

export const withProfileSecretReference = (
  profile: ConnectionProfile,
  reference: SecretReference,
): ConnectionProfile => {
  if (profile.kind === 's3') return { ...profile, secret: reference };
  if (profile.kind === 'sftp' && profile.authentication.method === 'private-key')
    return { ...profile, authentication: { ...profile.authentication, passphrase: reference } };
  if (profile.authentication.method === 'password')
    return { ...profile, authentication: { method: 'password', secret: reference } };
  return profile;
};
