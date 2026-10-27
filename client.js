/**
 * Client half of html-view。
 *
 * 让助手正文里的原始 HTML 块直接以渲染后的样子出现在原位，而不是一串转义源码。
 *
 * 做法：在 `conversation.chat.node` 的 `assistant-step` 键上以更高优先级（priority -1）
 * 注册一层薄外壳。外壳自己不渲染 Markdown —— 它找到官方注册的 assistant 渲染器，
 * 只把 text block 里的顶层 HTML 段切出来，改写成一个携带 HTML 标记的 image block，
 * 再把改写后的 node 交还官方渲染器。Markdown / 表格 / KaTeX / Shiki / 思考行 /
 * 流式输出 / 文件链接全部仍由官方代码完成。官方渲染器渲染图片组时会调用
 * renderSlot('conversation.chat.message.images')，外壳提供的 renderSlot 在那里认出
 * HTML 标记，画成沙箱 iframe；真图片和思考正文继续交给各自槽位当前的胜出注册。
 *
 * 外壳崩溃时，槽位系统会把它退位并回落到官方渲染器，所以最坏情况是回到原来的显示。
 * 复制、轮次尾栏、模型上下文读的都是原始 node 数据，不受改写影响。
 *
 * 另外保留 `render_html` 的工具视图，旧会话里已有的工具卡片照常显示。
 */

window.__ModuleLoader__.load({
  id: 'dsh-html-view',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // ───────────────────────── 常量 ─────────────────────────

    /** 外壳的注册优先级；数值越小越优先，官方渲染器在 0。 */
    const SHELL_PRIORITY = -1
    const NODE_SLOT = 'conversation.chat.node'
    const ASSISTANT_KEY = 'assistant-step'
    const IMAGES_SLOT = 'conversation.chat.message.images'
    const REASONING_SLOT = 'conversation.chat.reasoning.body'
    const IMAGES_FACTORY = 'conversation.images.content'
    const REASONING_FACTORY = 'conversation.chat.reasoning.content'

    /** 合成 image block 上携带 HTML 段的私有标记。 */
    const HTML_MARK = Symbol.for('dsh-html-view/segment')

    /** 能开启一个 HTML 段的块级标签（行首出现时才算）。 */
    const BLOCK_TAGS = new Set([
      'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
      'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'svg', 'style',
      'ul', 'ol', 'li', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre',
      'details', 'summary', 'form', 'fieldset', 'dl', 'hr', 'center',
    ])
    /** 不需要结束标签的元素。 */
    const VOID_TAGS = new Set([
      'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
      'param', 'source', 'track', 'wbr',
    ])
    /** 内容按原文处理的元素：内部出现的 `<` 不算标签。 */
    const RAW_TEXT_TAGS = new Set(['style', 'script', 'textarea', 'title'])

    /** iframe 高度范围（CSS 像素）。 */
    const MIN_FRAME_HEIGHT = 24
    const MAX_FRAME_HEIGHT = 2400
    const INITIAL_FRAME_HEIGHT = 120

    /** 流式期间 srcdoc 的重建节奏：随内容变长而放缓，避免逐 token 重排闪烁。 */
    const PACE_MIN_MS = 250
    const PACE_MAX_MS = 4000
    const PACE_CHARS_PER_MS = 2000

    /** iframe 内的内容安全策略：不联网、不执行脚本，只允许内联样式与 data: 资源。 */
    const FRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:"

    /** iframe 内的基础样式；作者样式写在后面，因此总能覆盖它。 */
    const BASE_CSS = [
      'html{margin:0;padding:0;background:transparent;overflow:auto}',
      'body{margin:0;padding:0;display:flow-root;overflow-wrap:anywhere}',
      'img{max-width:100%;height:auto}',
      'svg{max-width:100%}',
      'a{pointer-events:none;color:inherit}',
    ].join('')

    /** 透传进 iframe 的宿主主题变量。 */
    const THEME_TOKENS = [
      '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2',
      '--dsw-alias-bg-overlay', '--dsw-alias-border-l1', '--dsw-alias-border-l2',
      '--dsw-alias-brand-primary', '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
      '--dsw-alias-state-error-primary', '--dsw-alias-state-idle-primary',
      '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary',
    ]
    const THEME_STYLE_ID = '__dsh_html_view_theme'

    // ───────────────────────── 段落切分（纯函数） ─────────────────────────

    /**
     * 把文本拆成行，记录每行内容的起止偏移（不含换行符）和下一行的起点。
     * @param {string} text 原文。
     * @returns {{ start: number, end: number, next: number }[]} 行表。
     */
    function splitLines(text) {
      const lines = []
      let start = 0
      while (start <= text.length) {
        const nl = text.indexOf('\n', start)
        const stop = nl < 0 ? text.length : nl
        const end = stop > start && text.charCodeAt(stop - 1) === 13 ? stop - 1 : stop
        lines.push({ start, end, next: nl < 0 ? text.length : nl + 1 })
        if (nl < 0) break
        start = nl + 1
      }
      return lines
    }

    /**
     * 识别代码围栏的开启行。
     * @param {string} line 一行文本。
     * @returns {{ char: string, size: number } | null} 围栏信息。
     */
    function openFence(line) {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (m === null) return null
      // 反引号围栏的信息串里不能再出现反引号
      if (m[1][0] === '`' && m[2].includes('`')) return null
      return { char: m[1][0], size: m[1].length }
    }

    /**
     * 判断一行是否关闭当前围栏。
     * @param {string} line 一行文本。
     * @param {{ char: string, size: number }} fence 当前围栏。
     * @returns {boolean} 是否关闭。
     */
    function closesFence(line, fence) {
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      return m !== null && m[1][0] === fence.char && m[1].length >= fence.size
    }

    /**
     * 判断一行是否开启 HTML 段，并给出段的种类和 `<` 所在的列。
     * @param {string} line 一行文本。
     * @returns {{ kind: 'document' | 'fragment', column: number } | null} 段起点。
     */
    function htmlStart(line) {
      const m = /^( {0,3})<(!doctype\b|[a-zA-Z][a-zA-Z0-9-]*)/i.exec(line)
      if (m === null) return null
      const column = m[1].length
      const name = m[2].toLowerCase()
      if (name === '!doctype') return { kind: 'document', column }
      const after = line.charAt(column + 1 + m[2].length)
      if (after !== '' && !/[\s>/]/.test(after)) return null
      if (name === 'html') return { kind: 'document', column }
      return BLOCK_TAGS.has(name) ? { kind: 'fragment', column } : null
    }

    /**
     * 从 `<` 之后找标签的结束 `>`，跳过引号里的内容。
     * @param {string} text 原文。
     * @param {number} from 搜索起点。
     * @returns {number} `>` 的偏移；找不到时为 -1。
     */
    function findTagEnd(text, from) {
      let quote = ''
      for (let i = from; i < text.length; i++) {
        const c = text[i]
        if (quote !== '') {
          if (c === quote) quote = ''
        } else if (c === '"' || c === "'") {
          quote = c
        } else if (c === '>') {
          return i
        }
      }
      return -1
    }

    /**
     * 从片段起点开始按标签配对扫描，找到顶层元素闭合的位置。
     * 用栈而不是计数：遇到结束标签时一直弹到同名元素，这样 `<li>`、`<p>` 这类
     * 省略结束标签的写法也能收口。
     * @param {string} text 原文。
     * @param {number} from 段起点（`<` 的偏移）。
     * @returns {number} 闭合标签之后的偏移；未闭合时为 -1。
     */
    function scanFragmentEnd(text, from) {
      const stack = []
      let seenTag = false
      let i = from
      while (i < text.length) {
        const lt = text.indexOf('<', i)
        if (lt < 0) return -1
        if (text.startsWith('<!--', lt)) {
          const close = text.indexOf('-->', lt + 4)
          if (close < 0) return -1
          i = close + 3
          continue
        }
        const next = text.charAt(lt + 1)
        if (next === '!' || next === '?') {
          const close = text.indexOf('>', lt + 2)
          if (close < 0) return -1
          i = close + 1
          continue
        }
        if (next === '/') {
          const m = /^<\/([a-zA-Z][a-zA-Z0-9-]*)/.exec(text.slice(lt, lt + 64))
          if (m === null) { i = lt + 1; continue }
          const close = findTagEnd(text, lt + m[0].length)
          if (close < 0) return -1
          const name = m[1].toLowerCase()
          const at = stack.lastIndexOf(name)
          if (at >= 0) stack.length = at
          i = close + 1
          if (seenTag && stack.length === 0) return i
          continue
        }
        const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(text.slice(lt, lt + 64))
        if (m === null) { i = lt + 1; continue }
        const close = findTagEnd(text, lt + m[0].length)
        if (close < 0) return -1
        const name = m[1].toLowerCase()
        const selfClosing = text.charAt(close - 1) === '/'
        seenTag = true
        i = close + 1
        if (RAW_TEXT_TAGS.has(name) && !selfClosing) {
          // 原文元素：直接跳到它的结束标签，整体视作一个原子
          const re = new RegExp(`</${name}\\s*>`, 'ig')
          re.lastIndex = i
          const end = re.exec(text)
          if (end === null) return -1
          i = end.index + end[0].length
        } else if (!VOID_TAGS.has(name) && !selfClosing) {
          stack.push(name)
        }
        if (stack.length === 0) return i
      }
      return -1
    }

    /**
     * 整页文档在 `</html>` 处结束。
     * @param {string} text 原文。
     * @param {number} from 段起点。
     * @returns {number} `</html>` 之后的偏移；未闭合时为 -1。
     */
    function scanDocumentEnd(text, from) {
      const re = /<\/html\s*>/ig
      re.lastIndex = from
      const m = re.exec(text)
      return m === null ? -1 : m.index + m[0].length
    }

    /**
     * 把一段助手文本拆成 Markdown 段与顶层 HTML 段。
     *
     * - 代码围栏（``` 与 ~~~）里的内容一律不动，因此 ```html 代码块仍按代码显示。
     * - 段起点：围栏外、缩进不超过 3 格、以 `<!doctype` / `<html` / 块级标签开头的行。
     * - 段终点：按标签配对，不按空行切；整页文档到 `</html>` 为止；闭合行的剩余部分归入该段。
     * - 未闭合时：流式中延伸到文末（complete=false），已落定则退回 CommonMark 规则到首个空行。
     *
     * @param {string} text 原文。
     * @param {{ streaming?: boolean }} [options] 是否仍在流式输出。
     * @returns {Array<{ kind: 'md', text: string } | { kind: 'html', html: string, document: boolean, complete: boolean }> | null}
     *   没有 HTML 段时返回 null，调用方据此复用原数据。
     */
    function splitHtmlSegments(text, options) {
      if (typeof text !== 'string' || !text.includes('<')) return null
      const streaming = options !== undefined && options.streaming === true
      const lines = splitLines(text)
      const out = []
      let mdStart = 0
      let fence = null
      let found = false
      let i = 0

      const pushMd = (value) => {
        if (value.trim() !== '') out.push({ kind: 'md', text: value })
      }

      while (i < lines.length) {
        const line = text.slice(lines[i].start, lines[i].end)
        if (fence !== null) {
          if (closesFence(line, fence)) fence = null
          i += 1
          continue
        }
        const opened = openFence(line)
        if (opened !== null) {
          fence = opened
          i += 1
          continue
        }
        const start = htmlStart(line)
        if (start === null) {
          i += 1
          continue
        }

        const from = lines[i].start + start.column
        const end = start.kind === 'document' ? scanDocumentEnd(text, from) : scanFragmentEnd(text, from)
        let segEnd
        let nextLine
        let complete = true
        if (end >= 0) {
          let j = i
          while (j + 1 < lines.length && lines[j + 1].start < end) j += 1
          segEnd = lines[j].end
          nextLine = j + 1
        } else if (streaming) {
          segEnd = text.length
          nextLine = lines.length
          complete = false
        } else {
          let k = i + 1
          while (k < lines.length && text.slice(lines[k].start, lines[k].end).trim() !== '') k += 1
          segEnd = lines[k - 1].end
          nextLine = k
        }

        pushMd(text.slice(mdStart, lines[i].start))
        out.push({ kind: 'html', html: text.slice(lines[i].start, segEnd), document: start.kind === 'document', complete })
        mdStart = nextLine < lines.length ? lines[nextLine].start : text.length
        found = true
        i = nextLine
      }

      if (!found) return null
      pushMd(text.slice(mdStart))
      return out
    }

    /**
     * 把 assistant node 的 blocks 中含 HTML 的 text block 拆开，HTML 段改写成带标记的 image block。
     * @param {readonly any[]} blocks 原 blocks。
     * @param {boolean} streaming 该 node 是否仍在流式输出。
     * @returns {readonly any[]} 改写后的 blocks；无需改写时返回同一个数组引用。
     */
    function rewriteBlocks(blocks, streaming) {
      if (!Array.isArray(blocks)) return blocks
      let changed = false
      const out = []
      for (const block of blocks) {
        if (block !== null && typeof block === 'object' && block.kind === 'text' && typeof block.text === 'string') {
          const segments = splitHtmlSegments(block.text, { streaming })
          if (segments !== null) {
            changed = true
            for (const segment of segments) {
              if (segment.kind === 'md') {
                out.push({ ...block, text: segment.text })
              } else {
                out.push({
                  kind: 'image',
                  attachment: { [HTML_MARK]: { html: segment.html, document: segment.document, complete: segment.complete } },
                })
              }
            }
            continue
          }
        }
        out.push(block)
      }
      return changed ? out : blocks
    }

    /**
     * 判断 image 项是否是外壳合成的 HTML 段。
     * @param {any} image 图片组里的一项。
     * @returns {boolean} 是否为 HTML 段。
     */
    function isHtmlImage(image) {
      return image !== null && typeof image === 'object' && image.attachment !== null
        && typeof image.attachment === 'object' && image.attachment[HTML_MARK] !== undefined
    }

    // ───────────────────────── iframe 文档组装（纯函数） ─────────────────────────

    /**
     * 去掉 meta refresh，预览绝不触发导航。
     * @param {string} html HTML 源。
     * @returns {string} 清理后的 HTML。
     */
    function stripMetaRefresh(html) {
      return html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '')
    }

    /**
     * 组装 iframe 的 srcdoc：CSP 与基础样式放在最前，作者内容在后，作者样式因此能覆盖默认值。
     * @param {string} html HTML 源。
     * @param {boolean} isDocument 是否为整页文档。
     * @param {string} themeCss 宿主主题样式。
     * @returns {string} srcdoc 文本。
     */
    function buildSrcDoc(html, isDocument, themeCss) {
      const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`
        + `<style>${BASE_CSS}</style><style id="${THEME_STYLE_ID}">${themeCss}</style>`
      const source = stripMetaRefresh(html)
      if (!isDocument) return `<!doctype html><html><head>${head}</head><body>${source}</body></html>`
      const headTag = /<head(?:\s[^>]*)?>/i.exec(source)
      if (headTag !== null) {
        const at = headTag.index + headTag[0].length
        return source.slice(0, at) + head + source.slice(at)
      }
      const htmlTag = /<html(?:\s[^>]*)?>/i.exec(source)
      if (htmlTag !== null) {
        const at = htmlTag.index + htmlTag[0].length
        return `${source.slice(0, at)}<head>${head}</head>${source.slice(at)}`
      }
      return head + source
    }

    /**
     * 清理将写进 `<style>` 的值，避免意外闭合样式元素。
     * @param {string} value 计算样式值。
     * @returns {string} 安全值。
     */
    function cssValue(value) {
      return String(value).replace(/[<>{}]/g, '').trim()
    }

    /**
     * 从宿主元素读出主题：主题变量、文字色、字体与配色方案。
     * 配色方案必须与宿主一致，否则浏览器会给 iframe 画上不透明底色。
     * @param {Element | null} element 读取计算样式的宿主元素。
     * @returns {string} 写进 iframe 的主题样式。
     */
    function readThemeCss(element) {
      if (typeof getComputedStyle !== 'function' || typeof document === 'undefined') return ''
      const target = element ?? document.body ?? document.documentElement
      if (!target) return ''
      const own = getComputedStyle(target)
      const root = getComputedStyle(document.documentElement)
      const vars = []
      for (const name of THEME_TOKENS) {
        const value = cssValue(own.getPropertyValue(name))
        if (value !== '') vars.push(`${name}:${value};`)
      }
      const scheme = cssValue(root.colorScheme || '') || 'normal'
      return `:root{${vars.join('')}color-scheme:${scheme};}`
        + `body{color:${cssValue(own.color)};font-family:${cssValue(own.fontFamily)};`
        + `font-size:${cssValue(own.fontSize)};line-height:${cssValue(own.lineHeight)};}`
    }

    /**
     * 量出 iframe 内容的实际高度。body 是 flow-root，高度不受 iframe 视口影响，因此能缩也能涨。
     * @param {HTMLIFrameElement} iframe 目标 iframe。
     * @returns {number | null} 内容高度；文档未就绪时为 null。
     */
    function measureFrame(iframe) {
      try {
        const doc = iframe.contentDocument
        const win = iframe.contentWindow
        if (!doc || !doc.body || !win) return null
        const rect = doc.body.getBoundingClientRect()
        const style = win.getComputedStyle(doc.body)
        const margins = (Number.parseFloat(style.marginTop) || 0) + (Number.parseFloat(style.marginBottom) || 0)
        return Math.ceil(rect.height + margins)
      } catch {
        return null
      }
    }

    // ───────────────────────── React 视图 ─────────────────────────

    /** 渲染出错时只吞掉自己这一格，不连累整条消息。 */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.error('[html-view] 渲染失败：', error)
      }

      render() {
        return this.state.failed ? null : this.props.children
      }
    }

    /**
     * 流式期间按节奏放出最新值，落定后立即给出最终值。
     * @param {string} value 最新值。
     * @param {boolean} active 是否在流式中。
     * @returns {string} 当前应显示的值。
     */
    function usePacedValue(value, active) {
      const [paced, setPaced] = React.useState(value)
      const latest = React.useRef(value)
      latest.current = value
      React.useEffect(() => {
        if (!active) return undefined
        setPaced(latest.current)
        let timer
        const schedule = () => {
          const interval = Math.min(PACE_MAX_MS, Math.max(PACE_MIN_MS, latest.current.length / PACE_CHARS_PER_MS))
          timer = setTimeout(() => {
            setPaced(latest.current)
            schedule()
          }, interval)
        }
        schedule()
        return () => clearTimeout(timer)
      }, [active])
      return active ? paced : value
    }

    /**
     * 把一段 HTML 渲染进沙箱 iframe：无脚本、无网络、无导航，高度随内容自适应，主题随宿主切换。
     * @param {{ html: string, document?: boolean, complete?: boolean }} props HTML 段。
     * @returns {any} React 元素。
     */
    function HtmlFrame(props) {
      const html = typeof props.html === 'string' ? props.html : ''
      const isDocument = props.document === true
      const paced = usePacedValue(html, props.complete === false)
      const wrapRef = React.useRef(null)
      const frameRef = React.useRef(null)
      const themeRef = React.useRef(null)
      if (themeRef.current === null) themeRef.current = readThemeCss(null)
      const [height, setHeight] = React.useState(INITIAL_FRAME_HEIGHT)
      const srcDoc = React.useMemo(() => buildSrcDoc(paced, isDocument, themeRef.current), [paced, isDocument])

      React.useLayoutEffect(() => {
        const iframe = frameRef.current
        if (!iframe) return undefined
        let disposed = false
        let resizeObserver
        let mutationObserver
        let observedDoc
        let lastHeight = -1

        const sync = () => {
          if (disposed) return
          const measured = measureFrame(iframe)
          if (measured === null) return
          const next = Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, measured))
          if (Math.abs(next - lastHeight) >= 1) {
            lastHeight = next
            setHeight(next)
          }
        }

        const applyTheme = () => {
          const css = readThemeCss(wrapRef.current)
          themeRef.current = css
          const doc = iframe.contentDocument
          const style = doc && doc.getElementById(THEME_STYLE_ID)
          if (style && style.textContent !== css) style.textContent = css
          sync()
        }

        const observe = () => {
          if (resizeObserver) resizeObserver.disconnect()
          if (mutationObserver) mutationObserver.disconnect()
          if (observedDoc) observedDoc.removeEventListener('load', sync, true)
          const doc = iframe.contentDocument
          if (!doc || !doc.body) return
          observedDoc = doc
          applyTheme()
          if (typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(sync)
            resizeObserver.observe(doc.body)
          }
          if (typeof MutationObserver !== 'undefined') {
            mutationObserver = new MutationObserver(sync)
            mutationObserver.observe(doc.body, { childList: true, subtree: true, characterData: true, attributes: true })
          }
          // 图片等子资源加载完成后再量一次
          doc.addEventListener('load', sync, true)
          if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(sync, () => {})
        }

        // 宿主切换明暗主题时，直接改写 iframe 里的主题样式，不重建文档
        const themeObserver = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(applyTheme)
        if (themeObserver) {
          themeObserver.observe(document.documentElement, { attributes: true })
          if (document.body) themeObserver.observe(document.body, { attributes: true })
        }
        const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined
        if (media && media.addEventListener) media.addEventListener('change', applyTheme)

        observe()
        iframe.addEventListener('load', observe)
        window.addEventListener('resize', sync)
        return () => {
          disposed = true
          if (resizeObserver) resizeObserver.disconnect()
          if (mutationObserver) mutationObserver.disconnect()
          if (themeObserver) themeObserver.disconnect()
          if (observedDoc) observedDoc.removeEventListener('load', sync, true)
          if (media && media.removeEventListener) media.removeEventListener('change', applyTheme)
          iframe.removeEventListener('load', observe)
          window.removeEventListener('resize', sync)
        }
      }, [srcDoc])

      return h('div', {
        ref: wrapRef,
        'data-html-view': '',
        style: { display: 'block', width: '100%', margin: '8px 0' },
      }, h('iframe', {
        ref: frameRef,
        srcDoc,
        sandbox: 'allow-same-origin',
        referrerPolicy: 'no-referrer',
        title: 'HTML',
        loading: 'eager',
        style: { display: 'block', width: '100%', height: `${height}px`, border: '0', background: 'transparent' },
      }))
    }

    /**
     * 生成绑定到插件 ctx 的外壳组件。
     * @param {any} ctx 客户端插件上下文。
     * @returns {{ AssistantShell: Function, injectProxy: Function }} 外壳组件与 inject 代理。
     */
    function createShell(ctx) {
      const slots = ctx.slots

      /**
       * 找到被外壳遮住的那个 assistant 渲染器：同键、优先级低于外壳的最高者。
       * @returns {any | null} 官方注册。
       */
      function findOfficial() {
        let list
        try {
          list = slots.entries(NODE_SLOT)
        } catch {
          return null
        }
        if (!Array.isArray(list)) return null
        let best = null
        for (const entry of list) {
          if (!entry || !entry.options || entry.options.key !== ASSISTANT_KEY) continue
          if (entry.component === AssistantShell) continue
          const priority = entry.options.priority ?? 0
          if (priority <= SHELL_PRIORITY) continue
          const type = typeof entry.component
          if (type !== 'function' && (type !== 'object' || entry.component === null)) continue
          if (best === null || priority < (best.options.priority ?? 0)) best = entry
        }
        return best
      }

      /**
       * 订阅某个槽位的注册变化。
       * @param {string} key 槽位键。
       */
      function useSlotVersion(key) {
        React.useSyncExternalStore(
          React.useCallback((fn) => slots.subscribe(key, fn), [key]),
          () => slots.getVersion(key),
        )
      }

      /**
       * 只靠 props 就能工作的注册才直接调用；其余情况交给官方 Factory。
       * @param {any} entry 槽位注册。
       * @returns {boolean} 是否可直接调用。
       */
      function isPlainEntry(entry) {
        return entry !== undefined && entry !== null && entry.inject === undefined && entry.store === undefined
          && entry.children === undefined && entry.locale === undefined
      }

      /**
       * 渲染官方渲染器子槽位当前的胜出注册。
       * @param {{ slotKey: string, owner: any, renderFactorySlot: Function }} props 子槽位调用。
       * @returns {any} React 元素。
       */
      function ChildSlot({ slotKey, owner, renderFactorySlot }) {
        useSlotVersion(slotKey)
        let winner
        try {
          winner = slots.entriesOfSlot(slotKey)[0]
        } catch {
          winner = undefined
        }
        if (isPlainEntry(winner)) return h(winner.component, { ...owner, renderFactorySlot })
        if (typeof renderFactorySlot !== 'function') return null
        if (slotKey === IMAGES_SLOT) {
          return renderFactorySlot(IMAGES_FACTORY, { images: owner.images, loadImage: owner.loadImage, align: owner.align })
        }
        if (slotKey === REASONING_SLOT) {
          return renderFactorySlot(REASONING_FACTORY, { text: owner.text, running: owner.running })
        }
        return null
      }

      /**
       * 图片组：HTML 段画成 iframe，连续的真图片交回图片槽位，顺序不变。
       * @param {{ owner: any, renderFactorySlot: Function }} props 图片组调用。
       * @returns {any} React 元素。
       */
      function ImagesSlot({ owner, renderFactorySlot }) {
        const images = Array.isArray(owner.images) ? owner.images : []
        if (!images.some(isHtmlImage)) return h(ChildSlot, { slotKey: IMAGES_SLOT, owner, renderFactorySlot })
        const parts = []
        let run = []
        let runStart = 0
        const flush = () => {
          if (run.length === 0) return
          parts.push(h(Boundary, { key: `i${runStart}` },
            h(ChildSlot, { slotKey: IMAGES_SLOT, owner: { ...owner, images: run }, renderFactorySlot })))
          run = []
        }
        images.forEach((image, index) => {
          if (isHtmlImage(image)) {
            flush()
            parts.push(h(Boundary, { key: `h${index}` }, h(HtmlFrame, image.attachment[HTML_MARK])))
          } else {
            if (run.length === 0) runStart = index
            run.push(image)
          }
        })
        flush()
        return h(React.Fragment, null, ...parts)
      }

      /**
       * 外壳：改写 blocks 后交给官方 assistant 渲染器。
       * @param {any} props 槽位注入的全部属性。
       * @returns {any} React 元素。
       */
      function AssistantShell(props) {
        useSlotVersion(NODE_SLOT)
        const official = findOfficial()
        const renderFactorySlot = props.renderFactorySlot
        const node = props.node
        const data = node && typeof node === 'object' ? node.data : undefined
        const blocks = data && Array.isArray(data.blocks) ? data.blocks : undefined
        const streaming = data !== undefined && data.status === 'running'
        // 官方渲染器声明了图片子槽位，合成的 image block 才有地方落脚
        const canRewrite = official !== null && official.children !== undefined && official.children !== null
          && Object.prototype.hasOwnProperty.call(official.children, IMAGES_SLOT)

        const rewritten = React.useMemo(
          () => (canRewrite && blocks !== undefined ? rewriteBlocks(blocks, streaming) : blocks),
          [canRewrite, blocks, streaming],
        )
        const nextNode = React.useMemo(
          () => (rewritten === blocks ? node : { ...node, data: { ...data, blocks: rewritten } }),
          [node, data, blocks, rewritten],
        )
        const renderSlot = React.useCallback((key, owner) => {
          if (key === IMAGES_SLOT) return h(Boundary, null, h(ImagesSlot, { owner: owner ?? {}, renderFactorySlot }))
          if (key === REASONING_SLOT) {
            return h(Boundary, null, h(ChildSlot, { slotKey: key, owner: owner ?? {}, renderFactorySlot }))
          }
          return null
        }, [renderFactorySlot])

        if (official === null) return null
        return h(official.component, { ...props, node: nextNode, renderSlot })
      }

      /**
       * inject 代理：渲染时官方注册已就位，借用它的 inject（如 presentation 钩子）。
       * @param {...any} args 渲染器传入的绑定参数。
       * @returns {Record<string, unknown>} 注入属性。
       */
      function injectProxy(...args) {
        const official = findOfficial()
        return official !== null && typeof official.inject === 'function' ? official.inject(...args) : {}
      }

      return { AssistantShell, injectProxy }
    }

    return {
      inject: ['slots'],
      /**
       * 注册正文 HTML 外壳。
       * @param {any} ctx 客户端插件上下文。
       */
      apply(ctx) {
        const slots = ctx.slots
        if (typeof slots.entries !== 'function' || typeof slots.entriesOfSlot !== 'function'
          || typeof slots.subscribe !== 'function' || typeof slots.getVersion !== 'function') {
          console.error('[html-view] 槽位接口与预期不符，正文 HTML 渲染停用')
          return
        }
        const shell = createShell(ctx)
        ctx.slots.inject(NODE_SLOT, () => ctx.slots.register({
          name: NODE_SLOT,
          key: ASSISTANT_KEY,
          priority: SHELL_PRIORITY,
          locale: 'chat',
          inject: shell.injectProxy,
        }, shell.AssistantShell))
      },
      // 仅供本地测试
      splitHtmlSegments,
      rewriteBlocks,
      buildSrcDoc,
      HTML_MARK,
    }
  },
})
