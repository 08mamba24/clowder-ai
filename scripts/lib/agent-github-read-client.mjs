import { lstatSync, readFileSync } from 'node:fs';

function unsupported() {
  throw new Error('unsupported_query');
}

/** No shell evaluation: only literal words, with optional simple quotes. */
export function parseGhReadCommand(command, guardedGhPath) {
  const first = command
    .trim()
    .split(/\s/, 1)[0]
    .replace(/^['"]|['"]$/g, '');
  if (first !== 'gh' && first !== guardedGhPath) return null;
  if (command.length > 4096 || /[\r\n\0;$`\\&|<>(){}[\]*?!#]/.test(command)) unsupported();
  const words = [];
  const pattern = /\s*(?:'([^']*)'|"([^"]*)"|([^\s'"]+))/gy;
  let position = 0;
  while (position < command.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(command);
    if (!match) {
      if (command.slice(position).trim()) unsupported();
      break;
    }
    words.push(match[1] ?? match[2] ?? match[3]);
    position = pattern.lastIndex;
    if (position < command.length && !/\s/.test(command[position])) unsupported();
  }
  const positional = [];
  const flags = new Map();
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (!word.startsWith('-')) {
      positional.push(word);
      continue;
    }
    const match = /^(--repo|--state|--limit)(?:=(.*))?$/.exec(word) ?? /^(-R)(.*)$/.exec(word);
    if (!match) unsupported();
    const key = match[1] === '-R' ? '--repo' : match[1];
    const inline = match[1] === '-R' ? match[2]?.replace(/^=/, '') : match[2];
    const value = inline || words[++i];
    if (!value || flags.has(key)) unsupported();
    flags.set(key, value);
  }
  const repo = flags.get('--repo');
  if (!repo || !/^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo)) unsupported();
  const [subject, verb, number] = positional;
  const op = `${subject}_${verb}`;
  if (!['pr_view', 'pr_diff', 'pr_checks', 'pr_list', 'issue_view', 'issue_list', 'run_view', 'run_list'].includes(op))
    unsupported();
  if (verb === 'list') {
    if (positional.length !== 2) unsupported();
    const limit = flags.get('--limit') ?? '20';
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 50) unsupported();
    if (subject === 'run') {
      if (flags.has('--state')) unsupported();
      return { op, repo: repo.toLowerCase(), limit: Number(limit) };
    }
    const state = flags.get('--state') ?? 'open';
    if (!(subject === 'pr' ? ['open', 'closed', 'merged', 'all'] : ['open', 'closed', 'all']).includes(state))
      unsupported();
    return { op, repo: repo.toLowerCase(), state, limit: Number(limit) };
  }
  if (
    positional.length !== 3 ||
    flags.size !== 1 ||
    !/^[1-9]\d*$/.test(number ?? '') ||
    !Number.isSafeInteger(Number(number))
  )
    unsupported();
  return { op, repo: repo.toLowerCase(), [subject === 'run' ? 'runId' : 'number']: Number(number) };
}

/** Called only by the trusted shell-prefix process, before entering Seatbelt. */
export async function queryGitHubRead(configPath, query) {
  const stat = lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 4096)
    throw new Error('capability_unavailable');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const url = new URL(config.queryUrl);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/api/agent-github-read' ||
    url.search ||
    url.hash ||
    !/^[A-Za-z0-9_-]{43}$/.test(config.token)
  )
    throw new Error('capability_unavailable');
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(16_000),
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(query),
  });
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 6_300_000) throw new Error('output_limit');
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!result || typeof result.ok !== 'boolean') throw new Error('unavailable');
  return result;
}
