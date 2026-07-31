import { describe, expect, it } from 'vitest'

import { linkifyMessageLocalPaths } from './message-local-paths'

describe('linkifyMessageLocalPaths', () => {
  it('linkifies absolute paths and quoted paths with spaces', () => {
    expect(linkifyMessageLocalPaths("Open /tmp/report.txt and '/Users/yt/My Report.txt'.")).toBe(
      "Open [/tmp/report.txt](#preview/%2Ftmp%2Freport.txt) and '[/Users/yt/My Report.txt](#preview/%2FUsers%2Fyt%2FMy%20Report.txt)'."
    )
  })

  it('preserves protected markdown, code, URLs, and non-path text', () => {
    const text =
      '`/tmp/code.txt` [label](/tmp/link.txt) [label][ref] ![image](/tmp/image.png) https://example.test/a/b / ./relative ~/file C:\\file /'
    expect(linkifyMessageLocalPaths(text)).toBe(text)
  })

  it('preserves multi-backtick spans, indented and tilde fences, and nested links', () => {
    const text =
      '`` /tmp/code.txt ``\n   ```\n/tmp/fenced.txt\n```\n~~~\n/tmp/tilde.txt\n~~~\n[outer [inner]](/tmp/a_(b).txt)'
    expect(linkifyMessageLocalPaths(text)).toBe(text)
  })

  it('preserves unclosed quotes, escaped quotes, fences, and HTML', () => {
    const cases = [
      'unclosed "/tmp/My Report.txt',
      'escaped "/tmp/a\\"b.txt"',
      '```\n/tmp/unclosed.txt',
      '<!-- /tmp/comment.txt -->',
      '<!-- /tmp/unclosed-comment.txt',
      '<div>\n/tmp/block.txt\n</div>',
      '<div>\n/tmp/unclosed-block.txt'
    ]

    const unchanged = cases.slice(0, 1).concat(cases.slice(2)).join('\n')
    expect(linkifyMessageLocalPaths(unchanged)).toBe(unchanged)
    expect(linkifyMessageLocalPaths('escaped "/tmp/a\\"b.txt"')).toContain('(#preview/%2Ftmp%2Fa%5C%22b.txt)')
  })

  it('does not infer unquoted paths that contain whitespace', () => {
    expect(linkifyMessageLocalPaths('/tmp/My Report.txt')).toBe('[/tmp/My](#preview/%2Ftmp%2FMy) Report.txt')
    expect(linkifyMessageLocalPaths('/tmp/report.txt and notes.md')).toBe(
      '[/tmp/report.txt](#preview/%2Ftmp%2Freport.txt) and notes.md'
    )
    expect(linkifyMessageLocalPaths('See /tmp/report.txt and continue.md')).toBe(
      'See [/tmp/report.txt](#preview/%2Ftmp%2Freport.txt) and continue.md'
    )
  })

  it('rejects quoted control characters and escapes markdown label metacharacters', () => {
    for (let code = 0; code <= 0x1f; code += 1) {
      const control = `"/tmp/a${String.fromCharCode(code)}b.txt"`
      expect(linkifyMessageLocalPaths(control)).toBe(control)
    }
    const deleteCharacter = '"/tmp/a\u007fb.txt"'
    expect(linkifyMessageLocalPaths(deleteCharacter)).toBe(deleteCharacter)
    expect(linkifyMessageLocalPaths('/tmp/a*b_.txt')).toBe('[/tmp/a\\*b\\_.txt](#preview/%2Ftmp%2Fa*b_.txt)')
  })

  it('removes sentence punctuation and unmatched closers', () => {
    expect(linkifyMessageLocalPaths('/tmp/report.txt, /tmp/report(1).txt)')).toBe(
      '[/tmp/report.txt](#preview/%2Ftmp%2Freport.txt), [/tmp/report\\(1\\).txt](#preview/%2Ftmp%2Freport(1).txt))'
    )
  })
})
