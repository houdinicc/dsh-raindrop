/**
 * Raindrop 仪表盘（dsh-raindrop）—— 客户端半（浏览器 bundle）。
 *
 * 这是宿主 `exports["./client"]` 指向的产物：一个自注册的懒工厂，由
 * `window.__ModuleLoader__` 在浏览器里登记。`id` 必须等于包名。
 *
 * 约束（CONTRACT.md §5）：
 *  - 这是手写单文件 bundle，不是 npm 包：只用 `require('react')`，其余全部手写；
 *  - 只用 `--dsw-alias-*` 主题 token，不写字面色值（数据可视化用 token 或
 *    `color-mix(in srgb, var(--dsw-alias-…) X%, transparent)`）；
 *  - 只注册 `sidebar.panellist` 与 `main` 两个槽位；不写组件之外的 DOM；
 *  - 工厂体内无副作用，样式/文案注册都放在 `apply` 的 ctx.effect 里。
 *
 * 数据通道：宿主 HTTP 路由 `/api/dsh-raindrop/*`。这里用**文档相对路径**
 * （GUI 有 `<base href="./">`，根绝对路径会在子路径部署下逃出前缀）。
 * 响应信封统一为 `{ ok:true, value }` / `{ ok:false, error:{ code, message } }`。
 */

window.__ModuleLoader__.load({
  id: 'dsh-raindrop',

  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'raindrop';
    const API = 'api/dsh-raindrop';
    const TOKEN_URL = 'https://app.raindrop.io/settings/integrations';
    const RAINDROP_ROOT = 'https://app.raindrop.io/my/0';
    const RAINDROP_UNSORTED = 'https://app.raindrop.io/my/-1';

    // ---------------------------------------------------------------- 文案

    const zh = {
      'entry.label': 'Raindrop Dashboard',
      'panel.title': 'Raindrop Dashboard',
      'panel.refresh': '刷新',
      'panel.refreshing': '刷新中…',
      'panel.tokenActive': '已连接',
      'panel.tokenInactive': '未连接',
      'state.loading': '加载中…',
      'state.failed': '加载失败：{error}',
      'state.retry': '重试',
      'state.stale': '刷新失败，下面是上次加载的数据：{error}',
      'kpi.all': '总收藏',
      'kpi.month': '本月新增',
      'kpi.monthHint': '{month}',
      'kpi.collections': '收藏夹',
      'kpi.tags': '标签',
      'section.types': '类型分布',
      'section.monthly': '月度趋势（近 12 个月）',
      'section.collections': '收藏夹分布',
      'section.groups': '分类分布',
      'section.domains': '热门域名 Top',
      'section.tags': '热门标签 Top',
      'section.cleanup': '待清理',
      'section.recent': '最近收藏',
      'chart.none': '暂无数据',
      'chart.basedOn': '基于最近 {n} 条样本',
      'chart.total': '共 {n} 条',
      'type.link': '链接',
      'type.article': '文章',
      'type.image': '图片',
      'type.video': '视频',
      'type.document': '文档',
      'type.audio': '音频',
      'collections.untitled': '未命名收藏夹',
      'collections.more': '共 {total} 个，仅显示前 {shown} 个',
      'collections.total': '共 {n} 个收藏夹',
      'groups.note': '共 {n} 个顶层分类 · 含子收藏夹',
      'groups.open': '在 Raindrop 中打开 {title}',
      'domains.unknown': '未知域名',
      'domains.open': '在新标签页打开 {domain}',
      'tags.capped': '仅显示前 {n} 个标签',
      'tags.open': '在 Raindrop 中打开 #{tag}',
      'cleanup.broken': '死链',
      'cleanup.broken.hint': '打不开的链接',
      'cleanup.untagged': '无标签',
      'cleanup.untagged.hint': '还没打标签',
      'cleanup.duplicates': '重复',
      'cleanup.duplicates.hint': '重复收藏',
      'cleanup.unavailable': '当前账号不可用',
      'cleanup.unsorted': '未分类',
      'cleanup.unsorted.hint': '未归入收藏夹',
      'recent.important': '重要',
      'recent.broken': '死链',
      'recent.untitled': '未命名收藏',
      'recent.count': '共 {n} 条',
      'time.justNow': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
      'time.days': '{n} 天前',
      'time.months': '{n} 个月前',
      'time.years': '{n} 年前',
      'time.unknown': '时间未知',
      'footer.scanComplete': '全库已扫描',
      'footer.sample': '基于最近 {n} 条样本',
      'footer.updated': '更新于 {time}',
      'footer.warnings': '部分数据不可用：{warnings}',
      'warning.filters': '类型与清理筛选暂不可用',
      'warning.tags': '标签接口暂不可用',
      'warning.collections': '收藏夹接口暂不可用',
      'warning.stats': '总收藏统计暂不可用',
      'warning.children': '子收藏夹接口暂不可用',
      'list.sep': '、',
      'token.title': '连接 Raindrop.io',
      'token.intro':
        '面板需要一个 Raindrop API Token 才能读取你的收藏库。Token 只保存在本机 Host 的配置文件里，不会写入浏览器存储。',
      'token.step1': '打开 Raindrop 集成设置：',
      'token.step2': '点开「For Developers」，创建一个 Test token 并复制。',
      'token.step3': '把 Token 粘贴到下面，点「保存并加载」。',
      'token.link': 'app.raindrop.io/settings/integrations',
      'token.placeholder': '粘贴 Test token',
      'token.save': '保存并加载',
      'token.saving': '保存中…',
      'token.clear': '清除 Token',
      'token.clearing': '清除中…',
      'token.configure': '重新配置 Token',
      'token.hide': '收起 Token 设置',
      'token.masked': '当前 Token：{masked}',
    };

    const en = {
      'entry.label': 'Raindrop Dashboard',
      'panel.title': 'Raindrop Dashboard',
      'panel.refresh': 'Refresh',
      'panel.refreshing': 'Refreshing…',
      'panel.tokenActive': 'Connected',
      'panel.tokenInactive': 'Not connected',
      'state.loading': 'Loading…',
      'state.failed': 'Load failed: {error}',
      'state.retry': 'Retry',
      'state.stale': 'Refresh failed — showing the last loaded data: {error}',
      'kpi.all': 'Bookmarks',
      'kpi.month': 'Added this month',
      'kpi.monthHint': '{month}',
      'kpi.collections': 'Collections',
      'kpi.tags': 'Tags',
      'section.types': 'By type',
      'section.monthly': 'Monthly trend (last 12 months)',
      'section.collections': 'By collection',
      'section.groups': 'By category',
      'section.domains': 'Top domains',
      'section.tags': 'Top tags',
      'section.cleanup': 'Cleanup backlog',
      'section.recent': 'Recently saved',
      'chart.none': 'No data yet',
      'chart.basedOn': 'Based on the latest {n} sampled items',
      'chart.total': '{n} total',
      'type.link': 'Links',
      'type.article': 'Articles',
      'type.image': 'Images',
      'type.video': 'Videos',
      'type.document': 'Documents',
      'type.audio': 'Audio',
      'collections.untitled': 'Untitled collection',
      'collections.more': '{total} total, showing the first {shown}',
      'collections.total': '{n} collections',
      'groups.note': '{n} top-level categories · counts include sub-collections',
      'groups.open': 'Open {title} in Raindrop',
      'domains.unknown': 'Unknown domain',
      'domains.open': 'Open {domain} in a new tab',
      'tags.capped': 'Showing the first {n} tags',
      'tags.open': 'Open #{tag} in Raindrop',
      'cleanup.broken': 'Broken',
      'cleanup.broken.hint': 'Links that no longer work',
      'cleanup.untagged': 'Untagged',
      'cleanup.untagged.hint': 'No tags yet',
      'cleanup.duplicates': 'Duplicates',
      'cleanup.duplicates.hint': 'Saved more than once',
      'cleanup.unavailable': 'Unavailable for this account',
      'cleanup.unsorted': 'Unsorted',
      'cleanup.unsorted.hint': 'Not in a collection',
      'recent.important': 'Important',
      'recent.broken': 'Broken',
      'recent.untitled': 'Untitled bookmark',
      'recent.count': '{n} items',
      'time.justNow': 'just now',
      'time.minutes': '{n} min ago',
      'time.hours': '{n} h ago',
      'time.days': '{n} d ago',
      'time.months': '{n} mo ago',
      'time.years': '{n} y ago',
      'time.unknown': 'Unknown time',
      'footer.scanComplete': 'Full library scanned',
      'footer.sample': 'Based on the latest {n} sampled items',
      'footer.updated': 'Updated {time}',
      'footer.warnings': 'Some data is unavailable: {warnings}',
      'warning.filters': 'type / cleanup filters unavailable',
      'warning.tags': 'tags endpoint unavailable',
      'warning.collections': 'collections endpoint unavailable',
      'warning.stats': 'total stats unavailable',
      'warning.children': 'child collections endpoint unavailable',
      'list.sep': ', ',
      'token.title': 'Connect Raindrop.io',
      'token.intro':
        'The dashboard needs a Raindrop API Token to read your library. The token is stored only in the local Host config file, never in browser storage.',
      'token.step1': 'Open the Raindrop integrations page:',
      'token.step2': 'Open “For Developers”, create a Test token and copy it.',
      'token.step3': 'Paste the token below and click “Save and load”.',
      'token.link': 'app.raindrop.io/settings/integrations',
      'token.placeholder': 'Paste the Test token',
      'token.save': 'Save and load',
      'token.saving': 'Saving…',
      'token.clear': 'Remove token',
      'token.clearing': 'Removing…',
      'token.configure': 'Token settings',
      'token.hide': 'Hide token settings',
      'token.masked': 'Current token: {masked}',
    };

    // --------------------------------------------------------------- 样式

    const CSS = `
.dsr-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dsr-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 20px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsr-header-main{display:flex;align-items:center;gap:8px;min-width:0}
.dsr-title{margin:0;font-size:16px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsr-user{font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:2px 10px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsr-badge{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-bg-base);background:var(--dsw-alias-brand-primary);border-radius:999px;padding:1px 8px}
.dsr-header-spacer{flex:1 1 auto}
.dsr-tokenstate{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);flex:0 0 auto}
.dsr-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.dsr-dot.is-on{background:var(--dsw-alias-state-success-primary)}
.dsr-primary{color:var(--dsw-alias-bg-base);background:var(--dsw-alias-brand-primary);border:0;border-radius:6px;padding:5px 12px;font:inherit;cursor:pointer;flex:0 0 auto;white-space:nowrap}
.dsr-primary:disabled{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:default}
.dsr-ghost{color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 10px;font:inherit;cursor:pointer;flex:0 0 auto;white-space:nowrap}
.dsr-ghost:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.dsr-ghost:disabled{opacity:.55;cursor:default}
.dsr-ghost.is-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsr-body{flex:1 1 auto;min-height:0;overflow:auto;padding:8px 20px 28px}
.dsr-loading-hint{font-size:12px;color:var(--dsw-alias-label-secondary);margin:8px 0}
.dsr-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:8px 0 4px}
.dsr-kpi{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}
.dsr-kpi-value{font-size:22px;font-weight:600;line-height:30px;font-variant-numeric:tabular-nums}
.dsr-kpi-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsr-kpi-hint{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.75}
.dsr-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;margin:10px 0;background:var(--dsw-alias-bg-layer-1);min-width:0}
.dsr-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.dsr-card-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsr-card-note{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.8}
.dsr-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px}
.dsr-stack{display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.dsr-stack-seg{height:100%;min-width:2px}
.dsr-legend{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:10px}
.dsr-swatch{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:middle}
.dsr-bar-row{display:flex;align-items:center;gap:8px;font-size:12px;margin:4px 0;text-decoration:none;color:inherit}
a.dsr-bar-row:hover .dsr-bar-name{color:var(--dsw-alias-label-primary)}
.dsr-bar-name{flex:0 0 118px;box-sizing:border-box;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dsr-bar-track{flex:1 1 auto;height:10px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dsr-bar-fill{display:block;height:100%;border-radius:5px;background:var(--dsw-alias-brand-primary)}
.dsr-bar-value{flex:0 0 auto;min-width:38px;text-align:right;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsr-chips{display:flex;flex-wrap:wrap;gap:6px}
.dsr-tagchip{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);text-decoration:none;font-size:12px;max-width:100%}
.dsr-tagchip:hover{border-color:var(--dsw-alias-brand-primary)}
.dsr-tagchip.is-plain{cursor:default;color:var(--dsw-alias-label-secondary)}
.dsr-tagcount{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsr-cleans{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.dsr-clean{display:block;text-decoration:none;color:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}
.dsr-clean:hover{border-color:var(--dsw-alias-brand-primary)}
.dsr-clean-value{font-size:20px;font-weight:600;line-height:28px;font-variant-numeric:tabular-nums}
.dsr-clean-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsr-clean-hint{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.75}
.dsr-clean.is-error .dsr-clean-value{color:var(--dsw-alias-state-error-primary)}
.dsr-clean.is-warn .dsr-clean-value{color:var(--dsw-alias-state-warn-primary)}
.dsr-clean.is-zero{opacity:.55}
.dsr-clean.is-zero .dsr-clean-value{color:var(--dsw-alias-label-secondary)}
.dsr-recent{display:flex;flex-direction:column}
.dsr-recent-item{padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsr-recent-item:last-child{border-bottom:0}
.dsr-recent-title{display:block;color:var(--dsw-alias-label-primary);text-decoration:none;font-weight:500;overflow-wrap:anywhere}
a.dsr-recent-title:hover{text-decoration:underline}
.dsr-recent-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:3px}
.dsr-typebadge{display:inline-flex;align-items:center;padding:0 6px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsr-flag{display:inline-flex;align-items:center;padding:0 6px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);font-size:11px}
.dsr-flag.is-broken{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsr-flag.is-important{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dsr-recent-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}
.dsr-spark{display:flex;align-items:flex-end;gap:3px;height:82px}
.dsr-spark-col{flex:1 1 0;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:3px;min-width:0;height:100%}
.dsr-spark-bar{width:100%;min-height:2px;border-radius:3px 3px 0 0;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 70%,transparent)}
.dsr-spark-bar.is-current{background:var(--dsw-alias-brand-primary)}
.dsr-spark-label{font-size:10px;line-height:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsr-empty{color:var(--dsw-alias-label-secondary);font-size:13px;padding:6px 0}
.dsr-hint{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsr-error{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:12px 0;padding:10px 12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;color:var(--dsw-alias-label-primary)}
.dsr-inline-error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin-top:2px;overflow-wrap:anywhere}
.dsr-input{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 10px;font:inherit}
.dsr-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dsr-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.7}
.dsr-tokenform{display:flex;flex-direction:column;gap:8px;max-width:580px;margin-top:10px}
.dsr-tokenrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsr-tokenrow .dsr-input{flex:1 1 240px}
.dsr-guide-wrap{display:flex;justify-content:center;padding-top:32px}
.dsr-guide{max-width:640px;width:100%;margin:0}
.dsr-guide-title{margin:0 0 8px;font-size:16px;font-weight:600}
.dsr-guide-intro{margin:0 0 4px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsr-steps{margin:8px 0 4px;padding-left:20px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dsr-steps li{margin:4px 0;overflow-wrap:anywhere}
.dsr-steps a{color:var(--dsw-alias-brand-primary);overflow-wrap:anywhere}
.dsr-footer{display:flex;flex-direction:column;gap:8px;margin-top:16px;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsr-footer-row{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px}
.dsr-footer-config{display:flex;flex-direction:column;gap:2px}
.dsr-warn{color:var(--dsw-alias-state-warn-primary);overflow-wrap:anywhere}
.dsr-linkbtn{background:0 0;border:0;padding:0;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer}
.dsr-linkbtn:hover{text-decoration:underline}
.dsr-sep{opacity:.55}
.dsr-skel-line{height:10px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);margin:6px 0;animation:dsr-pulse 1.4s ease-in-out infinite}
.dsr-skel-value{height:22px;width:52%}
.dsr-skel-label{width:70%}
.dsr-skel-card{height:150px;border-radius:10px;margin:10px 0;background:var(--dsw-alias-bg-layer-2);animation:dsr-pulse 1.4s ease-in-out infinite}
.dsr-glyph{display:inline-flex}
@keyframes dsr-pulse{0%,100%{opacity:.5}50%{opacity:.9}}
@media (max-width:860px){.dsr-bar-name{flex-basis:88px}}
@media (prefers-reduced-motion:reduce){.dsr-skel-line,.dsr-skel-card{animation:none}}
`;

    const STYLE_TAG_ID = 'dsh-raindrop';

    /** 幂等地把样式注入 document.head；返回移除函数。 */
    function installStyles() {
      if (typeof document === 'undefined') return () => {};
      const selector = `style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`;
      const existing = document.querySelector(selector);
      if (existing !== null) return () => {};
      const tag = document.createElement('style');
      tag.dataset.pluginCss = STYLE_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        if (tag.parentNode !== null) tag.parentNode.removeChild(tag);
      };
    }

    // ------------------------------------------------------------ 数据通道

    async function request(path, init) {
      let response;
      try {
        response = await fetch(`${API}${path}`, {
          headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
          ...init,
        });
      } catch (cause) {
        const error = new Error(String(cause?.message ?? cause));
        error.code = 'network';
        throw error;
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (payload === null) {
        const error = new Error(`HTTP ${response.status}`);
        error.code = 'bad-response';
        throw error;
      }
      if (!response.ok || payload.ok !== true) {
        const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
        error.code = payload?.error?.code ?? `http-${response.status}`;
        throw error;
      }
      return payload.value;
    }

    const api = {
      status: () => request('/status'),
      saveToken: (token) => request('/token', { method: 'POST', body: JSON.stringify({ token }) }),
      clearToken: () => request('/token', { method: 'DELETE' }),
      dashboard: (force) => request(force ? '/dashboard?force=1' : '/dashboard'),
    };

    // -------------------------------------------------------------- 小工具

    const cls = (...parts) => parts.filter(Boolean).join(' ');

    const TYPE_ORDER = ['link', 'article', 'image', 'video', 'document', 'audio'];

    const TYPE_COLORS = {
      link: 'var(--dsw-alias-brand-primary)',
      article: 'var(--dsw-alias-state-success-primary)',
      image: 'var(--dsw-alias-state-warn-primary)',
      video: 'var(--dsw-alias-state-error-primary)',
      document: 'var(--dsw-alias-state-idle-primary)',
      audio: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 50%, transparent)',
    };

    const UNKNOWN_TYPE_COLOR = 'color-mix(in srgb, var(--dsw-alias-label-primary) 35%, transparent)';

    const typeColor = (type) => TYPE_COLORS[type] ?? UNKNOWN_TYPE_COLOR;

    const typeLabel = (type, t) =>
      TYPE_ORDER.includes(String(type)) ? t(`type.${type}`) : String(type ?? '');

    function formatCount(value) {
      const num = Number(value);
      if (!Number.isFinite(num)) return '0';
      return String(Math.round(num)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function formatPercent(count, total) {
      const c = Number(count);
      const sum = Number(total);
      if (!Number.isFinite(c) || !Number.isFinite(sum) || sum <= 0) return '0%';
      const pct = (c / sum) * 100;
      const rounded = pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
      return `${rounded}%`;
    }

    function safeArray(value) {
      return Array.isArray(value) ? value : [];
    }

    const pad2 = (value) => String(value).padStart(2, '0');

    function formatStamp(value) {
      const time = Date.parse(value);
      if (!Number.isFinite(time)) return String(value ?? '');
      const date = new Date(time);
      const now = new Date();
      const datePart =
        date.getFullYear() === now.getFullYear()
          ? `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
          : `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
      return `${datePart} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    function relativeTime(value, t) {
      const time = Date.parse(value);
      if (!Number.isFinite(time)) return t('time.unknown');
      const diff = Date.now() - time;
      if (diff < 60_000) return t('time.justNow');
      const minutes = Math.floor(diff / 60_000);
      if (minutes < 60) return t('time.minutes', { n: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t('time.hours', { n: hours });
      const days = Math.floor(hours / 24);
      if (days < 30) return t('time.days', { n: days });
      const months = Math.floor(days / 30);
      if (months < 12) return t('time.months', { n: months });
      return t('time.years', { n: Math.floor(months / 12) });
    }

    /** '2026-10' → '10'（图表 x 轴用的短标签；完整月份放在 title 里）。 */
    function shortMonth(value) {
      const text = String(value ?? '');
      const match = /^(\d{4})-(\d{2})$/.exec(text);
      return match === null ? text : String(Number(match[2]));
    }

    function monthCount(item) {
      const count = Number(item?.count);
      return Number.isFinite(count) ? count : 0;
    }

    function warningLabel(code, t) {
      const known = {
        'filters-unavailable': 'warning.filters',
        'tags-unavailable': 'warning.tags',
        'collections-unavailable': 'warning.collections',
        'collections-children-unavailable': 'warning.children',
        'stats-unavailable': 'warning.stats',
      };
      const key = known[String(code)];
      return key === undefined ? String(code) : t(key);
    }

    // ------------------------------------------------------------ 侧边栏字形

    function RaindropGlyph({ size = 16 }) {
      return h(
        'svg',
        {
          className: 'dsr-glyph',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', {
          d: 'M12 3.2C9.1 7.3 6.4 10.4 6.4 13.9a5.6 5.6 0 0011.2 0c0-3.5-2.7-6.6-5.6-10.7z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M9.4 14.2c0 1.5 1.2 2.7 2.7 2.7',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
      );
    }

    // -------------------------------------------------------------- 子组件

    function KpiCard({ label, value, hint }) {
      return h(
        'div',
        { className: 'dsr-kpi' },
        h('div', { className: 'dsr-kpi-value' }, String(value)),
        h('div', { className: 'dsr-kpi-label' }, label),
        hint === undefined || hint === null ? null : h('div', { className: 'dsr-kpi-hint' }, hint),
      );
    }

    /** Token 表单：needs-token 引导与页脚「重新配置」共用。 */
    function TokenForm({ t, busy, busyKind, error, masked, configured, onSave, onClear }) {
      const [draft, setDraft] = React.useState('');
      const alive = React.useRef(true);

      React.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const saveBusy = busy && busyKind === 'save';
      const clearBusy = busy && busyKind === 'clear';

      const submit = async (event) => {
        if (event !== undefined && typeof event.preventDefault === 'function') event.preventDefault();
        const value = draft.trim();
        if (value === '' || busy) return;
        const ok = await onSave(value);
        if (ok && alive.current) setDraft('');
      };

      const children = [];
      if (masked !== null && masked !== undefined) {
        children.push(h('div', { key: 'masked', className: 'dsr-hint' }, t('token.masked', { masked })));
      }
      children.push(
        h(
          'div',
          { key: 'row', className: 'dsr-tokenrow' },
          h('input', {
            type: 'password',
            autoComplete: 'off',
            spellCheck: false,
            className: 'dsr-input',
            placeholder: t('token.placeholder'),
            'aria-label': t('token.placeholder'),
            value: draft,
            disabled: busy,
            onChange: (event) => setDraft(event.target.value),
          }),
          h(
            'button',
            { type: 'submit', className: 'dsr-primary', disabled: busy || draft.trim() === '' },
            saveBusy ? t('token.saving') : t('token.save'),
          ),
        ),
      );
      if (configured) {
        children.push(
          h(
            'div',
            { key: 'clear', className: 'dsr-tokenrow' },
            h(
              'button',
              { type: 'button', className: 'dsr-ghost is-danger', disabled: busy, onClick: onClear },
              clearBusy ? t('token.clearing') : t('token.clear'),
            ),
          ),
        );
      }
      if (error !== null && error !== undefined) {
        children.push(
          h('div', { key: 'error', className: 'dsr-inline-error', role: 'alert' }, String(error)),
        );
      }

      return h('form', { className: 'dsr-tokenform', onSubmit: submit }, ...children);
    }

    function TokenGuide({ t, busy, busyKind, error, onSave }) {
      return h(
        'div',
        { className: 'dsr-body dsr-guide-wrap' },
        h(
          'div',
          { className: 'dsr-card dsr-guide' },
          h('h2', { className: 'dsr-guide-title' }, t('token.title')),
          h('p', { className: 'dsr-guide-intro' }, t('token.intro')),
          h(
            'ol',
            { className: 'dsr-steps' },
            h(
              'li',
              {},
              t('token.step1'),
              ' ',
              h(
                'a',
                { href: TOKEN_URL, target: '_blank', rel: 'noopener noreferrer' },
                t('token.link'),
              ),
            ),
            h('li', {}, t('token.step2')),
            h('li', {}, t('token.step3')),
          ),
          h(TokenForm, { t, busy, busyKind, error, masked: null, configured: false, onSave }),
        ),
      );
    }

    function TypeDistribution({ types, t }) {
      const counts = new Map();
      for (const entry of safeArray(types)) {
        const type = String(entry?.type ?? '');
        const count = Number(entry?.count);
        counts.set(type, Number.isFinite(count) ? count : 0);
      }
      const entries = [];
      for (const type of TYPE_ORDER) entries.push({ type, count: counts.get(type) ?? 0, known: true });
      for (const [type, count] of counts) {
        if (!TYPE_ORDER.includes(type)) entries.push({ type, count, known: false });
      }
      const total = entries.reduce((sum, entry) => sum + entry.count, 0);

      const head = h(
        'div',
        { className: 'dsr-card-head' },
        h('h3', { className: 'dsr-card-title' }, t('section.types')),
        h('span', { className: 'dsr-card-note' }, t('chart.total', { n: formatCount(total) })),
      );

      if (total === 0) {
        return h('div', { className: 'dsr-card' }, head, h('div', { className: 'dsr-empty' }, t('chart.none')));
      }

      const segments = entries
        .filter((entry) => entry.count > 0)
        .map((entry) =>
          h('span', {
            key: entry.type,
            className: 'dsr-stack-seg',
            style: { width: `${(entry.count / total) * 100}%`, background: typeColor(entry.type) },
            title: `${typeLabel(entry.type, t)} ${formatCount(entry.count)} (${formatPercent(entry.count, total)})`,
          }),
        );

      const legend = h(
        'div',
        { className: 'dsr-legend' },
        ...entries.map((entry) =>
          h(
            'span',
            { key: entry.type },
            h('span', { className: 'dsr-swatch', style: { background: typeColor(entry.type) } }),
            `${typeLabel(entry.type, t)} ${formatCount(entry.count)} · ${formatPercent(entry.count, total)}`,
          ),
        ),
      );

      return h(
        'div',
        { className: 'dsr-card' },
        head,
        h('div', { className: 'dsr-stack', role: 'img', 'aria-label': t('section.types') }, ...segments),
        legend,
      );
    }

    function MonthlyTrend({ monthly, t, scan }) {
      const items = safeArray(monthly).slice(-12);
      const counts = items.map(monthCount);
      const max = Math.max(1, ...counts);
      const basedOn = Number(scan?.scanned) > 0 ? t('chart.basedOn', { n: formatCount(scan.scanned) }) : null;

      const head = h(
        'div',
        { className: 'dsr-card-head' },
        h('h3', { className: 'dsr-card-title' }, t('section.monthly')),
        basedOn === null ? null : h('span', { className: 'dsr-card-note' }, basedOn),
      );

      if (items.length === 0) {
        return h('div', { className: 'dsr-card' }, head, h('div', { className: 'dsr-empty' }, t('chart.none')));
      }

      const columns = items.map((item, index) => {
        const count = counts[index];
        const current = index === items.length - 1;
        const height = Math.max(count > 0 ? 4 : 0, (count / max) * 100);
        return h(
          'div',
          {
            key: `${item?.month ?? index}`,
            className: 'dsr-spark-col',
            title: `${String(item?.month ?? '')}: ${formatCount(count)}`,
          },
          h('span', {
            className: cls('dsr-spark-bar', current && 'is-current'),
            style: { height: `${height}%` },
          }),
          index % 3 === 0 || current
            ? h('span', { className: 'dsr-spark-label' }, shortMonth(item?.month))
            : null,
        );
      });

      return h('div', { className: 'dsr-card' }, head, h('div', { className: 'dsr-spark' }, ...columns));
    }

    function CollectionBars({ collections, groups, t }) {
      // 优先用宿主聚合好的顶层分类（含子收藏夹合计）；缺失时退回归一化后的收藏夹列表。
      const groupRows = safeArray(groups);
      const usingGroups = groupRows.length > 0;
      const all = usingGroups ? groupRows : safeArray(collections);
      const rows = all.slice(0, 10);
      const max = Math.max(1, ...rows.map((row) => Number(row?.count) || 0));
      const note = usingGroups
        ? t('groups.note', { n: formatCount(groupRows.length) })
        : all.length > rows.length
          ? t('collections.more', { total: formatCount(all.length), shown: rows.length })
          : t('collections.total', { n: formatCount(all.length) });

      const head = h(
        'div',
        { className: 'dsr-card-head' },
        h('h3', { className: 'dsr-card-title' }, t(usingGroups ? 'section.groups' : 'section.collections')),
        h('span', { className: 'dsr-card-note' }, note),
      );

      if (rows.length === 0) {
        return h('div', { className: 'dsr-card' }, head, h('div', { className: 'dsr-empty' }, t('chart.none')));
      }

      const bars = rows.map((row, index) => {
        const count = Number(row?.count) || 0;
        const depth = usingGroups ? 0 : Math.max(0, Math.floor(Number(row?.depth) || 0));
        const title = row?.title === undefined || row.title === null || row.title === ''
          ? t('collections.untitled')
          : String(row.title);
        const id = Number(row?.id);
        const inner = [
          h(
            'span',
            {
              key: 'name',
              className: 'dsr-bar-name',
              style: { paddingLeft: `${Math.min(depth, 4) * 12}px` },
              title,
            },
            title,
          ),
          h(
            'span',
            { key: 'track', className: 'dsr-bar-track' },
            h('span', { key: 'fill', className: 'dsr-bar-fill', style: { width: `${(count / max) * 100}%` } }),
          ),
          h('span', { key: 'value', className: 'dsr-bar-value' }, formatCount(count)),
        ];
        if (!Number.isFinite(id)) {
          return h('div', { key: row?.id ?? index, className: 'dsr-bar-row' }, ...inner);
        }
        return h(
          'a',
          {
            key: row.id,
            className: 'dsr-bar-row',
            href: `https://app.raindrop.io/my/${id}`,
            target: '_blank',
            rel: 'noopener noreferrer',
            'aria-label': t('groups.open', { title }),
          },
          ...inner,
        );
      });

      return h('div', { className: 'dsr-card' }, head, ...bars);
    }

    function DomainBars({ domains, t, scan }) {
      const rows = safeArray(domains).slice(0, 8);
      const max = Math.max(1, ...rows.map((row) => Number(row?.count) || 0));
      const basedOn = Number(scan?.scanned) > 0 ? t('chart.basedOn', { n: formatCount(scan.scanned) }) : null;

      const head = h(
        'div',
        { className: 'dsr-card-head' },
        h('h3', { className: 'dsr-card-title' }, t('section.domains')),
        basedOn === null ? null : h('span', { className: 'dsr-card-note' }, basedOn),
      );

      if (rows.length === 0) {
        return h('div', { className: 'dsr-card' }, head, h('div', { className: 'dsr-empty' }, t('chart.none')));
      }

      const bars = rows.map((row, index) => {
        const count = Number(row?.count) || 0;
        const raw = String(row?.domain ?? '');
        const unknown = raw === '' || raw === 'unknown';
        const label = unknown ? t('domains.unknown') : raw;
        const inner = [
          h('span', { key: 'name', className: 'dsr-bar-name', title: raw === '' ? label : raw }, label),
          h(
            'span',
            { key: 'track', className: 'dsr-bar-track' },
            h('span', {
              className: 'dsr-bar-fill',
              style: {
                width: `${(count / max) * 100}%`,
                background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 70%, transparent)',
              },
            }),
          ),
          h('span', { key: 'value', className: 'dsr-bar-value' }, formatCount(count)),
        ];
        if (unknown) return h('div', { key: raw || index, className: 'dsr-bar-row' }, ...inner);
        return h(
          'a',
          {
            key: raw,
            className: 'dsr-bar-row',
            href: `https://${raw}`,
            target: '_blank',
            rel: 'noopener noreferrer',
            'aria-label': t('domains.open', { domain: raw }),
          },
          ...inner,
        );
      });

      return h('div', { className: 'dsr-card' }, head, ...bars);
    }

    function TagChips({ tags, t }) {
      const all = safeArray(tags);
      const rows = all.slice(0, 16);
      const head = h(
        'div',
        { className: 'dsr-card-head' },
        h('h3', { className: 'dsr-card-title' }, t('section.tags')),
        all.length > rows.length
          ? h('span', { className: 'dsr-card-note' }, t('tags.capped', { n: rows.length }))
          : null,
      );

      if (rows.length === 0) {
        return h('div', { className: 'dsr-card' }, head, h('div', { className: 'dsr-empty' }, t('chart.none')));
      }

      const chips = rows.map((row, index) => {
        const name = String(row?.name ?? '');
        const count = Number(row?.count) || 0;
        return h(
          'a',
          {
            key: `${name || index}`,
            className: 'dsr-tagchip',
            href: `${RAINDROP_ROOT}?search=%23${encodeURIComponent(name)}`,
            target: '_blank',
            rel: 'noopener noreferrer',
            title: t('tags.open', { tag: name }),
          },
          h('span', {}, `#${name}`),
          h('span', { className: 'dsr-tagcount' }, formatCount(count)),
        );
      });

      return h('div', { className: 'dsr-card' }, head, h('div', { className: 'dsr-chips' }, ...chips));
    }

    function CleanupCards({ totals, availability, t }) {
      const known = availability ?? {};
      const cards = [
        { key: 'broken', value: totals?.broken, href: RAINDROP_ROOT, tone: 'is-error', available: known.broken !== false },
        { key: 'untagged', value: totals?.untagged, href: RAINDROP_ROOT, tone: 'is-warn', available: known.untagged !== false },
        { key: 'duplicates', value: totals?.duplicates, href: RAINDROP_ROOT, tone: 'is-warn', available: known.duplicates !== false },
        { key: 'unsorted', value: totals?.unsorted, href: RAINDROP_UNSORTED, tone: 'is-warn', available: true },
      ];

      const tiles = cards.map((card) => {
        const available = card.available !== false;
        const value = Number(card.value) || 0;
        const inner = [
          h('div', { key: 'value', className: 'dsr-clean-value' }, available ? formatCount(value) : '—'),
          h('div', { key: 'label', className: 'dsr-clean-label' }, t(`cleanup.${card.key}`)),
          h('div', { key: 'hint', className: 'dsr-clean-hint' }, t(available ? `cleanup.${card.key}.hint` : 'cleanup.unavailable')),
        ];
        if (!available) {
          return h(
            'div',
            {
              key: card.key,
              className: cls('dsr-clean', card.tone, 'is-zero', 'is-unavailable'),
              'aria-label': `${t(`cleanup.${card.key}`)}: ${t('cleanup.unavailable')}`,
            },
            ...inner,
          );
        }
        return h(
          'a',
          {
            key: card.key,
            className: cls('dsr-clean', card.tone, value === 0 && 'is-zero'),
            href: card.href,
            target: '_blank',
            rel: 'noopener noreferrer',
            'aria-label': `${t(`cleanup.${card.key}`)}: ${formatCount(value)}`,
          },
          ...inner,
        );
      });

      return h(
        'div',
        { className: 'dsr-card' },
        h('div', { className: 'dsr-card-head' }, h('h3', { className: 'dsr-card-title' }, t('section.cleanup'))),
        h('div', { className: 'dsr-cleans' }, ...tiles),
      );
    }

    function RecentList({ recent, t, scan }) {
      const rows = safeArray(recent).slice(0, 12);
      const basedOn = Number(scan?.scanned) > 0 ? t('chart.basedOn', { n: formatCount(scan.scanned) }) : null;

      const head = h(
        'div',
        { className: 'dsr-card-head' },
        h('h3', { className: 'dsr-card-title' }, t('section.recent')),
        basedOn === null ? null : h('span', { className: 'dsr-card-note' }, basedOn),
      );

      if (rows.length === 0) {
        return h('div', { className: 'dsr-card' }, head, h('div', { className: 'dsr-empty' }, t('chart.none')));
      }

      const items = rows.map((item, index) => {
        const rawTitle = item?.title === undefined || item.title === null ? '' : String(item.title).trim();
        const link = typeof item?.link === 'string' ? item.link : '';
        const title = rawTitle !== '' ? rawTitle : link !== '' ? link : t('recent.untitled');

        const meta = [];
        const domainText = String(item?.domain ?? '');
        const typeText = typeLabel(item?.type, t);
        if (domainText !== '') meta.push(h('span', { key: 'domain' }, domainText));
        if (typeText !== '') {
          meta.push(h('span', { key: 'type', className: 'dsr-typebadge' }, typeText));
        }
        meta.push(h('span', { key: 'time' }, relativeTime(item?.created, t)));
        if (item?.broken === true) {
          meta.push(h('span', { key: 'broken', className: 'dsr-flag is-broken' }, t('recent.broken')));
        }
        if (item?.important === true) {
          meta.push(h('span', { key: 'important', className: 'dsr-flag is-important' }, t('recent.important')));
        }

        const tags = safeArray(item?.tags).slice(0, 3);
        const extra = safeArray(item?.tags).length - tags.length;
        const tagRow =
          tags.length === 0
            ? null
            : h(
                'div',
                { className: 'dsr-recent-tags' },
                ...tags.map((tag, tagIndex) =>
                  h('span', { key: `${tag}-${tagIndex}`, className: 'dsr-tagchip is-plain' }, `#${String(tag)}`),
                ),
                extra > 0 ? h('span', { className: 'dsr-hint' }, `+${extra}`) : null,
              );

        return h(
          'div',
          { key: item?.id ?? index, className: 'dsr-recent-item' },
          link === ''
            ? h('span', { className: 'dsr-recent-title' }, title)
            : h(
                'a',
                {
                  className: 'dsr-recent-title',
                  href: link,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  title: link,
                },
                title,
              ),
          h('div', { className: 'dsr-recent-meta' }, ...meta),
          tagRow,
        );
      });

      return h('div', { className: 'dsr-card' }, head, h('div', { className: 'dsr-recent' }, ...items));
    }

    function DashboardFooter({ data, t, scan, warnings, masked, tokenBusy, tokenBusyKind, tokenError, onSaveToken, onClearToken }) {
      const [open, setOpen] = React.useState(false);
      const complete = scan?.complete === true;
      const scanText = complete
        ? t('footer.scanComplete')
        : t('footer.sample', { n: formatCount(scan?.scanned ?? 0) });

      const warningText =
        warnings.length === 0
          ? null
          : t('footer.warnings', {
              warnings: warnings.map((code) => warningLabel(code, t)).join(t('list.sep')),
            });

      return h(
        'footer',
        { className: 'dsr-footer' },
        h(
          'div',
          { className: 'dsr-footer-row' },
          h('span', {}, scanText),
          h('span', { className: 'dsr-sep' }, '·'),
          h('span', {}, t('footer.updated', { time: formatStamp(data?.generatedAt) })),
        ),
        warningText === null ? null : h('div', { className: 'dsr-warn' }, warningText),
        h(
          'div',
          { className: 'dsr-footer-config' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsr-linkbtn',
              'aria-expanded': open ? 'true' : 'false',
              onClick: () => setOpen((value) => !value),
            },
            open ? t('token.hide') : t('token.configure'),
          ),
          open
            ? h(TokenForm, {
                t,
                busy: tokenBusy,
                busyKind: tokenBusyKind,
                error: tokenError,
                masked,
                configured: true,
                onSave: onSaveToken,
                onClear: onClearToken,
              })
            : null,
        ),
      );
    }

    function Skeleton({ t }) {
      const skeletons = [0, 1, 2, 3].map((index) =>
        h(
          'div',
          { key: index, className: 'dsr-kpi' },
          h('div', { className: 'dsr-skel-line dsr-skel-value' }),
          h('div', { className: 'dsr-skel-line dsr-skel-label' }),
        ),
      );
      return h(
        'div',
        { className: 'dsr-body', 'aria-busy': 'true' },
        h('div', { className: 'dsr-loading-hint' }, t('state.loading')),
        h('div', { className: 'dsr-kpis' }, ...skeletons),
        h('div', { className: 'dsr-grid2' }, h('div', { className: 'dsr-skel-card' }), h('div', { className: 'dsr-skel-card' })),
        h('div', { className: 'dsr-skel-card' }),
      );
    }

    function Dashboard({ data, t, scan, staleError, onRetry, masked, tokenBusy, tokenBusyKind, tokenError, onSaveToken, onClearToken }) {
      const totals = data?.totals ?? {};
      const monthly = safeArray(data?.monthly);
      const lastMonth = monthly.length > 0 ? monthly[monthly.length - 1] : null;
      const monthNew = monthCount(lastMonth);
      const warnings = safeArray(data?.warnings);
      const collections = safeArray(data?.collections);
      const groups = safeArray(data?.groups);
      const availability = data?.availability ?? {};

      const staleBanner =
        staleError === null || staleError === undefined
          ? null
          : h(
              'div',
              { className: 'dsr-error', role: 'alert' },
              h('span', {}, t('state.stale', { error: String(staleError) })),
              h('button', { type: 'button', className: 'dsr-ghost', onClick: onRetry }, t('state.retry')),
            );

      return h(
        'div',
        { className: 'dsr-body' },
        staleBanner,
        h(
          'div',
          { className: 'dsr-kpis' },
          h(KpiCard, { label: t('kpi.all'), value: formatCount(totals.all ?? 0) }),
          h(KpiCard, {
            label: t('kpi.month'),
            value: formatCount(monthNew),
            hint: lastMonth === null ? null : t('kpi.monthHint', { month: String(lastMonth.month ?? '') }),
          }),
          h(KpiCard, { label: t('kpi.collections'), value: formatCount(totals.collections ?? 0) }),
          h(KpiCard, { label: t('kpi.tags'), value: formatCount(totals.tags ?? 0) }),
        ),
        h(
          'div',
          { className: 'dsr-grid2' },
          h(TypeDistribution, { types: safeArray(data?.types), t }),
          h(MonthlyTrend, { monthly, t, scan }),
        ),
        h(
          'div',
          { className: 'dsr-grid2' },
          h(CollectionBars, { collections, groups, t }),
          h(DomainBars, { domains: safeArray(data?.domains), t, scan }),
        ),
        h(TagChips, { tags: safeArray(data?.tags), t }),
        h(CleanupCards, { totals, availability, t }),
        h(RecentList, { recent: safeArray(data?.recent), t, scan }),
        h(DashboardFooter, {
          data,
          t,
          scan,
          warnings,
          masked,
          tokenBusy,
          tokenBusyKind,
          tokenError,
          onSaveToken,
          onClearToken,
        }),
      );
    }

    // -------------------------------------------------------------- 主面板

    function RaindropPanel({ t }) {
      const [phase, setPhase] = React.useState('loading');
      const [data, setData] = React.useState(null);
      const [auth, setAuth] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [staleError, setStaleError] = React.useState(null);
      const [tokenError, setTokenError] = React.useState(null);
      const [busyKind, setBusyKind] = React.useState(null);
      const [refreshing, setRefreshing] = React.useState(false);

      const alive = React.useRef(true);
      const dataRef = React.useRef(null);

      React.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const loadDashboard = React.useCallback(async (force) => {
        try {
          const value = await api.dashboard(force);
          if (!alive.current) return;
          dataRef.current = value;
          setData(value);
          setStaleError(null);
          setError(null);
          setPhase('ready');
        } catch (cause) {
          if (!alive.current) return;
          const message = String(cause?.message ?? cause);
          if (cause?.code === 'not-configured') {
            dataRef.current = null;
            setData(null);
            setPhase('needs-token');
            return;
          }
          // 请求失败时不清空已有数据：保留上次结果，只提示刷新失败。
          if (dataRef.current !== null) {
            setStaleError(message);
            setPhase('ready');
          } else {
            setError(message);
            setPhase('error');
          }
        }
      }, []);

      const bootstrap = React.useCallback(async () => {
        setError(null);
        setStaleError(null);
        if (dataRef.current === null) setPhase('loading');
        try {
          const info = await api.status();
          if (!alive.current) return;
          setAuth(info ?? null);
          if (info === null || info === undefined || info.configured !== true) {
            dataRef.current = null;
            setData(null);
            setPhase('needs-token');
            return;
          }
          await loadDashboard(false);
        } catch (cause) {
          if (!alive.current) return;
          const message = String(cause?.message ?? cause);
          if (dataRef.current !== null) {
            setStaleError(message);
            setPhase('ready');
          } else {
            setError(message);
            setPhase('error');
          }
        }
      }, [loadDashboard]);

      React.useEffect(() => {
        bootstrap();
      }, [bootstrap]);

      const refresh = React.useCallback(async () => {
        setRefreshing(true);
        try {
          await loadDashboard(true);
        } finally {
          if (alive.current) setRefreshing(false);
        }
      }, [loadDashboard]);

      const saveToken = React.useCallback(
        async (value) => {
          setBusyKind('save');
          setTokenError(null);
          try {
            const info = await api.saveToken(value);
            if (!alive.current) return false;
            setAuth(info ?? null);
            await loadDashboard(true);
            return true;
          } catch (cause) {
            if (alive.current) setTokenError(String(cause?.message ?? cause));
            return false;
          } finally {
            if (alive.current) setBusyKind(null);
          }
        },
        [loadDashboard],
      );

      const clearToken = React.useCallback(async () => {
        setBusyKind('clear');
        setTokenError(null);
        try {
          const info = await api.clearToken();
          if (!alive.current) return;
          setAuth(info ?? { configured: false, masked: null, user: null });
          dataRef.current = null;
          setData(null);
          setStaleError(null);
          setPhase('needs-token');
        } catch (cause) {
          if (alive.current) setTokenError(String(cause?.message ?? cause));
        } finally {
          if (alive.current) setBusyKind(null);
        }
      }, []);

      const connected = auth?.configured === true || data !== null;
      const userName = data?.user?.name ?? auth?.user?.name ?? null;
      const pro = data?.user?.pro === true || auth?.user?.pro === true;
      const busy = busyKind !== null;
      const masked = auth?.masked ?? null;
      const scan = data?.scan ?? { scanned: 0, total: null, pages: 0, complete: true };

      // 已加载时刷新真实数据；未配置/出错时刷新改为重新走一遍 status 探测。
      const refreshAction = phase === 'ready' ? refresh : bootstrap;

      const header = h(
        'header',
        { className: 'dsr-header' },
        h(
          'div',
          { className: 'dsr-header-main' },
          h('h1', { className: 'dsr-title' }, t('panel.title')),
          userName === null || userName === '' ? null : h('span', { className: 'dsr-user', title: String(userName) }, String(userName)),
          pro ? h('span', { className: 'dsr-badge' }, 'Pro') : null,
        ),
        h('div', { className: 'dsr-header-spacer' }),
        h(
          'span',
          { className: 'dsr-tokenstate' },
          h('span', { className: cls('dsr-dot', connected && 'is-on'), 'aria-hidden': true }),
          t(connected ? 'panel.tokenActive' : 'panel.tokenInactive'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsr-primary',
            disabled: phase === 'loading' || refreshing || busy,
            onClick: refreshAction,
          },
          refreshing ? t('panel.refreshing') : t('panel.refresh'),
        ),
      );

      let body;
      if (phase === 'loading') {
        body = h(Skeleton, { t });
      } else if (phase === 'needs-token') {
        body = h(TokenGuide, { t, busy, busyKind, error: tokenError, onSave: saveToken });
      } else if (phase === 'error') {
        body = h(
          'div',
          { className: 'dsr-body' },
          h(
            'div',
            { className: 'dsr-error', role: 'alert' },
            h('span', {}, t('state.failed', { error: error ?? '' })),
            h('button', { type: 'button', className: 'dsr-ghost', onClick: bootstrap }, t('state.retry')),
          ),
        );
      } else if (data !== null) {
        body = h(Dashboard, {
          data,
          t,
          scan,
          staleError,
          onRetry: refresh,
          masked,
          tokenBusy: busy,
          tokenBusyKind: busyKind,
          tokenError,
          onSaveToken: saveToken,
          onClearToken: clearToken,
        });
      } else {
        body = h(Skeleton, { t });
      }

      return h('div', { className: 'dsr-root' }, header, body);
    }

    // ------------------------------------------------------------ 插件装配

    return {
      // 客户端**服务名**依赖（与 package.json 的 dsh.client.inject 不同，后者是包 id 排序）。
      inject: ['slots', 'locale'],

      apply(ctx) {
        ctx.effect(installStyles, 'dsh-raindrop: styles');
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-raindrop: dictionaries');
        const t = ctx.locale.bind(NS);

        // 侧边栏入口：id 必须与下面 main 的 key 相同，shell 才能把点击接到面板上。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'raindrop', order: 35, label: () => t('entry.label') },
            RaindropGlyph,
          ),
        );

        // 中央主面板：root 作用域的 keyed slot，按侧边栏条目 id 分发。
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'raindrop', locale: NS }, RaindropPanel),
        );
      },
    };
  },
});
