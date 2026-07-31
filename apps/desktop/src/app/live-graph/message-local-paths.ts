import { previewMarkdownHref } from '@/lib/preview-targets'

const TRAILING_PUNCTUATION = /[.,;:!?]+$/

function escapeMarkdownLabel(value: string) {
  return value.replace(/[\\[\]()]/g, '\\$&')
}

function isPathBoundary(value: string, index: number) {
  const previous = value[index - 1] || ''
  return index === 0 || /\s/.test(previous) || '([{'.includes(previous) || previous === '"' || previous === "'"
}

function pathLink(path: string) {
  return `[${escapeMarkdownLabel(path)}](${previewMarkdownHref(path)})`
}

function isAbsolutePath(path: string) {
  return path.startsWith('/') && path.length > 1 && /[^/]/.test(path)
}

function scanPlainText(text: string) {
  let output = ''
  let index = 0

  while (index < text.length) {
    const character = text[index]

    if ((character === '"' || character === "'") && text[index + 1] === '/') {
      const end = text.indexOf(character, index + 2)
      const path = end >= 0 ? text.slice(index + 1, end) : ''

      if (end >= 0 && !/[\r\n\0]/.test(path) && isAbsolutePath(path)) {
        output += character + pathLink(path) + character
        index = end + 1
        continue
      }
    }

    if (character === '/' && isPathBoundary(text, index)) {
      let end = index + 1

      while (end < text.length && !/[\s`"'<>]/.test(text[end] || '')) {
        end += 1
      }

      const token = text.slice(index, end)
      let path = token
      path = path.replace(TRAILING_PUNCTUATION, '')

      while (/[)\]}]$/.test(path)) {
        const closer = path.at(-1)
        const opener = closer === ')' ? '(' : closer === ']' ? '[' : '{'
        const opens = [...path].filter(character => character === opener).length
        const closes = [...path].filter(character => character === closer).length
        if (closes <= opens) {
          break
        }
        path = path.slice(0, -1)
      }

      if (isAbsolutePath(path)) {
        output += pathLink(path)
        output += token.slice(path.length)
        index = end
        continue
      }
    }

    output += character
    index += 1
  }

  return output
}

export function linkifyMessageLocalPaths(text: string): string {
  let output = ''
  let index = 0

  while (index < text.length) {
    const linePrefix = text.slice(text.lastIndexOf('\n', index - 1) + 1, index)
    const fence = text[index] === '`' || text[index] === '~' ? text[index] : ''
    const fenceLength = fence ? text.slice(index).match(new RegExp(`^${fence}+`))?.[0].length || 0 : 0
    if (linePrefix.length <= 3 && /^\s*$/.test(linePrefix) && fenceLength >= 3) {
      const closingFence = new RegExp(`${fence}{${fenceLength},}`)
      const closeMatch = closingFence.exec(text.slice(index + fenceLength))
      if (closeMatch) {
        const end = index + fenceLength + closeMatch.index + closeMatch[0].length
        output += text.slice(index, end)
        index = end
        continue
      }
    }

    if (text[index] === '`') {
      const run = text.slice(index).match(/^`+/)?.[0].length || 1
      const closing = text.indexOf('`'.repeat(run), index + run)
      if (closing >= 0) {
        const end = closing + run
        output += text.slice(index, end)
        index = end
        continue
      }
    }

    if (text[index] === '<') {
      const end = text.indexOf('>', index + 1)
      if (end >= 0 && /^(?:https?:\/\/|\/|[a-z][\w-]+(?:\s|>))/i.test(text.slice(index + 1, end))) {
        output += text.slice(index, end + 1)
        index = end + 1
        continue
      }
    }

    if ((text[index] === '[' || (text[index] === '!' && text[index + 1] === '['))) {
      const start = text[index] === '!' ? index + 1 : index
      const labelEnd = text.indexOf(']', start + 1)
      if (labelEnd >= 0 && text[labelEnd + 1] === '(') {
        let depth = 1
        let destinationEnd = labelEnd + 2
        while (destinationEnd < text.length && depth > 0) {
          if (text[destinationEnd] === '(') {
            depth += 1
          }
          if (text[destinationEnd] === ')') {
            depth -= 1
          }
          destinationEnd += 1
        }
        if (depth === 0) {
          output += text.slice(index, destinationEnd)
          index = destinationEnd
          continue
        }
      }
    }

    const boundaries = ['\n', '`', '<', '[']
      .map(boundary => text.indexOf(boundary, index))
      .filter(boundary => boundary >= 0)
    const end = boundaries.length ? Math.min(...boundaries) : text.length
    const plain = text.slice(index, end)
    if (!plain) {
      output += text[index]
      index += 1
      continue
    }
    output += scanPlainText(plain)
    index += plain.length
  }

  return output
}