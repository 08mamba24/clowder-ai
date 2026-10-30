import { readlinkSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { shellInvocation } from './native-effect-shell-tokenizer.mjs';
import { classifyNativeTarget } from './native-effect-target-classifier.mjs';

const API_VALUES = new Map([
  ['--method', 'method'],
  ['-X', 'method'],
  ['--field', 'field'],
  ['-F', 'field'],
  ['--raw-field', 'field'],
  ['-f', 'field'],
  ['--header', 'header'],
  ['-H', 'header'],
  ['--jq', 'format'],
  ['-q', 'format'],
  ['--template', 'format'],
  ['-t', 'format'],
  ['--preview', 'preview'],
  ['-p', 'preview'],
  ['--hostname', 'hostname'],
]);
const API_FLAGS = new Set(['--include', '-i', '--paginate', '--silent', '--slurp', '--verbose']);

const GRAPHQL_VALUES = new Map([
  ['-f', 'raw'],
  ['--raw-field', 'raw'],
  ['--field', 'typed'],
  ['-F', 'typed'],
  ['--jq', 'format'],
  ['-q', 'format'],
  ['--template', 'format'],
  ['-t', 'format'],
  ['--hostname', 'hostname'],
  ['--preview', 'preview'],
  ['-p', 'preview'],
]);

/**
 * GraphQL documents carry their own semantics, so the HTTP verb says nothing.
 * A word-boundary scan over the RAW document is the only mutation detector:
 * regex comment deletion cannot tell a `#` inside a GraphQL string from a real
 * comment, and deleting text is exactly how a selected mutation once vanished.
 * Consequence: `mutation`/`subscription` mentioned anywhere — including string
 * data or comments — conservatively yields a remote mutation; a document is a
 * read only when it mentions neither and opens with `query`/`{` verbatim.
 */
function graphqlDocumentEffect(document) {
  if (/\b(?:mutation|subscription)\b/.test(document)) return 'remote_mutation';
  const prologue = document.trimStart();
  return prologue.startsWith('query') || prologue.startsWith('{') ? 'read' : 'remote_mutation';
}

/**
 * Completeness of the shell parse already proves every word is literal data:
 * unquoted `$`, backticks, and `$(...)` make the parse incomplete. Within that
 * proof only gh's own typed `-F/--field` channel stays closed — its `@file`
 * prefix would attach local file contents to the request.
 */
function constrainedGhGraphqlOperation(tokens) {
  let query;
  for (let index = 3; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--help' || token === '-h') return { effect: 'read', target: 'github://api/help' };
    if (API_FLAGS.has(token)) continue;
    const equals = token.indexOf('=');
    const attached = !token.startsWith('--') && token.length > 2;
    const flag = attached ? token.slice(0, 2) : equals < 0 ? token : token.slice(0, equals);
    const role = GRAPHQL_VALUES.get(flag);
    if (!role) return null;
    const value = attached ? token.slice(2) : equals < 0 ? tokens[++index] : token.slice(equals + 1);
    if (value === undefined) return null;
    if (role !== 'raw' && role !== 'typed') continue;
    const separator = value.indexOf('=');
    if (separator <= 0) return null;
    const name = value.slice(0, separator);
    const body = value.slice(separator + 1);
    if (role === 'typed' && body.startsWith('@')) return null;
    if (name === 'query') {
      if (query !== undefined) return null;
      query = body;
    }
  }
  if (query === undefined) return null;
  return { effect: graphqlDocumentEffect(query), target: 'github://api/graphql' };
}

export function constrainedGhApiOperation(raw) {
  const parsed = shellInvocation(raw);
  if (!parsed.complete || parsed.redirections.length) return null;
  const tokens = parsed.words.map(({ value }) => value);
  if (tokens[0] !== 'gh' || tokens[1] !== 'api') return null;
  if (tokens[2] === 'graphql') return constrainedGhGraphqlOperation(tokens);
  let method,
    fields = false,
    endpoint;
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('-')) {
      if (endpoint) return null;
      endpoint = token;
      continue;
    }
    if (token === '--help' || token === '-h') return endpoint ? null : { effect: 'read', target: 'github://api/help' };
    if (API_FLAGS.has(token)) continue;
    const equals = token.indexOf('=');
    const attached = !token.startsWith('--') && token.length > 2;
    const flag = attached ? token.slice(0, 2) : equals < 0 ? token : token.slice(0, equals);
    const role = API_VALUES.get(flag);
    if (!role) return null;
    const value = attached ? token.slice(2) : equals < 0 ? tokens[++index] : token.slice(equals + 1);
    if (value === undefined) return null;
    if (role === 'method') method = value.toUpperCase();
    if (role === 'field') {
      // gh's typed -F/--field channel reads local files (@path) and stdin (@-)
      // into the request; the REST read fast path must not certify a command
      // with unproved local inputs. Raw -f/--raw-field values stay literal.
      if (flag === '--field' || flag === '-F') {
        const separator = value.indexOf('=');
        const body = separator < 0 ? value : value.slice(separator + 1);
        if (body.startsWith('@')) return null;
      }
      fields = true;
    }
  }
  if (!endpoint || !['GET', 'HEAD'].includes(method ?? (fields ? 'POST' : 'GET'))) return null;
  return { effect: 'read', target: `github://api/${endpoint}` };
}

/** `gh help [topics]` prints CLI documentation offline; flags and paths stay unrecognized. */
export function constrainedGhHelpOperation(raw) {
  const parsed = shellInvocation(raw);
  if (!parsed.complete || parsed.redirections.length) return null;
  const tokens = parsed.words.map(({ value }) => value);
  if (tokens[0] !== 'gh' || tokens[1] !== 'help') return null;
  if (tokens.slice(2).some((topic) => !/^[a-z][a-z0-9-]*$/.test(topic))) return null;
  return { effect: 'read', target: 'github://cli/help' };
}

export function isConstrainedGhPullRequestRead(raw) {
  return constrainedGhPullRequestOperation(raw)?.effect === 'read';
}

/**
 * Parse GitHub PR operations whose effect and remote target are structurally known.
 * Matching this narrow shape assigns the remote coordinate; it is not a global
 * allow/deny list. Unmatched shapes retain normal cwd/target classification, while
 * task custody, review, merge-gate, and operator boundaries remain authoritative.
 */
export function constrainedGhPullRequestOperation(raw) {
  // The PR entry shares the graphql/api/help proof standard: shellInvocation
  // completeness means every argv word is literal. A brace or glob word is not
  // literal (the shell rewrites the argv it came from), so the classified shape
  // can never diverge from the executed one; quoted braces/globs stay data.
  const parsed = shellInvocation(raw);
  if (!parsed.complete || parsed.redirections.length) return null;
  const tokens = parsed.words.map(({ value }) => value);
  if (tokens[0] !== 'gh' || tokens[1] !== 'pr') return null;
  const invocation = parseGhPullRequestInvocation(tokens);
  if (!invocation) return null;
  const flags = parseConstrainedGhFlags(
    tokens.slice(invocation.flagIndex),
    ghPullRequestFlagContract(invocation.subcommand),
  );
  if (!flags || !hasResolvableGhPullRequestCoordinate(invocation.subcommand, flags)) return null;

  const repo = flags.get('--repo');
  const repository = typeof repo === 'string' ? repo : 'current';
  const mutating = ['merge', 'close', 'create'].includes(invocation.subcommand);
  return {
    effect: mutating ? 'remote_mutation' : 'read',
    target: `github://${repository}/${invocation.pullNumber ? `pull/${invocation.pullNumber}` : 'pulls'}`,
  };
}

function parseGhPullRequestInvocation(tokens) {
  const subcommand = tokens[2] === 'new' ? 'create' : tokens[2];
  if (!['view', 'checks', 'list', 'merge', 'close', 'create'].includes(subcommand)) return null;
  if (subcommand === 'list') return { subcommand, flagIndex: 3 };
  if (subcommand === 'create') return { subcommand, flagIndex: 3 };
  const pullNumber = tokens[3];
  const hasValidPullNumber =
    subcommand === 'close' ? /^[1-9]\d*$/.test(pullNumber ?? '') : /^\d+$/.test(pullNumber ?? '');
  return hasValidPullNumber ? { subcommand, pullNumber, flagIndex: 4 } : null;
}

function hasResolvableGhPullRequestCoordinate(subcommand, flags) {
  if (subcommand !== 'merge') return true;
  return flags.has('--squash') && (!flags.has('--admin') || flags.has('--match-head-commit'));
}

function ghPullRequestFlagContract(subcommand) {
  if (subcommand === 'view') {
    return { booleans: new Set(['--comments']), values: new Set(['--repo', '-R', '--json', '--jq', '--template']) };
  }
  if (subcommand === 'list') {
    return {
      booleans: new Set(['--draft']),
      values: new Set([
        '--repo',
        '-R',
        '--app',
        '--assignee',
        '--author',
        '--base',
        '--head',
        '--json',
        '--jq',
        '--label',
        '--limit',
        '--search',
        '--state',
        '--template',
      ]),
    };
  }
  if (subcommand === 'create') {
    return {
      booleans: new Set(['--draft', '--fill', '--fill-first', '--no-maintainer-edit', '--verbose']),
      values: new Set([
        '--repo',
        '-R',
        '--title',
        '-t',
        '--body',
        '-b',
        '--body-file',
        '-F',
        '--base',
        '-B',
        '--head',
        '-H',
        '--assignee',
        '-a',
        '--reviewer',
        '-r',
        '--label',
        '-l',
        '--project',
        '-p',
        '--milestone',
        '-m',
      ]),
    };
  }
  if (subcommand === 'merge') {
    return {
      booleans: new Set(['--admin', '--delete-branch', '-d', '--squash', '-s']),
      values: new Set(['--repo', '-R', '--match-head-commit']),
    };
  }
  if (subcommand === 'close') {
    return { booleans: new Set(), values: new Set(['--repo', '-R']) };
  }
  return {
    booleans: new Set(['--required', '--watch', '--fail-fast']),
    values: new Set(['--repo', '-R', '--json', '--jq', '--template', '--interval']),
  };
}

function parseConstrainedGhFlags(tokens, contract) {
  const parsed = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const flag = tokens[index];
    const normalized = normalizeGhFlag(flag);
    if (parsed.has(normalized)) return null;
    if (contract.booleans.has(flag)) {
      parsed.set(normalized, true);
      continue;
    }
    const value = tokens[index + 1];
    if (!contract.values.has(flag) || value === undefined || !isValidGhFlagValue(normalized, value)) return null;
    parsed.set(normalized, value);
    index += 1;
  }
  return parsed;
}

function normalizeGhFlag(flag) {
  // Aliases normalize to one semantic role BEFORE duplicate detection and
  // value validation run, so `-F x` can neither dodge `--body-file`'s file
  // proof nor slip past a repeated-option check as a different key.
  const ALIASES = {
    '-R': '--repo',
    '-d': '--delete-branch',
    '-s': '--squash',
    '-F': '--body-file',
    '-t': '--title',
    '-b': '--body',
    '-B': '--base',
    '-H': '--head',
    '-a': '--assignee',
    '-r': '--reviewer',
    '-l': '--label',
    '-p': '--project',
    '-m': '--milestone',
  };
  return ALIASES[flag] ?? flag;
}

/**
 * The OS descriptor namespace — /dev/fd/N, /dev/stdin and friends,
 * /proc/self/fd/N — names THIS process's open file descriptors by construction:
 * the same path is a different file depending on which process resolves it.
 * That is an input ORIGIN, not a named on-disk file, so it never earns the
 * named-file proof — even when the descriptor happens to be backed by a
 * regular file.
 */
const DESCRIPTOR_NAMESPACE_PATH =
  /^(?:\/dev\/(?:fd\/\d+|stdin|stdout|stderr)|\/proc\/(?:self|thread-self|\d+)(?:\/task\/\d+)?\/fd\/\d+)$/;

/** The descriptor-namespace membership test, exported for cross-platform regression:
 * Linux thread/task forms (/proc/thread-self, /proc/PID/task/TID) cannot be
 * exercised from a darwin host, so the boundary itself is unit-tested. */
export const isDescriptorNamespacePath = (value) => DESCRIPTOR_NAMESPACE_PATH.test(value);

/**
 * Resolve <value> with kernel-equivalent sequencing: raw segments (including
 * '.' and '..') are processed one at a time against a stack of PHYSICALLY
 * resolved components, and a symlink expansion happens BEFORE any later '..'
 * applies — a relative target's dot segments are never folded lexically, so
 * `middle/../body.md` through a symlinked `middle` cannot swap a protected
 * physical source for an ordinary-looking path. The descriptor namespace is
 * checked at EVERY accumulated component (Linux /proc/<pid>/fd/N is itself a
 * symlink to the open file; dot segments like /proc/self/./fd/0 defeat
 * anchored literal checks). Unprovable topology — missing component, unreadable
 * link, hop or segment limits, '..' above the root — returns null:
 * conservative unknown, never a speculative fallback.
 */
function resolvePathWithoutDescriptorTraversal(value) {
  let queue = value.split('/');
  let stack = [];
  let hops = 0;
  let processed = 0;
  while (queue.length > 0) {
    processed += 1;
    if (hops > 40 || processed > 512) return null;
    const part = queue.shift();
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    const current = `/${[...stack, part].join('/')}`;
    if (DESCRIPTOR_NAMESPACE_PATH.test(current)) return null;
    let link;
    try {
      link = readlinkSync(current);
    } catch (error) {
      if (error.code === 'EINVAL') {
        stack.push(part);
        continue;
      }
      return null;
    }
    hops += 1;
    // Both branches keep the unconsumed suffix: an absolute directory alias
    // (alias -> /abs/named) still owns the rest of the input path after it.
    queue = [...link.split('/'), ...queue];
    if (isAbsolute(link)) stack = [];
  }
  return stack.length === 0 ? '/' : `/${stack.join('/')}`;
}

/**
 * Contract for `gh pr create --body-file <path>` — one local read feeding a
 * remote publication, proven as:
 * 1. an ordinary NAMED file that exists on disk — the literal path and the
 *    fully traversed resolution both classify as ordinary in the target model
 *    (any cat-cafe-runtime component, runtime branch, or Redis 6399 refuses);
 * 2. never a process stdin/handle/descriptor origin — descriptor-namespace
 *    paths are refused as the literal value AND at every intermediate hop of
 *    the resolution, because they name this process's descriptors by
 *    construction; a symlink chain through one is refused with it;
 * 3. unresolvable when resolution fails (missing component, dangling symlink,
 *    hop limit) — no speculative fallback for not-yet-created inputs.
 * The proven node must additionally be a regular file, so devices and other
 * node types are excluded by type rather than by name. Relative paths and
 * gh's `-` stdin form stay unrecognized, keeping the conservative path.
 */
function isReadableOrdinaryBodyFile(value) {
  if (!isAbsolute(value) || value === '-') return false;
  if (DESCRIPTOR_NAMESPACE_PATH.test(value)) return false;
  const kind = (path) => classifyNativeTarget(path, undefined, 'read').kind;
  if (kind(value) !== 'ordinary') return false;
  const real = resolvePathWithoutDescriptorTraversal(value);
  if (real === null || kind(real) !== 'ordinary') return false;
  try {
    return statSync(real).isFile();
  } catch {
    return false;
  }
}

function isValidGhFlagValue(flag, value) {
  if (flag === '--repo') return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
  if (flag === '--interval') return /^\d+$/.test(value);
  if (flag === '--limit') return /^[1-9]\d*$/.test(value);
  if (flag === '--state') return ['open', 'closed', 'merged', 'all'].includes(value);
  if (flag === '--match-head-commit') return /^[0-9a-f]{40,64}$/i.test(value);
  if (flag === '--body-file') return isReadableOrdinaryBodyFile(value);
  // PR text values are literal argv words (the tokenizer already rejected real
  // substitutions); the file-backed body is governed by isReadableOrdinaryBodyFile.
  return true;
}
