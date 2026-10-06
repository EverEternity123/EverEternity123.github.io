/* ==========================================================================
   markdown.js — 迷你 Markdown 渲染器（零依赖）
   支持：标题 / 粗体 / 斜体 / 行内代码 / 代码块 / 链接 / 图片
        引用 / 有序无序列表 / 分隔线 / 段落换行
        **裸网址自动变链接**（直接贴 https://… 就能点，不用写成 [文字](网址)）
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

  /* 行内元素：先把行内代码 / 图片 / 链接抽成占位符，避免其中的符号被二次解析 */
  function inline(text) {
    var store = [];

    function hold(html) {
      store.push(html);
      return '\u0000' + (store.length - 1) + '\u0000';
    }

    var s = text.replace(/`([^`]+)`/g, function (_, code) {
      return hold('<code>' + code + '</code>');
    });

    /* 图片和 markdown 链接**整段**存成占位符 —— 这样下面「裸网址自动变链接」
       就不会去动 href 里的地址（否则会套出 <a href="<a href=…"> 那种鬼东西）。 */
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_, alt, src) {
      return hold('<img src="' + src + '" alt="' + alt + '" loading="lazy">');
    });

    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, txt, url) {
      return hold('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + txt + '</a>');
    });

    /* 裸网址自动变链接：正文里**直接贴一个网址**也能点，不用写成 [文字](网址)。
       覆盖三种写法：① https://… ② www.… ③ 不带协议的域名（zhihu.com/xxx）。
       ⚠️ 必须排在上面两步之后 —— 那时真链接已经换成占位符了，
          否则会把 href 里的地址再包一层 <a>。
       ⚠️ 结尾的中文标点不算网址（否则「……详见 https://a.com。」会把句号吞进链接）；
          英文标点同理再剥一层（. , ; : ! ?）。
       ⚠️ 第 ③ 种**只认常见后缀** —— 不然「3.5 版本」「2024.08」这种也会被当成网址。
       ⚠️ 到这里文本已经过 esc()，网址里的 & 是 &amp; —— 原样放进 href 正好是对的。 */
    s = s.replace(
      /(https?:\/\/|www\.)[^\s<>"'()\u3000-\u303f\uff00-\uffef]+|(?:[0-9a-z][0-9a-z-]*\.)+(?:com|cn|net|org|io|dev|me|app|ai|co|cc|tv|info|top|xyz|edu|gov|club|site|blog|wiki|art)(?:\/[^\s<>"'()\u3000-\u303f\uff00-\uffef]*)?/gi,
      function (whole) {
        var url = whole.replace(/[.,;:!?]+$/, '');
        var tail = whole.slice(url.length);
        // 不带协议的要补一个，否则浏览器会当成站内相对路径
        var href = /^https?:\/\//i.test(url) ? url : 'https://' + url;
        return hold('<a href="' + href + '" target="_blank" rel="noopener noreferrer">' +
                    url + '</a>') + tail;
      });

    // 粗体 **text**
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

    // 斜体 *text*（避免误伤 ** ）
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

    // 还原行内代码 / 图片 / 链接
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

      /* ---- 列表 ----

         ⚠️ 这里必须同时容忍两种写法，否则「一个列表」会被拆成好几个 <ol>，
            每一项都从 1. 重新数（主人 2026-10-06 报的「工作台里是 1.2.3.，
            预览却是 1.1.1.」就是这个）：

         ① **项与项之间空一行** —— 手写时很自然，CommonMark 里这叫「松列表」，
            仍然**是同一个列表**。第一版遇到空行就 break，于是每项各成一个 <ol>。
         ② **缩进的非空行 = 本项的续行** —— 作者的写法是序号行写加粗小标题、
            正文另起一行缩进三格：
                1. **权力腐化革命**
                   动物推翻人类，却复制了暴政。
            第一版把「不是列表标记」当成列表结束，于是正文那行被甩出去变成
            独立段落，后面的 2. 又开一个新 <ol> —— 这才是《动物农场》里
            14 项全长成「1.」的真正原因。

         ③ 首项数字不是 1 时补 `<ol start="N">`（标准做法，不然 3. 开头会显示成 1.）。 */
      var ulMatch = line.match(/^\s*[-*+]\s+(.*)$/);
      var olMatch = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ulMatch || olMatch) {
        var ordered = !!olMatch;
        var items = [];      // 每项是一个「行数组」，最后再拼
        var buf = null;      // 正在累积的那一项
        var startNum = null;
        var flush = function () { if (buf !== null) { items.push(buf); buf = null; } };

        while (i < lines.length) {
          var raw = lines[i];
          var m = ordered
            ? raw.match(/^\s*(\d+)\.\s+(.*)$/)
            : raw.match(/^\s*[-*+]\s+(.*)$/);
          if (m) {
            flush();
            if (ordered && startNum === null) startNum = parseInt(m[1], 10);
            buf = [ordered ? m[2] : m[1]];
            i++;
            continue;
          }
          /* 空行：往后看第一个非空行。还是本列表的东西 → 松列表，跳过空行继续；
             否则列表到此为止（空行后面接段落是最常见的情况，不能吞进来）。 */
          if (isBlank(raw)) {
            var j = i;
            while (j < lines.length && isBlank(lines[j])) j++;
            if (j >= lines.length) break;
            var nx = lines[j];
            var nxIsItem = ordered ? /^\s*\d+\.\s+/.test(nx) : /^\s*[-*+]\s+/.test(nx);
            var nxIsCont = !isBlockStart(nx) && /^\s+\S/.test(nx);   // 缩进的续行
            if (!nxIsItem && !nxIsCont) break;
            i = j;
            continue;
          }
          /* 缩进的非空行 = 本项的续行（作者把正文写在序号行下面一行）。 */
          if (buf !== null && /^\s+\S/.test(raw) && !isBlockStart(raw)) {
            buf.push(raw.trim());
            i++;
            continue;
          }
          break;
        }
        flush();

        var tag = ordered ? 'ol' : 'ul';
        var attr = (ordered && startNum !== null && startNum !== 1)
          ? ' start="' + startNum + '"' : '';
        var html = items.map(function (ls) {
          return '<li>' + inline(esc(ls.join('\n'))).replace(/\n/g, '<br>') + '</li>';
        }).join('');
        out.push('<' + tag + attr + '>' + html + '</' + tag + '>');
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
    return readingTimeFromChars(charCount(src));
  }

  /* 字数**已经算好**时用这个（列表页拿的是 data/index.json，里面只有预计算好的
     `words`、没有正文）。⚠️ 别在别处再写一遍 `round(n / 350)` ——
     350 这个口径只在这一个文件里。 */
  function readingTimeFromChars(n) {
    return Math.max(1, Math.round(Number(n || 0) / 350));
  }

  /* 文章页和写作台编辑页共用的那一句：「1234 字 · 约 4 分钟读完」。
     ⚠️ 拼串只留这一处 —— 编辑器里显示的和文章页上的必须一字不差，
        各写一份的话迟早会分叉（比如一处改成「约 4 分钟」、另一处还是「4 分钟读完」），
        用户会以为文章长度变了。check-content.js 有断言钉着这两处同源。 */
  function readingLabel(src) {
    return charCount(src) + ' 字 · 约 ' + readingTime(src) + ' 分钟读完';
  }

  global.MD = {
    render: render, excerpt: excerpt, readingTime: readingTime,
    readingTimeFromChars: readingTimeFromChars,
    charCount: charCount, readingLabel: readingLabel, escape: esc
  };
})(window);
