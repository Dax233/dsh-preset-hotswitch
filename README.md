# dsh-preset-hotswitch · 预设热切换

一个只做一件事的 DeepSeek Harness 插件：让**已经聊到一半的会话**热切换到另一个 Agent 预设
（比如 `cordis` 创造模式），不用新开会话。

> **实验性**：`recompose()` 是 registry 的公开服务方法，但其自述契约是"重新绑定空白 Agent，
> 由调用方负责空白检查"。本插件**刻意跳过**这个检查，依赖 DSH `0.2.1-rc.3` 的实现细节；
> 升级 DSH 后可能失效（失效会以普通工具错误返回，不会改坏会话）。介意的话先在新会话里验证。

## 为什么需要它

官方 UI 只在**空白会话**（发出第一条消息之前）允许切换 preset。会话一旦开始，
`agentPresets.select()` 会以 `agent-preset/locked` 拒绝，registry 的设计是"组合在会话创建时确定"。

但实际使用里，经常是聊到一半才发现需要另一套工具面/提示词：

- 普通会话里忽然要写插件 → 想切到 `cordis`；
- 在 `cordis` 里做完插件开发 → 想切回 `standard` 继续日常任务；
- 临时想用 `minimal` / `ptc` 控制上下文与工具暴露面。

本插件用 registry 的公开服务方法 `agentPresets.recompose()` 重新绑定会话的组合
（它的 JSDoc 自述"由调用方负责空白检查"——本插件正是刻意跳过该检查的调用方），
再写入 `agent-preset/selected` 会话事件，让 registry 的 `agentPreset` 投影在恢复会话时重放这次选择
—— 重启 DSH 后仍然保持。

## 安装

```sh
dsh plugin --profile desktop add github:Dax233/dsh-preset-hotswitch
```

装完**重启 DSH Desktop**。Host-only bundle，没有额外依赖，不改任何 profile 配置。

要求 DSH `0.2.1-rc.3`（提供 `agentPresets` 服务）；DSH 升级后请按上面的实现说明重新核对
`recompose` / `composedPreset` / `list` 的契约。

## 工具

### `switch_session_preset`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `preset` | 否 | 目标 preset id。不传时只报告当前绑定与可用 id，不切换 |

- **不传 `preset`**：返回本会话的 `current` 与可用 `presets` 列表。
- **传 `preset`**：把**调用本工具的会话**重新绑定到目标预设，返回切换前后的 id；
  工具组合与提示词段落从**下一次请求**开始生效。
- 目标与当前相同时是 no-op；目标不存在、激活失败或记录失败时返回 `ok: false` 与原因，
  目标不存在时还会带上当前可用的 preset id 列表。

示例输出：

```json
{"session":"session-233741f7","current":"ptc","presets":["standard","ptc","minimal","cordis"]}
```

```text
switched session session-233741f7: ptc -> cordis (effective on the next request)
```

## 生效与持久化

- `recompose()` 立即重新绑定组合，并触发 `tools/change`；当前正在执行的请求仍用旧组合，
  下一次请求才用新组合（工具面、系统提示段落、skill 目录都会随之变化）。
- 插件随后 `append('agent-preset/selected', { agentPreset })`。registry 的 `agentPreset`
  会话投影会重放该事件，因此**会话恢复/重启后保持新预设**。
- 会话创建头里的 `agentPreset` 是创建事实，不会被改写；选择记录只以事件形式追加。

## 限制与注意事项

- 只影响**调用工具的当前会话**（工具运行上下文里的 `exec.agent`），不会改默认预设，
  也不会批量影响其它会话。
- **子 agent（subagent）会话会被拒绝**：子会话的组合继承自委派它的父会话，不应从内部重绑定；
  父会话切换后，已有子会话保留旧组合，之后新建的子会话才继承新预设。
- 目标预设必须存在且可挂载；不存在或激活失败时会返回错误（含错误码、原因与可用 id），
  会话保持原绑定。
- 切换后目标预设没有你需要的工具，是预设组合差异，不是切换失败；随时可以再切回来。
- **同一 preset id 的新 revision 不会刷新**：no-op 判断只比较 id。修改了 preset 定义后，
  当前会话再次调用本工具不会重新挂载；请重启 DSH 或新开会话。
- **`ptc` 组合下的工具面不同**：ptc 模式只允许直接调用 `run_code`，本工具需要在 `run_code`
  程序内调用（`tools.switch_session_preset({ preset })`）；切回其它组合后恢复直接调用。
- 这是模型面向的工具，没有 UI 按钮；需要手动切换时让 Agent 调用它即可。
- 切换发生在会话中途，历史消息不会按新预设重写；浅层解读是"后续请求换一套组合"。

## 实现

- `lib/index.js`：`apply()` 里用 `ctx.effect` 注册一个工具；`inject = ['tools','agents','agentPresets']`。
- 调用方会话解析顺序：工具运行上下文的 `exec.agent` → `agents.currentInitiator()`；
  两条路径都要通过 `agents.get(id) === agent` 的存活校验，都拿不到就报错，
  **不会**猜"最后一个 Agent"切错会话。
- 切换前拒绝 subagent 会话；切换：`composedPreset` 读当前值 → `recompose(agent.ctx, id)`
  → `session.append` 记录。
- 不读会话文件、不写配置、不改默认预设；所有操作都走公开服务接口。

## 测试

```sh
node --test tests/hotswitch.test.mjs
```

覆盖：只读报告、切换并记录事件、当前预设 no-op、initiator 回退、非存活 agent 拒绝、
initiator 异常、非法 preset 类型、subagent 拒绝、recompose 失败（含可用 id）、
list 失败、记录失败，以及 `render` 输出。

## License

MIT
