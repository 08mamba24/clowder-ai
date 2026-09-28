#!/usr/bin/env python3
"""qoder L0 prompt `@token` -> 文件路径 改写扫描（只读，可复跑）。

用法: python3 review-notes/2026-09-28-qoder-at-token-scan-dsh.py
输出: 受影响 prompt 数 / 分母 / 去重 token 表 / 图片类 token。
口径: 只扫 `.cat-cafe/qoder-profiles/*/projects/*.jsonl` 的 `type=="user"` 记录
      （= CLI 自己存下的一份 prompt 副本），排除 logs/ 段。
"""
import collections
import glob
import json
import os
import re

PROFILE_GLOB = '.cat-cafe/qoder-profiles/**/*.jsonl'
PATH_TOKEN = re.compile(r'@[\w.@+-]+/[\w./@+-]+')
IMAGE_EXT = re.compile(r'\.(png|jpg|jpeg|gif|webp|svg|bmp)$', re.I)


def main() -> None:
    prompts = []  # (timestamp, session, hits, distinct)
    tokens = collections.Counter()
    images = collections.Counter()

    for path in sorted(glob.glob(PROFILE_GLOB, recursive=True)):
        if '/logs/' in path:
            continue
        base = os.path.basename(path)[:8]
        for line in open(path, encoding='utf-8', errors='replace'):
            if '@' not in line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get('type') != 'user':
                continue
            content = rec.get('message', {}).get('content')
            if not isinstance(content, str):
                continue
            hits = PATH_TOKEN.findall(content)
            prompts.append((rec.get('timestamp', ''), base, len(hits), len(set(hits))))
            for token in set(hits):
                tokens[token] += 1
                if IMAGE_EXT.search(token):
                    images[token] += 1

    prompts.sort()
    affected = [p for p in prompts if p[2] > 0]

    print(f'qoder user prompts (L0 copies) : {len(prompts)}')
    print(f'affected (contains path-like @token): {len(affected)}')
    if affected:
        print(f'first affected : {affected[0][0]}')
        print(f'last  affected : {affected[-1][0]}')
        print(f'tokens/prompt  : min {min(p[2] for p in affected)} '
              f'max {max(p[2] for p in affected)}')
    print(f'distinct tokens: {len(tokens)}')
    print('--- top tokens ---')
    for token, n in tokens.most_common(15):
        print(f'{n:4d}  {token}')
    print('--- image-extension tokens ---')
    for token, n in images.most_common():
        print(f'{n:4d}  {token}')
    if not images:
        print('(none)')


if __name__ == '__main__':
    main()
