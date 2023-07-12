import fs from 'node:fs'
import path from 'node:path'

import { walk, AST_PrefixedTemplateString } from './lib/ast.js'
import { parse } from './lib/parse.js'

const shatter = (slicable, indices) => [0, ...indices].map((e, i, a) => slicable.slice(e, a[i + 1]))
const escapeJSTL = s => s.replace(/[\\`]/g, '\\$&').replace(/\n/g, '\\n')

const reNewLines = /\n/g
const webbuilderTags = new Set([
  '_pug',
  '_styl',
  '_pugf',
  '_stylf',
  '_txtf'
])

function processTaggedTemplates(js, filePath, { processPug, processStylus }) {
  js = js.replace(/\r\n/g, '\n')
  const tts = []
  walk(parse(js, { filename: filePath, module: true }), token => {
    if (token instanceof AST_PrefixedTemplateString && webbuilderTags.has(token.prefix.name)) {
      tts.push(token)
      return true
    }
  })
  if (tts.length > 0) {
    tts.sort((a, b) => a.start.pos - b.start.pos)
    const tools = {
      processPug: s => processPug(s, filePath),
      processStylus: s => processStylus(s, filePath)
    }
    const parts = shatter(js, tts.map(t => [t.start.pos, t.start.pos + t.prefix.name.length + 2 + t.template_string.segments[0].raw.length]).flat())
    for (let i = 1; i < parts.length; i += 2) {
      const t = tts[Math.floor(i/2)]
      if (webbuilderTags.has(t.prefix.name)) {
        parts[i] = processTaggedTemplate(t, tools)
      }
    }
    return parts.join('')
  }
  return js
}

function newlines(t) {
  return Array(t.template_string.segments[0].raw.match(reNewLines)?.length ?? 0).fill('\n').join('')
}

function processTaggedTemplate(t, { processPug, processStylus }) {
  if (t.template_string.segments.length > 1) {
    throw `[WebBuilder] Interpolation is not supported in '${t.prefix.name}' tagged templates. Escaped interpolation will result in regular interpolation in the output.`
  }
  let s = t.end.value

  // Remove extra indentation from the input
  const indentSize = (s.match(/(?<=^|\n)(?!\n)\s*[^\s]/)?.[0].length ?? 1) - 1 //.reduce((a, e) => Math.min(a, e.length - 1), Infinity)
  if (indentSize > 0) {
    s = s.replace(new RegExp(`^(?!\\n)\\s{${indentSize}}`, 'gm'), '')
  }

  switch (t.prefix.name) {
    case '_pug':
      return `\`${escapeJSTL(processPug(s))}\`${newlines(t)}`
    case '_styl':
      return `\`${escapeJSTL(processStylus(s))}\`${newlines(t)}`
    case '_pugf':
      return `\`${escapeJSTL(processPug(fs.readFileSync(path.join('.', s), 'utf-8')))}\`${newlines(t)}`
    case '_stylf':
      return `\`${escapeJSTL(processStylus(fs.readFileSync(path.join('.', s), 'utf-8')))}\`${newlines(t)}`
    case '_txtf':
      return `\`${escapeJSTL(fs.readFileSync(path.join('.', s), 'utf-8'))}\`${newlines(t)}`
  }
}

export default processTaggedTemplates
