import type { KeyboardEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceTab } from '@shared/models/workspace-tab';
import { defaultAppearance } from '@shared/ipc/workspace';
import { useTranslation } from 'react-i18next';
import { WorkspaceView } from './components/WorkspaceView';
import { ProfileLibrary } from './components/ProfileLibrary';
import { SettingsDialog } from './components/SettingsDialog';
import { Dialog } from './components/Dialog';
import { Icon } from './components/Icon';
import { useWorkspaceService } from './components/useWorkspaceService';
import { TransferQueue } from './components/TransferQueue';
import {
  hasWorkspaceConnection,
  sessionPaneId,
  workspaceIds,
  workspaceOf,
  workspaceTitle,
  type PaneLocation,
  type PaneSide,
} from './components/workspace-layout';

const createWorkspace = (sequence: number): WorkspaceTab => ({
  id: `workspace-${sequence}`,
  remoteSession: null,
  sequence,
});
const getTabId = (id: string) => `workspace-tab-${id}`;
const getTabPanelId = (id: string) => `workspace-panel-${id}`;

export const App = () => {
  const { i18n, t } = useTranslation();
  const sequence = useRef(1);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceTab[]>([createWorkspace(1)]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('workspace-1');
  const [locations, setLocations] = useState<
    Record<string, Partial<Record<PaneSide, PaneLocation>>>
  >({});
  const [activeSides, setActiveSides] = useState<Record<string, PaneSide>>({});
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const connecting = useRef(new Set<string>());
  const [connectingIds, setConnectingIds] = useState<ReadonlySet<string>>(new Set());
  const service = useWorkspaceService(true);
  const appearance = service.snapshot.appearance ?? defaultAppearance;
  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage ?? i18n.language;
  }, [i18n.language, i18n.resolvedLanguage]);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme =
        appearance.theme === 'system' ? (media?.matches ? 'dark' : 'light') : appearance.theme;
    };
    apply();
    media?.addEventListener('change', apply);
    return () => media?.removeEventListener('change', apply);
  }, [appearance.theme]);
  useEffect(() => {
    let live = true;
    void window.desktop.workspace({ action: 'snapshot' }).then((result) => {
      if (!live || !result.ok) return;
      const ids = [
        ...result.data.snapshot.transfers.flatMap((item) => [
          item.workspaceId,
          item.destinationWorkspaceId,
        ]),
        ...result.data.snapshot.sessions.map((item) => item.workspaceId),
      ];
      const sequences = [
        ...new Set(
          ids
            .filter((id): id is string => !!id)
            .map(workspaceOf)
            .filter((id) => /^workspace-\d+$/u.test(id))
            .map((id) => Number(id.slice(10))),
        ),
      ].filter((value) => value > 0 && value < 10000);
      sequence.current = Math.max(sequence.current, ...sequences);
      setWorkspaces((current) => [
        ...current,
        ...sequences
          .filter((value) => !current.some((item) => item.sequence === value))
          .map(createWorkspace),
      ]);
      if (result.data.snapshot.language) void i18n.changeLanguage(result.data.snapshot.language);
    });
    return () => {
      live = false;
    };
  }, [i18n]);
  const reportLocations = useCallback(
    (id: string, value: Partial<Record<PaneSide, PaneLocation>>) => {
      setLocations((current) => ({ ...current, [id]: value }));
    },
    [],
  );
  const activateSide = useCallback((id: string, side: PaneSide) => {
    setActiveSides((current) => (current[id] === side ? current : { ...current, [id]: side }));
  }, []);
  const focusTab = (id: string) =>
    requestAnimationFrame(() => document.getElementById(getTabId(id))?.focus());
  const addWorkspace = () => {
    const workspace = createWorkspace(++sequence.current);
    const previous = locations[activeWorkspaceId];
    const initialPaths = {
      left: previous?.left?.kind === 'local' ? previous.left.path || null : null,
      right: previous?.right?.kind === 'local' ? previous.right.path || null : null,
    };
    setWorkspaces((current) => [...current, { ...workspace, initialPaths }]);
    setActiveWorkspaceId(workspace.id);
    focusTab(workspace.id);
  };
  const connect = (workspaceId: string, side: PaneSide, profileId: string) => {
    const id = sessionPaneId(service.snapshot, workspaceId, side);
    if (
      closingRef.current ||
      service.snapshot.sessions.some((item) => item.workspaceId === id) ||
      connecting.current.has(id)
    ) {
      setLocalError('ui.lockedError');
      return;
    }
    connecting.current.add(id);
    setConnectingIds(new Set(connecting.current));
    setLocalError(null);
    setLibraryOpen(false);
    void service.run({ action: 'connect', workspaceId: id, profileId }).finally(() => {
      connecting.current.delete(id);
      setConnectingIds(new Set(connecting.current));
    });
  };
  const closeWorkspace = async (id: string, cancelActive = false) => {
    const ids = workspaceIds(id);
    if (
      closingRef.current ||
      ids.some((value) => connecting.current.has(value)) ||
      (workspaces.length === 1 && !hasWorkspaceConnection(service.snapshot, id))
    )
      return;
    closingRef.current = true;
    setClosing(true);
    setLocalError(null);
    try {
      const state = await window.desktop.workspace({ action: 'snapshot' });
      if (!state.ok) {
        setLocalError(state.error.messageKey);
        return;
      }
      if (
        !cancelActive &&
        state.data.snapshot.transfers.some(
          (item) =>
            (ids.includes(item.workspaceId) ||
              (!!item.destinationWorkspaceId && ids.includes(item.destinationWorkspaceId))) &&
            ['running', 'queued', 'requiring-review'].includes(item.state),
        )
      ) {
        setPendingClose(id);
        return;
      }
      for (const workspaceId of ids) {
        const result = await service.run(
          cancelActive
            ? { action: 'close-session', workspaceId, cancelActive: true }
            : { action: 'disconnect', workspaceId },
        );
        if (!result) return;
      }
      setPendingClose(null);
      const index = workspaces.findIndex((item) => item.id === id);
      let remaining = workspaces.filter((item) => item.id !== id);
      if (!remaining.length) remaining = [createWorkspace(++sequence.current)];
      setWorkspaces(remaining);
      if (activeWorkspaceId === id) {
        const next = remaining[Math.min(index, remaining.length - 1)];
        if (next) {
          setActiveWorkspaceId(next.id);
          focusTab(next.id);
        }
      }
      setLocations((current) =>
        Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)),
      );
      setActiveSides((current) =>
        Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)),
      );
    } finally {
      closingRef.current = false;
      setClosing(false);
    }
  };
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const index = workspaces.findIndex((item) => item.id === id);
    const next =
      event.key === 'Home'
        ? workspaces[0]
        : event.key === 'End'
          ? workspaces.at(-1)
          : ['ArrowLeft', 'ArrowRight'].includes(event.key)
            ? workspaces[
                (index + (event.key === 'ArrowLeft' ? -1 : 1) + workspaces.length) %
                  workspaces.length
              ]
            : undefined;
    if (next) {
      event.preventDefault();
      setActiveWorkspaceId(next.id);
      focusTab(next.id);
    }
  };
  const onAppKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      (event.target as HTMLElement).closest('dialog, [role="dialog"]') ||
      (!event.ctrlKey && !event.metaKey)
    )
      return;
    if (event.key.toLowerCase() === 't') {
      event.preventDefault();
      if (!closing) addWorkspace();
    } else if (event.key.toLowerCase() === 'w') {
      event.preventDefault();
      void closeWorkspace(activeWorkspaceId);
    }
  };
  const error = localError ?? service.errorKey;
  return (
    <main className="app-shell" onKeyDown={onAppKeyDown} data-density={appearance.density}>
      <header className="toolbar">
        <div className="brand">
          <span className="brand-icon">
            <Icon name="FolderSync" />
          </span>
          <h1>{t('app.name')}</h1>
        </div>
        <div className="workspace-tabs-shell">
          <div aria-label={t('tabs.label')} className="workspace-tabs" role="tablist">
            {workspaces.map((workspace) => {
              const active = workspace.id === activeWorkspaceId;
              const name = workspaceTitle(
                locations[workspace.id]?.left,
                locations[workspace.id]?.right,
                t('tabs.workspace', { number: workspace.sequence }),
              );
              const remote = hasWorkspaceConnection(service.snapshot, workspace.id);
              return (
                <div
                  className="workspace-tab"
                  data-active={active}
                  key={workspace.id}
                  role="presentation"
                >
                  <button
                    aria-controls={getTabPanelId(workspace.id)}
                    aria-selected={active}
                    className="workspace-tab__select"
                    id={getTabId(workspace.id)}
                    title={name}
                    onClick={() => setActiveWorkspaceId(workspace.id)}
                    onKeyDown={(event) => onTabKeyDown(event, workspace.id)}
                    role="tab"
                    tabIndex={active ? 0 : -1}
                  >
                    <Icon name={remote ? 'ShieldCheck' : 'PanelsTopLeft'} />
                    <span>{name}</span>
                  </button>
                  {workspaces.length > 1 || remote ? (
                    <button
                      aria-label={t('tabs.close', { name })}
                      title={t(remote ? 'ui.closeConnection' : 'tabs.close', { name })}
                      className="workspace-tab__close icon-button"
                      disabled={
                        closing || workspaceIds(workspace.id).some((id) => connectingIds.has(id))
                      }
                      onClick={() => void closeWorkspace(workspace.id)}
                    >
                      <Icon name="X" />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          <button
            aria-label={t('tabs.add')}
            className="workspace-tab__add icon-button"
            disabled={closing}
            onClick={addWorkspace}
            title={t('tabs.addHint')}
          >
            <Icon name="Plus" />
          </button>
        </div>
        <div className="toolbar__actions">
          <button
            onClick={() => {
              setLocalError(null);
              setLibraryOpen(true);
            }}
          >
            <Icon name="Plug" />
            {t('ui.connections')}
          </button>
          <button
            className="icon-button settings-button"
            aria-label={t('ui.settings')}
            title={t('ui.settings')}
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="Settings" />
          </button>
        </div>
      </header>
      {error && !libraryOpen && !settingsOpen && !pendingClose ? (
        <div className="app-error inline-error" role="alert">
          {t(error)}
        </div>
      ) : null}
      {workspaces.map((workspace) => (
        <WorkspaceView
          key={workspace.id}
          workspaceId={workspace.id}
          isActive={workspace.id === activeWorkspaceId}
          tabId={getTabId(workspace.id)}
          tabPanelId={getTabPanelId(workspace.id)}
          initialPaths={workspace.initialPaths}
          snapshot={service.snapshot}
          run={service.run}
          errorKey={error}
          appearance={appearance}
          activeSide={activeSides[workspace.id] ?? 'left'}
          connectingIds={connectingIds}
          onActiveSide={activateSide}
          onConnect={connect}
          onLocations={reportLocations}
        />
      ))}
      <TransferQueue transfers={service.snapshot.transfers} run={service.run} />
      {libraryOpen ? (
        <ProfileLibrary
          snapshot={service.snapshot}
          run={service.run}
          errorKey={error}
          onClose={() => setLibraryOpen(false)}
          onOpen={(profileId) =>
            connect(activeWorkspaceId, activeSides[activeWorkspaceId] ?? 'left', profileId)
          }
        />
      ) : null}
      {settingsOpen ? (
        <SettingsDialog
          appearance={appearance}
          run={service.run}
          errorKey={error}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {pendingClose ? (
        <Dialog
          title={t('library.closeTitle')}
          onClose={() => {
            if (!closing) setPendingClose(null);
          }}
        >
          <p>{t('library.closeWarning')}</p>
          {error ? (
            <p role="alert" className="inline-error">
              {t(error)}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button disabled={closing} onClick={() => setPendingClose(null)}>
              {t('library.keepOpen')}
            </button>
            <button
              className="destructive"
              disabled={closing}
              onClick={() => void closeWorkspace(pendingClose, true)}
            >
              {t('library.cancelClose')}
            </button>
          </div>
        </Dialog>
      ) : null}
    </main>
  );
};
