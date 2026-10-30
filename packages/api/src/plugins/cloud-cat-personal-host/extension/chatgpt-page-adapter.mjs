import {
  assistantIsStreaming,
  findSendButton,
  requireIdleComposer,
  SEND_BUTTON_SELECTORS,
  sendButtonIsDisabled,
  waitForSendButton,
} from './chatgpt-composer-controls.mjs';
import {
  composerSnapshot,
  composerTextResult,
  insertComposerText,
  restoreAfterNoSend,
} from './chatgpt-composer-transaction.mjs';
import {
  ChatGptPageAdapterError,
  composerDomFingerprint,
  contentEditableText,
  conversationIdFromLocation,
  firstMatch,
  requireContentString,
  requireExactString,
  requireTimeout,
  SAFE_CONVERSATION_ID,
} from './chatgpt-page-contract.mjs';

const COMPOSER_SELECTORS = [
  '#prompt-textarea[contenteditable="true"]',
  'div[contenteditable="true"][data-virtualkeyboard="true"]',
  'textarea[data-id="root"]',
];
const USER_MESSAGE_SELECTOR = '[data-message-author-role="user"]';
const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';
const MESSAGE_TURN_SELECTOR = '[data-testid^="conversation-turn-"], article';
const RENDERED_MESSAGE_CONTENT_SELECTOR = '.whitespace-pre-wrap';
const SAFE_TURN_ID = /^conversation-turn-[A-Za-z0-9._:-]+$/;
const MAX_ASSISTANT_CONTENT_BYTES = 128 * 1024;

// Roleless DOM (observed on ChatGPT Pro 2026-10-28): user messages render as
// [data-user-message-bubble="true"] inside [data-content-search-unit-key]
// units, assistant replies as units whose key ends in ":assistant". These
// markers carry no Host-provided message identity; unit keys such as
// fallback-turn-N:M:role are page-local and never qualify as hostMessageId.
const ROLELESS_USER_BUBBLE_SELECTOR = '[data-user-message-bubble="true"]';
const ROLELESS_ASSISTANT_UNIT_SELECTOR = '[data-content-search-unit-key$=":assistant"]';
const ROLELESS_TEXT_EXCLUSION_SELECTOR = 'button, a, svg, script, style, noscript';
// DOM spec constants (the adapter never assumes a global Node/NodeFilter).
const TREE_WALKER_SHOW_TEXT = 0x4;
const TREE_WALKER_ACCEPT = 1;
const TREE_WALKER_REJECT = 2;
const DOCUMENT_POSITION_FOLLOWING = 0x4;

function outermostMatches(document, selector) {
  return [...document.querySelectorAll(selector)].filter((element) => element.parentElement?.closest(selector) == null);
}

function visibleUserBubbleTextNodes(bubble) {
  const document = bubble.ownerDocument;
  const walker = document.createTreeWalker(bubble, TREE_WALKER_SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest(ROLELESS_TEXT_EXCLUSION_SELECTOR) == null
        ? TREE_WALKER_ACCEPT
        : TREE_WALKER_REJECT;
    },
  });
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  return nodes;
}

const ROLELESS_BLOCK_TAGS = new Set([
  'ADDRESS',
  'BLOCKQUOTE',
  'DIV',
  'DD',
  'DL',
  'DT',
  'FIELDSET',
  'FIGURE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'OL',
  'P',
  'PRE',
  'UL',
]);

// The dispatched body renders as one whole text node inside the bubble, so an
// exact projection is a per-node equality check; concatenated textContent
// would also pick up affordance labels rendered inside the bubble.
// Multi-paragraph bodies render as one text run per block element, so a
// second projection compares the per-block lines against the dispatched
// newline-separated lines without collapsing any whitespace.
function rolelessBubbleBlockLines(bubble) {
  const lines = new Map();
  for (const node of visibleUserBubbleTextNodes(bubble)) {
    let block = node.parentElement;
    while (block && block !== bubble && !ROLELESS_BLOCK_TAGS.has(block.tagName)) {
      block = block.parentElement;
    }
    const key = block ?? bubble;
    lines.set(key, (lines.get(key) ?? '') + node.data);
  }
  return [...lines.values()];
}

function rolelessBubbleHasExactText(bubble, expectedText) {
  if (visibleUserBubbleTextNodes(bubble).some((node) => node.data === expectedText)) return true;
  const expectedLines = expectedText.split('\n');
  const blockLines = rolelessBubbleBlockLines(bubble);
  return blockLines.length === expectedLines.length && blockLines.every((line, index) => line === expectedLines[index]);
}

function rolelessUserBubbles(document) {
  return [...document.querySelectorAll(ROLELESS_USER_BUBBLE_SELECTOR)];
}

function rolelessAssistantUnits(document) {
  return outermostMatches(document, ROLELESS_ASSISTANT_UNIT_SELECTOR);
}

function messageSequence(document) {
  const items = [];
  for (const element of document.querySelectorAll(USER_MESSAGE_SELECTOR)) {
    items.push({ role: 'user', lineage: 'legacy', element });
  }
  for (const element of rolelessUserBubbles(document)) {
    items.push({ role: 'user', lineage: 'roleless', element });
  }
  for (const element of document.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR)) {
    items.push({ role: 'assistant', lineage: 'legacy', element });
  }
  for (const element of rolelessAssistantUnits(document)) {
    items.push({ role: 'assistant', lineage: 'roleless', element });
  }
  items.sort((a, b) => {
    if (a.element === b.element) return 0;
    return a.element.compareDocumentPosition(b.element) & DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  return items;
}

function anchorElementFor(item) {
  if (item.lineage === 'roleless') {
    return item.element.closest('[data-content-search-unit-key]') ?? item.element;
  }
  return enclosingTurn(item.element);
}

function enclosingTurn(message) {
  return message.closest(MESSAGE_TURN_SELECTOR);
}

function hostMessageIdFor(message) {
  const owner = message.closest('[data-message-id]');
  const ownerId = owner?.getAttribute('data-message-id')?.trim();
  if (ownerId) return ownerId;

  const turn = enclosingTurn(message);
  if (!turn) return null;
  const candidates = [...turn.querySelectorAll('[data-message-id]')]
    .map((candidate) => candidate.getAttribute('data-message-id')?.trim())
    .filter(Boolean);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return null;

  const turnId = turn.getAttribute('data-testid')?.trim();
  if (!turnId || !SAFE_TURN_ID.test(turnId)) return null;
  const matchingTurns = [...message.ownerDocument.querySelectorAll(MESSAGE_TURN_SELECTOR)].filter(
    (candidate) => candidate.getAttribute('data-testid')?.trim() === turnId,
  );
  return matchingTurns.length === 1 ? turnId : null;
}

function renderedNodeHasExactText(node, expectedText) {
  const normalized = contentEditableText(node);
  const projections = normalized === null ? [node.innerText, node.textContent] : [normalized];
  return projections.some((value) => typeof value === 'string' && value === expectedText);
}

function renderedMessageHasExactText(message, expectedText) {
  const renderedContent = [...message.querySelectorAll(RENDERED_MESSAGE_CONTENT_SELECTOR)];
  if (renderedContent.length === 0) return renderedNodeHasExactText(message, expectedText);
  return renderedContent.length === 1 && renderedNodeHasExactText(renderedContent[0], expectedText);
}

export { ChatGptPageAdapterError };

function rolelessHostMessageDiagnostic(document, rolelessScan) {
  return {
    v: 1,
    legacyUserMessageCount: Math.min(document.querySelectorAll(USER_MESSAGE_SELECTOR).length, 1_000),
    rolelessUserBubbleCount: Math.min(rolelessScan.bubbles.length, 1_000),
    userBubbleTextExactMatchCount: Math.min(rolelessScan.matching.length, 1_000),
    ambiguousMatch: rolelessScan.matching.length > 1,
    hostIdExposed: rolelessScan.matching.some((bubble) => hostMessageIdFor(bubble) != null),
    nextAction: 'inspect_bound_tab',
  };
}

function legacyReceiptCandidate(document, existingIds, text) {
  for (const message of document.querySelectorAll(USER_MESSAGE_SELECTOR)) {
    const messageId = hostMessageIdFor(message);
    if (!messageId || existingIds.has(messageId)) continue;
    if (!renderedMessageHasExactText(message, text)) continue;
    return { hostMessageId: messageId, turn: enclosingTurn(message) };
  }
  return null;
}

function rolelessReceiptScan(document, existingIds, text) {
  const bubbles = rolelessUserBubbles(document);
  const matching = bubbles.filter((bubble) => rolelessBubbleHasExactText(bubble, text));
  const confirmed = matching
    .map((bubble) => ({ bubble, hostMessageId: hostMessageIdFor(bubble) }))
    .find((candidate) => candidate.hostMessageId && !existingIds.has(candidate.hostMessageId));
  return {
    bubbles,
    matching,
    receipt: confirmed
      ? {
          hostMessageId: confirmed.hostMessageId,
          turn: anchorElementFor({ role: 'user', lineage: 'roleless', element: confirmed.bubble }),
        }
      : null,
  };
}

function observeHostMessage({ document, MutationObserver, existingIds, text, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastRolelessScan = { bubbles: [], matching: [], receipt: null };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      observer.disconnect();
      callback();
    };
    const scan = () => {
      const legacy = legacyReceiptCandidate(document, existingIds, text);
      if (legacy) {
        finish(() => resolve(legacy));
        return;
      }
      lastRolelessScan = rolelessReceiptScan(document, existingIds, text);
      if (lastRolelessScan.receipt) {
        finish(() => resolve(lastRolelessScan.receipt));
      }
    };
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    const timer = setTimeout(() => {
      finish(() => {
        const diagnostic = rolelessHostMessageDiagnostic(document, lastRolelessScan);
        if (lastRolelessScan.matching.length > 0) {
          reject(
            new ChatGptPageAdapterError(
              'HOST_MESSAGE_ID_UNAVAILABLE',
              'ChatGPT exposed the dispatched user bubble without any Host-provided message identifier',
              diagnostic,
            ),
          );
          return;
        }
        const error = new ChatGptPageAdapterError(
          'HOST_MESSAGE_NOT_OBSERVED',
          'ChatGPT did not expose a new user message with one unique Host-provided turn identifier',
        );
        error.diagnostic = diagnostic;
        reject(error);
      });
    }, timeoutMs);
    scan();
  });
}

function messageRoleElements(turn) {
  const elements = [];
  if (turn.matches?.('[data-message-author-role]')) elements.push(turn);
  elements.push(...turn.querySelectorAll('[data-message-author-role]'));
  return elements;
}

function boundedAssistantText(message) {
  const raw = typeof message.innerText === 'string' ? message.innerText : message.textContent;
  const content = typeof raw === 'string' ? raw.trim() : '';
  if (!content || new TextEncoder().encode(content).byteLength > MAX_ASSISTANT_CONTENT_BYTES) return null;
  return content;
}

function assistantContentStatus(message) {
  const raw = typeof message?.innerText === 'string' ? message.innerText : message?.textContent;
  const content = typeof raw === 'string' ? raw.trim() : '';
  if (!content) return 'missing';
  return new TextEncoder().encode(content).byteLength > MAX_ASSISTANT_CONTENT_BYTES ? 'oversized' : 'present';
}

function causalAssistantCandidate(turn) {
  const roles = messageRoleElements(turn);
  if (roles.some((candidate) => candidate.matches(USER_MESSAGE_SELECTOR))) {
    return {
      error: new ChatGptPageAdapterError(
        'ASSISTANT_TURN_SUPERSEDED',
        'a later user turn appeared before the source-bound assistant final',
      ),
    };
  }
  const assistants = roles.filter((candidate) => candidate.matches(ASSISTANT_MESSAGE_SELECTOR));
  if (assistants.length === 0) return null;
  if (assistants.length !== 1) {
    return {
      error: new ChatGptPageAdapterError(
        'AMBIGUOUS_ASSISTANT_TURN',
        'the causal ChatGPT turn exposed multiple assistant message candidates',
      ),
    };
  }
  return { message: assistants[0] };
}

function uniqueAnchorItem(sequence, hostMessageId) {
  const matches = sequence.filter((item) => item.role === 'user' && hostMessageIdFor(item.element) === hostMessageId);
  const anchors = [...new Set(matches.map(anchorElementFor).filter((anchor) => anchor != null))];
  if (anchors.length !== 1) return null;
  return matches.find((item) => anchorElementFor(item) != null) ?? null;
}

function findCausalAssistantCandidate(document, hostMessageId) {
  const sequence = messageSequence(document);
  const anchorItem = uniqueAnchorItem(sequence, hostMessageId);
  if (!anchorItem) return null;
  const anchorIndex = sequence.indexOf(anchorItem);
  if (anchorIndex === -1) return null;
  for (let index = anchorIndex + 1; index < sequence.length; index += 1) {
    const item = sequence[index];
    if (item.role === 'user') {
      return {
        error: new ChatGptPageAdapterError(
          'ASSISTANT_TURN_SUPERSEDED',
          'a later user turn appeared before the source-bound assistant final',
        ),
      };
    }
    if (item.lineage === 'legacy') {
      const turn = anchorElementFor(item);
      const turnCandidate = causalAssistantCandidate(turn);
      if (turnCandidate?.error) return turnCandidate;
      if (!turnCandidate) continue;
      return { turn, message: turnCandidate.message };
    }
    return { turn: anchorElementFor(item), message: item.element };
  }
  return null;
}

function assistantHostIdStatusFor(assistantCandidates) {
  if (assistantCandidates.length === 0) return 'not_observed';
  return assistantCandidates.length === 1 && hostMessageIdFor(assistantCandidates[0])
    ? 'unique'
    : 'missing_or_ambiguous';
}

function assistantContentStatusFor(contentStatuses) {
  if (contentStatuses.includes('oversized')) return 'oversized';
  if (contentStatuses.includes('present')) return 'present';
  if (contentStatuses.includes('missing')) return 'missing';
  return 'not_observed';
}

function assistantObservationDiagnostic(document, userTurn, hostMessageId) {
  const sequence = messageSequence(document);
  const anchorItem = uniqueAnchorItem(sequence, hostMessageId);
  const anchorIndex = anchorItem ? sequence.indexOf(anchorItem) : -1;
  const followingItems = anchorIndex === -1 ? [] : sequence.slice(anchorIndex + 1);
  const assistantCandidates = followingItems.filter((item) => item.role === 'assistant').map((item) => item.element);
  const contentStatuses = assistantCandidates.map(assistantContentStatus);
  const anchorTurn = anchorItem?.lineage === 'legacy' ? anchorElementFor(anchorItem) : null;
  const turns = [...document.querySelectorAll(MESSAGE_TURN_SELECTOR)];
  const legacyAnchorIndex = anchorTurn ? turns.indexOf(anchorTurn) : -1;
  const followingTurns = legacyAnchorIndex === -1 ? [] : turns.slice(legacyAnchorIndex + 1);
  return {
    v: 1,
    userTurnConnected: (anchorItem?.element ?? userTurn)?.isConnected === true,
    anchorTurnFound: anchorIndex !== -1,
    followingTurnCount: Math.min(followingTurns.length, 1_000),
    assistantCandidateCount: Math.min(assistantCandidates.length, 1_000),
    rolelessAssistantUnitCount: Math.min(rolelessAssistantUnits(document).length, 1_000),
    laterUserTurnPresent: followingItems.some((item) => item.role === 'user'),
    assistantHostIdStatus: assistantHostIdStatusFor(assistantCandidates),
    assistantContentStatus: assistantContentStatusFor(contentStatuses),
    streamingControlPresent: assistantIsStreaming(document),
    turnMatchCount: Math.min(turns.length, 1_000),
    userMessageCount: Math.min(document.querySelectorAll(USER_MESSAGE_SELECTOR).length, 1_000),
    assistantMessageCount: Math.min(document.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR).length, 1_000),
  };
}

function observeCausalAssistantFinal({
  document,
  MutationObserver,
  timeoutMs,
  quietMs,
  requestId,
  conversationId,
  idempotencyKey,
  hostMessageId,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let assistantTurn = null;
    let assistantMessage = null;
    let quietTimer = null;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(quietTimer);
      observer.disconnect();
      callback();
    };
    const settleIfQuiet = () => {
      if (!assistantTurn || !assistantMessage) return;
      const content = boundedAssistantText(assistantMessage);
      const assistantMessageId = hostMessageIdFor(assistantMessage);
      if (!content || !assistantMessageId) return;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        const stableContent = boundedAssistantText(assistantMessage);
        const stableId = hostMessageIdFor(assistantMessage);
        if (stableContent !== content || stableId !== assistantMessageId || assistantIsStreaming(document)) {
          settleIfQuiet();
          return;
        }
        finish(() =>
          resolve({
            requestId,
            conversationId,
            idempotencyKey,
            hostMessageId,
            assistantMessageId,
            content,
          }),
        );
      }, quietMs);
    };
    const scan = () => {
      const candidate = findCausalAssistantCandidate(document, hostMessageId);
      if (!candidate) return;
      if (candidate.error) {
        finish(() => reject(candidate.error));
        return;
      }
      if (assistantTurn && assistantTurn !== candidate.turn) {
        const previousId = hostMessageIdFor(assistantMessage);
        const candidateId = hostMessageIdFor(candidate.message);
        if (previousId && candidateId && previousId !== candidateId) {
          finish(() =>
            reject(
              new ChatGptPageAdapterError(
                'AMBIGUOUS_ASSISTANT_TURN',
                'the causal ChatGPT assistant turn changed its Host-provided identifier during observation',
              ),
            ),
          );
          return;
        }
      }
      assistantTurn = candidate.turn;
      assistantMessage = candidate.message;
      settleIfQuiet();
    };
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    const timeoutTimer = setTimeout(() => {
      finish(() =>
        reject(
          new ChatGptPageAdapterError(
            'ASSISTANT_FINAL_NOT_OBSERVED',
            'ChatGPT did not expose one stable assistant final causally following the dispatched user turn',
          ),
        ),
      );
    }, timeoutMs);
    timeoutTimer.unref?.();
    scan();
  });
}

function requireMatchingConversation(location, conversationId, message) {
  if (conversationIdFromLocation(location) !== conversationId) {
    throw new ChatGptPageAdapterError('CONVERSATION_MISMATCH', message);
  }
}

function unsupportedComposerError({ code, message, composer, phase, adapterRevision, artifactRevision, path }) {
  const fingerprint = composerDomFingerprint(composer, {
    phase,
    adapterRevision,
    artifactRevision,
    firstUnsupportedPath: path,
  });
  return new ChatGptPageAdapterError(code, message, {
    v: 1,
    errorCode: code,
    fingerprint,
    nextAction: 'inspect_bound_tab',
  });
}

function requireEmptyComposer(document, revisions) {
  const composer = firstMatch(document, COMPOSER_SELECTORS);
  if (!composer) throw new ChatGptPageAdapterError('COMPOSER_NOT_FOUND', 'ChatGPT composer was not found');
  const current = composerTextResult(document, composer);
  if (current.status === 'unsupported') {
    throw unsupportedComposerError({
      code: 'COMPOSER_DOM_UNSUPPORTED',
      message: `ChatGPT composer contains an unsupported node at ${current.path}`,
      composer,
      phase: 'empty_check',
      ...revisions,
      path: current.path,
    });
  }
  if (current.text !== '') {
    throw new ChatGptPageAdapterError('COMPOSER_NOT_EMPTY', 'ChatGPT composer contains an owner draft');
  }
  return composer;
}

function existingUserMessageIds(document) {
  const legacyIds = [...document.querySelectorAll(USER_MESSAGE_SELECTOR)].map(hostMessageIdFor);
  const rolelessIds = rolelessUserBubbles(document).map(hostMessageIdFor);
  return new Set([...legacyIds, ...rolelessIds].filter(Boolean));
}

function requireSafeSubmissionState({
  document,
  location,
  composer,
  sendButton,
  conversationId,
  text,
  adapterRevision,
  artifactRevision,
}) {
  requireMatchingConversation(location, conversationId, 'bound conversation changed before ChatGPT submission');
  requireIdleComposer(document);
  const current = composerTextResult(document, composer);
  if (current.status === 'unsupported') {
    throw unsupportedComposerError({
      code: 'COMPOSER_DOM_UNSUPPORTED',
      message: `ChatGPT composer contains an unsupported node at ${current.path}`,
      composer,
      phase: 'before_submit',
      adapterRevision,
      artifactRevision,
      path: current.path,
    });
  }
  if (current.text !== text) {
    throw new ChatGptPageAdapterError('COMPOSER_CHANGED_BEFORE_SUBMIT', 'ChatGPT composer changed before submission');
  }
  if (
    !sendButton.isConnected ||
    sendButtonIsDisabled(sendButton) ||
    findSendButton(document, composer) !== sendButton
  ) {
    throw new ChatGptPageAdapterError(
      sendButtonIsDisabled(sendButton) ? 'SEND_BUTTON_DISABLED' : 'SEND_BUTTON_INVALID',
      'ChatGPT send button changed before submission',
    );
  }
}

async function submitPageMessage({
  document,
  location,
  MutationObserver,
  onProgress,
  observationTimeoutMs,
  sendButtonTimeoutMs,
  requestId,
  conversationId,
  text,
  idempotencyKey,
  adapterRevision,
  artifactRevision,
  assistantObservationTimeoutMs,
  assistantQuietMs,
  onAssistantFinal,
  onAssistantObservationFailure,
}) {
  requireMatchingConversation(location, conversationId, 'bound conversation does not match the current ChatGPT tab');
  const composer = requireEmptyComposer(document, { adapterRevision, artifactRevision });
  const snapshot = composerSnapshot(document, composer);
  const existingIds = existingUserMessageIds(document);
  let clicked = false;
  let mutated = false;
  try {
    requireIdleComposer(document);
    insertComposerText(document, composer, text, () => {
      mutated = true;
    });
    await onProgress('inserted', { requestId, conversationId, idempotencyKey });
    const sendButton = await waitForSendButton({
      document,
      composer,
      MutationObserver,
      timeoutMs: sendButtonTimeoutMs,
    });
    requireSafeSubmissionState({
      document,
      location,
      composer,
      sendButton,
      conversationId,
      text,
      adapterRevision,
      artifactRevision,
    });
    sendButton.click();
    clicked = true;
  } catch (error) {
    if (error instanceof ChatGptPageAdapterError && error.diagnostic === undefined) {
      error.diagnostic = {
        v: 1,
        errorCode: error.code,
        fingerprint: composerDomFingerprint(composer, {
          phase: 'failed_before_submit',
          adapterRevision,
          artifactRevision,
        }),
        nextAction: 'inspect_bound_tab',
      };
    }
    if (!clicked && mutated) restoreAfterNoSend(document, composer, snapshot);
    throw error;
  }
  await onProgress('submitted', { requestId, conversationId, idempotencyKey });
  const receipt = await observeHostMessage({
    document,
    MutationObserver,
    existingIds,
    text,
    timeoutMs: observationTimeoutMs,
  });
  await onProgress('host_observed', {
    requestId,
    conversationId,
    idempotencyKey,
    hostMessageId: receipt.hostMessageId,
  });
  void observeCausalAssistantFinal({
    document,
    MutationObserver,
    timeoutMs: assistantObservationTimeoutMs,
    quietMs: assistantQuietMs,
    requestId,
    conversationId,
    idempotencyKey,
    hostMessageId: receipt.hostMessageId,
  })
    .then(onAssistantFinal)
    .catch((error) =>
      onAssistantObservationFailure({
        requestId,
        conversationId,
        idempotencyKey,
        hostMessageId: receipt.hostMessageId,
        errorCode: typeof error?.code === 'string' ? error.code : 'PAGE_ADAPTER_FAILED',
        diagnostic: assistantObservationDiagnostic(document, receipt.turn, receipt.hostMessageId),
      }),
    )
    .catch(() => undefined);
  return { hostMessageId: receipt.hostMessageId };
}

export function createChatGptPageAdapter({
  document,
  location,
  MutationObserver,
  onProgress = () => undefined,
  observationTimeoutMs = 10_000,
  sendButtonTimeoutMs = 2_000,
  assistantObservationTimeoutMs = 120_000,
  assistantQuietMs = 750,
  onAssistantFinal = () => undefined,
  onAssistantObservationFailure = () => undefined,
  adapterRevision = 'unversioned',
  artifactRevision = 'unversioned',
}) {
  if (!document?.querySelector || !location || typeof MutationObserver !== 'function') {
    throw new ChatGptPageAdapterError('INVALID_ENVIRONMENT', 'document, location, and MutationObserver are required');
  }
  requireTimeout(observationTimeoutMs, 10, 60_000, 'observationTimeoutMs');
  requireTimeout(sendButtonTimeoutMs, 10, 10_000, 'sendButtonTimeoutMs');
  requireTimeout(assistantObservationTimeoutMs, 10, 300_000, 'assistantObservationTimeoutMs');
  requireTimeout(assistantQuietMs, 10, 10_000, 'assistantQuietMs');
  if (typeof onAssistantFinal !== 'function') {
    throw new ChatGptPageAdapterError('INVALID_ENVIRONMENT', 'onAssistantFinal must be a function');
  }
  if (typeof onAssistantObservationFailure !== 'function') {
    throw new ChatGptPageAdapterError('INVALID_ENVIRONMENT', 'onAssistantObservationFailure must be a function');
  }
  const completedByKey = new Map();
  const inFlightByKey = new Map();
  let appendTail = Promise.resolve();

  return {
    async appendMessage(rawRequest) {
      const requestId = requireExactString(rawRequest?.requestId, 'requestId', 200);
      const conversationId = requireExactString(rawRequest?.conversationId, 'conversationId', 200);
      if (!SAFE_CONVERSATION_ID.test(conversationId)) {
        throw new ChatGptPageAdapterError('INVALID_REQUEST', 'conversationId has an invalid format');
      }
      const text = requireContentString(rawRequest?.text);
      const idempotencyKey = requireExactString(rawRequest?.idempotencyKey, 'idempotencyKey', 512);
      const dedupeKey = `${conversationId}\u0000${idempotencyKey}`;
      const completed = completedByKey.get(dedupeKey);
      if (completed) return completed;
      const inFlight = inFlightByKey.get(dedupeKey);
      if (inFlight) return inFlight;

      const runAppend = async () => {
        const receipt = await submitPageMessage({
          document,
          location,
          MutationObserver,
          onProgress,
          observationTimeoutMs,
          sendButtonTimeoutMs,
          requestId,
          conversationId,
          text,
          idempotencyKey,
          adapterRevision,
          artifactRevision,
          assistantObservationTimeoutMs,
          assistantQuietMs,
          onAssistantFinal,
          onAssistantObservationFailure,
        });
        completedByKey.set(dedupeKey, receipt);
        return receipt;
      };
      const operation = appendTail.then(runAppend, runAppend);
      appendTail = operation;
      inFlightByKey.set(dedupeKey, operation);
      try {
        return await operation;
      } finally {
        inFlightByKey.delete(dedupeKey);
      }
    },
  };
}

export const CHATGPT_PAGE_ADAPTER_SELECTORS = Object.freeze({
  composer: [...COMPOSER_SELECTORS],
  sendButton: [...SEND_BUTTON_SELECTORS],
  userMessage: USER_MESSAGE_SELECTOR,
  assistantMessage: ASSISTANT_MESSAGE_SELECTOR,
  rolelessUserBubble: ROLELESS_USER_BUBBLE_SELECTOR,
  rolelessAssistantUnit: ROLELESS_ASSISTANT_UNIT_SELECTOR,
});
