// Temporary diagnostic: dump the exact outgoing request shape to stderr.
export const name = 'dump-request'
export const inject = ['llm']

export function apply(ctx) {
  let n = 0
  ctx.on('llm/stream', (options, next) => {
    n += 1
    const i = n
    process.stderr.write(`\n===== LLM REQUEST #${i} provider=${options.provider} model=${options.model} =====\n`)
    process.stderr.write(`tools: ${(options.tools ?? []).length}  messages: ${options.messages.length}\n`)
    options.messages.forEach((m, idx) => {
      const txt = (m.content ?? [])
        .map((b) => (b.type === 'text' ? b.text : b.type === 'tool-call' ? `<tool-call ${b.name}>` : `<${b.type}>`))
        .join(' | ')
      process.stderr.write(`  [${idx}] role=${m.role} src=${m.source?.kind ?? '-'} :: ${String(txt).slice(0, 220).replace(/\n/g, '\\n')}\n`)
    })
    process.stderr.write(`===== END REQUEST #${i} =====\n\n`)
    return next()
  })
}
