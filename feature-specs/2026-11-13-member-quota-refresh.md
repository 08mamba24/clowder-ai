---
tips_exempt: "既有成员状态的自动只读更新，无新增用户动作、入口或设置；保留现有成员页引导。"
---

# 成员页额度状态自动刷新

授权：线程 `thread_mw9in3e11gpamynj` 中用户
`0001794562739066-000125-26dc56a2` 接受 120 所述方案，并安排 6.1 实现、5.6 勘察、宪宪审查。
Task：`0001794562890076-000141-be4405c4`。基线：`3b5e2132f8a83a54c9c0c1ada2b4dc27a15fb2e3`。

Architecture cell: routing-context（Web 读取投影）。
Map delta: none。
Why: 复用现有 snapshot API 与 apiFetch，只增加页面生命周期和本地时效投影，不新增架构所有者。

## 行为

- 可见页面挂载立即读取 `/api/routing-context/snapshot`，每次读取结束后再计 60 秒。
- 页面隐藏时取消下一次轮询；重新可见或获得焦点时立即读取。100ms 内的同次前台事件合并，隐藏后的重新可见不受此限制。
- 自动读取不与当前读取重叠；卸载时移除监听、计时器并取消该组件的等待。
- 公开 `refresh()` 保留写后读契约：复用 `apiFetch` 的 `afterCurrentGet` 队列，等待当前 GET 后的新一代结果。
- 各挂载实例独立调度；同一波在途 GET 由现有客户端合并。错开挂载的实例不承诺只有一次物理请求，也没有新增全局缓存或请求池。
- 请求失败保留旧数据和错误；重试开始不会清除错误。只有最新请求成功才能更新本组件的数据。

## 额度时效

成员列表、详情和共用成员投影的资料卡按额度事实计算时效，HTTP/read-model 的生成时间不会续期采样。
截止时间取 `capacityFacts.current.validUntil`、`observedAt + 120s` 和窗口 `resetAt` 的最早值。
缺失采样证明、未来采样或 unknown 显示未确认；过期样本显示未确认并解释正在等待新数据。
独立的人工/健康限制仍按原成员投影显示，不会因额度过期被隐藏。
本地截止计时器使样本在下一次 HTTP 返回前就能过期。

## 边界

只修改 Web 读取、生命周期、时效投影和文案。API 继续只读现有缓存；页面不调用 MCP、provider 或 usage-monitor 采集，也不创建任务来刷新。
已验收的 quota-only dispatch preflight、账号绑定、全局 availability 退役和终态回流保持原契约。
浏览器本机时间用于现有绝对期限比较；本次没有新增客户端时钟校正机制。

## 验证入口

```sh
NODE_ENV=test pnpm --filter @cat-cafe/web exec vitest run \
  src/components/routing-context/__tests__ \
  src/components/members/__tests__ \
  src/components/cat-profile-card/__tests__ \
  src/utils/__tests__/api-client-get-coordination.test.ts
pnpm --filter @cat-cafe/web exec tsc --noEmit
pnpm --filter @cat-cafe/web run test:browser:member-quota-refresh
```

测试包含可见/隐藏与 focus、慢请求节奏、错误保留、写后读取、StrictMode/卸载、真实 apiFetch 多实例合并及来源 TTL。
浏览器使用真实 SettingsShell → MemberListPage → MemberTable，网络和额度数据为隔离 fixture，覆盖桌面中文和窄屏英文深色。
它验证缓存变化、自动轮询、本地过期与前台刷新，不代表真实 provider 采集或线上新版本已经加载。
独立 review、精确 HEAD、检查结果及运行加载证据记入原 Task。
