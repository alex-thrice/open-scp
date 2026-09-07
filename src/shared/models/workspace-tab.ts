export interface WorkspaceRemoteSessionReference {
  readonly displayName: string;
  readonly profileId: string;
  readonly provider: 'ftp' | 's3' | 'sftp';
  readonly sessionId: string;
}

export interface WorkspaceTab {
  readonly initialPaths?: { readonly left: string | null; readonly right: string | null };
  readonly id: string;
  readonly remoteSession: WorkspaceRemoteSessionReference | null;
  readonly sequence: number;
}
