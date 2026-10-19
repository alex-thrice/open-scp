import { DOMParser } from '@xmldom/xmldom';
import { createMailruProviderPath } from '@shared/models/provider-path';
import { mailruPathSchema } from '@shared/models/mailru-profile';
import type { FileSystemEntry } from '@shared/models/file-system-entry';
import {
  ProviderError,
  providerErrorCodes,
  type ProviderOperation,
} from '@shared/providers/provider-error';
import { webDavStatusError } from './webdav-transport';

const malformed = (operation: ProviderOperation) =>
  new ProviderError(providerErrorCodes.ioError, { provider: 'mailru', operation });
const children = (element: Element, name: string): Element[] =>
  Array.from(element.childNodes).filter(
    (node): node is Element =>
      node.nodeType === 1 &&
      (node as Element).namespaceURI === 'DAV:' &&
      (node as Element).localName === name,
  );
const child = (element: Element, name: string): Element | undefined => children(element, name)[0];
const text = (element: Element, name: string): string | undefined =>
  child(element, name)?.textContent ?? undefined;
const statusCode = (status: string | undefined, operation: ProviderOperation): number => {
  const match = /^HTTP\/\d(?:\.\d)? ([1-5]\d\d)(?:\s.*)?$/u.exec(status?.trim() ?? '');
  if (!match) throw malformed(operation);
  return Number(match[1]);
};

const documentResponses = (xml: string, operation: ProviderOperation): Element[] => {
  if (/<!\s*(?:DOCTYPE|ENTITY)/iu.test(xml)) throw malformed(operation);
  let invalid = false;
  const document = new DOMParser({
    errorHandler: {
      warning: () => {
        invalid = true;
      },
      error: () => {
        invalid = true;
      },
      fatalError: () => {
        invalid = true;
      },
    },
  }).parseFromString(xml, 'text/xml');
  const root = document.documentElement;
  if (invalid || !root || root.namespaceURI !== 'DAV:' || root.localName !== 'multistatus')
    throw malformed(operation);
  const responses = children(root, 'response');
  if (!responses.length) throw malformed(operation);
  return responses;
};

export const checkWebDavMultiStatus = (xml: string, operation: ProviderOperation): void => {
  for (const response of documentResponses(xml, operation)) {
    const status = statusCode(text(response, 'status'), operation);
    if (status < 200 || status >= 300) throw webDavStatusError(status, operation);
  }
};

const hrefPath = (
  href: string | undefined,
  requestUrl: URL,
  operation: ProviderOperation,
): string => {
  try {
    if (!href) throw malformed(operation);
    const url = new URL(href, requestUrl);
    if (url.origin !== requestUrl.origin || url.username || url.password || url.search || url.hash)
      throw malformed(operation);
    const path = url.pathname
      .split('/')
      .map((segment) => {
        const value = decodeURIComponent(segment);
        if (value.includes('/') || value.includes('\\')) throw malformed(operation);
        return value;
      })
      .join('/');
    if (!mailruPathSchema.safeParse(path).success) throw malformed(operation);
    return path === '/' ? '/' : path.replace(/\/$/u, '');
  } catch {
    throw malformed(operation);
  }
};

export const parseWebDavEntries = (
  xml: string,
  requestUrl: URL,
  operation: ProviderOperation,
): FileSystemEntry[] => {
  const paths = new Set<string>();
  return documentResponses(xml, operation).map((response) => {
    const path = hrefPath(text(response, 'href'), requestUrl, operation);
    if (paths.has(path)) throw malformed(operation);
    paths.add(path);
    const responseStatus = text(response, 'status');
    if (responseStatus !== undefined) {
      const status = statusCode(responseStatus, operation);
      if (status < 200 || status >= 300) throw webDavStatusError(status, operation);
    }
    const properties = new Map<string, Element>();
    for (const propstat of children(response, 'propstat')) {
      const status = statusCode(text(propstat, 'status'), operation);
      if (status < 200 || status >= 300) {
        if (status !== 404) throw webDavStatusError(status, operation);
        continue;
      }
      const prop = child(propstat, 'prop');
      if (!prop) throw malformed(operation);
      for (const node of Array.from(prop.childNodes))
        if (node.nodeType === 1 && (node as Element).namespaceURI === 'DAV:')
          properties.set((node as Element).localName, node as Element);
    }
    const resourceType = properties.get('resourcetype');
    if (!resourceType) throw malformed(operation);
    const directory = !!child(resourceType, 'collection');
    const length = properties.get('getcontentlength')?.textContent?.trim() ?? '';
    if (!directory && !/^\d+$/u.test(length)) throw malformed(operation);
    const modified = properties.get('getlastmodified')?.textContent;
    const date = modified ? Date.parse(modified) : NaN;
    const etag = properties.get('getetag')?.textContent?.trim();
    return {
      path: createMailruProviderPath(path),
      name: path.split('/').at(-1) || '/',
      kind: directory ? 'directory' : 'file',
      size: directory ? 0n : BigInt(length),
      ...(Number.isNaN(date) ? {} : { modifiedAt: new Date(date).toISOString() }),
      ...(etag && /^"[\x21\x23-\x7e\x80-\xff]*"$/u.test(etag) ? { versionTag: etag } : {}),
    };
  });
};
