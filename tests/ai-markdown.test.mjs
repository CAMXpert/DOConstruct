import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAiMarkdown } from '../src/renderer/ai-markdown.mjs';

test('AI replies render Markdown headings, emphasis, lists, tables and fenced source', () => {
  const html = renderAiMarkdown('# Heading\n\n**Bold** and `inline`\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = "<test>";\n```');
  for (const pattern of [/<h1>Heading<\/h1>/, /<strong>Bold<\/strong>/, /<ul>/, /<li>one<\/li>/, /<table>/, /<th>A<\/th>/, /<pre><code class="language-js">/]) assert.match(html, pattern);
  assert.match(html, /&lt;test&gt;/);
});

test('untrusted AI Markdown cannot create HTML, images or navigable local/script links', () => {
  const html = renderAiMarkdown('<script>globalThis.pwned=1</script>\n\n<img src=x onerror="globalThis.pwned=1">\n\n[x](javascript:alert(1)) [y](file:///C:/secret.txt) [z](data:text/html,test) [credentials](https://user:pass@example.com) [safe](https://example.com)\n\n![image](https://example.com/tracker.png)');
  assert.ok(!/<script|<img|onerror="/.test(html));
  assert.ok(!/href="(?:javascript|file|data):/.test(html));
  assert.match(html, /href="https:\/\/example.com" title="https:\/\/example.com"/);
  assert.ok(!html.includes('href="https://user:pass@'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /\[圖片：image\]/);
});
