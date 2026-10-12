import type { DormantPluginRuntimeComposition } from '../plugin/runtime-composition.js';
import { ProjectContentOwnerService } from '../video-studio/content-owner/service.js';
import type { AuthorizeVideoProjectCat } from '../video-studio/project/access.js';
import { VideoProjectAssetIndex } from '../video-studio/project/asset-index.js';
import { VideoProjectService } from '../video-studio/project/service.js';
import { resolveWorkspaceContentRoot } from '../workspace/workspace-content-source-factory.js';
import { readWorkspaceOfficeImport } from '../workspace/workspace-office-import.js';
import { EditorBridgeService } from './editor-bridge/service.js';
import { EditorSessionService } from './editor-session-service.js';
import { NamedCatContentService } from './named-cat-content-service.js';
import { CollaborativePatchService, type ContentPatchMaterializerPort } from './patch-service.js';
import { createPluginDocxMaterializer } from './plugin-docx-materializer.js';
import { createPluginEditorAuthority } from './plugin-editor-authority.js';
import { OfficeProviderBindingStore } from './provider-binding-store.js';
import { SemanticOperationStore } from './semantic-operation-store.js';
import { WorkspaceEditorService } from './workspace-editor-service.js';

export function createCollaborativeContentComposition(options: {
  readonly dataDir: string;
  readonly ownerUserId: string;
  readonly plugins: Pick<DormantPluginRuntimeComposition, 'inventoryStore' | 'contentEditors' | 'contentMaterializers'>;
  readonly materializer?: ContentPatchMaterializerPort;
  readonly readSource?: (worktreeId: string, path: string) => Promise<Buffer>;
  /** Trusted invocation/delegation port; omission deliberately denies Cat project access. */
  readonly authorizeVideoProjectCat?: AuthorizeVideoProjectCat;
}) {
  const runtime = options.plugins.contentEditors;
  if (!runtime) throw new Error('F202 content editor runtime is required');
  const owner = new ProjectContentOwnerService({ dataDir: options.dataDir });
  const projects = new VideoProjectService({
    owner,
    ownerUserId: options.ownerUserId,
    assets: new VideoProjectAssetIndex({ resolveRoot: resolveWorkspaceContentRoot }),
    ...(options.authorizeVideoProjectCat ? { authorizeCat: options.authorizeVideoProjectCat } : {}),
  });
  const bindings = new OfficeProviderBindingStore({ dataDir: options.dataDir });
  const { authority, surfaces } = createPluginEditorAuthority(runtime);
  const sessions = new EditorSessionService({ dataDir: options.dataDir, owner, bindings, authority });
  const semantic = createPluginDocxMaterializer(options.plugins.contentMaterializers);
  const patches = new CollaborativePatchService({
    owner,
    sessions,
    semanticOperations: new SemanticOperationStore(options.dataDir),
    materializer: options.materializer ?? semantic,
  });
  const bridge = new EditorBridgeService({ owner, sessions, patches });
  const workspace = new WorkspaceEditorService({
    owner,
    ownerUserId: options.ownerUserId,
    bindings,
    sessions,
    inventory: options.plugins.inventoryStore,
    runtime,
    readSource: options.readSource ?? readWorkspaceOfficeImport,
  });
  const namedCats = new NamedCatContentService({
    ownerUserId: options.ownerUserId,
    sessions,
    owner,
    patches,
    inspector: semantic,
    workspace,
  });
  return { owner, projects, bindings, sessions, patches, bridge, surfaces, workspace, namedCats };
}
