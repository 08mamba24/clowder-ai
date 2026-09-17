#!/usr/bin/env node

/**
 * F317 Qoder shell-prefix boundary.
 *
 * Qoder invokes this executable with one fully assembled shell command.  The
 * memory MCP gets a read-only policy; every other invocation (including Bash)
 * gets the workspace policy.  Selection is exact: an arbitrary Bash command
 * cannot opt into the memory policy by containing the shim path.
 */

import { spawnSync } from 'node:child_process';

const requiredEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const unwrapSingleShellWord = (command) => {
  if (/^[A-Za-z0-9_./-]+$/.test(command)) return command;
  if (command.length >= 2 && command[0] === "'" && command.at(-1) === "'" && !command.slice(1, -1).includes("'")) {
    return command.slice(1, -1);
  }
  if (command.length >= 2 && command[0] === '"' && command.at(-1) === '"' && !/["$`\\]/.test(command.slice(1, -1))) {
    return command.slice(1, -1);
  }
  return null;
};

try {
  const command = process.argv[2];
  if (!command || process.argv.length !== 3 || command.includes('\0')) {
    throw new Error('expected exactly one non-empty shell command argument');
  }

  const sandboxBinary = requiredEnv('CAT_CAFE_QODER_SANDBOX_BIN');
  const workspacePolicy = requiredEnv('CAT_CAFE_QODER_WORKSPACE_POLICY');
  const memoryPolicy = requiredEnv('CAT_CAFE_QODER_MEMORY_POLICY');
  const memoryShim = requiredEnv('CAT_CAFE_QODER_MEMORY_SHIM');
  const selectedPolicy = unwrapSingleShellWord(command) === memoryShim ? memoryPolicy : workspacePolicy;

  const childEnv = { ...process.env };
  for (const key of [
    'CAT_CAFE_QODER_SANDBOX_BIN',
    'CAT_CAFE_QODER_WORKSPACE_POLICY',
    'CAT_CAFE_QODER_MEMORY_POLICY',
    'CAT_CAFE_QODER_MEMORY_SHIM',
    'QODERCN_CONFIG_DIR',
    'QODERCN_SHELL_PREFIX',
    'QODER_SHELL_PREFIX',
    'CLAUDE_CODE_SHELL_PREFIX',
  ]) {
    delete childEnv[key];
  }

  const result = spawnSync(sandboxBinary, ['-f', selectedPolicy, '/bin/sh', '-c', command], {
    env: childEnv,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) {
    process.kill(process.pid, result.signal);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
} catch (error) {
  process.stderr.write(`[qoder-shell-sandbox] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(126);
}
