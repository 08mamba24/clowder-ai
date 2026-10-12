import { randomUUID } from 'node:crypto';
import type { CodexAppServerJsonObject } from '../../../cats/services/agents/providers/CodexAppServerEventMapper.js';
import type { CodexLiveNativeClient } from '../../../cats/services/agents/providers/CodexLiveRunPort.js';
import { record } from '../live-call-async.js';

/** Presentation eligibility only. Native work and its durable history are never cancelled or rewritten. */
export class LiveResultReturn {
  private epoch = 0;
  private consumedEpoch = 0;
  private speaking = false;
  private closed = false;
  private readonly inputs = new Map<string, { epoch: number; owner: boolean; signal?: AbortSignal }>();
  private readonly samples = new Map<string, number>();
  private readonly seenSamples = new Set<string>();
  private readonly seenInputs = new Set<string>();
  private readonly seenVoice = new Set<string>();
  private pendingOpening?: CodexAppServerJsonObject;
  constructor(
    private readonly deps: {
      client(): CodexLiveNativeClient | undefined;
      threadId(): string | undefined;
      realtimeSessionId(): string | undefined;
      available(): boolean;
      verifyCompanion(): Promise<boolean>;
      handed(turnId: string, itemId: string): void;
    },
  ) {}

  ownerChanged(): void {
    ++this.epoch;
    this.inputs.clear();
    this.samples.clear();
    this.pendingOpening = undefined;
  }

  bind(client: CodexLiveNativeClient): CodexLiveNativeClient {
    const submitContext = client.submitContextAtBoundary?.bind(client);
    const wake = client.wakeBoundary?.bind(client);
    return {
      request: (method, params) => client.request(method, params),
      submitText: (text, sourceMessageId) => {
        this.register(sourceMessageId, true);
        return client.submitText(text, sourceMessageId);
      },
      ...(submitContext
        ? {
            submitContextAtBoundary: (text, refs, kind, signal, authorize) => {
              const clientId = randomUUID();
              this.register(clientId, kind === 'owner_voice_context', signal);
              return submitContext(text, refs, kind, signal, authorize, clientId);
            },
          }
        : {}),
      ...(wake ? { wakeBoundary: wake } : {}),
    };
  }

  private register(id: string, owner: boolean, signal?: AbortSignal): void {
    if (!owner || this.seenInputs.has(id)) return;
    for (const [key, input] of this.inputs) if (input.signal?.aborted) this.inputs.delete(key);
    if (this.closed || signal?.aborted || this.inputs.size >= 256 || this.seenInputs.size >= 4096)
      throw new Error('Live input qualification unavailable');
    this.seenInputs.add(id);
    this.inputs.set(id, { epoch: this.epoch, owner, signal });
  }

  observe(message: CodexAppServerJsonObject, activeTurnId: string | undefined): void {
    if (this.closed) return;
    const params = record(message.params);
    const item = record(params.item);
    this.observeVoice(message, params, item);
    if (!activeTurnId || params.turnId !== activeTurnId) return;
    if (message.method === 'item/completed' && item.type === 'userMessage' && typeof item.clientId === 'string') {
      this.consume(item.clientId);
    }
    if (
      message.method === 'item/started' &&
      item.type === 'agentMessage' &&
      item.phase === 'final_answer' &&
      typeof item.id === 'string'
    ) {
      if (this.seenSamples.has(item.id) || this.seenSamples.size >= 4096) return;
      this.seenSamples.add(item.id);
      if (this.samples.size < 64 && this.consumedEpoch === this.epoch) this.samples.set(item.id, this.epoch);
    }
  }

  private consume(clientId: string): void {
    const input = this.inputs.get(clientId);
    this.inputs.delete(clientId);
    if (input?.owner && input.epoch === this.epoch && !input.signal?.aborted) this.consumedEpoch = this.epoch;
  }

  private observeVoice(
    message: CodexAppServerJsonObject,
    params: Record<string, unknown>,
    item: Record<string, unknown>,
  ): void {
    const session = this.deps.realtimeSessionId();
    if (
      message.method === 'thread/realtime/transcript/delta' &&
      params.role === 'user' &&
      typeof params.delta === 'string' &&
      params.delta.length > 0 &&
      (!params.realtimeSessionId || params.realtimeSessionId === session) &&
      !this.speaking
    ) {
      this.speaking = true;
      this.ownerChanged();
    }
    if (
      message.method === 'thread/realtime/transcript/done' &&
      params.role === 'user' &&
      (!params.realtimeSessionId || params.realtimeSessionId === session)
    )
      this.speaking = false;
    // Some providers commit a segment without an earlier delta; that still retires the previous presentation.
    if (
      message.method === 'thread/realtime/item/completed' &&
      item.type === 'transcriptSegment' &&
      item.role === 'user' &&
      item.realtimeSessionId === session &&
      typeof item.id === 'string' &&
      !this.seenVoice.has(item.id)
    ) {
      if (this.seenVoice.size < 4096) this.seenVoice.add(item.id);
      if (!this.speaking) this.ownerChanged();
      this.speaking = false;
    }
  }

  takePendingOpening(): CodexAppServerJsonObject | undefined {
    const opening = this.pendingOpening;
    this.pendingOpening = undefined;
    return !this.closed && this.epoch === 0 ? opening : undefined;
  }

  async flushOpening(persist: (message: CodexAppServerJsonObject, turnId: string) => Promise<void>): Promise<void> {
    const opening = this.takePendingOpening();
    const turnId = record(opening?.params).turnId;
    if (!opening || typeof turnId !== 'string') return;
    await persist(opening, turnId);
    await this.present(opening, turnId);
  }

  async present(message: CodexAppServerJsonObject, activeTurnId: string | undefined): Promise<void> {
    const params = record(message.params);
    const item = record(params.item);
    if (
      message.method !== 'item/completed' ||
      params.turnId !== activeTurnId ||
      item.type !== 'agentMessage' ||
      item.phase !== 'final_answer' ||
      typeof item.id !== 'string'
    )
      return;
    const epoch = this.samples.get(item.id);
    if (epoch === undefined || typeof item.text !== 'string' || !item.text.trim()) return;
    if (!this.closed && epoch === 0 && this.epoch === 0 && !this.deps.available()) {
      this.pendingOpening ??= message;
      return;
    }
    this.samples.delete(item.id);
    const available = () => !this.closed && this.deps.available() && epoch === this.epoch;
    if (!available() || !(await this.deps.verifyCompanion()) || !available()) return;
    const client = this.deps.client();
    const threadId = this.deps.threadId();
    if (!client || !threadId || !activeTurnId) return;
    // No await between the final current-source check and the actual native write.
    await client.request('thread/realtime/appendSpeech', { threadId, text: item.text });
    this.deps.handed(activeTurnId, item.id);
  }

  close(): void {
    this.closed = true;
    this.inputs.clear();
    this.samples.clear();
    this.seenSamples.clear();
    this.seenInputs.clear();
    this.seenVoice.clear();
    this.pendingOpening = undefined;
  }
}
