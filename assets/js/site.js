/* ==========================================================================
   site.js — 站点固定内容的渲染（首页介绍 / 关于页 / 页脚落款）
   --------------------------------------------------------------------------
   数据来自 data/site.json，写作台的「站点信息」那一屏改的就是它。
   前台（app.js）和写作台预览（admin.js）共用这里的实现，避免两份代码走样。

   设计上的两个要点：
     1. 字段为空就**不动页面**。所以就算 site.json 丢了、或者是空的，
        页面会保持 HTML 里写好的那份静态内容，不会开天窗。
     2. 关于页正文里单独一行写 {{此刻}}，卡片就渲染在那个位置；
        没写就放在正文最后。
   ========================================================================== */
(function (global) {
  'use strict';

  var SITE_URL = 'data/site.json';

  /* ⚠️⚠️ 这里以前是「加一个 ?v=<时间戳>」—— **对 CDN 无效**。
     2026-10-06 实测（`_preview/_probe-cdn-cache.py`）：GitHub Pages 的 CDN
     **缓存键不含 query** —— 两个全新的参数拿到的是**同一个缓存对象**
     （`Age` 连续累加），连请求头 `Cache-Control: no-cache`（硬刷新）也照样 HIT。
     真正管用的是**让路径变**：路径中间塞进重复斜杠，
       data/site.json  →  data///site.json
     CDN 把它当成另一个文件，第一次请求必定 MISS 回源 → 拿到最新。
     ⚠️ 只能用「重复斜杠」：浏览器的 URL 规范化会吃掉 `/./` 和 `/../`，
        但空段（连续斜杠）原样保留（实测见 `_preview/_probe-path-variants2.py`）。
     ⚠️ 斜杠加在**路径中间**，不能写成 `//data/site.json` —— 那是协议相对 URL。
     ⚠️ 这里**故意**每次换一个新变体（每次回源）：site.json 才 2KB，
        换来「写作台改完站点信息、刷新就能看到」，值。
        （app.js 那边同理，见它的 `bust()` / `initSync()`。） */
  function busted(url) {
    var m = url.lastIndexOf('/');
    if (m < 0) return url;
    var n = 3 + (Date.now() % 200);          // 3~202 个斜杠，和 app.js 那边同口径
    return url.slice(0, m) + new Array(n + 1).join('/') + url.slice(m + 1);
  }

  function esc(s) {
    return global.MD ? MD.escape(s) : String(s == null ? '' : s);
  }

  function load() {
    return fetch(busted(SITE_URL), { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  /* 「此刻」卡片：标题 + 若干「名称 / 内容」 */
  function nowCardHTML(now) {
    if (!now || !now.title) return '';
    var items = (now.items || []).filter(function (it) {
      return it && (it.label || it.text);
    }).map(function (it) {
      return '<dt>' + esc(it.label || '') + '</dt>' +
             '<dd>' + esc(it.text || '') + '</dd>';
    }).join('');
    if (!items) return '';
    return '<div class="now-card">' +
             '<div class="now-title"><span class="pulse"></span>' +
               esc(now.title) + '</div>' +
             '<dl>' + items + '</dl>' +
           '</div>';
  }

  function aboutBodyHTML(body, now) {
    var html = MD.render(body);
    var card = nowCardHTML(now);
    if (!card) return html;
    var marker = /<p>\s*\{\{\s*此刻\s*\}\}\s*<\/p>/;
    return marker.test(html) ? html.replace(marker, card) : html + '\n' + card;
  }

  /* 把 site.json 的内容填进页面。任何一段为空就跳过那一段。 */
  function apply(site) {
    if (!site || typeof site !== 'object') return;

    var $ = function (s) { return document.querySelector(s); };

    var hero = site.hero || {};
    var titleEl = $('#hero-title');
    if (titleEl && hero.title) titleEl.textContent = hero.title;
    var tagEl = $('#hero-tagline');
    if (tagEl && hero.tagline) tagEl.textContent = hero.tagline;
    var chipsEl = $('#hero-chips');
    if (chipsEl && hero.chips && hero.chips.length) {
      chipsEl.innerHTML = hero.chips.map(function (c) {
        return '<span class="chip">' + esc(c) + '</span>';
      }).join('') + '<a class="chip" href="about.html">关于我 →</a>';
    }

    var about = site.about || {};
    var subEl = $('#about-sub');
    if (subEl && about.sub) subEl.textContent = about.sub;
    var bodyEl = $('#about-body');
    if (bodyEl && about.body) bodyEl.innerHTML = aboutBodyHTML(about.body, about.now);

    var noteEl = $('#footer-note');
    if (noteEl && site.footer && site.footer.note) {
      noteEl.textContent = '© ' + new Date().getFullYear() +
                           ' Ever Eternity · ' + site.footer.note;
    }
  }

  /* 摘掉 <head> 里那行内联脚本打上的遮罩（.ee-site-pending，规则在 style.css）。
     站点信息填完了要摘，**没读到也要摘** —— 否则首页介绍、关于页正文、页脚
     会一直空着。读不到时就沿用 HTML 里写死的兜底内容，跟以前一样。 */
  function reveal() {
    try {
      document.documentElement.classList.remove('ee-site-pending');
    } catch (e) { /* ignore */ }
  }

  global.SITE = { load: load, apply: apply, reveal: reveal,
                  aboutBodyHTML: aboutBodyHTML };
})(window);
