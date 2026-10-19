import { z } from 'zod';

export const absoluteRemotePathSchema = z
  .string()
  .min(1)
  .max(32768)
  .refine(
    (value) =>
      value.startsWith('/') &&
      !value.includes('\\') &&
      ![...value].some((character) => character.charCodeAt(0) < 32 || character === '\x7f') &&
      value
        .replace(/\/$/u, '')
        .split('/')
        .slice(1)
        .every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
  );
