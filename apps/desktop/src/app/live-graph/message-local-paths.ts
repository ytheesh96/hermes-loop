import { previewMarkdownHref } from '@/lib/preview-targets'

const TRAILING_PUNCTUATION = /[.,;:!?]+$/
const MARKDOWN_LABEL_CHARACTERS = /[\\`*_()[\]{}#+!|>~-]/g
const BLOCK_HTML_TAGS =
  /^(?:address|article|aside|blockquote|details|dialog|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)$/i

function escapeMarkdownLabel(value: string) {
  return value.replace(MARKDOWN_LABEL_CHARACTERS, '\\$&')
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

function containsControlCharacter(value: string) {
  return [...value].some(character => character <= '\u001f' || character === '\u007f')
}

function findClosingQuote(text: string, start: number, quote: string) {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1
      continue
    }
    if (text[index] === quote) {
      return index
    }
  }
  return -1
}

function scanPlainText(text: string) {
  let output = ''
  let index = 0

  while (index < text.length) {
    const character = text[index]

    if ((character === '"' || character === "'") && text[index + 1] === '/') {
      const end = findClosingQuote(text, index + 2, character)
      const path = end >= 0 ? text.slice(index + 1, end) : ''

      if (end < 0) {
        output += text.slice(index)
        break
      }

      if (!containsControlCharacter(path) && isAbsolutePath(path)) {
        output += character + pathLink(path) + character
        index = end + 1
        continue
      }

      output += text.slice(index, end + 1)
      index = end + 1
      continue
    }

    if (character === '/' && isPathBoundary(text, index)) {
      const lineEnd = text.indexOf('\n', index)
      const line = text.slice(index, lineEnd >= 0 ? lineEnd : text.length)
      const linePath = line.replace(TRAILING_PUNCTUATION, '')

      if (
        /\s/.test(linePath) &&
        isAbsolutePath(linePath) &&
        /\/[^/\s]+(?:\s+[^\s]+)+\.[^\s./]+$/.test(linePath) &&
        !/\s+\//.test(linePath) &&
        !/[`'"<>[\]]/.test(linePath)
      ) {
        output += pathLink(linePath)
        output += line.slice(linePath.length)
        index += line.length
        continue
      }

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
      output += text.slice(index)
      break
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
      output += text.slice(index)
      break
    }

    if (text[index] === '<') {
      if (text.startsWith('<!--', index)) {
        const commentEnd = text.indexOf('-->', index + 4)
        output += commentEnd >= 0 ? text.slice(index, commentEnd + 3) : text.slice(index)
        if (commentEnd < 0) {
          break
        }
        index = commentEnd + 3
        continue
      }
      const end = text.indexOf('>', index + 1)
      const tagMatch = end >= 0 ? text.slice(index + 1, end).match(/^\/?([a-z][\w-]*)\b/i) : null
      if (tagMatch?.[1] && BLOCK_HTML_TAGS.test(tagMatch[1]) && !text.slice(index, end + 1).startsWith('</')) {
        const closeTag = new RegExp(`</${tagMatch[1]}\\s*>`, 'i').exec(text.slice(end + 1))
        if (closeTag) {
          const blockEnd = end + 1 + closeTag.index + closeTag[0].length
          output += text.slice(index, blockEnd)
          index = blockEnd
          continue
        }
        output += text.slice(index)
        break
      }
      if (end >= 0 && /^(?:https?:\/\/|\/|[a-z][\w-]+(?:\s|>))/i.test(text.slice(index + 1, end))) {
        output += text.slice(index, end + 1)
        index = end + 1
        continue
      }
    }

    if (text[index] === '[' || (text[index] === '!' && text[index + 1] === '[')) {
      const start = text[index] === '!' ? index + 1 : index
      let labelDepth = 1
      let labelEnd = start + 1
      while (labelEnd < text.length && labelDepth > 0) {
        if (text[labelEnd] === '\\') {
          labelEnd += 2
        } else if (text[labelEnd] === '[') {
          labelDepth += 1
        } else if (text[labelEnd] === ']') {
          labelDepth -= 1
        }
        labelEnd += 1
      }
      if (labelDepth === 0) {
        if (text[labelEnd] === '(') {
          let depth = 1
          let destinationEnd = labelEnd + 1
          while (destinationEnd < text.length && depth > 0) {
            if (text[destinationEnd] === '\\') {
              destinationEnd += 2
            } else if (text[destinationEnd] === '(') {
              depth += 1
            } else if (text[destinationEnd] === ')') {
              depth -= 1
            }
            destinationEnd += 1
          }
          if (depth === 0) {
            output += text.slice(index, destinationEnd)
            index = destinationEnd
            continue
          }
        } else if (text[labelEnd] === '[') {
          const referenceEnd = text.indexOf(']', labelEnd + 1)
          if (referenceEnd >= 0) {
            output += text.slice(index, referenceEnd + 1)
            index = referenceEnd + 1
            continue
          }
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
