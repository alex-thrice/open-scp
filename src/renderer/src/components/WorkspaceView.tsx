import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Appearance, WorkspaceSnapshot } from '@shared/ipc/workspace';
import { defaultKeyboardShortcuts, matchesShortcut } from '@shared/models/keyboard-shortcuts';
import { FilePane } from './FilePane';
import type { WorkspaceRunner } from './useWorkspaceService';
import { sessionPaneId, type PaneLocation, type PaneSide } from './workspace-layout';

export const WorkspaceView = ({
  isActive,
  workspaceId,
  tabId,
  tabPanelId,
  initialPaths,
  initialized,
  snapshot,
  run,
  errorKey,
  appearance,
  activeSide,
  connectingIds,
  onActiveSide,
  onConnect,
  onLocations,
}: {
  readonly isActive: boolean;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly tabPanelId: string;
  readonly initialPaths:
    { readonly left: string | null; readonly right: string | null } | undefined;
  readonly initialized: boolean;
  readonly snapshot: WorkspaceSnapshot;
  readonly run: WorkspaceRunner;
  readonly errorKey: string | null;
  readonly appearance: Appearance;
  readonly activeSide: PaneSide;
  readonly connectingIds: ReadonlySet<string>;
  readonly onActiveSide: (workspaceId: string, side: PaneSide) => void;
  readonly onConnect: (workspaceId: string, side: PaneSide, profileId: string) => void;
  readonly onLocations: (
    workspaceId: string,
    locations: Partial<Record<PaneSide, PaneLocation>>,
  ) => void;
}) => {
  const { t } = useTranslation();
  const panels = useRef<HTMLDivElement>(null);
  const [locations, setLocations] = useState<Partial<Record<PaneSide, PaneLocation>>>({});
  const locationsRef = useRef(locations);
  const report = useCallback(
    (side: PaneSide, location: PaneLocation) => {
      const previous = locationsRef.current[side];
      if (previous && JSON.stringify(previous) === JSON.stringify(location)) return;
      const next = { ...locationsRef.current, [side]: location };
      locationsRef.current = next;
      setLocations(next);
      onLocations(workspaceId, next);
    },
    [onLocations, workspaceId],
  );
  return (
    <section
      aria-labelledby={tabId}
      className="workspace"
      data-workspace-id={workspaceId}
      hidden={!isActive}
      id={tabPanelId}
      role="tabpanel"
    >
      <div
        className="panels"
        ref={panels}
        aria-label={t('panels.label')}
        onKeyDown={(event) => {
          const shortcut =
            snapshot.keyboardShortcuts?.switchPanel ?? defaultKeyboardShortcuts.switchPanel;
          if (
            !matchesShortcut(event, shortcut) ||
            (event.target as HTMLElement).closest('dialog, [role="dialog"]')
          )
            return;
          event.preventDefault();
          const next = panels.current?.querySelector<HTMLElement>(
            `[data-testid="${activeSide === 'left' ? 'right' : 'left'}-panel"]`,
          );
          (
            next?.querySelector<HTMLElement>('[data-testid="file-row"][tabindex="0"]') ??
            next?.querySelector<HTMLElement>('button:not(:disabled)') ??
            next
          )?.focus();
        }}
      >
        {(['left', 'right'] as const).map((side) => {
          const paneId = sessionPaneId(snapshot, workspaceId, side);
          const session = snapshot.sessions.find((item) => item.workspaceId === paneId);
          // Состояние каталога и операций принадлежит конкретному источнику панели.
          const sourceKey = JSON.stringify([paneId, session?.kind, session?.profileId]);
          return (
            <FilePane
              key={sourceKey}
              side={side}
              paneId={paneId}
              active={activeSide === side}
              isActive={isActive}
              initialPath={initialPaths?.[side] ?? snapshot.localPaths?.[paneId] ?? null}
              initialized={initialized}
              snapshot={snapshot}
              run={run}
              errorKey={errorKey}
              appearance={appearance}
              destination={locations[side === 'left' ? 'right' : 'left']}
              destinationId={sessionPaneId(
                snapshot,
                workspaceId,
                side === 'left' ? 'right' : 'left',
              )}
              isConnecting={connectingIds.has(paneId)}
              onConnect={(id) => onConnect(workspaceId, side, id)}
              onActivate={() => onActiveSide(workspaceId, side)}
              onLocation={report}
            />
          );
        })}
      </div>
    </section>
  );
};
