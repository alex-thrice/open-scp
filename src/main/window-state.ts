import type { Rectangle } from 'electron';

export interface PersistedWindowState {
  readonly bounds: Rectangle;
  readonly isFullScreen: boolean;
  readonly isMaximized: boolean;
}

const isCoordinate = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= -100000 && Number(value) <= 100000;

const isDimension = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 32768;

export const readWindowState = (value: string | undefined): PersistedWindowState | undefined => {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const state = parsed as Record<string, unknown>;
    if (typeof state.bounds !== 'object' || state.bounds === null || Array.isArray(state.bounds))
      return undefined;
    const bounds = state.bounds as Record<string, unknown>;
    if (
      !isCoordinate(bounds.x) ||
      !isCoordinate(bounds.y) ||
      !isDimension(bounds.width) ||
      !isDimension(bounds.height) ||
      typeof state.isFullScreen !== 'boolean' ||
      typeof state.isMaximized !== 'boolean'
    )
      return undefined;
    return {
      bounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
      isFullScreen: state.isFullScreen,
      isMaximized: state.isMaximized,
    };
  } catch {
    return undefined;
  }
};

const intersectionArea = (left: Rectangle, right: Rectangle): number => {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  return width * height;
};

export const fitWindowBounds = (
  bounds: Rectangle,
  workAreas: readonly Rectangle[],
  minimumSize: { readonly width: number; readonly height: number },
): Rectangle => {
  if (!workAreas.length) return bounds;
  const workArea = workAreas.reduce((best, candidate) =>
    intersectionArea(bounds, candidate) > intersectionArea(bounds, best) ? candidate : best,
  );
  const width = Math.min(Math.max(bounds.width, minimumSize.width), workArea.width);
  const height = Math.min(Math.max(bounds.height, minimumSize.height), workArea.height);
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height,
  };
};
