# Delegate 目标架构 V2：从用户输入到最终交付

日期：2026-09-28。依据：[最终优先级与交付计划](agent-priority-and-delivery-plan.md)、[整改技术方案 V2.1](agent-remediation-final-plan.md)、[代码与测试自检](reviews/delegate-architecture-selfcheck.md)。本文替代2026-09-24旧流程图中的流程顺序。

代码实施已开始；各节点的当前完成范围与验证证据见[实施验收记录](agent-implementation-progress.md)。

**这是待落地的目标流程，不是所有节点已实现或已通过验收。** 每图包含逻辑职责，不代表新增服务，也不代表每个方框调用一次模型。第14节区分当前基础、本轮改动和后续能力。

核心：一个 Pi 主 Agent；服务端维护可信身份、有效任务、权限、审批、预算和真实状态；知识、记忆、Skill正文按需加载；工具选择由主 Agent 完成；硬检查常驻，语义复核按需。近期不增加独立前置路由模型。

所有重试、补证、修订与恢复循环都受累计预算、取消状态及停止条件限制；循环箭头不表示无限重试。下文的“权限检查”包括拒绝分支，即使总览未重复画出。

## 1. 整体主流程

```mermaid
flowchart TD
    userInput["用户输入：文字、附件、补充、修改或取消"] --> entry["Web / Matrix / Telegram 渠道入口"]
    entry --> identity["校验身份、会话、实际受众、附件归属与消息去重"]
    identity --> entryKind{"前置代码分流"}
    entryKind -->|"明确状态或取消"| control["校验任务归属，查询最小状态或记录取消"]
    entryKind -->|"普通请求或有效修改"| admission["新服务准入：发布状态、回答范围、控制权与额度"]
    eventIn["认证审批事件 / 恢复事件"] --> originalAction["绑定原任务、原动作与当前身份"]
    admission --> taskState["建立或更新有效请求、约束、交付要求和任务版本"]
    taskState --> context["最小上下文：规则、配置、任务状态、有效资料和工具目录"]
    context --> modelGate["检查资料可发送范围、累计预算与输出模式"]
    modelGate --> mainAgent["单一主 Agent：理解需求并决定下一步"]
    mainAgent --> nextStep{"本轮需要什么？"}
    nextStep -->|"信息足够"| answer["形成最终候选：回答、来源、真实状态、产物引用"]
    nextStep -->|"关键条件缺失"| clarify["提出必要澄清，不执行缺条件的动作"]
    nextStep -->|"需要资料或执行"| toolGate["服务端工具检查，详见图5"]
    originalAction --> toolGate
    toolGate --> gateResult{"检查结果"}
    gateResult -->|"已有结果或恢复"| restore["重验可见性，取原回执或进入unknown恢复"]
    gateResult -->|"需要审批"| pending["保存动作与checkpoint，发送等待状态并释放运行"]
    pending -.->|"后续认证事件"| eventIn
    gateResult -->|"允许新执行"| execute["轻量读取或持久动作派发，保存真实结果"]
    gateResult -->|"拒绝或能力不足"| observation["结构化观察：内容、状态、来源、时间和限制"]
    restore --> observation
    execute --> observation
    observation --> gap{"仍有相关且获准的缺口，并有预算？"}
    gap -->|"有"| context
    gap -->|"无"| answer
    clarify --> answer
    control --> answer
    answer --> verify["最终权限、依据、状态、产物硬检查及必要语义复核"]
    verify --> deliver["绑定实际接收者和最终版本，持久化并交付"]
    deliver --> closure["分别更新交付、任务、消费与治理记忆状态"]
```

本图省略各入口拒绝分支，详见图2/5/10。图中主路径采用缓冲输出；可选真流式是图10的独立受控分支，首批不依赖它。审批/恢复不通过主模型重新发明已经批准的动作。

## 2. 用户输入、前置分流与任务修改

```mermaid
flowchart TD
    inbound["接收渠道事件与附件引用"] --> principal["从可信会话绑定租户、代表、访客和渠道身份"]
    principal --> access{"身份、会话、附件归属与基础限流通过？"}
    access -->|"否"| refused["返回允许展示的拒绝状态，不读取私人任务正文"]
    access -->|"是"| duplicate{"同一消息事件是否已处理？"}
    duplicate -->|"是"| existing["重验可见性后返回原接受状态，不新建效果"]
    duplicate -->|"否"| kind{"明确控制请求，还是业务输入？"}
    kind -->|"查状态 / 取消"| owned["确认目标任务与当前归属"]
    owned --> controlType{"控制类型"}
    controlType -->|"本地状态"| status["返回最小可见状态，不消耗新生成额度"]
    controlType -->|"取消"| cancel["持久化取消意图，停止未派发步骤"]
    cancel --> sent{"动作是否可能已提交？"}
    sent -->|"否"| stopped["标记未执行取消，释放适用预留"]
    sent -->|"是"| externalCancel["按能力请求撤销或核查，不能直接称已撤销"]
    kind -->|"新请求 / 修改 / 补充"| admission["检查已发布服务、渠道、当前控制权及消费准入"]
    admission --> allowed{"可由 AI 处理？"}
    allowed -->|"否"| unavailable["准确返回不可用，或交由已接管的真人处理"]
    allowed -->|"是"| relation["关联当前任务；模型可解释，服务端保存有效修改"]
    relation --> revision{"修改影响什么？"}
    revision -->|"只改给访客的排版"| presentation["只更新呈现要求，不重做已完成业务"]
    revision -->|"收件人、金额、对象、外发正文等"| effect["建立动作修订，旧审批重新判断效力"]
    revision -->|"明确要求新的效果"| newIntent["建立新意图/动作，不按相同参数一律去重"]
    presentation --> queue["保存工作与任务状态，交由conversation-worker认领"]
    effect --> queue
    newIntent --> queue
```

模糊取消或unknown之后的“再来一次”需要明确对象/意图，不机械猜测。仅修改访客看到的排版与修改实际发送的邮件正文不同：后者仍是动作参数变化。代表暂停或新额度不足不应挡住经授权的最小本地状态查询；外部查询/取消如有成本，使用有界恢复预算。

## 3. 每轮到底发送什么给模型

```mermaid
flowchart TD
    fixed["固定主规则：身份边界、授权、证据、执行、表达"] --> assemble["组装本次模型上下文"]
    config["可信代表配置：回答范围、依据策略、性格、承诺范围"] --> assemble
    task["当前有效请求、必要历史、交付要求与未决动作"] --> assemble
    runtimeState["服务端状态摘要：当前权限、预算、审批及真实回执"] --> assemble
    catalog["可见且可用的工具名称、能力与参数说明"] --> assemble
    artifacts["附件元数据、已获准的产物和来源句柄"] --> assemble
    candidates["相关记忆、知识证据、Skill正文、工具结果"] --> recheck["授权、同意、版本、时效与受众检查"]
    recheck --> valid{"本次用途仍然允许？"}
    valid -->|"否"| invalidate["移除失效正文及派生副本，必要时重建上下文"]
    valid -->|"是"| scoped["只保留任务所需内容、条件、例外及出处"]
    scoped --> assemble
    invalidate --> assemble
    assemble --> compact["按完整工具调用与返回配对压缩"]
    compact --> outbound["核对模型提供方可接收的数据与推理预算"]
    outbound --> request["发送一次模型请求：规则、消息、上下文与工具定义"]
    request --> response["得到文本或工具提议；保存实际usage和安全事件"]
```

- 工具目录是能力说明，不是工具已经执行。近期保留简洁完整的获准目录，不增加一次专用路由调用。
- 不默认上传全部知识、全部记忆、全部Skill正文和所有历史；相关正文按需取用。附件元数据不证明已读取文件。
- 网页、附件、检索结果、记忆、外部工具描述和Skill内容不能扩大权限或覆盖平台规则。Skill提供方法，实际调用仍走图5。
- 平台/模型/云端密钥留在服务端适配层；模型只看到必要的能力与身份范围摘要。

## 4. 同一个主 Agent 如何选择知识与能力

```mermaid
flowchart TD
    goal["当前有效请求、获准范围与已有有效证据"] --> enough{"能否直接完成？"}
    enough -->|"能"| direct["直接组织答案，不为凑次数调用工具"]
    enough -->|"不能"| missing["判断缺的是事实、资料、文件内容、计算还是业务状态"]
    missing --> ambiguity{"有影响结果或动作的重要歧义？"}
    ambiguity -->|"有且不能低成本并列处理"| question["澄清关键条件"]
    ambiguity -->|"没有或可分别标注"| need{"需要的证据或能力"}
    need -->|"所有者政策 / 指定资料"| knowledge["查询当前访客获准的知识；已有有效证据可复用"]
    need -->|"动态公开信息 / 公开历史"| publicInfo["选择能取得所需信息的公开能力"]
    publicInfo --> method{"用户是否指定可用且获准的方法？"}
    method -->|"指定浏览器等"| requiredMethod["遵守方法约束；不可用时说明，不能悄悄换方法"]
    method -->|"未指定"| match{"有适用的专用工具？"}
    match -->|"有"| specialized["可使用相关工具，不因MCP身份获得固定优先权"]
    match -->|"无或不能满足"| browser["公开浏览器；搜索服务仅在已接入时使用"]
    need -->|"附件 / 计算 / 文件"| fileTask["读取获准附件，必要时加载Skill并执行计算"]
    need -->|"订单 / 预约 / 提交 / 转人工"| business["匹配业务能力，准备参数和动作范围"]
    need -->|"缺少处理方法"| skill["发现并加载相关Skill，再选择实际能力"]
    knowledge --> gate["交给服务端工具检查，不由模型自行放行"]
    requiredMethod --> gate
    specialized --> gate
    browser --> gate
    fileTask --> gate
    business --> gate
    skill --> goal
```

这张图表示主Agent的决策职责，不是一个前置分类模型，也不是股票/天气等行业关键词路由。多步骤任务在同一个循环中推进；每一步必须能解释它填补了什么缺口。稳定常识按代表范围可以直接回答；不能将普通公司的公开价格误归为所有者内部政策。

## 5. 所有工具出口的共同检查与轻重分路

```mermaid
flowchart TD
    proposal["工具提议或原动作恢复请求"] --> contract["读取可信能力契约、版本与实际适配器"]
    contract --> classified{"行为与作用边界是否明确？"}
    classified -->|"未知或发生漂移"| blocked["不派发；额外确认不能替代未知行为分类"]
    classified -->|"明确"| parameters["校验参数、对象、方法约束和附件归属"]
    parameters --> authorization["当前身份、对象访问权、执行权与数据外发许可"]
    authorization --> authOK{"允许且参数完整？"}
    authOK -->|"否"| explain["返回缺参数、拒绝或能力限制观察"]
    authOK -->|"是"| actionState{"同一逻辑动作的持久状态"}
    actionState -->|"完成且仍可见"| receipt["返回原回执，不新执行"]
    actionState -->|"可能已提交 / unknown"| recover["进入图9恢复，不先要求新业务额度"]
    actionState -->|"纯新读取或尚未派发"| policy{"当前有效allow / ask / deny"}
    policy -->|"deny"| explain
    policy -->|"ask且无有效匹配批准"| approval["进入图8等待审批"]
    policy -->|"allow或ask已有有效批准"| budget["检查本次资源/执行预算和业务条件"]
    budget --> feasible{"预算、隔离及执行条件均满足？"}
    feasible -->|"否"| explain
    feasible -->|"是"| lane{"是否需要持久动作语义？"}
    lane -->|"普通已获准知识 / Skill读取"| lightweight["轻量授权读取和来源使用记录"]
    lane -->|"审批 / 外部效果 / 异步恢复"| durable["动作记录、审批效力和唯一派发资格"]
    durable --> beforeSend["派发前重验权限、取消、来源、租约代次与参数"]
    beforeSend --> adapter["Broker / 对应适配器调用真实提供方"]
    lightweight --> observed["标准观察：实际状态、内容、来源、时间、回执和产物"]
    adapter --> observed
    receipt --> observed
    explain --> observed
```

只读、已授权、需审批是三个独立属性。只读仍可能受限或被配置为ask；获准写入也可能为allow。知识读取不强制经过外部动作Outbox，但必须有同等有效的数据访问检查。工具可见不表示获准执行，schema一致也不证明远端真实行为只读。

## 6. 授权知识、记忆及撤回的完整路径

```mermaid
flowchart TD
    query["提出知识或记忆缺口"] --> scope["服务端绑定真实代表、访客、渠道、用途与受众"]
    scope --> sourcePolicy["读取权限元信息；凭证源排除普通问答"]
    sourcePolicy --> authorized{"有可访问的来源范围？"}
    authorized -->|"否或身份不明"| noRead["不取受限正文，返回限制或身份验证要求"]
    authorized -->|"有"| retrieve["在获准范围检索；快照与缓存应用同样检查"]
    retrieve --> evidence["返回必要原文、条件、例外、时间、版本及公开出处"]
    evidence --> register["记录本次模型调用的来源依赖"]
    register --> inference["主 Agent 使用证据"]
    inference --> derived["回答、摘要、工具参数、checkpoint和产物继承依赖"]
    derived --> useGate["每次新模型请求、工具派发或交付前重验"]
    useGate --> useOK{"当前授权、同意、版本与受众仍有效？"}
    useOK -->|"是"| permitted["允许当前用途；下载时再次检查"]
    useOK -->|"否"| stale["阻断新使用，使受影响副本与未发送输出失效"]
    withdrawal["撤回 / 到期 / 同意变化 / 受众变化"] --> stale
    stale --> rebuild["用仍可见来源重建上下文，或返回最小状态"]
    rebuild --> query
```

模型没有引用某来源，不代表其输出不含该来源；默认采用调用级保守继承。无命中、权限不足、检索故障和资料冲突要区分，不把无命中推断为事实不存在。不能收回已经合法发送的历史内容；保证是阻止后续使用与新披露，边界以实际派发阶段为准。

记忆只有在渠道支持、身份/同意/代表范围均允许时参与；匿名跨渠道不自动合并。源正文先过滤再读取，不能先全取后要求模型自觉保密。

## 7. All-in-One 浏览器、附件与文件交付

```mermaid
flowchart TD
    authorizedTask["图5检查通过的沙盒任务"] --> kind{"任务类型"}
    kind -->|"公开网页读取"| browserProfile["选择PUBLIC AIO浏览器profile"]
    browserProfile --> browserScope["核对URL、导航与数据外发范围；隔离访客状态"]
    browserScope --> readPage["浏览器访问并提取内容，按需截图"]
    readPage --> pageResult["保留最终URL、来源、观察时间及成功/429/空页等状态"]
    kind -->|"附件分析 / 计算 / 文件"| files["核对文件归属、实际格式、大小与支持的输出能力"]
    files --> readInput["实际读取必要内容；Skill可指导处理方法"]
    readInput --> script["检查代码与外部副作用；区分模板、上传和生成代码"]
    script --> profile{"实际网络、文件、凭证、进程与资源边界可满足？"}
    profile -->|"否或未知"| unavailable["说明不能执行，不用风险标签或审批代替隔离"]
    profile -->|"是"| execute["在对应会话执行，收集退出状态与日志"]
    execute --> outputKind{"已发布产物能力"}
    outputKind -->|"近期：单个文本 / CSV / JSON"| textFile["适配层保存真实文本文件；内容与格式校验"]
    outputKind -->|"后续：已验收二进制 / 多文件"| realFiles["独立读取真实文件字节和清单；日志分离"]
    textFile --> artifact["Artifact记录大小、类型、hash、来源依赖与下载权限"]
    realFiles --> artifact
    artifact --> checkFile["验证存在、可解析、符合任务、可授权下载"]
    pageResult --> result["返回可用内容、真实状态和已验证产物引用"]
    checkFile --> result
    unavailable --> result
```

当前PUBLIC工具不能被宣称具有已验证的实例级禁网；有此要求的任务需独立验证其他profile。正常获准的公共浏览继续可用。通用浏览器如涉及登录、提交表单或其他效果，回到动作权限与审批路径；不能因为名称是“浏览器”就当作全部只读。

上传脚本不要求先原样执行。代码hash只证明内容一致；平台密钥不交给代码，认证浏览器和其他访客文件不能被任意代码共享。文本改名为XLSX/PDF不能交付成功；浏览器已有截图能力不代表代码工具支持任意图片生成。

## 8. 审批、参数变化与恢复时序

```mermaid
sequenceDiagram
    participant visitor as 访客
    participant worker as Worker与主Agent
    participant broker as Broker与策略
    participant store as 动作/审批/任务存储
    participant approver as 规定审批主体
    participant provider as 外部提供方
    worker->>broker: 提议具体工具、对象、参数、数据用途
    broker->>store: 查询原动作与有效策略、授权、审批
    alt ask且没有匹配的有效批准
        broker->>store: 保存动作绑定、审批范围、期限和使用规则
        broker-->>worker: awaiting_approval及原动作引用
        worker->>store: 保存checkpoint、有效任务及来源依赖
        worker-->>visitor: 交付等待状态并结束本次运行
        approver->>broker: 经认证的批准或拒绝事件
        broker->>store: 重新读取原动作、当前参数、权限与取消状态
        alt 拒绝、过期、撤权、取消或关键参数已变
            broker->>store: 记录相应状态；旧批准不能驱动新动作
            broker-->>worker: 回填当前真实状态
        else 原动作仍获准且所有条件满足
            broker->>store: 原子认领派发资格、审批使用和预算预留
            broker->>provider: 派发前重验；使用原payload与原幂等合同
            provider-->>broker: 回执或不确定结果
            broker->>store: 保存结果并产生唯一恢复工作
            store-->>worker: 恢复原任务，不重新生成业务动作
        end
        worker->>store: 重验checkpoint来源、受众和任务修订
        worker-->>visitor: 经最终检查交付结果或限制说明
    else deny
        broker-->>worker: 不执行，返回有效规则导致的限制
    else allow或有效批准
        broker->>store: 重验并认领本次派发资格
        broker->>provider: 按图9执行与恢复合同处理
    end
```

等待期间不保持数据库事务或模型连接。批准不能扩大原本没有的数据/对象权限。只修改给访客的答复格式通常不重新审批；更换收件人、金额、对象、实际外发正文或附件需要重新判定。晚回执归原动作，保留实际发生的结果，不能覆盖新任务。

## 9. 外部动作、超时、取消与幂等恢复

```mermaid
flowchart TD
    action["经授权的逻辑动作引用"] --> load["读取原payload、原key、审批、attempt和持久状态"]
    load --> state{"当前状态"}
    state -->|"已完成"| done["重验可见性后返回原回执"]
    state -->|"明确失败或已取消"| terminal["返回真实终态，不自动新建动作"]
    state -->|"未提交且仍获准"| admission["原子确认取消、版本、审批、预算与唯一派发资格"]
    admission --> lease["工人发送前重验租约代次与当前资格"]
    lease --> boundary["持久记录可能已发送的界线，然后执行外部请求"]
    boundary --> response{"提供方结果"}
    response -->|"明确完成"| saveDone["保存已完成与回执"]
    response -->|"权威确认未生效"| noEffect["保存未生效；后续重试仍需重新检查条件"]
    response -->|"超时、断线、崩溃或含糊结果"| unknown["持久unknown，冻结相关效果及依赖步骤"]
    state -->|"可能已提交 / unknown"| unknown
    unknown --> query{"有获准且可用的状态查询？"}
    query -->|"有"| lookup["使用原请求/业务引用，在恢复预算内查询"]
    lookup --> authoritative{"能否得到权威状态？"}
    authoritative -->|"已完成"| saveDone
    authoritative -->|"确认未生效"| noEffect
    authoritative -->|"暂未查到或不确定"| retryContract
    query -->|"无"| retryContract{"原幂等合同仍有效且允许恢复？"}
    retryContract -->|"是"| admission
    retryContract -->|"否"| hold["保留unknown，待人工核查或后续权威事件"]
    cancellation["用户取消"] --> cancelState{"是否越过可能已发送界线？"}
    cancelState -->|"否"| stop["使未派发资格失效，停止相应步骤"]
    cancelState -->|"是"| cancelProvider["按提供方能力撤销/查询；不直接判已取消"]
    cancelProvider --> cancelResult{"权威取消或查询结果"}
    cancelResult -->|"确认撤销"| terminal
    cancelResult -->|"已完成且未撤销"| saveDone
    cancelResult -->|"尚未确认"| unknown
```

恢复必须保持原动作、原参数、原提供方key；新attempt不等于新业务效果。暂未查到不等于未执行；部分成功不能整批重放；不得换浏览器/脚本绕过unknown冻结。外部查询有界，额度不足时仍可展示最小本地状态。数据库事务和本地租约不保证任意外部服务恰好一次；越过界线后的取消只能依据真实结果表述。

## 10. 最终答案、硬检查、语义复核与输出模式

```mermaid
flowchart TD
    beforeGeneration["每次生成前检查实际上下文、任务义务与未决状态"] --> mode{"允许哪种输出模式？"}
    mode -->|"默认或需完整检查"| buffer["生成候选并缓冲；候选已包含最终风格"]
    mode -->|"后续：预先获准低风险真流式"| chunks["逐片检查、记录顺序与接收者后发送"]
    buffer --> hard["硬检查：权限/来源、指定方法、回执、文件和任务版本"]
    hard --> hardOK{"满足硬约束？"}
    hardOK -->|"否"| gap["补相关证据、修订或准确说明限制"]
    hardOK -->|"是"| risk{"需要独立语义复核？"}
    risk -->|"简单且条件满足"| finalGate["核对真正出站版本、来源、产物和接收者"]
    risk -->|"受限资料/承诺/冲突/复杂恢复"| review["只读复核：是否答题、证据是否支持、条件是否遗漏"]
    review --> reviewOK{"可以交付？"}
    reviewOK -->|"是"| finalGate
    reviewOK -->|"否"| gap
    gap --> retry{"有相关获准补救且在累计预算内？"}
    retry -->|"有"| agentLoop["回主Agent补证或修订，再从硬检查开始"]
    agentLoop --> buffer
    retry -->|"无"| limited["形成真实部分结果、澄清或限制说明"]
    limited --> finalGate
    finalGate --> safe{"当前仍允许披露？"}
    safe -->|"是"| delivery["固定输出版本，进入交付"]
    safe -->|"否"| minimal["使用服务端可公开的最小状态模板；不发送受限正文"]
    minimal --> delivery
    chunks --> streamEnd["处理完整/中断交付状态；后续不能撤回已发字节"]
    streamEnd --> streamAccounting["进入交付状态与消费记录，不再次发送完整正文"]
```

近期先验证简单问答少一次模型调用，真流式是单独后续项；简单路径也不跳过硬检查。真流式资格依赖受约束的实际上下文和能力，不能靠模型自称低风险；若发现需工具/受限资料等资格变化，停止新增正文流出，转入缓冲检查。服务端关键状态不能被reviewer的布尔值抹除；queued、accepted、unknown不冒充完成。语义复核无执行授权。核验之后不再新增风格模型，任何改写后都要检查最终内容。

来源规则统一：知识来源以产品允许公开的引用展示为主；动态网页注明必要来源、时间及状态；允许提及用户提供的名称，但不能伪造已验证来源。敏感正文不能先流出再补审。

## 11. 最终交付、渠道故障、消费与记忆

```mermaid
flowchart TD
    checked["图10放行的最终版本"] --> persist["保存正文、产物引用、来源依赖和目标接收者"]
    persist --> deliveryWork["认领交付工作，不重新创建原业务动作"]
    deliveryWork --> fence["发送前核对版本、实际受众及当前来源权限"]
    fence --> allowed{"仍可发送？"}
    allowed -->|"否"| blocked["标记交付受阻，只展示获准最小状态"]
    allowed -->|"是"| channel["调用Web或渠道适配器，记录真实接收结果"]
    channel --> ack{"渠道结果"}
    ack -->|"确认接收"| delivered["更新交付状态"]
    ack -->|"权威确认未接收"| retry["按渠道合同重试同一交付；重新经过发送检查"]
    ack -->|"可能接收但ACK丢失"| deliveryUnknown["标记交付unknown"]
    deliveryUnknown --> recover{"可查询或可靠去重恢复？"}
    recover -->|"有"| retry
    recover -->|"无"| reconcile["保留未知，进入对账/人工核查，不盲重发"]
    retry --> deliveryWork
    delivered --> task["汇总任务：完成、部分完成、等待或未知"]
    blocked --> task
    reconcile --> task
    actualUsage["模型、工具与恢复实际usage及成本事件"] --> ledger["按既有合同记消费、提供方成本、结算/释放/对账"]
    task --> ledger
    ledger --> unique["稳定事件键防重复；不因消息恢复重记原消费"]
    task --> memoryEligible{"满足当前渠道、同意和来源规则的记忆候选？"}
    memoryEligible -->|"是"| memory["最小化提取、自动治理、版本与隔离；符合条件才激活"]
    memoryEligible -->|"否"| noMemory["仅保留适用的任务与交付记录"]
```

业务成功、消息交付成功、整个任务完成分别记录；不因ACK丢失重做业务。收费时点继续按现有合同，不在图中改成全部执行即收费或全部ACK后收费。记忆处理依据真实交付/使用资格，不自动将所有聊天或失败草稿转长期记忆。

审计贯穿入口、模型调用、工具检查、派发、回执和交付各阶段；**每次写通用日志前最小化**，并非等任务结束才脱敏。客户端显示任务阶段和真实进展，不显示隐藏推理、私人正文、原始工具参数或内部凭证。

## 12. 贯穿全链路的可信记录与模块归属

| 数据/职责 | 复用基础 | 新方案要求 |
| --- | --- | --- |
| 会话与任务 | GenerationRun、消息事件、worker工作租约 | 当前有效请求、呈现/动作修订、停止原因、累计预算；模型只提议不能自行改权 |
| 能力与策略 | compute-protocol、capability-policy、工具目录、Broker | 行为/权限/审批/恢复合同分开；目录、adapter和执行端一致 |
| 业务动作 | ToolExecution、审批、Outbox或等价持久记录 | 稳定动作与attempt；原payload/key；派发界线、取消、审批效力与代次 |
| 来源与上下文 | OpenViking、MemoryUseRun、Pi消息/checkpoint | 检索前授权、条件完整、派生依赖、撤回与完整交互压缩 |
| 产物 | Artifact存储与下载入口 | 当前格式真实校验；后续字节清单；每次下载当前来源与受众重验 |
| 交付 | conversation-worker、渠道adapter、deliveryOnly | 固定最终版本，发前检查，ACK未知单独恢复，不重做业务 |
| 额度与成本 | 现有双账本、billingSnapshot、唯一事件键 | 维持收费合同，逐事件对账，模型/工具成本与用户额度分别计量 |
| 观测 | Pi telemetry、agentTrace、Broker事件 | 入库前最小化；真实usage/延迟；不记录隐藏推理或原始私密参数 |

这不是八个新服务。优先复用现有结构；只有缺少的语义才补字段或模块。主要接线点仍是 `apps/reps` 输入入口、`apps/conversation-worker/src/processor-pi.ts`、`packages/model-runtime/src/pi/`、`apps/compute-broker/src/` 与 `packages/web-data/src/`。

## 13. 用原始问题走一遍

```mermaid
flowchart TD
    input["使用沙盒浏览器查询某公司今天的股票信息"] --> scope["验证身份、公开问答范围和可用消费额度"]
    scope --> task["记录对象、今天、浏览器方法及所需公开事实"]
    task --> context["注入必要规则和可见工具；不预取所有者知识或天气"]
    context --> agent["主Agent识别动态公开信息和指定浏览器方法"]
    agent --> ambiguity["重要市场歧义澄清，或可行时分别查询并标注"]
    ambiguity --> browserGate["服务端检查浏览器有效策略、目标及数据外发"]
    browserGate --> policy{"allow / ask / deny"}
    policy -->|"allow或ask已有有效批准"| publicBrowser["PUBLIC All-in-One 浏览器读取相关公开页面"]
    policy -->|"ask且无有效批准"| pending["暂停并等待有效审批"]
    pending -->|"认证批准事件回填原动作"| browserGate
    policy -->|"deny"| unavailable["说明当前限制，不调用无关工具替代"]
    publicBrowser --> evidence["获取市场、币种、数据时间、行情状态和来源"]
    evidence --> quality{"取得足够且可核实的信息？"}
    quality -->|"是"| answer["按证据回答；不冒充所有者观点或投资承诺"]
    quality -->|"否"| fallback["有界尝试相关获准页面，或说明缺失数据"]
    fallback --> answer
    answer --> verify["核对方法、依据、时间、可披露范围和最终状态"]
    verify --> delivery["交付答案和公开来源，记录实际usage"]
    unavailable --> delivery
```

这条链路不需要新增“股票专用Agent”，也不需要为100个场景各写一个工具。天气能力只有在确实缺天气信息时才适用；通用浏览器可承担不同领域的公开网页读取，但并不保证所有网站可访问或所有数据实时。

## 14. 哪些已有，哪些本轮改，哪些以后再做

| 部分 | 已有基础或自检证据 | 本轮目标 | 后续/条件性扩展 |
| --- | --- | --- | --- |
| 前置入口 | 已有status/cancel分支和身份/准入机制 | 将本人旧任务管理放到新服务准入前；补任务修订语义 | 不新增独立语义路由模型 |
| 主Agent与工具 | 已有Pi循环、小规模可见目录、按需Skill/知识读取 | 统一规则、工具分类、有效策略与任务依据义务 | 大目录发现/裁剪、只读并行需收益证据 |
| 审批恢复 | 已有通知、payload hash、重验、部分CAS与晚回调保护 | 补端到端动作身份、原key、派发代次和跨运行unknown | 提供方不支持的保证不作承诺 |
| 资料治理 | 已有MemoryUseRun与出站检查，隔离PG子项通过 | 扩展到派生参数/checkpoint/文件/实际接收者 | 更广缓存先评估，不默认新建 |
| 沙盒 | 已接PUBLIC AIO与浏览器适配 | 风险标签不放权、profile真实约束、访客隔离验证 | SANDBOX/VPC按需要另测 |
| 文件 | Pi当前主要stdout转单文本，浏览器有独立截图能力 | 限定真实支持格式，校验内容和下载 | 二进制/多文件逐项验收后声明 |
| 输出 | v2已有草稿缓冲，受控简单文本为2次模型 | 先试符合条件的一次主模型，硬检查仍在 | 真流式单独验证，不作为首批前提 |
| 交付/账本 | 已有Outbox、交付恢复、账本幂等基础 | 补业务成功/ACK丢失联合故障和PG失败闭环 | 不重设计收费合同 |

首批M1覆盖直接体验改善与必要边界；M2/M3完成相关高风险能力闭环。P0未满足时只限制受影响路径，不把普通公开查询等待全部新功能完成作为默认策略。图中“后续”分支在验收并发布能力之前不向模型承诺可用。

## 15. 图的检查范围

本文件为架构与数据流设计。Mermaid语法校验不代表实现通过；真实执行、权限、取消竞态、来源撤回、文件字节、下载、渠道回执和账本仍按R01–R16、T01–T22及新旧质量对照验收。代码实现已经另行开展，完成范围以实施记录为准；没有进行部署。
