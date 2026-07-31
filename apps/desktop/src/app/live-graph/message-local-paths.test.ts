import { describe, expect, it } from 'vitest'

import { linkifyMessageLocalPaths } from './message-local-paths'

describe('linkifyMessageLocalPaths', () => {
  it('linkifies absolute paths and quoted paths with spaces', () => {
    expect(linkifyMessageLocalPaths("Open /tmp/report.txt and '/Users/yt/My Report.txt'.")).toBe(
      "Open [/tmp/report.txt](#preview/%2Ftmp%2Freport.txt) and '[/Users/yt/My Report.txt](#preview/%2FUsers%2Fyt%2FMy%20Report.txt)'."
    )
  })

  it('preserves protected markdown, code, URLs, and non-path text', () => {
    const text = '`/tmp/code.txt` [label](/tmp/link.txt) https://example.test/a/b / ./relative ~/file C:\\file /'
    expect(linkifyMessageLocalPaths(text)).toBe(text)
  })

  it('preserves multi-backtick spans, indented and tilde fences, and nested links', () => {
    const text = '`` /tmp/code.txt ``\n   ```\n/tmp/fenced.txt\n```\n~~~\n/tmp/tilde.txt\n~~~\n[label](/tmp/a_(b).txt)'
    expect(linkifyMessageLocalPaths(text)).toBe(text)
  })

  it('removes sentence punctuation and unmatched closers', () => {
    expect(linkifyMessageLocalPaths('/tmp/report.txt, /tmp/report(1).txt)')).toBe(
      '[/tmp/report.txt](#preview/%2Ftmp%2Freport.txt), [/tmp/report\\(1\\).txt](#preview/%2Ftmp%2Freport(1).txt))'
    )
  })
})