# 服务申请后端接入契约（c007，实施中）

此文档定义本方接口，前端按此接入；实现状态与限制见外层c007验证记录，不代表已完成发布或生产上线。

## 配置与发布

owner使用POST `/api/dashboard/representatives/{slug}/service-requests`，JSON为`{"operation":"configure","rules":{"version":1,"boundaries":[...]}}`。boundaries必须含五预设appointment/discount/scope/dispute/human，元素为id/request/action，action为approve/handoff/decline；自定义request非空。

GET同一路径加`?configuration=true`读取草稿（仅owner）。保存至KnowledgePack.serviceBoundaries草稿；既有publishRepresentativeVersion将其写入RepresentativeVersion.snapshot.knowledge.serviceBoundaries。Agent仅按会话绑定发布版本读取，不读取草稿。缺字段的旧版本不启用新工具。本配置接口不改变同事分支其他新版配置的发布保护。

## 身份与HTTP

owner端上述路径需要真实owner登录态，无本地匿名写入fallback。访客路径`/reps/{slug}/service-requests?conversationId={id}`，沿用公开聊天可信Cookie及会话归属校验；conversationId不是授权依据。

GET列表参数：box=sent/received，objectId（owner侧contact业务对象筛选，仍受归属限制）、kind、status、from/to（ISO时间）、order=asc/desc、cursor、limit（1—100）。默认最近365天所有状态，每项含createdAt，按createdAt+id稳定排序；返回items/nextCursor。GET指定id获取详情；id+chain=true获取依赖链，可用offset/limit分页，返回items/nextOffset，节点仅id/parentId/content/reply。

POST操作：

- create：`{operation:"create",batch:{messageId,overflow:false,items:[{itemId,content,summary,ruleIds}]}}`。服务端默认上限5项，DELEGATE_SERVICE_REQUEST_MAX_ITEMS配置1—100；overflow或数量超限在写入前整批拒绝。规则只允许审批事项进入业务申请，人工接待走既有独立能力。
- resolve：`{operation:"resolve",id,action:"accepted"|"rejected"|"withdraw",text?}`。owner可整项接受/拒绝，原发送访客可撤回待处理项。
- successor：`{operation:"successor",id,mode:"follow_up"|"answer"|"replace",idempotencyKey,item:{itemId,content,summary,ruleIds},options?:[{id,label}],reply?:{selectedOptionId?,text?}}`。owner仅follow_up，访客仅answer/replace；其他选项由后端强制保留，选择其他必须填文字。answer/replace按当前会话发布版本重新校验。

初始content最多8000字符、summary最多2000字符，空白内容拒绝。非法输入400、无权限403、未找到404、状态/幂等冲突409、超限422。HTTP私有no-store。内部audienceIdentityId、contactId、哈希和幂等token不返回客户端。

## 数据规则

独立ServiceRequest表，与ApprovalRequest（工具/技能审批）及HandoffRequest（接待）分离。direction为visitor_to_owner/owner_to_visitor；status为pending/accepted/rejected/disabled。

原内容不可改写。pending可审核、撤回或创建后继；终态不可再操作。disabledReason为withdrawn/superseded/follow_up；保留旧记录，数据库触发器拒绝删除和终态修改。parentId唯一，前置已有且同一代表/会话/访客，创建后继与禁用前项同一事务；失败回滚。每个会话幂等键唯一，参数变化复用同键返回冲突。

业务成功不等于通知送达、owner批准不等于改价/履约。通知和其他未完成能力不能以当前创建接口成功代替。
