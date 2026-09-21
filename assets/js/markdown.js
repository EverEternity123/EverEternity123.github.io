/* ==========================================================================
   markdown.js — 迷你 Markdown 渲染器（零依赖）
   支持：标题 / 粗体 / 斜体 / 行内代码 / 代码块 / 链接 / 图片
        引用 / 有序无序列表 / 分隔线 / 段落换行
   用法：MD.render('## 标题\n正文')  →  HTML 字符串
   ========================================================================== */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* 行内元素：先把行内代码抽成占位符，避免其中的符号被二次解析 */
  function inline(text) {
    var store = [];

    var s = text.replace(/`([^`]+)`/g, function (_, code) {
      store.push('<code>' + code + '</code>');
      return '\u0000' + (store.length - 1) + '\u0000';
    });

    // 图片 ![alt](src)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,
      '<img src="$2" alt="$1" loading="lazy">');

    // 链接 [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // 粗体 **text**
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

    // 斜体 *text*（避免误伤 ** ）
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

    // 还原行内代码
    s = s.replace(/\u0000(\d+)\u0000/g, function (_, i) {
      return store[Number(i)];
    });

    return s;
  }

  function render(src) {
    var text = String(src == null ? '' : src).replace(/\r\n?/g, '\n').trim();
    if (!text) return '';

    var lines = text.split('\n');
    var out = [];
    var i = 0;

    function isBlank(l) { return /^\s*$/.test(l); }
    function isBlockStart(l) {
      return isBlank(l) ||
             /^```/.test(l) ||
             /^(#{1,6})\s+/.test(l) ||
             /^\s*>/.test(l) ||
             /^\s*([-*+]|\d+\.)\s+/.test(l) ||
             /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l);
    }

    while (i < lines.length) {
      var line = lines[i];

      if (isBlank(line)) { i++; continue; }

      /* ---- 代码块 ---- */
      if (/^```/.test(line)) {
        var lang = line.replace(/^```/, '').trim();
        var buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // 跳过结束围栏
        out.push(
          '<pre class="md-pre"' + (lang ? ' data-lang="' + esc(lang) + '"' : '') + '>' +
          '<code>' + esc(buf.join('\n')) + '</code></pre>'
        );
        continue;
      }

      /* ---- 分隔线 ---- */
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      /* ---- 标题 ---- */
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        var lv = h[1].length;
        out.push('<h' + lv + '>' + inline(esc(h[2].trim())) + '</h' + lv + '>');
        i++;
        continue;
      }

      /* ---- 引用 ---- */
      if (/^\s*>/.test(line)) {
        var bq = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          bq.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push('<blockquote><p>' + inline(esc(bq.join('\n'))).replace(/\n/g, '<br>') + '</p></blockquote>');
        continue;
      }

      /* ---- 列表 ---- */
      var ulMatch = line.match(/^\s*[-*+]\s+(.*)$/);
      var olMatch = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ulMatch || olMatch) {
        var ordered = !!olMatch;
        var items = [];
        while (i < lines.length) {
          var m = ordered
            ? lines[i].match(/^\s*\d+\.\s+(.*)$/)
            : lines[i].match(/^\s*[-*+]\s+(.*)$/);
          if (!m) break;
          items.push('<li>' + inline(esc(m[1])) + '</li>');
          i++;
        }
        var tag = ordered ? 'ol' : 'ul';
        out.push('<' + tag + '>' + items.join('') + '</' + tag + '>');
        continue;
      }

      /* ---- 段落（连续非空行，保留作者换行） ---- */
      var para = [];
      while (i < lines.length && !isBlockStart(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      if (para.length) {
        out.push('<p>' + inline(esc(para.join('\n'))).replace(/\n/g, '<br>') + '</p>');
      }
    }

    return out.join('\n');
  }

  /* 中文友好的摘要：去掉 Markdown 标记，按字数截断 */
  function excerpt(src, limit) {
    limit = limit || 88;
    var plain = String(src || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (plain.length <= limit) return plain;
    return plain.slice(0, limit) + '……';
  }

  /* 正文字数：去掉代码块、去掉所有空白之后的长度。
     ⚠️ 阅读时长就是拿它除以 350 算的 —— 两处必须走同一个函数，
        否则「1 千字」和「约 4 分钟」会互相打架。 */
  function charCount(src) {
    return String(src || '').replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, '').length;
  }

  /* 中文阅读时长估算（约 350 字/分钟） */
  function readingTime(src) {
    return Math.max(1, Math.round(charCount(src) / 350));
  }

  global.MD = {
    render: render, excerpt: excerpt, readingTime: readingTime,
    charCount: charCount, escape: esc
  };
})(window);
