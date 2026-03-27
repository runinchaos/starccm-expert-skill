---
name: starccm-expert
description: 用于回答 Simcenter STAR-CCM+ 文档问题。当前默认走 graph-peek 和 graph-read 访问受控语料；graph-peek 直接使用 STAR 原生 WebHelp 搜索索引，不再依赖图资产。未指定版本时默认 18.04，明确指定 20.06 时也走同一主路。
---

# STAR-CCM+ Expert

这个技能面向一套受控的 STAR-CCM+ 文档语料。

对 agent 来说，允许访问面只有两个动作：

- `graph-peek`
- `graph-read`

不要把这套语料当成可以任意直接扫描的普通文件集合。不要直接扫 HTML，不要绕开这个 skill。
注意：这里沿用旧名字 `graph-peek`，但它现在指的是“原生搜索索引 peek”，不是图检索。

Codex 本地脚本在这个目录下：

- `scripts/starccm-cli.mjs`
- `scripts/search-core.js`
- `package.json`

本地数据集映射文件也在这个目录同级：

- `starccm-expert.json`

配置约束：

- 代码内不要再硬编码 STAR 文档根路径
- 默认从 `starccm-expert.json` 读取 `datasets[]`
- 每条数据集至少包含：
  - `path`
  - `version`
  - `language`
- 只有临时手工排障时，才使用 `--docs-root` 覆盖配置

## 默认边界

- 用户未明确指定版本时：默认按 `18.04` 处理
- `18.04` 和 `20.06` 都走同一条主流程：
  - `graph-peek -> graph-read`
- 这两步都不依赖 `_graphs`：
  - `graph-peek` 只用 STAR 原生 WebHelp 搜索索引
  - `graph-read` 只按 `pageId -> *.html` 回读正文
- 当前默认语言可为：
  - `en`
  - `zh`
  - `zh,en`
- 新增初始搜索规则：
  - 第一次 `graph-peek` 时，默认同时覆盖：
    - `18.04`
    - `20.06`
    - `zh`
    - `en`
  - 目的不是一开始就做版本结论，而是先看两个版本、两种语言各自命中什么页面
  - 如果用户明确限制了版本或语言，再按用户限制收窄
- agent 负责柔性关键词规划
- 脚本负责把关键词送进 STAR 原生 WebHelp 搜索索引，生成 peek 卡片，并按 `pageId` 回读正文

## 版本黑话

用户有时不会直接说 `18.04` 或 `20.06`，而是会说黑话。

默认解释规则：

- `老版`：默认指 `18.04`
- `新版`：默认指 `20.06`

但要注意两条覆盖规则：

1. 如果用户在同一句或紧邻上下文里已经明确给了版本号，就以明确版本号为准
- 例如：
  - `20.06 新版里怎么改了`
  - 这里 `新版` 只是口语重复，不需要再猜

2. 如果上下文已经在做两版本对比，就不要把 `老版` / `新版` 再解释成别的版本
- 例如：
  - `老版和新版这里差在哪`
  - 默认解释成：
    - `老版 = 18.04`
    - `新版 = 20.06`

如果你采用了这种黑话解释，回答时最好直接写明一次，避免歧义：

- `下面按老版 = 18.04、新版 = 20.06 来回答。`

## 分层上下文

这个 skill 默认按分层上下文加载，不要一开始就把正文读很多页。

分层定义：

- `graph-peek` = 卡片层上下文
  - 只看：
    - `index`
    - `pageId`
    - `title`
    - `breadcrumb`
    - `breadcrumbTail`
    - `contextLine`
    - `matchedKeywords`
    - `missingKeywords`
    - `languages`
  - `pageId` 是第一公民
    - 后续 `graph-read` 直接用卡片里的 `pageId`
    - 不要从 `breadcrumbTail`、标题或路径文本里反推 `pageId`
  - `breadcrumb` 是结构化节点数组
    - 每层至少有 `title`、`pageId`、`relPath`
    - 如果你想顺着父层目录继续精读，优先用这里的父层 `pageId`
  - `breadcrumbTail` 只是显示友好的标题数组
    - 它是 `breadcrumb` 的降维视图，不是主索引键
  - `matchedKeywords` / `missingKeywords` 是当前卡片对本轮关键词的覆盖视图
    - `matchedKeywords` 表示这页命中了哪些查询关键词
    - `missingKeywords` 表示相对本轮关键词，这页还没覆盖到哪些关键词
    - 它们帮助你判断“这页适不适合精读”，不是正文证据
- `graph-read` = 正文层上下文
  - 只在你已经选定 `pageId` 后才进入

执行原则：

1. 先卡片层，再正文层
2. 没完成卡片层筛选前，不要扩大正文读取
3. 正文脚注来源必须来自已经进入正文层的 `pageId`

一句话流程：

`问题理解 -> 产出紧凑关键词列表 -> graph-peek(原生搜索索引) 返回 peekList -> agent 选择 pageId -> graph-read 精读 -> 带 citation 回答`

## 分阶段方法

把整件事理解成 `4` 个阶段，而不是“搜一下就写”。

### Phase 1: Broad Exploration

- 先用主题词做初始 peek，目标是摸清主题版图
- 先看：
  - 有没有 overview / reference / setup / limitations 这几类页
  - 两个版本、两种语言各自命中了什么
  - 当前命中的页主要落在哪些父层 breadcrumb

### Phase 2: Gap-Driven Peek

- 如果第 `1` 轮还不能支持选页，不要机械重跑同义词
- 先判断缺口属于哪一类：
  - 定义缺口
  - 设置缺口
  - 限制缺口
  - 版本差异缺口
- 然后只针对缺口补下一轮关键词

### Phase 3: Evidence Read

- 真正的证据层只在 `graph-read`
- 选定 `pageId` 后，至少要读到能支撑下面几个问题的正文：
  - 这是什么
  - 从哪里设置
  - 有什么前置条件
  - 有什么限制
  - 如果题目涉及版本差异，两个版本分别怎么说

### Phase 4: Synthesis Check

- 写答案前先自检，不满足就继续补读，而不是直接开始写
- 目标不是“已经看了几页”，而是“关键面向有没有被正文覆盖”

## 强制流程

按下面 4 步执行，不要跳步。

### 第 1 步：agent 先做关键词规划

拿到用户问题后，先自己压缩成紧凑关键词列表，不要把口语化原句直接塞给脚本。

要求：

- 每种语言产出 `2` 到 `5` 个短关键词或短短语
- 优先保留：
  - 模型名
  - 功能名
  - 设置对象
  - 初始条件 / 限制 / 选型 / 边界条件 这类主题词
- 不要把脏的整句问法原样传给脚本
- 不要机械拆成很多单词级查询
- 不要超过 `5` 个关键词；超过就说明你还没压缩好问题

如果用户是中文、英文或中英混合，并且目标版本的中英文文档都在，应该自己规划两组关键词：

- `zhQueries[]`
- `enQueries[]`

## 第 2 步：只用 graph-peek 生成 peekList

固定入口：

```bash
node ~/.codex/skills/starccm-expert/scripts/starccm-cli.mjs graph-peek \
  --config ~/.codex/skills/starccm-expert/starccm-expert.json \
  --query-list-json-zh '["壁面沸腾","初始条件"]' \
  --query-list-json-en '["wall boiling","initial conditions"]' \
  --versions 18.04 \
  --languages zh,en
```

单语示例：

```bash
node ~/.codex/skills/starccm-expert/scripts/starccm-cli.mjs graph-peek \
  --config ~/.codex/skills/starccm-expert/starccm-expert.json \
  --query-list-json '["thermal comfort model","initial conditions"]' \
  --versions 20.06 \
  --languages en
```

初始搜索的强制规则：

- 如果用户没有明确把问题限制在单一版本或单一语言
- 那么第 `1` 轮 peek 必须至少覆盖：
  - `18.04 + zh,en`
  - `20.06 + zh,en`
- 由于当前 CLI 一次只支持一个版本，所以这里通常意味着连续跑两次：

```bash
node ~/.codex/skills/starccm-expert/scripts/starccm-cli.mjs graph-peek \
  --config ~/.codex/skills/starccm-expert/starccm-expert.json \
  --query-list-json-zh '["壁面沸腾","初始条件"]' \
  --query-list-json-en '["wall boiling","initial conditions"]' \
  --versions 18.04 \
  --languages zh,en

node ~/.codex/skills/starccm-expert/scripts/starccm-cli.mjs graph-peek \
  --config ~/.codex/skills/starccm-expert/starccm-expert.json \
  --query-list-json-zh '["壁面沸腾","初始条件"]' \
  --query-list-json-en '["wall boiling","initial conditions"]' \
  --versions 20.06 \
  --languages zh,en
```

然后你再综合两次 `peekList` 来选本轮值得精读的 `pageId`。

你要把 `graph-peek` 当成“原生搜索卡片生成器”，不是答案生成器。

它的主要输出是 `peekList`。当前 `peekList` 只保留：

- `index`
- `pageId`
- `title`
- `breadcrumb`
- `breadcrumbTail`
- `contextLine`
- `matchedKeywords`
- `missingKeywords`
- `languages`

注意：

- `contextLine` 应优先来自 STAR 原生 WebHelp 搜索索引里的 `shortDescription`
- 不要再把 `peek-cache` 中正文抽取的 `leadSentence` 当成对外 peek 摘要
- `graph-peek` 不应依赖 `_graphs/*.doc-graph.json` 或 `peek-cache.json`
- `graph-peek` 的卡片和排序语义应尽量贴近原生搜索页

这一步只允许做两件事：

1. 看 `peekList` 是否覆盖了主题
2. 选出值得精读的 `pageId`

这里的 `pageId` 直接取自 `peekList` 卡片本身，不要自己再从别的字段拼。

不要在这一步直接总结答案。

## Peek 轮数上限

`graph-peek` 的 peek 轮数必须受控。

硬限制：

- 默认目标：`1` 轮 peek 解决
- 允许补充：最多再补 `2` 轮
- 总上限：最多 `3` 轮 peek

只有下面情况才允许进入下一轮 peek：

- 当前 `peekList` 明显偏题
- 当前 `peekList` 缺少核心 reference / setup / limitations 页
- 当前关键词明显过泛，需要压缩重写

到第 `3` 轮后，必须停止继续发新的 peek 检索，然后二选一：

1. 从现有 `peekList` 中选最接近的 `pageId` 去读
2. 明确说明当前 peek 覆盖不足，不能把不确定内容写成文档事实

不要出现：

- 第 4 轮、第 5 轮继续补 peek
- 每轮只微调一个无关紧要的同义词然后反复重跑
- 先跑很多轮 peek，再一次性读一堆页

## Peek 递进策略

这 `3` 轮 peek 不是机械重试，而是结构化递进。

第 `1` 轮：主题词

- 目标：先锁定主题簇
- 默认同时扫两版本、双语：
  - `18.04 + zh,en`
  - `20.06 + zh,en`
- 关键词应偏：
  - 模型名
  - 功能名
  - 对象名

第 `2` 轮：页面定位词

- 只有第 `1` 轮不能支持选页时才进入
- 目标：把候选收敛到具体页面类型
- 关键词应偏：
  - `reference`
  - `setup`
  - `limitations`
  - `initial conditions`
  - `boundary conditions`

第 `3` 轮：缺口补位词

- 只有读题后确认仍缺关键面向时才进入
- 目标：补定义 / 设置 / 限制中的缺口
- 关键词应偏：
  - 缺失的那个面向
  - 而不是重新泛搜整个主题

进入下一轮前，先自己说清楚为什么要进：

- 是主题偏了
- 还是页面类型不够
- 还是关键证据面缺失

不要无理由重跑下一轮。

## 覆盖检查单

在进入正式回答前，先做一次覆盖检查。

至少检查这几项：

- 我有没有看到 overview / reference / setup / limitations 中足够支撑本题的页面类型
- 我准备写成“文档事实”的每一句话，是否都来自已经 `graph-read` 过的 `pageId`
- 如果题目问“怎么设置”，我是否真的读到了设置页，而不只是总览页
- 如果题目问“限制 / 注意事项”，我是否真的读到了 limitation / requirement 相关页
- 如果题目涉及版本差异，我是否真的读到了两个版本，而不是只看一个版本后脑补
- 如果当前 peek 卡的 `missingKeywords` 还暴露出明显缺口，我是否已经补过这类缺口

如果上面有任意一项答案是否定的，就继续补 `peek` 或 `read`，不要提前生成结论。

## 第 3 步：agent 只根据 peekList 选择 pageId

从 `peekList` 里优先选：

- 总览页
- reference 页
- setup / workflow 页
- requirements / limitations 页
- 同一逻辑文档的双语版本

通常精读 `2` 到 `5` 个 `pageId` 就够。

不要：

- 把没精读过的 peek 项当证据
- 在看到 peek 后又自由发散做很多额外检索
- 把脚本产出的候选直接当结论

## 第 4 步：只用 graph-read 按 pageId 精读

固定命令：

```bash
node ~/.codex/skills/starccm-expert/scripts/starccm-cli.mjs graph-read \
  --config ~/.codex/skills/starccm-expert/starccm-expert.json \
  --page-ids-json '["GUID-...","GUID-..."]' \
  --versions 20.06 \
  --languages zh,en
```

单页快速读也可以：

```bash
node ~/.codex/skills/starccm-expert/scripts/starccm-cli.mjs graph-read \
  --config ~/.codex/skills/starccm-expert/starccm-expert.json \
  --page-id GUID-... \
  --version 20.06 \
  --language en
```

参数兼容规则：

- `pageId`:
  - `--page-id`
  - `--page-ids`
  - `--page-ids-json`
- 版本:
  - `--version`
  - `--versions`
- 语言:
  - `--language`
  - `--languages`

但对 agent 来说，默认仍优先用：

- `--page-ids-json`
- `--versions`
- `--languages`

这样最稳定，也最适合一次读多页。

读完后再组织答案。

回答前至少确认：

- 这是什么
- 怎么设置或从哪里进入
- 有哪些前置条件、限制或注意事项

## 检索轨迹整理卡

在组织最终答案前，先在脑中整理一个极简检索轨迹。

至少整理这 `4` 项：

- `queries`
- `peekRounds`
- `selectedPageIds`
- `footnoteSources`

含义固定：

- `queries`
  - 本题实际使用过的关键词列表
- `peekRounds`
  - 实际一共跑了几轮 `graph-peek`
- `selectedPageIds`
  - 真正进入正文层的页面
- `footnoteSources`
  - 最终写进脚注的来源

强制关系：

1. `footnoteSources` 必须是 `selectedPageIds` 的子集
2. `selectedPageIds` 必须来自 `peekList`
3. 没读过的页面不能进入脚注
4. 没进脚注的页面，不要假装它支撑了最终结论

这个轨迹默认不用完整输出给用户，但你在写答案前必须先把它想清楚。

## 回答前模板卡

在真正输出答案前，先在脑中过一遍这个极短模板：

```text
queries:
peekRounds:
selectedPageIds:
footnoteSources:
```

填写要求：

- `queries`
  - 只写本题实际使用过的关键词列表
- `peekRounds`
  - 只写实际跑了几轮 `graph-peek`
- `selectedPageIds`
  - 只写真正进入正文层的页面
- `footnoteSources`
  - 只写最终进入脚注的来源

约束关系：

- `footnoteSources ⊆ selectedPageIds`
- `selectedPageIds ⊆ peekList`

这个模板默认不需要原样输出给用户，但你必须先在脑中把这 4 行补齐，再开始写正式答案。

## 引用纪律

这个 skill 的回答必须默认可审计。

强制要求：

1. 文档事实必须逐条带 citation
2. citation 要就地挂在相关结论后面
3. 回答末尾必须有 `References`
4. 没有 citation 的句子，不得写成“文档事实”
5. 如果一句话是多页综合后的推断，必须显式写成“综合判断”

这个 skill 默认使用 Markdown 脚注，不再在正文里直接塞长 citation 字符串。

### 脚注规则

正文引用格式：

- `[^1]`
- `[^2]`

优先使用数字脚注，不要在正文里使用长名字脚注 key。

编号规则：

1. 按正文第一次出现顺序编号
2. 同一来源全文复用同一个脚注编号
3. “同一来源”的判定键是：
   - `language + version + pageId`

这意味着：

- 同一页被反复引用时，始终复用同一个 `[^n]`
- 多页共同支撑一个结论时，可以并列写：
  - `[^1][^2]`

### 回答前固定整理步骤

在真正输出答案前，必须先做一次脚注整理，不允许边写边临时乱编号。

固定顺序：

1. 先列出本次真正用到的来源
- 只收集你已经读过并且准备在答案里引用的页面
- 不要把没读过的 peek 项放进来源池

2. 对每个来源生成唯一键
- 唯一键固定为：
  - `language + version + pageId`

3. 先去重，再编号
- 先按唯一键去重
- 再按“正文第一次需要引用它的顺序”分配脚注编号
- 编号只允许是连续数字：
  - `1, 2, 3, ...`

4. 再把脚注编号回填到正文
- 先写结论和正文草稿时，可以先在脑中记来源
- 真正输出时，必须使用整理后的最终编号
- 不允许前文 `[^3]`、后文又把同页写成 `[^7]`

5. 最后生成 `References`
- 按编号升序输出脚注定义
- 不允许漏掉正文里出现过的脚注
- 不允许定义没在正文里用到的脚注

你可以把这个过程理解成一个固定 map：

```text
sourceKey -> footnoteNumber
en|18.04|GUID-AAA -> 1
zh|18.04|GUID-BBB -> 2
en|20.06|GUID-CCC -> 3
```

正文和 `References` 都必须复用这同一个 map。

### 去重与合并规则

下面这些情况必须合并成同一个脚注：

- 同一页在答案里被引用多次
- 同一页同时支撑“结论”和“文档事实”
- 同一页在不同段落里重复出现

下面这些情况不能合并：

- 不同 `pageId`
- 同一标题但不同版本
- 同一标题但不同语言且 `pageId` 不同

### 禁止的脚注错误

下面这些都算格式错误：

- 同一来源出现多个编号
- 不同来源误用同一个编号
- 编号跳号严重但没有必要
- 正文有 `[^4]`，文末没有 `[^4]: ...`
- 文末有 `[^5]: ...`，正文里根本没用 `[^5]`
- 先写完正文后随手补脚注，导致编号顺序和正文出现顺序不一致

正文示例：

- `TCM 向导启动前必须先指定 body segment 初始温度。[^1]`
- `综合判断：因此这个问题不能把人体初始状态简单理解成普通 CFD 初始场。[^1][^2]`

### 脚注内容格式

文末 `References` 区块中，不再写普通项目符号列表，而是写脚注定义。

脚注正文最少应包含：

- 语言
- 版本
- 标题
- `pageId`

推荐格式：

```md
[^1]: en 18.04 | Wall Boiling | pageId=GUID-4066F39A-214D-4D60-8323-94DED7611B73
[^2]: zh 20.06 | 热舒适性向导 | pageId=GUID-...
```

如果需要补充路径或备注，可以使用脚注缩进续行：

```md
[^1]: en 18.04 | Wall Boiling | pageId=GUID-4066F39A-214D-4D60-8323-94DED7611B73
  Path: en_STARCCMP_18.04/GUID-4066F39A-214D-4D60-8323-94DED7611B73.html
```

不要在正文里再写：

- `[en 18.04 | ... | GUID-...]`
- 长串括号 citation
- 普通链接式来源列表替代脚注

## 回答结构

固定结构：

1. 先给结论
2. 再分开写：
   - `文档事实`
   - `综合判断`
3. 文档事实逐条挂 citation
4. 末尾列 `References`

`References` 固定格式：

- 标题仍然叫 `References`
- 标题下面直接写脚注定义
- 不再单独写普通项目符号来源列表

## 禁止事项

下面这些都不允许：

- 使用任何旧检索接口
- 直接扫原始 HTML
- 先走通用 web / 全局文件搜索再回来
- 把整句口语问题原样塞给脚本
- 只看 peek 不精读就下结论
- 只给最终来源列表，不给正文逐条 citation

## 速记规则

- 每种语言关键词最多 `5` 个。
- peek 最多 `3` 轮。
- 先规划关键词，再 peek，再按 `pageId` 精读。
- 当前对外只认 `graph-peek` 和 `graph-read`。
- agent 负责柔性理解；脚本负责硬检索。
- `18.04` 默认走 `peek -> read`，`20.06` 明确指定时也走 `peek -> read`。
