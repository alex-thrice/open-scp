import { z } from 'zod';
import { fileDragRequestSchema, type FileDragRequest } from '@shared/ipc/file-drag';
import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError } from './application-error';
import { createValidatedIpcHandler } from './validated-handler';

export const createFileDragHandler = (dependencies: {
  readonly isAllowed: () => boolean;
  readonly filesForDrag: (request: FileDragRequest) => Promise<string[]>;
  readonly startDrag: (paths: string[]) => Promise<void>;
}) =>
  createValidatedIpcHandler({
    requestSchema: z.strictObject({
      correlationId: z.string().uuid(),
      payload: fileDragRequestSchema,
    }),
    responseSchema: z.null(),
    handle: async (request) => {
      if (!dependencies.isAllowed())
        throw new ApplicationError(applicationErrorCodes.invalidIpcPayload);
      const files = await dependencies.filesForDrag(request);
      if (!dependencies.isAllowed())
        throw new ApplicationError(applicationErrorCodes.invalidIpcPayload);
      await dependencies.startDrag(files);
      return null;
    },
  });
