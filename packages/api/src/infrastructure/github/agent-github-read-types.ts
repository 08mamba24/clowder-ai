/** Provider-facing lease contract. Keep server executors out of cross-package type consumers. */
export interface GhReadLease {
  readonly token: string;
  readonly queryUrl: string;
  readonly mcpUrl: string;
  revoke(): void;
}
