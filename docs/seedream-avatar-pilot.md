# Seedream 人物母版与四视图小样接入

日期：2026-11-06。首轮交付范围是官方 API 的服务端适配器、保留全画幅的图片处理和内部小样命令行。尚未新增用户上传页面、生产任务队列或公开生成接口；这些在样件效果验证后接入现有登录和存储体系。

## 当前状态

- 官方接口：`POST https://ark.cn-beijing.volces.com/api/v3/images/generations`。
- 人物母版最多两张，确认一张后才生成正、背、左、右四视图。
- 每张视图独立调用并记录用途；请求成功不代表图片的角度或人物一致性已经通过人工检查。
- 首个真实素材试验位于 `.local/seedream-avatar/first-run`，已准备 4 张参考图，身高设定 170 厘米，用户确认的总预算为 ¥30。
- 创建试验时密钥和模型尚未配置；没有提交真实生成，没有上传照片，调用次数为 0。
- 离线测试使用合成图片与注入的模拟传输，不能作为真实 Seedream 效果验收。

## 服务端模块

- `@delegate/model-runtime/seedream`：读取服务端配置、固定官方 HTTPS 端点、编码参考图、发出一次请求、限制响应大小并解析单张 Base64 图片。
- `@delegate/web-data/avatar-reference-images`：实际解码参考图，保留画幅、校正方向、去除元数据，最长边缩至 2048；与现有 512×512 个人头像裁剪入口分开。
- `scripts/lib/seedream-avatar-pilot.ts`：本地试验状态、预算预留、母版确认、输出哈希、并发锁及回执恢复。
- `scripts/avatar-seedream.ts`：内部命令行入口。

API Key 不进入客户端或试验状态文件。日志不输出密钥、参考图 Base64 或提供方原始错误正文。响应要求 `b64_json`，不自动抓取提供方返回的任意 URL；生成图校验后直接存入本地私有目录。

Seedream 4.0、4.5、5.0 lite 使用 `sequential_image_generation: disabled`；5.0 pro/flash 省略该字段，因为官方文档称这些版本不支持配置组图。一次请求只接受一个成功图片结果。四视图采用四次明确角度的请求，而非假设组图输出顺序。

## 配置

在本机 `.env` 配置，不将密钥粘贴到聊天或提交到 Git：

```dotenv
ARK_API_KEY="在本机填写"
SEEDREAM_MODEL_ID="控制台已开通的实际Model ID或Endpoint ID"
SEEDREAM_ENABLED="true"
# ep-* 不暴露模型系列时必填；可选 4.0 / 4.5 / 5.0-lite / 5.0-pro / 5.0-flash
SEEDREAM_MODEL_FAMILY="4.5"
```

不会猜测一个未验证的模型 ID。使用 `doubao-seedream-*` 的已知版本前缀时可自动识别系列；使用 `ep-*` 时需要显式配置。此配置目前供内部 Node 试验脚本使用，没有新增 Docker 服务，也没有将生成密钥注入网页前端。

## 运行步骤

### 1. 准备参考包（不联网、不计费）

参考包的 `manifest.json` 包含按序排列的四张图片及 SHA-256：无眼镜正脸、两侧脸、全身服装照。已准备的实际目录在相邻 DelegateVP 项目的 `.local/multimodal-avatar/reference-pack-v1/`。

```sh
pnpm avatar:seedream prepare \
  --run .local/seedream-avatar/first-run \
  --references /Users/neo/Documents/project/DelegateVP/.local/multimodal-avatar/reference-pack-v1 \
  --budget-cny 30
pnpm avatar:seedream status --run .local/seedream-avatar/first-run
```

同一试验目录不能重复 prepare 或覆盖；当前目录已经准备好，接下来从 status 开始。

### 2. 核对实际单次费用上界

在真实调用前，根据**实际模型、2K 输出及最多 5 张输入参考图**核对官方计费，记录保守的单次费用上界及来源：

```sh
pnpm avatar:seedream pricing --run .local/seedream-avatar/first-run \
  --ceiling-cny VERIFIED_REQUEST_COST_CEILING \
  --pricing-note "实际模型、费用来源和核对日期"
```

占位符必须换成经过核对的数值，不能照抄。总预算以分为单位保存；发请求前按上界预留金额，六次请求总预留不得超过预算。价格上界必须覆盖适用的输入与输出费用。没有可信价格信息时不执行请求。

这是基于配置的本地保守预留，不是云平台账单查询或平台侧硬性消费封顶。试验会保留失败／未知请求的预留，避免不确定情况下继续扩大费用。模型及价格在发出第一笔请求后不能在该试验中修改。

### 3. 生成母版（真实调用）

```sh
pnpm avatar:seedream master --run .local/seedream-avatar/first-run \
  --slot master-1 --execute
```

生成结果、SHA-256、请求标识和图片尺寸会输出到终端。第二候选仅在需要且预算允许时用 `--slot master-2` 单独执行。没有 `--execute` 或未启用环境配置时不会发出请求。

### 4. 审阅并确认母版（不联网）

```sh
pnpm avatar:seedream approve --run .local/seedream-avatar/first-run \
  --slot master-1 --sha256 REVIEWED_IMAGE_SHA256
```

只接受已成功保存且哈希一致的结果。开始四视图后，该试验不能再切换母版；换人物方案应新建试验。

### 5. 生成四视图（真实调用）

```sh
pnpm avatar:seedream views --run .local/seedream-avatar/first-run --execute
```

顺序生成 front/back/left/right，每次都携带确认的母版与原始身份／服装参考。可用 `--slot left` 单独指定一个视图。已成功保存的视图会校验并复用，不重复提交。输出仅标记预期角度，仍需检查是否实际符合该角度、人物与服装是否一致。

## 中断与异常

- 并发进程由排他锁拦截，同一个试验最多六次请求（包括失败与不确定结果）。
- 明确拒绝的请求需要显式 `--retry-rejected`，重试仍消耗次数和预算预留。
- 网络超时、5xx、无效响应或结果保存失败可能已经产生费用，标记为 unknown，不自动重发。
- 若图片与回执已经保存、仅状态更新中断，可执行 `reconcile --run DIR --slot SLOT`，校验回执和输出哈希后恢复，不联网。
- 进程崩溃遗留锁时，可执行 `unlock --run DIR`。仅在锁内 PID 已不存在时归档锁；running/unknown 请求仍保持阻止重试状态。
- 没有匹配回执的未知请求需要核对提供方记录。同步图片 API 的本地试验状态不等于提供方可查询的异步任务 ID。

本地目录状态面向单机内部试验，不是多租户生产计费或任务队列。生产化时仍需 Owner 鉴权、数据库事务／配额、私有对象存储和独立 worker。

## 验证

```sh
pnpm exec vitest run packages/model-runtime/tests/seedream-provider.test.ts \
  packages/web-data/tests/avatar-reference-images.test.ts \
  scripts/tests/seedream-avatar-pilot.test.ts
pnpm exec tsc --noEmit -p scripts/tsconfig.seedream.json
pnpm --filter @delegate/model-runtime typecheck
pnpm --filter @delegate/web-data typecheck
```

24 项离线测试通过；CLI 与两个相关包的类型检查通过。覆盖官方请求字段、Pro/Flash 参数差异、大小和格式校验、错误脱敏、超时不重试、母版哈希确认、预算预留、并发防重、已完成结果复用、回执恢复和参考图篡改拒绝。

真实接口权限、实际耗时、账单及人物效果需要密钥配置后的试验，当前不标为通过。

官方依据：[Seedream 图片 API](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh)，2026-11-06 核对。
