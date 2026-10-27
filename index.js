/**
 * html-view 的 Host 半边。
 *
 * 注册一个内联 Skill：`html-visualization`。它把「怎么写 HTML 块才会被正文渲染」
 * 直接教给模型。内容内嵌在包里，不依赖文件系统，装完即可用。
 */

/** Cordis 诊断用的插件名。 */
export const name = 'html-view'

/** 需要 skills 注册表。 */
export const inject = ['skills']

/** Skill 名（kebab-case）。 */
const SKILL_NAME = 'html-visualization'

/** 本 Provider 的名字，候选里的 provider 字段必须与它一致。 */
const PROVIDER_NAME = 'dsh-html-view'

/** Skill 一句话描述，展示在模型的能力目录里。 */
const SKILL_DESCRIPTION = '在回复正文里用 HTML 块做可视化表达：卡片、流程图、对比矩阵，直接渲染成画面。'

/** 排序权重，与随包分发的 Skill 同级。 */
const SKILL_RANK = 600

/** 固定 invocation：模型与用户都可以调用。 */
const SKILL_INVOCATION = { modelInvocable: true, userInvocable: true }

/** Skill 正文。 */
const SKILL_CONTENT = `# 可视化表达[丰富图谱模式]

回复采用多可视化图谱、排版美观的阅读友好型版本，方便用户阅读，提升用户阅读体验。可视化风格强制使用瑞士平面主义。

这个对话窗装了正文 HTML 渲染：回复正文里的 HTML 块会直接画成真实的样子，显示在原位，跟前后的 Markdown 连成一体。

## 怎么写才能被渲染

- HTML 块要从**行首**的块级标签开始（div、section、table、svg、figure、style 等），块的前后各空一行；
- 块内部可以换行、可以有空行，以最外层标签闭合为结束；
- 只有块级 HTML 会被渲染，写在句子中间的行内标签（b、span）仍按原文显示，强调还是用 Markdown 的粗体；
- 想给用户看 HTML **源码**时，用带 html 标注的代码块（三个反引号 + html），它按代码显示，不会被渲染。

## 以下情形优先用 HTML 块

- 逻辑与结构图：流程图、架构图、状态机、树状层级、思维导图等带节点和连线关系的内容；
- 横向对比：多维对比矩阵、优劣势对照、参数并排展示；
- 信息卡片：多字段聚合、需要视觉分组和边框隔离的密集信息；
- 节省空间：垂直排列会让内容显得割裂冗长时，用折叠、标签页等组件收拢；
- 其他情形：Markdown 列表或表格显得平淡松散、重点不清，而卡片能显著提升可读性时。

简单的表格、列表、公式、代码仍用 Markdown，它们本来就渲染得很好。可视化的唯一目标是更好地结构化展示内容，不要喧宾夺主，并在 Token 消耗与审美效果之间审慎平衡。

## 渲染环境

HTML 块在隔离沙箱里渲染：脚本不执行、外部资源（字体、图片、网址）加载不了、链接点不了。文字颜色和字体会自动跟随对话窗的明暗主题，所以默认**不要写死文字颜色和背景色**，用 currentColor、半透明的灰（如 rgba(128,128,128,.3)）做线条和分隔，深浅主题下都好看。

默认采用黑白灰的克制色调，用线条和留白建立层次，不依赖彩色渐变；需要突出重点时，可以少量使用高级的彩色。追求设计感，用简单元素搭配出高级的视觉效果。

## 必须遵守的红线

1. 只写正文片段：不写 DOCTYPE、html、head、body 这类页面框架，根元素自带内联样式；需要复杂效果可以用 style 标签加 class。
2. 图形仅限流程图、架构图、状态机、树状层级、对比矩阵、数据图表等，禁止装饰性插画、氛围图和图标。
3. 不写 script，不引用外部字体、图片、网址等网络资源，HTML 块里不放可点击的链接；需要给链接时写在 HTML 块外的 Markdown 里。
4. 每个可视化块都要服务于具体的信息需求，兼顾 Token 效率和渲染稳定性，避免过度设计。
5. 以上规则只约束回复里的可视化块；用户明确要求开发 HTML 或前端交付物时，按交付需求处理，不受上述限制。

## 示例

<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;border-top:2px solid currentColor;padding:16px 4px 4px">
  <div style="border:1px solid rgba(128,128,128,.35);padding:12px">
    <div style="font-size:10px;letter-spacing:.15em;opacity:.6">方案A</div>
    <div style="font-weight:600;margin-top:6px">快速部署</div>
    <div style="font-size:11px;opacity:.55;margin-top:6px">适合 MVP 验证</div>
  </div>
  <div style="border:1px solid rgba(128,128,128,.35);padding:12px">
    <div style="font-size:10px;letter-spacing:.15em;opacity:.6">方案B</div>
    <div style="font-weight:600;margin-top:6px">稳定扩展</div>
    <div style="font-size:11px;opacity:.55;margin-top:6px">适合长期维护</div>
  </div>
  <div style="border:1px solid rgba(128,128,128,.35);padding:12px">
    <div style="font-size:10px;letter-spacing:.15em;opacity:.6">方案C</div>
    <div style="font-weight:600;margin-top:6px">深度定制</div>
    <div style="font-size:11px;opacity:.55;margin-top:6px">适合特殊集成</div>
  </div>
</div>
`

/**
 * 构造候选摘要。
 * @returns {object} 候选对象。
 */
function createCandidate() {
  return {
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    invocation: SKILL_INVOCATION,
    source: 'bundled',
    rank: SKILL_RANK,
    provider: PROVIDER_NAME,
  }
}

/**
 * 构造完整定义。
 * @returns {object} Skill 定义。
 */
function createDefinition() {
  return {
    ...createCandidate(),
    content: SKILL_CONTENT,
  }
}

/**
 * 注册内联 Skill Provider。
 * @param ctx 带 skills 服务的插件上下文。
 */
export function apply(ctx) {
  ctx.skills.registerProvider(() => ({
    name: PROVIDER_NAME,
    /**
     * 列出本 Provider 提供的能力。
     * @returns {Promise<object[]>} 候选数组。
     */
    async list() {
      return [createCandidate()]
    },
    /**
     * 加载能力正文。
     * @returns {Promise<object>} 完整定义。
     */
    async get() {
      return createDefinition()
    },
  }))
}
