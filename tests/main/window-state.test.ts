// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { fitWindowBounds, readWindowState } from '../../src/main/window-state';

describe('main window state', () => {
  it('reads only bounded persisted geometry', () => {
    expect(
      readWindowState(
        JSON.stringify({
          bounds: { x: -1200, y: 40, width: 1100, height: 700 },
          isFullScreen: false,
          isMaximized: true,
        }),
      ),
    ).toEqual({
      bounds: { x: -1200, y: 40, width: 1100, height: 700 },
      isFullScreen: false,
      isMaximized: true,
    });
    expect(readWindowState('{"bounds":{"x":0,"y":0,"width":999999,"height":700}}')).toBe(undefined);
    expect(readWindowState('not-json')).toBe(undefined);
  });

  it('keeps the window inside an available display', () => {
    expect(
      fitWindowBounds(
        { x: 4000, y: 3000, width: 1400, height: 1000 },
        [{ x: 0, y: 0, width: 1920, height: 1040 }],
        { width: 880, height: 560 },
      ),
    ).toEqual({ x: 520, y: 40, width: 1400, height: 1000 });
    expect(
      fitWindowBounds(
        { x: -1100, y: 100, width: 1000, height: 700 },
        [
          { x: 0, y: 0, width: 1920, height: 1040 },
          { x: -1280, y: 0, width: 1280, height: 1024 },
        ],
        { width: 880, height: 560 },
      ),
    ).toEqual({ x: -1100, y: 100, width: 1000, height: 700 });
  });
});
