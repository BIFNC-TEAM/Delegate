# Owner 头像上传（2026-09-21）

分支：`codex/unified-account-onboarding`。将个人信息页的 URL 输入替换为本地选图、预览、上传保存和移除；未创建 PR。

## 实现

浏览器通过当前登录会话向 `POST /api/dashboard/account-profile` 上传单个 multipart `avatar` 文件。Dashboard 校验登录、Origin、表单字段和流式大小上限后，通过既有受限内部接口交给 workflow-runner。后台再次校验 Owner / issuer / subject 绑定，处理图片并写入 COS，最后更新该用户 Logto 资料中的 avatar。昵称、手机号、密码及微信绑定不变。

图片限静态 JPG / PNG / WebP、5 MiB、2000 万像素。服务端检查文件签名并实际解码；输出居中裁剪的 512×512 JPEG，移除 EXIF/GPS 等元数据。复用项目已经锁定的 sharp 0.35.0，并声明为直接依赖，没有引入新版本或额外测试框架。

COS 使用现有 `KNOWLEDGE_OBJECT_STORE_*` 配置，但对象单独放在 `avatars/<Owner 摘要>/<随机 UUID>.jpg`。只对新头像设置 private ACL，不改存储桶或知识库权限。浏览器不持有 COS 密钥。Logto 保存稳定的应用图片展示 URL，图片接口只允许读取这个头像命名空间中的合规随机标识，不能指定任意对象 key、bucket 或外部 URL。

头像是展示资源：持有其随机展示链接即可读取，COS 原对象仍不能匿名读取。展示链接不使用会过期的 COS 临时签名；返回固定 image/jpeg、nosniff、5 分钟缓存。移除/替换后只清理经过当前 Owner 校验的旧头像对象，不删除其他 Owner 或外部地址指向的数据。

上传失败时不更新旧头像。资料写入响应丢失时先回读：若已保存则保留新图片；只有确认未引用时才删除这次新上传对象；无法确认时保留对象并报错，避免删除已生效头像。旧对象清理失败会记录事件并通过响应/UI 明确提示，未虚构后台自动重试。

本地开发容器复用了镜像中已有的 sharp，并重新启动 Dashboard 读取模块导出。正式构建/新镜像仍按项目标准执行 `pnpm install --frozen-lockfile`，以生成新增直接依赖的链接。

## 验证

| 测试场景 | 输入／前置条件 | 预期结果 | 实际结果 |
| --- | --- | --- | --- |
| 本地文件入口 | 登录后打开个人资料 | 选择本地图片，没有 URL 输入框 | 浏览器确认 |
| 图片处理 | 含 EXIF 的图片、非正方形 PNG | 512×512 JPEG，无 EXIF，正确处理透明背景 | 自动化通过 |
| 非法图片 | SVG、损坏数据、超 5 MiB、过大像素 | 拒绝，不写 COS 或资料 | 自动化通过 |
| 上传权限 | 未登录、跨 Origin、Owner 不匹配、停用用户 | 拒绝，不存储图片 | 自动化通过 |
| multipart 边界 | 空文件、多字段、超限文件、伪造 JSON URL | 拒绝无效上传 | 自动化通过 |
| COS 上传失败 | 对象存储错误 | 保留旧资料，不更新 avatar | 自动化通过 |
| 资料保存失败 | 上传成功但更新失败 | 只清理确认未引用的新对象 | 自动化通过 |
| 写入响应丢失 | Logto 已保存但响应异常 | 回读确认成功，不误删新头像 | 自动化通过 |
| 真实 COS | 自动生成的合成图片 | 上传/读回成功；原对象匿名访问被拒绝 | 通过 |
| 显示接口 | 上述对象的随机展示 URL | 返回相同 JPEG、nosniff；路径越界被拒绝 | 真实 HTTP 和自动化通过 |
| 真实保存/移除链路 | 独立临时 Owner 和 Logto 身份 | COS → Logto 持久化 → 图片展示 → 移除头像/对象 | 通过；已清理临时身份和对象 |

命令与结果：

- `pnpm exec vitest run packages/web-data/tests/owner-avatar-storage.test.ts packages/web-data/tests/owner-identity-profile.test.ts apps/web/tests/account-profile-route.test.ts apps/workflow-runner/tests/owner-profile.test.ts`：38 项通过。
- web-data、Dashboard、workflow-runner 的 `typecheck`：通过。
- `pnpm --filter @delegate/dashboard build`：通过。
- `pnpm exec turbo run test --concurrency=1`：28/28 任务成功，包含缓存复用；既有条件跳过的集成测试未标记为通过。
- `DELEGATE_AVATAR_COS_E2E=1 node --env-file=.env --import tsx scripts/tests/owner-avatar-cos.local.mjs`：真实 COS 与显示接口通过，随后清理本次合成对象。
- 临时身份集成测试通过真实后台接口上传、读取 Logto、访问展示 URL 并移除；只清理本次创建的 Owner/Logto 用户/COS 对象，未修改既有用户头像。

首次真实显示测试曾返回 500：本地 Next 开发进程仍缓存旧模块导出和依赖解析。重新加载依赖并重启后，重复完整读写测试通过。sharp 的当前包 exports 未导出其类型声明，代码使用同版本自带声明保持类型检查，没有通过 any 或跳过检查掩盖问题。

## 文件清单

| 文件 | 修改原因 |
| --- | --- |
| `apps/web/app/dashboard/dashboard-account-profile.tsx` | 本地选图、blob 预览、上传/取消/移除、错误恢复与防止旧请求覆盖新状态 |
| `apps/web/app/dashboard/dashboard-v2.css` | 复用设计系统的上传操作排版 |
| `apps/web/app/api/dashboard/account-profile/route.ts` | 会话及 Origin 校验后的有界 multipart 上传 |
| `apps/web/app/api/dashboard/account-profile/client.ts` | 受限内部上传动作、超时及状态码传递 |
| `apps/web/app/api/avatars/[owner]/[id]/route.ts` | 独立头像展示端点和固定图片响应头 |
| `apps/workflow-runner/src/owner-profile.ts` | 有界上传请求体与既有身份校验链路衔接 |
| `packages/web-data/src/owner-avatar-storage.ts` | 图片校验/转换、COS 私有存储、限定读取及对象清理 |
| `packages/web-data/src/owner-identity-profile.ts` | 上传后更新 Logto、回读确认、失败补偿和旧对象清理 |
| `packages/web-data/package.json` | 导出头像模块并声明复用的 sharp 直接依赖 |
| `pnpm-lock.yaml` | 对应直接依赖及由此必需的依赖标记变化，无版本升级 |
| `apps/web/tests/account-profile-route.test.ts` | 上传鉴权、Origin、大小及字段边界测试 |
| `apps/workflow-runner/tests/owner-profile.test.ts` | 上传仍通过受限后台端点 |
| `packages/web-data/tests/owner-avatar-storage.test.ts` | 图片转换、恶意输入、COS 对象属性及路径隔离 |
| `packages/web-data/tests/owner-identity-profile.test.ts` | 上传持久化、权限与失败补偿 |
| `scripts/tests/owner-avatar-cos.local.mjs` | 显式开启的真实 COS 集成测试与自动清理 |
| `docs/owner-avatar-upload.md` | 实现、验证及逐文件记录 |
