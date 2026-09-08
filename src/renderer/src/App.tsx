import type { KeyboardEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceTab } from '@shared/models/workspace-tab';
import {
  defaultKeyboardShortcuts,
  formatShortcut,
  matchesShortcut,
} from '@shared/models/keyboard-shortcuts';
import { defaultUpdateSettings } from '@shared/models/application-update';
import { defaultAppearance, type WorkspaceSnapshot } from '@shared/ipc/workspace';
import { useTranslation } from 'react-i18next';
import { WorkspaceView } from './components/WorkspaceView';
import { ProfileLibrary } from './components/ProfileLibrary';
import { SettingsDialog, type SettingsPage } from './components/SettingsDialog';
import { Dialog } from './components/Dialog';
import { Icon } from './components/Icon';
import { useWorkspaceService } from './components/useWorkspaceService';
import { TransferQueue } from './components/TransferQueue';
import { ExternalEditPrompt } from './components/ExternalEditPrompt';
import {
  hasWorkspaceConnection,
  protocolIcon,
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
const workspaceSequences = (ids: readonly (string | undefined)[]): number[] =>
  [
    ...new Set(
      ids.flatMap((id) => {
        if (!id) return [];
        const workspaceId = workspaceOf(id);
        const match = /^workspace-([1-9]\d{0,3})$/u.exec(workspaceId);
        return match?.[1] ? [Number(match[1])] : [];
      }),
    ),
  ].sort((left, right) => left - right);

const restoredWorkspaceSequences = (snapshot: WorkspaceSnapshot): number[] => {
  const stored = workspaceSequences(snapshot.workspaceLayout?.workspaceIds ?? []);
  if (stored.length) return stored;
  const required = workspaceSequences([
    ...snapshot.transfers.flatMap((item) => [item.workspaceId, item.destinationWorkspaceId]),
    ...snapshot.sessions.map((item) => item.workspaceId),
  ]);
  if (required.length) return required;
  const local = workspaceSequences(Object.keys(snapshot.localPaths ?? {}));
  return [local.at(-1) ?? 1];
};

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
  const [settingsPage, setSettingsPage] = useState<SettingsPage>('appearance');
  const [pendingClose, setPendingClose] = useState<{
    readonly id: string;
    readonly hasActiveTransfers: boolean;
  } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const connecting = useRef(new Set<string>());
  const [connectingIds, setConnectingIds] = useState<ReadonlySet<string>>(new Set());
  const [workspaceLayoutReady, setWorkspaceLayoutReady] = useState(false);
  const restoredWorkspaceLayout = useRef(false);
  const service = useWorkspaceService(true);
  const appearance = service.snapshot.appearance ?? defaultAppearance;
  const shortcuts = service.snapshot.keyboardShortcuts ?? defaultKeyboardShortcuts;
  const updateState = service.snapshot.updateState;
  const hasAvailableUpdate =
    updateState?.availableVersion !== null &&
    (updateState?.status === 'available' ||
      updateState?.status === 'downloading' ||
      updateState?.status === 'downloaded');
  const isMac = /Mac/iu.test(navigator.platform);
  const openSettings = (page: SettingsPage): void => {
    setSettingsPage(page);
    setSettingsOpen(true);
  };
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
    if (!service.snapshot.language) return;
    void i18n.changeLanguage(service.snapshot.language);
  }, [i18n, service.snapshot.language]);
  useEffect(() => {
    if (!service.initialized || restoredWorkspaceLayout.current) return;
    restoredWorkspaceLayout.current = true;
    const sequences = restoredWorkspaceSequences(service.snapshot);
    sequence.current = Math.max(...sequences);
    setWorkspaces(sequences.map(createWorkspace));
    const storedActiveSequence = workspaceSequences([
      service.snapshot.workspaceLayout?.activeWorkspaceId,
    ])[0];
    const activeSequence =
      storedActiveSequence && sequences.includes(storedActiveSequence)
        ? storedActiveSequence
        : (sequences.at(-1) ?? 1);
    setActiveWorkspaceId(`workspace-${activeSequence}`);
    setWorkspaceLayoutReady(true);
  }, [service.initialized, service.snapshot]);
  useEffect(() => {
    if (!workspaceLayoutReady || !workspaces.length) return;
    void service.run({
      action: 'remember-workspace-layout',
      layout: {
        activeWorkspaceId,
        workspaceIds: workspaces.map((workspace) => workspace.id),
      },
    });
  }, [activeWorkspaceId, service.run, workspaceLayoutReady, workspaces]);
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
  const closeWorkspace = async (id: string, confirmed = false) => {
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
      const hasActiveTransfers = state.data.snapshot.transfers.some(
        (item) =>
          (ids.includes(item.workspaceId) ||
            (!!item.destinationWorkspaceId && ids.includes(item.destinationWorkspaceId))) &&
          ['running', 'queued', 'requiring-review'].includes(item.state),
      );
      if (!confirmed && service.snapshot.confirmTabClose !== false) {
        setPendingClose({ id, hasActiveTransfers });
        return;
      }
      for (const workspaceId of ids) {
        const result = await service.run(
          hasActiveTransfers
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
    if ((event.target as HTMLElement).closest('input, select, textarea, dialog, [role="dialog"]'))
      return;
    if (matchesShortcut(event, shortcuts.newWorkspace)) {
      event.preventDefault();
      if (!closing) addWorkspace();
    } else if (matchesShortcut(event, shortcuts.closeWorkspace)) {
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
              const remoteSession = service.snapshot.sessions.find((item) =>
                workspaceIds(workspace.id).includes(item.workspaceId),
              );
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
                    <Icon
                      name={
                        remoteSession
                          ? protocolIcon(remoteSession.kind ?? 'sftp')
                          : remote
                            ? 'Plug'
                            : 'PanelsTopLeft'
                      }
                    />
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
            disabled={closing || !workspaceLayoutReady}
            onClick={addWorkspace}
            title={`${t('tabs.add')} (${formatShortcut(shortcuts.newWorkspace, isMac)})`}
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
          {hasAvailableUpdate ? (
            <button
              className="icon-button update-available-button"
              aria-label={t('updates.availableHint', {
                version: updateState.availableVersion,
              })}
              title={t('updates.availableHint', { version: updateState.availableVersion })}
              onClick={() => openSettings('updates')}
            >
              <Icon name="RefreshCw" />
            </button>
          ) : null}
          <button
            className="icon-button settings-button"
            aria-label={t('ui.settings')}
            title={t('ui.settings')}
            onClick={() => openSettings('appearance')}
          >
            <Icon name="Settings" />
          </button>
        </div>
      </header>
      {error && !libraryOpen && !settingsOpen && !pendingClose ? (
        <div className="app-error inline-error" role="alert">
          {t(error)}
          {error === 'errors.external.unavailable' ? (
            <button type="button" onClick={() => openSettings('advanced')}>
              {t('terminal.configure')}
            </button>
          ) : null}
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
          initialized={service.initialized && workspaceLayoutReady}
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
      <ExternalEditPrompt edits={service.snapshot.externalEdits ?? []} run={service.run} />
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
          confirmTabClose={service.snapshot.confirmTabClose !== false}
          editorPath={service.snapshot.editorPath ?? null}
          initialPage={settingsPage}
          keyboardShortcuts={shortcuts}
          puttyPath={service.snapshot.puttyPath ?? null}
          rememberPaths={service.snapshot.rememberPaths !== false}
          updateSettings={service.snapshot.updateSettings ?? defaultUpdateSettings}
          updateState={service.snapshot.updateState}
          run={service.run}
          errorKey={error}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {pendingClose ? (
        <Dialog
          title={t('tabs.closeTitle')}
          onClose={() => {
            if (!closing) setPendingClose(null);
          }}
        >
          <p>
            {t(pendingClose.hasActiveTransfers ? 'tabs.closeActiveWarning' : 'tabs.closeWarning')}
          </p>
          {error ? (
            <p role="alert" className="inline-error">
              {t(error)}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button disabled={closing} onClick={() => setPendingClose(null)}>
              {t('tabs.keepOpen')}
            </button>
            <button
              className="destructive"
              disabled={closing}
              onClick={() => void closeWorkspace(pendingClose.id, true)}
            >
              {t(pendingClose.hasActiveTransfers ? 'tabs.interruptAndClose' : 'tabs.confirmClose')}
            </button>
          </div>
        </Dialog>
      ) : null}
    </main>
  );
};
