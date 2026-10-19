import { z } from 'zod';

export interface GooglePathSegment {
  readonly id: string | null;
  readonly name: string;
}
const idPattern = /^[A-Za-z\d_-]{1,200}$/u;
const validName = (name: string) =>
  name.length > 0 &&
  name.length <= 1024 &&
  ![...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
export const googleExportFormats = {
  'application/vnd.google-apps.document': [
    { mimeType: 'application/pdf', extension: '.pdf', label: 'PDF' },
    {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extension: '.docx',
      label: 'Word (.docx)',
    },
    { mimeType: 'text/plain', extension: '.txt', label: 'Text (.txt)' },
  ],
  'application/vnd.google-apps.spreadsheet': [
    {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: '.xlsx',
      label: 'Excel (.xlsx)',
    },
    { mimeType: 'text/csv', extension: '.csv', label: 'CSV' },
    { mimeType: 'application/pdf', extension: '.pdf', label: 'PDF' },
  ],
  'application/vnd.google-apps.presentation': [
    {
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      extension: '.pptx',
      label: 'PowerPoint (.pptx)',
    },
    { mimeType: 'application/pdf', extension: '.pdf', label: 'PDF' },
  ],
  'application/vnd.google-apps.drawing': [
    { mimeType: 'image/png', extension: '.png', label: 'PNG' },
    { mimeType: 'application/pdf', extension: '.pdf', label: 'PDF' },
  ],
} as const;
export const googleNativeCopyFormats: Readonly<Partial<Record<string, string>>> = {
  'application/vnd.google-apps.document':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.google-apps.spreadsheet':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-apps.presentation':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export const googleRootPath = 'gdrive:/';
const encodeName = (name: string) => encodeURIComponent(name).replace(/~/gu, '%7E');
export const formatGooglePath = (
  segments: readonly GooglePathSegment[],
  exportMimeType?: string,
): string => {
  const result =
    googleRootPath +
    segments.map((segment) => `${segment.id ?? ''}~${encodeName(segment.name)}`).join('/');
  return exportMimeType ? `${result}?export=${encodeURIComponent(exportMimeType)}` : result;
};
export const parseGooglePath = (
  value: string,
): { segments: GooglePathSegment[]; exportMimeType?: string } => {
  if (!value.startsWith(googleRootPath) || value.length > 32768)
    throw new Error('Invalid Google address');
  const parts = value.split('?');
  if (parts.length > 2) throw new Error('Invalid Google query');
  const address = parts[0] ?? '';
  const raw = address.slice(googleRootPath.length);
  const segments = raw
    ? raw.split('/').map((segment): GooglePathSegment => {
        const separator = segment.indexOf('~');
        if (separator < 0) throw new Error('Missing Google identity');
        const id = segment.slice(0, separator) || null;
        const name = decodeURIComponent(segment.slice(separator + 1));
        if ((id !== null && !idPattern.test(id)) || !validName(name))
          throw new Error('Invalid Google identity');
        return { id, name };
      })
    : [];
  if (segments.length > 128 || segments.slice(0, -1).some((segment) => segment.id === null))
    throw new Error('Invalid Google ancestry');
  const query = new URLSearchParams(parts[1]);
  const exportMimeType = query.get('export') ?? undefined;
  if (
    parts[1] !== undefined &&
    (!segments.length ||
      !segments.at(-1)?.id ||
      [...query.keys()].length !== 1 ||
      !exportMimeType ||
      !Object.values(googleExportFormats).some((formats) =>
        formats.some((format) => format.mimeType === exportMimeType),
      ))
  )
    throw new Error('Invalid Google export');
  if (formatGooglePath(segments, exportMimeType) !== value)
    throw new Error('Noncanonical Google address');
  return { segments, ...(exportMimeType ? { exportMimeType } : {}) };
};
export const googlePathSchema = z.string().refine((value) => {
  try {
    parseGooglePath(value);
    return true;
  } catch {
    return false;
  }
});
export const googleDirectoryPathSchema = googlePathSchema.refine((value) => {
  const parsed = parseGooglePath(value);
  return !parsed.exportMimeType && parsed.segments.every((segment) => segment.id !== null);
});
export const googlePathName = (value: string) =>
  parseGooglePath(value).segments.at(-1)?.name ?? 'My Drive';
export const googleParentPath = (value: string) =>
  formatGooglePath(parseGooglePath(value).segments.slice(0, -1));
export const googleChildPath = (parent: string, name: string, id: string | null = null) => {
  const parsed = parseGooglePath(parent);
  if (
    parsed.exportMimeType ||
    !validName(name) ||
    (id !== null && !idPattern.test(id)) ||
    parsed.segments.some((segment) => segment.id === null)
  )
    throw new Error('Invalid Google child');
  return formatGooglePath([...parsed.segments, { id, name }]);
};
export const googleSiblingPath = (path: string, name: string) =>
  googleChildPath(googleParentPath(path), name);
export const googleDisplayPath = (path: string) =>
  '/My Drive' +
  parseGooglePath(path)
    .segments.map((segment) => '/' + segment.name)
    .join('');
export const googleExportPath = (path: string, mimeType: string) => {
  const parsed = parseGooglePath(path);
  const last = parsed.segments.at(-1);
  const format = Object.values(googleExportFormats)
    .flat()
    .find((item) => item.mimeType === mimeType);
  if (!last?.id || !format) throw new Error('Unsupported Google export');
  return formatGooglePath(
    [...parsed.segments.slice(0, -1), { ...last, name: last.name + format.extension }],
    mimeType,
  );
};
