/**
 * dsh 启动加速钩子（只加速，不改行为）。
 *
 * dsh-client-modules 启动时要为浏览器端合成 20MB+ 的客户端 bundle，其中两处纯字符串
 * 操作有明显的实现缺陷（微基准实测，输出逐字节一致）：
 * - newlineCount 用 `for...of` 逐码点遍历整段文本数换行 —— 慢 56 倍；
 * - identitySectionMap 用 Array.from + join 逐项拼 sourcemap 的 mappings —— 慢 273 倍。
 *
 * 安全性：只在**原实现与已知的慢实现完全一致**时才替换（逐字符校验过），
 * dsh 升级导致代码变化时自动跳过（no-op），不会把语义改错。
 */
const TARGET = 'dsh-client-modules/lib/index.js'

/** 已知的慢实现（用于校验，必须精确匹配才动手）。 */
const SLOW_NEWLINE = 'function newlineCount(value) {\n\tlet count = 0;\n\tfor (const char of value) if (char === "\\n") count += 1;\n\treturn count;\n}'
const FAST_NEWLINE = 'function newlineCount(value) { let count = 0, i = -1; while ((i = value.indexOf("\\n", i + 1)) !== -1) count += 1; return count; }'

const SLOW_MAPPINGS = 'const mappings = Array.from({ length: newlineCount(source) }, (_, index) => index === 0 ? "AAAA" : "AACA").join(";");'
const FAST_MAPPINGS = 'const _lines = newlineCount(source); const mappings = _lines <= 0 ? "" : "AAAA" + ";AACA".repeat(_lines - 1);'

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (!url.includes(TARGET)) return result
  if (result.format !== 'module' || result.source === undefined) return result

  let source = Buffer.isBuffer(result.source) ? result.source.toString('utf8') : String(result.source)
  const applied = []

  // 逐字符校验后才替换：只有长得和实测过的慢实现一模一样才动手
  if (source.includes(SLOW_NEWLINE)) {
    source = source.replace(SLOW_NEWLINE, FAST_NEWLINE)
    applied.push('newlineCount')
  }
  if (source.includes(SLOW_MAPPINGS)) {
    source = source.replace(SLOW_MAPPINGS, FAST_MAPPINGS)
    applied.push('mappings')
  }

  if (process.env.DSH_PERF_DEBUG === '1') {
    console.error(`[perf] 客户端 bundle 合成加速: ${applied.length ? applied.join(' + ') : '未命中（跳过）'}`)
  }
  if (!applied.length) return result
  return { ...result, source }
}
