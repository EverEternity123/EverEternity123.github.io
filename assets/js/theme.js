/* ==========================================================================
   theme.js — 明暗主题切换
   优先级：localStorage > 系统偏好
   ========================================================================== */
(function () {
  'use strict';

  var KEY = 'ee-blog-theme';
  var root = document.documentElement;

  function current() {
    return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function apply(theme, animate) {
    if (animate) {
      root.classList.add('theme-anim');
      window.setTimeout(function () { root.classList.remove('theme-anim'); }, 360);
    }
    root.setAttribute('data-theme', theme);
    try { localStorage.setItem(KEY, theme); } catch (e) { /* 隐私模式忽略 */ }

    var btn = document.querySelector('.theme-toggle');
    if (btn) {
      btn.setAttribute('aria-label', theme === 'dark' ? '切换到浅色模式' : '切换到深色模式');
      btn.setAttribute('title', theme === 'dark' ? '切换到浅色模式' : '切换到深色模式');
    }
  }

  function toggle() {
    apply(current() === 'dark' ? 'light' : 'dark', true);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.querySelector('.theme-toggle');
    if (btn) {
      btn.addEventListener('click', toggle);
      btn.setAttribute('aria-label', current() === 'dark' ? '切换到浅色模式' : '切换到深色模式');
    }

    // 未手动设置过时，跟随系统变化
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function (e) {
        var saved = null;
        try { saved = localStorage.getItem(KEY); } catch (err) { /* ignore */ }
        if (!saved) apply(e.matches ? 'dark' : 'light', true);
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  });
})();
