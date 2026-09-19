/* ==========================================================================
   admin.js — 写作台逻辑（纯前端，直接读写 GitHub 仓库）
   依赖：markdown.js、write.config.js
   保存 = 向仓库提交一次 commit，托管平台随后自动重新部署

   令牌存在本设备的 localStorage 里（键 ee-gh-token），不经过任何服务器。
   它等同于这个仓库的写权限，所以别分享给别人。
   ========================================================================== */
(function () {
  'use strict';

  var CFG = window.BLOG_CONFIG || {};
  var API = 'https://api.github.com';
  var TOKEN_KEY = 'ee-gh-token';
  var DRAFT_PREFIX = 'ee-draft:';

  var $ = function (s) { return document.querySelector(s); };

  var state = {
    token: '',
    user: '',
    sha: null,        // 当前 posts.json 的 blob sha，提交时必须带上
    posts: [],        // 按**显示顺序**排好的文章（自定义顺序 + 新文章在最前）
    editing: null,
    original: null,
    isNew: true,
    filterTag: '',    // 列表页当前选中的标签，'' = 全部
    site: null,       // data/site.json 的内容（首页介绍 / 关于页 / 页脚）
    siteSha: null,    // site.json 的 blob sha，提交时必须带上
    order: { ids: [] }, // data/order.json 的内容：自定义顺序
    orderSha: null,     // order.json 的 blob sha，提交时必须带上
    sorting: false,     // 是否处于「排序」模式
    sortBaseline: null  // 进入排序模式那一刻的顺序，用来判断有没有改过
  };

  /* ======================================================================
     小工具
     ====================================================================== */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var toastTimer = null;
  function toast(msg, isError) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('err', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3400);
  }

  function show(view) {
    ['connect', 'list', 'edit', 'site'].forEach(function (v) {
      $('#view-' + v).hidden = (v !== view);
    });
    window.scrollTo(0, 0);
  }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  function fmtDate(iso) {
    var p = String(iso || '').split('-');
    return p.length < 3 ? (iso || '') : p[0] + '.' + p[1] + '.' + p[2];
  }

  function byDateDesc(a, b) { return String(b.date).localeCompare(String(a.date)); }

  /* UTF-8 ↔ base64（GitHub Contents API 用 base64 传内容，中文必须正确处理） */
  function b64encode(str) {
    var bytes = new TextEncoder().encode(str);
    var chunk = 0x8000, parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return btoa(parts.join(''));
  }

  function b64decode(b64) {
    var bin = atob(String(b64 || '').replace(/[\r\n\s]/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ======================================================================
     GitHub API
     ====================================================================== */

  function ghError(status, data) {
    var msg = (data && data.message) || '';
    if (status === 401) return '令牌无效或已过期，请重新生成一个';
    if (status === 403) return '权限不足，或触发了 GitHub 限流：' + msg;
    if (status === 404) {
      return '找不到仓库或文件。请检查 write.config.js 里的 owner / repo / path，' +
             '以及令牌是否勾选了这个仓库、Contents 权限是否为 Read and write';
    }
    if (status === 409) return '文件在别处被改过了，请点「刷新」重新读取后再保存';
    if (status === 422) return '提交被拒绝：' + msg;
    return 'GitHub 返回 ' + status + (msg ? '：' + msg : '');
  }

  function gh(path, options) {
    options = options || {};
    var headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    if (options.body) headers['Content-Type'] = 'application/json';

    return fetch(API + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store'
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error(ghError(res.status, data));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  /* 仓库里任意一个文件的 Contents API 地址 */
  function contentsPathOf(p) {
    return '/repos/' + encodeURIComponent(CFG.owner) + '/' +
           encodeURIComponent(CFG.repo) + '/contents/' +
           String(p || '').split('/').map(encodeURIComponent).join('/');
  }

  function contentsPath() {
    return contentsPathOf(CFG.path);
  }

  function sitePath() {
    return CFG.sitePath || 'data/site.json';
  }

  function orderPath() {
    return CFG.orderPath || 'data/order.json';
  }

  /* ======================================================================
     显示顺序
     ----------------------------------------------------------------------
     真正的规则在 assets/js/order.js（前台也用它），这里只负责取数据。
     一句话：不在 order.json 里的文章（＝新发的）按日期排在最前面，
     在里面的按列表顺序排在后面。
     ====================================================================== */

  /* order.json 的内容 → { ids: [...] }。文件坏掉就当没排过序，不阻断列表 */
  function parseOrder(content) {
    try {
      var obj = JSON.parse(b64decode(content));
      var ids = window.EE_ORDER ? window.EE_ORDER.idsOf(obj) : [];
      return { ids: ids };
    } catch (e) {
      return { ids: [] };
    }
  }

  /* 把一组文章按 state.order 排好 */
  function applyOrder(list) {
    var ord = window.EE_ORDER;
    if (!ord) return list.slice().sort(byDateDesc);
    return ord.apply(list, (state.order && state.order.ids) || []);
  }

  /* 当前显示顺序对应的 id 列表 */
  function currentIds() {
    if (window.EE_ORDER) return window.EE_ORDER.idsFrom(state.posts);
    return state.posts.map(function (p) { return p.id; });
  }

  /* 排序模式下：跟进入时的顺序比，有没有动过 */
  function sortDirty() {
    var a = currentIds(), b = state.sortBaseline || [];
    if (a.length !== b.length) return true;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
    return false;
  }

  function loadPosts() {
    var ref = encodeURIComponent(CFG.branch || 'main');
    return Promise.all([
      gh(contentsPath() + '?ref=' + ref),
      // order.json 是后加的文件，老仓库里可能还没有 —— 404 当成「没排过序」
      gh(contentsPathOf(orderPath()) + '?ref=' + ref).catch(function (e) {
        if (e.status === 404) return null;
        throw e;
      })
    ]).then(function (both) {
      var data = both[0], odata = both[1];
      if (!data || typeof data.content !== 'string') {
        throw new Error('文件内容读取失败');
      }
      state.sha = data.sha;
      var list = JSON.parse(b64decode(data.content));
      if (!Array.isArray(list)) throw new Error('posts.json 格式不对：顶层应该是数组');

      state.orderSha = odata ? odata.sha : null;
      state.order = odata ? parseOrder(odata.content) : { ids: [] };
      state.posts = applyOrder(list);
    }).catch(function (err) {
      // 文件还不存在（第一次用）：允许从空列表开始，保存时会创建它
      if (err.status === 404) {
        state.sha = null;
        state.posts = [];
        return;
      }
      throw err;
    });
  }

  function commit(message) {
    var json = JSON.stringify(state.posts.slice().sort(byDateDesc), null, 2) + '\n';
    var body = {
      message: message,
      content: b64encode(json),
      branch: CFG.branch || 'main'
    };
    if (state.sha) body.sha = state.sha;

    return gh(contentsPath(), { method: 'PUT', body: body }).then(function (data) {
      if (data && data.content && data.content.sha) state.sha = data.content.sha;
      // 写进仓库的永远是「按日期降序」（posts.json 只管内容）；
      // 内存里这份要恢复成显示顺序 —— 新文章没进 order.json，会自动排到最前面
      state.posts = applyOrder(state.posts);
      return data;
    });
  }

  /* ======================================================================
     连接 / 锁定
     ====================================================================== */

  function renderRepoInfo() {
    var el = $('#repo-info');
    var configured = !!(CFG.owner && CFG.repo);

    if (!configured) {
      el.innerHTML = '<span class="repo-bad">●</span> 还没配置仓库';
      $('#config-missing').hidden = false;
      $('#token-form').hidden = true;
      return;
    }
    el.innerHTML =
      '<span class="repo-ok">●</span> ' + esc(CFG.owner + '/' + CFG.repo) +
      '<span class="repo-meta">' + esc(CFG.branch || 'main') + ' · ' + esc(CFG.path) + '</span>';
    $('#config-missing').hidden = true;
    $('#token-form').hidden = false;
  }

  /* 记住 / 忘掉这台设备上的令牌 */
  function setToken(t) {
    state.token = t || '';
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* 隐私模式下写不进去，不影响这一次的使用 */ }
  }

  /* 作者留空就用默认作者，占位文字跟着配置走 */
  function renderConnect() {
    var authorEl = $('#f-author');
    if (authorEl) authorEl.placeholder = '留空 = ' + defaultAuthor();
  }

  /* 真正去连仓库：先验令牌，再看仓库写权限，最后读一遍文章 */
  function connect(token) {
    state.token = token;
    return gh('/user').then(function (me) {
      state.user = me.login;
      return gh('/repos/' + encodeURIComponent(CFG.owner) + '/' + encodeURIComponent(CFG.repo));
    }).then(function (repo) {
      if (repo && repo.permissions && repo.permissions.push === false) {
        throw new Error('这个令牌没有该仓库的写入权限：请把 Contents 权限设为 Read and write');
      }
      return loadPosts();
    }).then(function () {
      setToken(token);
      $('#f-token').value = '';
      renderList();
      show('list');
      toast('已连接 ' + CFG.owner + '/' + CFG.repo);
    });
  }

  /* 断开：清掉本设备记住的令牌，回到「贴令牌」那一屏 */
  function disconnect() {
    setToken('');
    state.user = '';
    state.sha = null;
    state.posts = [];
    state.filterTag = '';
    state.site = null;
    state.siteSha = null;
    $('#f-token').value = '';
    renderConnect();
    show('connect');
  }

  /* ======================================================================
     文章列表
     ====================================================================== */

  /* 数一遍所有标签：list 按「出现次数多的在前」排，count 是每个标签的篇数。
     和首页的标签栏同一套口径（含已隐藏的文章 —— 这里是管理界面，得看全）。 */
  function tagStats(posts) {
    var count = Object.create(null);
    posts.forEach(function (p) {
      (p.tags || []).forEach(function (t) {
        var k = String(t).trim();
        if (k) count[k] = (count[k] || 0) + 1;
      });
    });
    var list = Object.keys(count).sort(function (a, b) {
      return count[b] - count[a] || a.localeCompare(b, 'zh');
    });
    return { list: list, count: count };
  }

  /* 当前筛选下要显示的文章 */
  function visiblePosts() {
    if (!state.filterTag) return state.posts;
    return state.posts.filter(function (p) {
      return (p.tags || []).indexOf(state.filterTag) !== -1;
    });
  }

  function renderTagbar() {
    var bar = $('#admin-tagbar');
    if (!bar) return;

    var st = tagStats(state.posts);
    // 选中的标签可能已经不存在了（比如刚删掉最后一篇用它标过的文章）
    if (state.filterTag && st.list.indexOf(state.filterTag) === -1) state.filterTag = '';

    if (!st.list.length) { bar.innerHTML = ''; bar.hidden = true; return; }

    var html = '<button class="tag-btn' + (state.filterTag ? '' : ' on') +
               '" data-tag="">全部<span class="count">' + state.posts.length + '</span></button>';
    st.list.forEach(function (t) {
      html += '<button class="tag-btn' + (state.filterTag === t ? ' on' : '') +
              '" data-tag="' + esc(t) + '">' + esc(t) +
              '<span class="count">' + st.count[t] + '</span></button>';
    });
    bar.innerHTML = html;
    bar.hidden = false;
  }

  function renderList() {
    var ul = $('#list');
    var sorting = state.sorting === true;

    // 排序模式下强制看全部：在筛选后的列表里挪位置，很容易挪到自己看不见的地方
    if (sorting) state.filterTag = '';
    renderTagbar();
    var tagbarEl = $('#admin-tagbar');
    if (tagbarEl && sorting) tagbarEl.hidden = true;

    var shown = visiblePosts();
    $('#count-pill').textContent = state.filterTag
      ? shown.length + ' / ' + state.posts.length + ' 篇'
      : state.posts.length + ' 篇';

    var empty = $('#list-empty');
    empty.hidden = shown.length > 0;
    empty.textContent = sorting
      ? '还没有文章，没什么可排的。'
      : (state.filterTag
          ? '没有「' + state.filterTag + '」标签的文章。'
          : '还没有文章，点右上角开始写第一篇。');

    $('#repo-strip').innerHTML =
      '<span class="repo-ok">●</span> ' +
      esc(CFG.owner + '/' + CFG.repo) +
      '<span class="repo-meta">' + esc(CFG.branch || 'main') +
      (state.user ? ' · 已连接 ' + esc(state.user) : '') + '</span>';

    // 排序模式在 body 上挂个类：CSS 靠它把「电脑端整行可拖」的光标和
    // 「收起 ↑↓ 按钮」两条规则限定在排序模式内（平时列表也要能正常选中文字）
    document.body.classList.toggle('ee-sorting', sorting);

    var sortBar = $('#sort-bar');
    if (sortBar) sortBar.hidden = !sorting;
    var btnSort = $('#btn-sort');
    if (btnSort) {
      btnSort.textContent = sorting ? '排序中' : '排序';
      btnSort.classList.toggle('on', sorting);
    }

    ul.innerHTML = shown.map(function (p, i) {
      var tags = (p.tags || []).map(function (t) {
        return '<span class="pill">' + esc(t) + '</span>';
      }).join(' ');
      var author = p.author
        ? '<span class="pill pill-author">' + esc(p.author) + '</span>'
        : '';
      var hidden = p.hidden === true
        ? '<span class="pill pill-hidden">已隐藏</span>'
        : '';

      // 排序模式下把「编辑 / 删除」换成位移按钮，免得一行挤四个按钮
      var ops = sorting
        ? '<button class="btn btn-move" data-act="top"' +
            (i === 0 ? ' disabled' : '') + ' title="移到最前">置顶</button>' +
          '<button class="btn btn-move" data-act="up"' +
            (i === 0 ? ' disabled' : '') + ' title="上移一位">↑</button>' +
          '<button class="btn btn-move" data-act="down"' +
            (i === shown.length - 1 ? ' disabled' : '') + ' title="下移一位">↓</button>'
        : '<button class="btn" data-act="edit">编辑</button>' +
          '<button class="btn btn-danger" data-act="del">删除</button>';

      return '' +
        '<li data-id="' + esc(p.id) + '"' +
            (p.hidden === true ? ' class="is-hidden"' : '') + '>' +
          // 排序模式下这个序号同时是**拖拽把手**（CSS 里 touch-action:none，
          // 手指按住它才不会变成滚页面；鼠标则整行都能拖）
          (sorting
            ? '<span class="ord" title="按住拖动" aria-label="拖动排序">'
              + (i + 1) + '</span>'
            : '') +
          '<div class="info">' +
            '<div class="ttl">' + esc(p.title) + '</div>' +
            '<div class="meta"><span>' + fmtDate(p.date) + '</span>' +
              hidden + author + tags + '</div>' +
          '</div>' +
          '<div class="ops">' + ops + '</div>' +
        '</li>';
    }).join('');
  }

  /* ======================================================================
     自定义排序
     ====================================================================== */

  function enterSort() {
    if (!state.posts.length) {
      toast('还没有文章，不用排序', true);
      return;
    }
    state.sorting = true;
    state.filterTag = '';
    state.sortBaseline = currentIds();   // 用来判断「有没有动过」
    renderList();
  }

  function cancelSort() {
    if (sortDirty() && !window.confirm('顺序改过了，确定放弃这些调整吗？')) return;
    state.sorting = false;
    state.sortBaseline = null;
    state.posts = applyOrder(state.posts);  // 丢掉未保存的调整，回到线上那份顺序
    renderList();
  }

  /* delta：-1 上移一位 / 1 下移一位 / 'top' 移到最前 */
  function movePost(id, delta) {
    var i = -1;
    for (var k = 0; k < state.posts.length; k++) {
      if (state.posts[k].id === id) { i = k; break; }
    }
    if (i < 0) return;

    var j = delta === 'top' ? 0 : i + delta;
    if (j < 0 || j >= state.posts.length || j === i) return;

    var moved = state.posts.splice(i, 1)[0];
    state.posts.splice(j, 0, moved);
    renderList();

    // 手机上一屏放不下几行，挪完把这一行滚回视野里，不然会「找不到刚才那篇」
    var li = $('#list li[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (li && li.scrollIntoView) {
      try { li.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 老浏览器忽略 */ }
    }
  }

  /* ======================================================================
     拖拽排序（鼠标和手指用同一套代码）
     ----------------------------------------------------------------------
     ⚠️ 不要用 HTML5 的 draggable / dragstart —— 它在触屏上**根本不触发**
     （安卓/iOS 都不发 drag 事件），而这个写作台主要在手机上用。
     改用 Pointer Events：鼠标按住行就能拖；手指要按住**左侧的序号**
     （那是拖拽把手，CSS 里 touch-action:none，所以不会变成滚动页面）。

     拖动过程中直接搬 DOM（把被拖的 li insertBefore 到目标位置），
     不搞幽灵元素 —— 少一层同步，落点就是最终落点。
     ====================================================================== */

  var dragState = null;
  var DRAG_MARGIN = 72;      // 离视口上下边缘多近开始自动滚动

  function dragCleanup() {
    if (!dragState) return;
    if (dragState.timer) clearTimeout(dragState.timer);
    if (dragState.li) dragState.li.classList.remove('dragging');
    document.documentElement.classList.remove('ee-dragging');
    document.removeEventListener('pointermove', dragMove);
    document.removeEventListener('pointerup', dragEnd);
    document.removeEventListener('pointercancel', dragEnd);
    dragState = null;
  }

  /* 把序号重新编一遍（搬完 DOM 之后编号会乱） */
  function renumberRows() {
    var rows = $('#list').querySelectorAll('li .ord');
    for (var i = 0; i < rows.length; i++) rows[i].textContent = String(i + 1);
  }

  /* 只刷新首末行的按钮禁用状态。
     拖拽结束走这里，而不是 renderList() —— 整表重画会闪一下，
     还会把刚做完的位移动画一起打断。 */
  function refreshMoveButtons() {
    var rows = $('#list').querySelectorAll('li');
    for (var i = 0; i < rows.length; i++) {
      var up = rows[i].querySelector('button[data-act="up"]');
      var top = rows[i].querySelector('button[data-act="top"]');
      var down = rows[i].querySelector('button[data-act="down"]');
      var first = i === 0, last = i === rows.length - 1;
      if (up) up.disabled = first;
      if (top) top.disabled = first;
      if (down) down.disabled = last;
    }
  }

  /* 松手后在被拖的那一行上打一下高亮，确认「就落在这儿」 */
  function settleRow(li) {
    if (!li || !li.classList) return;
    li.classList.add('settled');
    setTimeout(function () { li.classList.remove('settled'); }, 460);
  }

  /* FLIP：先量位置 → 改 DOM → 补一个反向位移再过渡回 0，
     这样其它行是「滑」到新位置，而不是瞬间跳过去。
     ⚠️ 量位置用 offsetTop，不用 getBoundingClientRect()：后者把 transform
     算进去，上一次动画还没跑完时量到的就是中间态，位移量会算错（越拖越飘）。 */
  function flipReorder(mutate) {
    var lis = [].slice.call($('#list').querySelectorAll('li'));
    var tops = [];
    var i;
    for (i = 0; i < lis.length; i++) tops.push(lis[i].offsetTop);

    mutate();

    for (i = 0; i < lis.length; i++) {
      var li = lis[i];
      if (li === dragState.li) continue;        // 被拖的那行跟手，不参与动画
      var dy = tops[i] - li.offsetTop;
      if (!dy) continue;
      li.style.transition = 'none';
      li.style.transform = 'translateY(' + dy + 'px)';
      void li.offsetHeight;                     // 强制回流，让起点真的生效
      li.style.transition = 'transform .16s cubic-bezier(.2, .7, .3, 1)';
      li.style.transform = '';
      clearFlipLater(li);
    }
  }

  function clearFlipLater(li) {
    setTimeout(function () {
      li.style.transition = '';
      li.style.transform = '';
    }, 240);
  }

  /* 指针位置下面是哪一行（被拖的那行 pointer-events:none，所以会被"看穿"） */
  function rowUnder(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el || !el.closest) return null;
    var li = el.closest('#list li');
    if (!li || !dragState || li === dragState.li) return null;
    return li;
  }

  function autoScroll(y) {
    var step = 0;
    if (y < DRAG_MARGIN) step = -(DRAG_MARGIN - y) / 3;
    else if (y > window.innerHeight - DRAG_MARGIN) {
      step = (y - (window.innerHeight - DRAG_MARGIN)) / 3;
    }
    if (step) window.scrollBy(0, step);
  }

  function dragMove(e) {
    if (!dragState) return;
    var x = e.clientX, y = e.clientY;

    if (!dragState.active) {
      // 还没真正进入拖拽：手指一动就说明用户是在滚页面，让路
      if (Math.abs(y - dragState.y0) > 8 || Math.abs(x - dragState.x0) > 8) {
        dragCleanup();
      }
      return;
    }

    if (e.cancelable) e.preventDefault();
    dragState.y = y;
    autoScroll(y);

    var over = rowUnder(x, y);
    if (!over) return;
    var r = over.getBoundingClientRect();
    var after = y > r.top + r.height / 2;
    var ref = after ? over.nextSibling : over;
    // 落点没变就别碰 DOM：否则每一帧都重排一次，动画会被自己反复打断
    if (ref === dragState.li || ref === dragState.li.nextSibling) return;
    flipReorder(function () {
      dragState.li.parentNode.insertBefore(dragState.li, ref);
    });
    renumberRows();
  }

  function dragEnd() {
    if (!dragState) return;
    var wasActive = dragState.active;
    var dragged = dragState.li;
    dragCleanup();
    if (!wasActive) return;

    // 把 DOM 里的顺序读回 state.posts
    var ids = [];
    var rows = $('#list').querySelectorAll('li');
    for (var i = 0; i < rows.length; i++) ids.push(rows[i].getAttribute('data-id'));

    var byId = {};
    state.posts.forEach(function (p) { byId[p.id] = p; });
    var next = [];
    ids.forEach(function (id) { if (byId[id]) next.push(byId[id]); });
    // 兜底：万一有哪篇没进 DOM（理论上不会），原样补在后面，别把它弄丢
    state.posts.forEach(function (p) {
      if (ids.indexOf(p.id) === -1) next.push(p);
    });

    state.posts = next;
    // ⚠️ 这里**不能** renderList()：整表重画会闪一下，还会把刚做完的位移动画打断。
    //    序号在拖动过程中已经编好，只需要补一下首末行的按钮禁用状态。
    refreshMoveButtons();
    settleRow(dragged);
  }

  function dragStart(li, e) {
    var isTouch = e.pointerType === 'touch';
    // 手指只认把手（序号），否则一按住就拖，页面没法滚了
    if (isTouch && !(e.target.closest && e.target.closest('.ord'))) return;
    if (e.target.closest && e.target.closest('button')) return;   // 点按钮不算拖

    dragState = {
      li: li, y0: e.clientY, x0: e.clientX, y: e.clientY,
      pid: e.pointerId, active: false, isTouch: isTouch, timer: null
    };

    if (isTouch) {
      // 手指按住把手 250ms 才算「要拖」，中途动了就当滚动
      dragState.timer = setTimeout(function () {
        if (dragState) dragActivate();
      }, 250);
    }

    document.addEventListener('pointermove', dragMove);
    document.addEventListener('pointerup', dragEnd);
    document.addEventListener('pointercancel', dragEnd);
  }

  function dragActivate() {
    if (!dragState || dragState.active) return;
    dragState.active = true;
    dragState.li.classList.add('dragging');
    document.documentElement.classList.add('ee-dragging');
    try {
      // 合成事件没有真实指针，会抛 —— 包起来，拖拽照样能用
      dragState.li.parentNode.setPointerCapture(dragState.pid);
    } catch (err) { /* ignore */ }
  }

  function initDrag() {
    $('#list').addEventListener('pointerdown', function (e) {
      if (state.sorting !== true || dragState) return;
      if (e.button && e.button !== 0) return;              // 只认左键
      var li = e.target.closest && e.target.closest('#list li');
      if (!li) return;
      dragStart(li, e);
      // 鼠标：按住就可以直接拖，不用等
      if (e.pointerType !== 'touch') dragActivate();
    });
  }

  function saveSort() {
    var ids = currentIds();
    var json = JSON.stringify({ ids: ids }, null, 2) + '\n';
    var body = {
      message: '调整文章顺序',
      content: b64encode(json),
      branch: CFG.branch || 'main'
    };
    if (state.orderSha) body.sha = state.orderSha;

    var btn = $('#btn-sort-save');
    btn.disabled = true;
    btn.textContent = '保存中…';

    return gh(contentsPathOf(orderPath()), { method: 'PUT', body: body })
      .then(function (data) {
        if (data && data.content && data.content.sha) state.orderSha = data.content.sha;
        state.order = { ids: ids };
        state.sorting = false;
        state.sortBaseline = null;
        renderList();
        toast('顺序已保存，约 1 分钟后线上生效');
      })
      .catch(function (e) {
        toast(e.message, true);
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = '保存排序';
      });
  }

  function refresh() {
    var btn = $('#btn-refresh');
    btn.disabled = true;
    btn.textContent = '刷新中…';
    loadPosts().then(function () {
      renderList();
      toast('已从 GitHub 重新读取');
    }).catch(function (e) {
      toast(e.message, true);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '刷新';
    });
  }

  /* ======================================================================
     草稿
     ====================================================================== */

  function draftKey(id) { return DRAFT_PREFIX + (id || '__new__'); }

  function saveDraft() {
    if (!state.editing) return;
    try {
      localStorage.setItem(draftKey(state.editing.id),
        JSON.stringify({ post: state.editing, at: Date.now() }));
    } catch (e) { /* ignore */ }
  }

  function readDraft(id) {
    try {
      var raw = localStorage.getItem(draftKey(id));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function clearDraft(id) {
    try { localStorage.removeItem(draftKey(id)); } catch (e) { /* ignore */ }
  }

  var draftTimer = null;
  function scheduleDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 700);
  }

  function isDirty() {
    if (!state.editing || !state.original) return false;
    return JSON.stringify(state.editing) !== JSON.stringify(state.original);
  }

  /* ======================================================================
     编辑器
     ====================================================================== */

  /* 站点默认作者，和 write.config.js 里的 defaultAuthor 保持一致 */
  function defaultAuthor() {
    return CFG.defaultAuthor || 'Ever Eternity';
  }

  function fillForm(p) {
    $('#f-title').value = p.title || '';
    $('#f-date').value = p.date || todayISO();
    $('#f-tags').value = (p.tags || []).join(', ');
    $('#f-lede').value = p.lede || '';
    $('#f-content').value = p.content || '';
    $('#f-author').value = p.author || '';
    $('#f-hidden').checked = p.hidden === true;
  }

  function readForm() {
    // 固定顺序，方便看 diff
    var out = {
      id: state.editing ? state.editing.id : '',
      title: $('#f-title').value.trim(),
      date: $('#f-date').value || todayISO(),
      tags: $('#f-tags').value.split(/[,，]/).map(function (t) { return t.trim(); })
              .filter(Boolean).slice(0, 8),
      lede: $('#f-lede').value.trim(),
      content: $('#f-content').value,
      author: $('#f-author').value.trim(),
      hidden: $('#f-hidden').checked
    };
    // 带上将来可能新增的字段，编辑旧文章时不会把它们弄丢
    if (state.editing) {
      Object.keys(state.editing).forEach(function (k) {
        if (!(k in out)) out[k] = state.editing[k];
      });
    }
    // 用不到的字段就不写进 JSON，保持 posts.json 干净
    if (!out.hidden) delete out.hidden;
    if (!out.author) delete out.author;
    return out;
  }

  /* 从标题生成一个 URL 友好的 id；taken 是已占用的 id 集合（Set） */
  function makeId(title, taken) {
    var base = String(title || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!base) base = 'p-' + Date.now().toString(36);
    var id = base, n = 2;
    while (taken.has(id)) id = base + '-' + (n++);
    return id;
  }

  function shallowCopy(o) {
    var out = {};
    Object.keys(o || {}).forEach(function (k) { out[k] = o[k]; });
    return out;
  }

  function openEditor(post) {
    state.isNew = !post;
    if (post) {
      state.editing = shallowCopy(post);
      state.editing.tags = (post.tags || []).slice();
      state.editing.lede = post.lede || '';
      state.editing.content = post.content || '';
    } else {
      state.editing = {
        id: '', title: '', date: todayISO(), tags: [], lede: '', content: '',
        author: '', hidden: false
      };
    }
    state.original = JSON.parse(JSON.stringify(state.editing));

    $('#edit-mode').textContent = state.isNew ? '新文章' : ('编辑 · ' + state.editing.id);
    $('#preview-wrap').hidden = true;
    $('#btn-preview').textContent = '预览';
    fillForm(state.editing);

    var draft = readDraft(state.editing.id);
    var banner = $('#draft-banner');
    if (draft && draft.post &&
        JSON.stringify(draft.post) !== JSON.stringify(state.original)) {
      var when = new Date(draft.at);
      $('#draft-text').textContent =
        '有一份未保存的草稿（' + (when.getMonth() + 1) + '月' + when.getDate() + '日 ' +
        String(when.getHours()).padStart(2, '0') + ':' +
        String(when.getMinutes()).padStart(2, '0') + '），要恢复吗？';
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }

    show('edit');
  }

  function backToList() {
    if (isDirty() && !confirm('有改动还没保存，确定要离开吗？\n（改动会留成草稿，下次可以恢复）')) {
      return;
    }
    saveDraft();
    clearTimeout(draftTimer);
    renderList();
    show('list');
  }

  function doSave() {
    var post = readForm();

    if (!post.title) { toast('标题还没写', true); $('#f-title').focus(); return; }
    if (post.title.length > 120) { toast('标题太长了', true); return; }
    if (!post.content.trim()) { toast('正文还是空的', true); $('#f-content').focus(); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(post.date)) { toast('日期格式不对', true); return; }
    if (post.author && post.author.length > 60) {
      toast('作者名太长了', true); $('#f-author').focus(); return;
    }

    var list = state.posts.slice();
    var idx = post.id ? list.findIndex(function (p) { return p.id === post.id; }) : -1;
    var created = idx < 0;

    if (created) {
      var taken = new Set();
      list.forEach(function (p) { taken.add(p.id); });
      post.id = makeId(post.title, taken);
      list.push(post);
    } else {
      list[idx] = post;
    }    state.posts = list.sort(byDateDesc);

    var btn = $('#btn-save');
    btn.disabled = true;
    btn.textContent = '提交中…';

    commit((created ? '新文章：' : '更新：') + post.title)
      .then(function (data) {
        clearDraft(post.id);
        clearDraft('');
        state.original = JSON.parse(JSON.stringify(post));
        state.editing = post;
        renderList();
        show('list');
        var sha = data && data.commit && data.commit.sha ? data.commit.sha.slice(0, 7) : '';
        toast('已提交' + (sha ? '（' + sha + '）' : '') +
              (post.hidden ? '，这篇是隐藏的' : '') + '，网站约 1 分钟后更新');
      })
      .catch(function (err) {
        // 提交失败：回滚内存状态，避免界面与远端不一致
        return loadPosts().catch(function () {}).then(function () {
          toast(err.message, true);
        });
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = '保存并发布';
      });
  }

  function doDelete(id, title) {
    if (!confirm('确定删掉《' + title + '》吗？\n会向仓库提交一次删除。')) return;

    var removed = state.posts.filter(function (p) { return p.id === id; })[0];
    state.posts = state.posts.filter(function (p) { return p.id !== id; });

    commit('删除：' + title)
      .then(function () {
        clearDraft(id);
        renderList();
        toast('已删除，网站约 1 分钟后更新');
      })
      .catch(function (err) {
        if (removed) state.posts.push(removed);
        state.posts.sort(byDateDesc);
        renderList();
        toast(err.message, true);
      });
  }

  function togglePreview() {
    var wrap = $('#preview-wrap');
    if (!wrap.hidden) {
      wrap.hidden = true;
      $('#btn-preview').textContent = '预览';
      return;
    }
    $('#preview').innerHTML = MD.render($('#f-content').value);
    wrap.hidden = false;
    $('#btn-preview').textContent = '收起预览';
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function doExport() {
    var blob = new Blob([JSON.stringify(state.posts, null, 2) + '\n'],
                        { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'posts-' + todayISO() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('已导出备份');
  }

  /* ======================================================================
     站点信息（data/site.json）
     ----------------------------------------------------------------------
     首页那段自我介绍、关于页、页脚落款。跟文章一样是一次 commit。
     字段顺序固定，方便看 diff；也为空就删掉，保持文件干净。
     ====================================================================== */

  var DEFAULT_SITE = {
    hero: { title: '', tagline: '', chips: [] },
    about: { sub: '', now: { title: '', items: [] }, body: '' },
    footer: { note: '' }
  };

  function loadSite() {
    var ref = encodeURIComponent(CFG.branch || 'main');
    return gh(contentsPathOf(sitePath()) + '?ref=' + ref).then(function (data) {
      if (!data || typeof data.content !== 'string') {
        throw new Error('站点信息读取失败');
      }
      state.siteSha = data.sha;
      var obj = JSON.parse(b64decode(data.content));
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error('site.json 格式不对：顶层应该是一个对象');
      }
      state.site = obj;
      return true;                       // true = 远端有这个文件
    }).catch(function (err) {
      if (err.status === 404) {          // 还没有这个文件：从空开始，保存时会创建
        state.siteSha = null;
        state.site = JSON.parse(JSON.stringify(DEFAULT_SITE));
        return false;
      }
      throw err;
    });
  }

  /* 「此刻」条目在界面里是「名称 | 内容」一行一条 */
  function nowToLines(now) {
    return ((now && now.items) || []).map(function (it) {
      return (it.label || '') + ' | ' + (it.text || '');
    }).join('\n');
  }

  function linesToNow(text) {
    return String(text || '').split('\n').map(function (ln) {
      var i = ln.indexOf('|');
      var label = (i < 0 ? ln : ln.slice(0, i)).trim();
      var val = (i < 0 ? '' : ln.slice(i + 1)).trim();
      return { label: label, text: val };
    }).filter(function (it) {
      return it.label || it.text;
    }).slice(0, 12);
  }

  function fillSiteForm() {
    var s = state.site || DEFAULT_SITE;
    var hero = s.hero || {}, about = s.about || {}, now = about.now || {};
    var footer = s.footer || {};

    $('#s-hero-title').value = hero.title || '';
    $('#s-hero-tagline').value = hero.tagline || '';
    $('#s-hero-chips').value = (hero.chips || []).join(', ');
    $('#s-about-sub').value = about.sub || '';
    $('#s-now-title').value = now.title || '';
    $('#s-now-items').value = nowToLines(now);
    $('#s-about-body').value = about.body || '';
    $('#s-footer-note').value = footer.note || '';

    $('#site-preview-wrap').hidden = true;
    $('#btn-site-preview').textContent = '预览关于页';
  }

  function readSiteForm() {
    return {
      hero: {
        title: $('#s-hero-title').value.trim(),
        tagline: $('#s-hero-tagline').value.trim(),
        chips: $('#s-hero-chips').value.split(/[,，]/)
                 .map(function (t) { return t.trim(); })
                 .filter(Boolean).slice(0, 6)
      },
      about: {
        sub: $('#s-about-sub').value.trim(),
        now: {
          title: $('#s-now-title').value.trim(),
          items: linesToNow($('#s-now-items').value)
        },
        body: $('#s-about-body').value
      },
      footer: {
        note: $('#s-footer-note').value.trim()
      }
    };
  }

  function isSiteDirty() {
    if (!state.site) return false;
    return JSON.stringify(readSiteForm()) !== JSON.stringify(state.site);
  }

  function openSite() {
    var btn = $('#btn-site');
    btn.disabled = true;
    loadSite().then(function (exists) {
      fillSiteForm();
      // 基线设成「表单现在的样子」，这样脏检查只反映用户自己的改动
      state.site = readSiteForm();
      $('#site-missing').hidden = (exists !== false);
      show('site');
    }).catch(function (err) {
      toast(err.message, true);
    }).then(function () {
      btn.disabled = false;
    });
  }

  function backFromSite() {
    if (isSiteDirty() && !confirm('站点信息有改动还没保存，确定要离开吗？')) return;
    state.site = null;                   // 下次进来重新拉一遍，拿到最新的 sha
    renderList();
    show('list');
  }

  function saveSite() {
    var site = readSiteForm();
    var btn = $('#btn-site-save');
    btn.disabled = true;
    btn.textContent = '提交中…';

    var body = {
      message: '更新站点信息',
      content: b64encode(JSON.stringify(site, null, 2) + '\n'),
      branch: CFG.branch || 'main'
    };
    if (state.siteSha) body.sha = state.siteSha;

    gh(contentsPathOf(sitePath()), { method: 'PUT', body: body }).then(function (data) {
      if (data && data.content && data.content.sha) state.siteSha = data.content.sha;
      state.site = site;
      $('#site-missing').hidden = true;
      var sha = data && data.commit && data.commit.sha ? data.commit.sha.slice(0, 7) : '';
      toast('已提交' + (sha ? '（' + sha + '）' : '') + '，网站约 1 分钟后更新');
    }).catch(function (err) {
      // 撞车（文件在别处被改过）：重新拉一次，免得下次还带着过期的 sha
      return loadSite().catch(function () {}).then(function () {
        toast(err.message, true);
      });
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '保存并发布';
    });
  }

  function toggleSitePreview() {
    var wrap = $('#site-preview-wrap');
    if (!wrap.hidden) {
      wrap.hidden = true;
      $('#btn-site-preview').textContent = '预览关于页';
      return;
    }
    var about = readSiteForm().about;
    $('#site-preview').innerHTML =
      '<p class="sub">' + esc(about.sub) + '</p>' +
      SITE.aboutBodyHTML(about.body, about.now);
    wrap.hidden = false;
    $('#btn-site-preview').textContent = '收起预览';
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ======================================================================
     绑定
     ====================================================================== */

  function bind() {
    /* ---------- 连接 ---------- */
    $('#btn-connect').addEventListener('click', function () {
      var btn = this;
      var token = $('#f-token').value.trim();
      if (!token) { toast('先贴上令牌', true); $('#f-token').focus(); return; }

      btn.disabled = true;
      btn.textContent = '连接中…';
      connect(token).catch(function (err) {
        state.token = '';
        toast(err.message, true);
      }).then(function () {
        btn.disabled = false;
        btn.textContent = '连接';
      });
    });

    $('#f-token').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('#btn-connect').click(); }
    });

    $('#btn-new').addEventListener('click', function () { openEditor(null); });
    $('#btn-back').addEventListener('click', backToList);
    $('#btn-save').addEventListener('click', doSave);
    $('#btn-preview').addEventListener('click', togglePreview);
    $('#btn-refresh').addEventListener('click', refresh);
    $('#btn-export').addEventListener('click', doExport);

    /* ---------- 站点信息 ---------- */
    $('#btn-site').addEventListener('click', openSite);
    $('#btn-site-back').addEventListener('click', backFromSite);
    $('#btn-site-save').addEventListener('click', saveSite);
    $('#btn-site-preview').addEventListener('click', toggleSitePreview);

    $('#btn-disconnect').addEventListener('click', function () {
      if (!confirm('断开写作台？\n\n会清掉这台设备上记住的令牌，下次要重新贴一次。\n' +
                   '（文章不受影响）')) return;
      disconnect();
      toast('已断开');
    });

    $('#list').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn || btn.disabled) return;
      var id = btn.closest('li').getAttribute('data-id');
      var act = btn.getAttribute('data-act');

      if (act === 'up') return movePost(id, -1);
      if (act === 'down') return movePost(id, 1);
      if (act === 'top') return movePost(id, 'top');

      var post = state.posts.filter(function (p) { return p.id === id; })[0];
      if (!post) return;
      if (act === 'edit') openEditor(post);
      else doDelete(id, post.title);
    });

    $('#btn-sort').addEventListener('click', function () {
      if (state.sorting) cancelSort();
      else enterSort();
    });
    $('#btn-sort-save').addEventListener('click', saveSort);
    $('#btn-sort-cancel').addEventListener('click', cancelSort);
    initDrag();

    var tagbar = $('#admin-tagbar');
    if (tagbar) {
      tagbar.addEventListener('click', function (e) {
        var btn = e.target.closest('.tag-btn');
        if (!btn) return;
        state.filterTag = btn.getAttribute('data-tag') || '';
        renderList();
      });
    }

    $('#btn-draft-restore').addEventListener('click', function () {
      var draft = readDraft(state.editing.id);
      if (!draft || !draft.post) return;
      state.editing = draft.post;
      fillForm(draft.post);
      $('#draft-banner').hidden = true;
      toast('草稿已恢复');
    });

    $('#btn-draft-discard').addEventListener('click', function () {
      clearDraft(state.editing.id);
      $('#draft-banner').hidden = true;
      toast('草稿已丢弃');
    });

    ['#f-title', '#f-date', '#f-tags', '#f-lede', '#f-content', '#f-author', '#f-hidden']
      .forEach(function (sel) {
        var el = $(sel);
        var onEdit = function () {
          state.editing = readForm();
          scheduleDraft();
        };
        el.addEventListener('input', onEdit);
        el.addEventListener('change', onEdit);
      });

    window.addEventListener('beforeunload', function (e) {
      var dirty = (!$('#view-edit').hidden && isDirty()) ||
                  (!$('#view-site').hidden && isSiteDirty()) ||
                  (state.sorting && sortDirty());
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) saveDraft();
    });
  }

  /* ======================================================================
     启动
     ====================================================================== */

  document.addEventListener('DOMContentLoaded', function () {
    bind();
    renderRepoInfo();
    renderConnect();

    if (!CFG.owner || !CFG.repo) { show('connect'); return; }

    // 本地双击打开（file://）也能正常用：GitHub API 允许跨域，令牌也存得下。
    // 只是顺手提一句还有本地服务这条路。
    if (location.protocol === 'file:') {
      var hint = document.createElement('p');
      hint.className = 'lead';
      hint.style.cssText = 'margin:16px 0 0;font-size:13.5px';
      hint.innerHTML = '你正在本地打开这个页面，功能完全可用。' +
        '如果浏览器拦了跨域请求，可以改用 <code>node .tools/preview.js</code> 起本地服务。';
      $('#view-connect .admin-card').appendChild(hint);
    }

    // 先站在连接页：自动登录要发几个网络请求，期间页面不能是空白的
    show('connect');

    var saved = '';
    try { saved = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { /* ignore */ }
    if (!saved) return;                       // 没贴过令牌，等用户贴

    var btn = $('#btn-connect');
    btn.disabled = true;
    btn.textContent = '正在自动登录…';

    connect(saved).catch(function (err) {
      setToken('');
      show('connect');
      toast('自动登录失败：' + err.message + '，请重新贴一次令牌', true);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '连接';
    });
  });

})();
