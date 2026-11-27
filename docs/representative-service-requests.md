# 服务申请后端接入契约（c007，实施中）

此文档定义本方接口，前端按此接入；实现状态与限制见外层c007验证记录，不代表已完成发布或生产上线。

## 配置与发布

owner使用POST `/api/dashboard/representatives/{slug}/service-requests`，JSON为`{"operation":"configure","rules":{"version":1,"boundaries":[...]}}`。boundaries必须含五预设appointment/discount/scope/dispute/human，元素为id/request/action，action为approve/handoff/decline；自定义request非空。

GET同一路径加`?configuration=true`读取草稿（仅owner）。保存至KnowledgePack.serviceBoundaries草稿；既有publishRepresentativeVersion将其写入RepresentativeVersion.snapshot.knowledge.serviceBoundaries。Agent仅按会话绑定发布版本读取，不读取草稿。缺字段的旧版本不启用新工具。本配置接口不改变同事分支其他新版配置的发布保护。

## 身份与HTTP

owner端上述路径需要真实owner登录态，无本地匿名写入fallback。访客路径`/reps/{slug}/service-requests?conversationId={id}`，沿用公开聊天可信Cookie及会话归属校验；conversationId不是授权依据。

GET列表参数：box=all/sent/received（默认all），objectId（owner侧contact业务对象筛选，仍受归属限制）、kind、status、from/to（ISO时间）、order=asc/desc、cursor、limit（1—100）。默认最近365天所有状态，每项含createdAt，按createdAt+id稳定排序；返回items/nextCursor。GET指定id获取详情；id+chain=true获取依赖链，可用offset/limit分页，返回items/nextOffset，节点仅id/parentId/content/reply。

POST操作：

- create：`{operation:"create",batch:{messageId,overflow:false,items:[{itemId,content,summary,ruleIds}]}}`。服务端默认上限5项，DELEGATE_SERVICE_REQUEST_MAX_ITEMS配置1—100；overflow或数量超限在写入前整批拒绝。规则只允许审批事项进入业务申请，人工接待走既有独立能力。
- resolve：`{operation:"resolve",id,action:"accepted"|"rejected"|"withdraw",text?}`。owner可整项接受/拒绝，原发送访客可撤回待处理项。
- successor：`{operation:"successor",id,mode:"follow_up"|"answer"|"replace",idempotencyKey,item:{itemId,content,summary,ruleIds},options?:[{id,label}],reply?:{selectedOptionId?,text?}}`。owner仅follow_up，访客仅answer/replace；其他选项由后端强制保留，选择其他必须填文字。answer/replace按当前会话发布版本重新校验。

初始content最多8000字符、summary最多2000字符，空白内容拒绝。非法输入400、未登录401 authentication_required、无权限403、未找到404、状态/幂等冲突409、超限422。HTTP私有no-store。内部audienceIdentityId、contactId、哈希和幂等token不返回客户端。

## 数据规则

独立ServiceRequest表，与ApprovalRequest（工具/技能审批）及HandoffRequest（接待）分离。direction为visitor_to_owner/owner_to_visitor；status为pending/accepted/rejected/disabled。

原内容不可改写。pending可审核、撤回或创建后继；终态不可再操作。disabledReason为withdrawn/superseded/follow_up；保留旧记录，数据库触发器拒绝删除和终态修改。parentId唯一，前置已有且同一代表/会话/访客，创建后继与禁用前项同一事务；失败回滚。每个会话幂等键唯一，参数变化复用同键返回冲突。

业务成功不等于通知送达、owner批准不等于改价/履约。通知和其他未完成能力不能以当前创建接口成功代替。

## 2026-11-27 审查修订

- 匿名仅聊天，访客写接口要求authenticated principal；共享服务再次验证REGISTERED身份关联ACTIVE账号和有效认证身份，外部渠道沿可信绑定/上下文授权链接入。被提示登录后由访客登录并重新尝试，不自动检测、恢复或提交登录前意图；只有后端落库成功才算创建成功。
- ServiceRequest.ownerId为创建时后端确定的归属，后继继承；owner查询和处理按该归属授权，不因代表当前管理关系变化失去历史申请。配置规则仍要求代表当前owner权限。
- GET `/api/dashboard/service-requests`为owner聚合读取接口，必须登录；可传representativeId筛选，省略查自身跨代表申请。支持既有列表筛选、id详情和chain查询，box=all/sent/received默认all。visitor_to_owner对owner为收到，owner_to_visitor为发出。objectId仅供owner按contact筛选，访客传入400。
- 幂等键最大250字符。owner追问重试比较稳定业务输入，不比较模型生成选项；相同键/输入返回首次结果，不再生成选项；输入变化返回409。并发首发可能分别生成候选选项，但只有一个后继生效。
- 格式合法的业务条目超限统一422 too_many_requests且零申请写入；格式非法400，请求体大小保护独立生效。
- 链节点reply.action的accepted/rejected是后端实际处理动作，普通回答选项ID或文案不是批准凭据。通知正文以业务摘要或实际问题表达，不展示内部申请cuid。

### 可选建议操作

harness将authentication_required映射为`{type:"login"}`，随回复保存到Message.content.suggestedActions，经run结果和历史/SSE返回；不会拼进text或后续Agent历史/任务恢复/记忆输入。前端可忽略，未知类型忽略；本阶段仅登录，前端复用已有登录跳转，已登录隐藏，不自动提交。

示例：`{"text":"登录后可继续申请。","suggestedActions":[{"type":"login"}]}`。不解析模型正文标签，不传任意URL。访客HTTP匿名写拒绝也返回同样建议字段。后续新增类型需同时扩展服务端错误码映射和前端受支持操作。

部署先应用新增owner归属迁移并生成Prisma Client，再部署应用；原申请迁移未改写。当前PR未合并，不需要生产匿名历史迁移，迁移会为开发旧记录回填ownerId。

### 模型不选择已有申请（2026-11-27）

模型服务申请工具仅保留query_service_requests和submit_service_requests，不再注册change_service_request。worker不再自动注入待回答候选，也不按targetQuote定位申请。普通聊天中无论回复“商品a”还是“10件”、无论有几条待答追问，都不能由模型选择申请进行answer、replace或withdraw；不能把追问答案当新申请绕过。模型应准确说明当前聊天不支持这类操作，不虚构卡片或已上线的回复页面。

上方HTTP的明确id操作及其身份/归属/状态/选项校验保留；HTTP接口可用不代表当前已有卡片UI。申请卡片、绑定输入和Message.content扩展留在外层c008草稿，未实施。旧2abeb81简短回答自动定位的验证为历史行为，本次变更取消该模型写入口，不声称修好了旧的文本匹配算法。

### 共享人工接管权限（2026-11-27）

`createOrReuseHandoffRequestInTransaction` 与业务申请共用 `requireRegisteredServiceVisitor`，在历史接管查询/刷新、权益预留和FREE创建之前验证contact关联的账号资格。匿名、缺失账号、账号停用、无有效认证身份或身份已合并等不符合既有校验的请求，抛出 `ServiceRequestError("authentication_required", 401)`；调用方不得降级为创建匿名接管。

该边界也保护旧会话接管包装、旧生成完成回调和bot接管适配。它沿用宿主现有登录/渠道绑定解析，不新增会话或退出规则；正常用户原有免费、付费接管及幂等行为保留。
