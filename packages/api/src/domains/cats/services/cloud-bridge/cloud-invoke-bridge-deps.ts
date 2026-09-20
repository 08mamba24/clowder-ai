import type { CatId } from '@cat-cafe/shared';
import type { IThreadStore } from '../stores/ports/ThreadStore.js';
import type { IConversationHostAdapter } from './conversation-host-adapter.js';
import type { BridgeFallbackReason, IPinchTabBridgeAdapter } from './types.js';
import type { IWorkspaceAgentTriggerAdapter } from './workspace-agent/workspace-agent-trigger-adapter.js';

export type EmitFallbackFn = (params: {
  readonly threadId: string;
  readonly catId: CatId | string;
  readonly reason: BridgeFallbackReason;
  readonly detail?: string;
}) => Promise<void>;

export interface BridgeLogger {
  warn(ctx: object, msg: string): void;
  info(ctx: object, msg: string): void;
  error?(ctx: object, msg: string): void;
}

export interface CloudInvokeBridgeDeps {
  readonly hostAdapter?: IConversationHostAdapter | null;
  readonly pinchTabAdapter: IPinchTabBridgeAdapter | null;
  /**
   * F247 Workspace Agent (KD-24 pending): when present together with
   * `workspaceAgentWorkspaceId`, the official Trigger API path owns the
   * outbound outcome (fail closed — no silent Personal Chrome fallback).
   */
  readonly workspaceAgentAdapter?: IWorkspaceAgentTriggerAdapter | null;
  readonly workspaceAgentWorkspaceId?: string | null;
  readonly emitFallback: EmitFallbackFn;
  readonly threadStore: IThreadStore;
  readonly logger?: BridgeLogger;
}

export const noopBridgeLogger: BridgeLogger = {
  warn() {},
  info() {},
};
