import { z } from 'zod';

const repository = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/)
  .max(200)
  .refine((value) => !['.', '..'].includes(value.split('/')[1]))
  .transform((value) => value.toLowerCase());
const number = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const limit = z.number().int().min(1).max(50);
export const ghReadQuerySchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('pr_view'), repo: repository, number }).strict(),
  z.object({ op: z.literal('pr_diff'), repo: repository, number }).strict(),
  z.object({ op: z.literal('pr_checks'), repo: repository, number }).strict(),
  z.object({ op: z.literal('issue_view'), repo: repository, number }).strict(),
  z
    .object({ op: z.literal('pr_list'), repo: repository, state: z.enum(['open', 'closed', 'merged', 'all']), limit })
    .strict(),
  z.object({ op: z.literal('issue_list'), repo: repository, state: z.enum(['open', 'closed', 'all']), limit }).strict(),
  z.object({ op: z.literal('run_view'), repo: repository, runId: number }).strict(),
  z.object({ op: z.literal('run_list'), repo: repository, limit }).strict(),
]);
export type GhReadQuery = z.infer<typeof ghReadQuerySchema>;
export type GhReadFailure =
  | 'capability_unavailable'
  | 'scope_denied'
  | 'invocation_ended'
  | 'unsupported_query'
  | 'authentication_required'
  | 'permission_denied'
  | 'rate_limited'
  | 'not_found'
  | 'timeout'
  | 'output_limit'
  | 'cancelled'
  | 'stale_head'
  | 'unavailable';
export interface GhReadProvenance {
  repository: string;
  operation: GhReadQuery['op'];
  observedAt: string;
  sourceUrl: string;
  headSha?: string;
  truncated: boolean;
}

const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const item = z.object({
  number,
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  url: z.string().url(),
  updatedAt: z.string(),
});
const pull = item.extend({ headRefOid: sha, isDraft: z.boolean() });
const issue = item.extend({ state: z.enum(['OPEN', 'CLOSED']) });
const run = z.object({
  databaseId: number,
  displayTitle: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  headSha: sha,
  url: z.string().url(),
  workflowName: z.string(),
});
const check = z.object({
  name: z.string(),
  state: z.string(),
  bucket: z.enum(['pass', 'fail', 'pending', 'skipping', 'cancel']),
  workflow: z.string(),
  link: z.string(),
});
export const ghReadHeadSchema = z.object({ headRefOid: sha, baseRefOid: sha });
export const GH_READ_HEAD_FIELDS = 'headRefOid,baseRefOid';
const ITEM_FIELDS = 'number,title,state,url,updatedAt';
const PULL_FIELDS = `${ITEM_FIELDS},headRefOid,isDraft`;
const RUN_FIELDS = 'databaseId,displayTitle,status,conclusion,headSha,url,workflowName';

const operations = {
  pr_view: { command: ['pr', 'view'], fields: `${PULL_FIELDS},body`, schema: pull.extend({ body: z.string() }) },
  pr_list: { command: ['pr', 'list'], fields: PULL_FIELDS, schema: z.array(pull) },
  pr_diff: { command: ['pr', 'diff'], fields: '', schema: z.string() },
  pr_checks: { command: ['pr', 'checks'], fields: 'name,state,bucket,workflow,link', schema: z.array(check) },
  issue_view: { command: ['issue', 'view'], fields: `${ITEM_FIELDS},body`, schema: issue.extend({ body: z.string() }) },
  issue_list: { command: ['issue', 'list'], fields: ITEM_FIELDS, schema: z.array(issue) },
  run_view: { command: ['run', 'view'], fields: RUN_FIELDS, schema: run },
  run_list: { command: ['run', 'list'], fields: RUN_FIELDS, schema: z.array(run) },
} as const;

export function ghReadArgs(query: GhReadQuery): string[] {
  const op = operations[query.op];
  const args: string[] = [...op.command];
  if ('number' in query) args.push(String(query.number));
  if ('runId' in query) args.push(String(query.runId));
  args.push('--repo', `github.com/${query.repo}`);
  if ('state' in query) args.push('--state', query.state);
  // One lookahead establishes truncation without unbounded pagination.
  if ('limit' in query) args.push('--limit', String(query.limit + 1));
  if (query.op === 'pr_diff') args.push('--color', 'never');
  else args.push('--json', op.fields);
  return args;
}

export type GhReadData =
  | z.infer<(typeof operations)[keyof typeof operations]['schema']>
  | { state: 'unknown' | 'pass' | 'fail' | 'pending'; checks: z.infer<typeof check>[] };
export type GhReadResult =
  | { ok: true; data: GhReadData; provenance: GhReadProvenance }
  | { ok: false; code: GhReadFailure; retryable: boolean };

export function projectGhRead(
  query: GhReadQuery,
  stdout: string,
): { data: GhReadData; truncated: boolean; headSha?: string } {
  const data = operations[query.op].schema.parse(query.op === 'pr_diff' ? stdout : JSON.parse(stdout));
  if (query.op === 'pr_checks') {
    const checks = z.array(check).parse(data);
    return { data: { state: checksState(checks), checks }, truncated: false };
  }
  if ('limit' in query && Array.isArray(data))
    return { data: data.slice(0, query.limit), truncated: data.length > query.limit };
  let headSha: string | undefined;
  if (typeof data === 'object' && data !== null && 'headRefOid' in data) headSha = data.headRefOid;
  if (typeof data === 'object' && data !== null && 'headSha' in data) headSha = data.headSha;
  return { data, truncated: false, headSha };
}

function checksState(checks: z.infer<typeof check>[]): 'unknown' | 'pass' | 'fail' | 'pending' {
  if (checks.some((c) => c.bucket === 'fail' || c.bucket === 'cancel')) return 'fail';
  if (checks.some((c) => c.bucket === 'pending')) return 'pending';
  if (checks.some((c) => c.bucket === 'pass')) return 'pass';
  return 'unknown';
}

export function ghReadSourceUrl(query: GhReadQuery): string {
  const base = `https://github.com/${query.repo}`;
  if (query.op.startsWith('pr_')) return 'number' in query ? `${base}/pull/${query.number}` : `${base}/pulls`;
  if (query.op.startsWith('issue_')) return 'number' in query ? `${base}/issues/${query.number}` : `${base}/issues`;
  return 'runId' in query ? `${base}/actions/runs/${query.runId}` : `${base}/actions`;
}
