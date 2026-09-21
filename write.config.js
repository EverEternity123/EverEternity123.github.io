/* ==========================================================================
   write.config.js — 写作台要写到哪个仓库
   --------------------------------------------------------------------------
   只有这个文件需要你手改。改完提交，刷新写作台即可。

   当前配置对应：https://evereternity123.github.io
   写作台地址：  https://evereternity123.github.io/write.html
   ========================================================================== */
window.BLOG_CONFIG = {
  // 你的 GitHub 用户名
  owner: 'EverEternity123',

  // 存放博客的仓库名
  repo: 'EverEternity123.github.io',

  // 分支名。GitHub 新建仓库默认是 main，老仓库可能是 master
  branch: 'main',

  // 文章数据在这个仓库里的路径（相对仓库根目录）
  path: 'data/posts.json',

  // 站点信息（首页介绍、关于页、页脚）的路径。
  // 写作台里「站点信息」那一屏改的就是它，同样是一次 commit。
  sitePath: 'data/site.json',

  // 自定义文章顺序的路径。写作台里「排序」那一屏改的就是它。
  // 里面只有一串 id；不在这个列表里的文章（＝新发的）按日期插到对应的位置。
  orderPath: 'data/order.json',

  // 站点地址，仅用于界面上显示提示，可留空
  siteUrl: 'https://evereternity123.github.io',

  // 新文章默认作者。写作台里「作者」一栏留空时用它
  defaultAuthor: 'Ever Eternity'
};
