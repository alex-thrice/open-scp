// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { hasRequiredMacUpdateSignature } from '../../src/main/updates/mac-update-signature';

describe('macOS update signature detection', () => {
  it('accepts a valid Developer ID Application signature', async () => {
    const codesign = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(
        'Authority=Developer ID Application: OpenSCP (ABC1234567)\nTeamIdentifier=ABC1234567\n',
      );

    await expect(
      hasRequiredMacUpdateSignature('/Applications/OpenSCP.app', codesign),
    ).resolves.toBe(true);
    expect(codesign).toHaveBeenNthCalledWith(1, [
      '--verify',
      '--deep',
      '--strict',
      '/Applications/OpenSCP.app',
    ]);
  });

  it('rejects an ad-hoc signature without an authority or team identifier', async () => {
    const codesign = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('Signature=adhoc\nTeamIdentifier=not set\n');

    await expect(
      hasRequiredMacUpdateSignature('/Applications/OpenSCP.app', codesign),
    ).resolves.toBe(false);
  });

  it('rejects a signature that fails strict verification', async () => {
    const codesign = vi.fn().mockRejectedValue(new Error('invalid signature'));

    await expect(
      hasRequiredMacUpdateSignature('/Applications/OpenSCP.app', codesign),
    ).resolves.toBe(false);
  });
});
