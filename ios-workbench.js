(function () {
  'use strict';

  var sidebar = document.getElementById('sidebar');
  var menuButton = document.getElementById('menuButton');
  var knowledgeApiRoot = window.location.protocol === 'file:' ? 'http://127.0.0.1:4173' : '';
  window.knowledgeApiRoot = knowledgeApiRoot;

  var themeStorageKey = 'design-knowledge-theme';
  var themeRoot = document.documentElement;
  var themeButtons = Array.prototype.slice.call(document.querySelectorAll('[data-theme-mode]'));
  var themeRefreshTimer = 0;
  var themeTransitionTimer = 0;

  function resolveTheme(mode, date) {
    if (mode !== 'auto') return mode;
    var hour = (date || new Date()).getHours();
    return hour >= 6 && hour < 18 ? 'light' : 'dark';
  }

  function updateThemeControls(mode, theme) {
    themeButtons.forEach(function (button) {
      var selected = button.dataset.themeMode === mode;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
      if (button.dataset.themeMode === 'auto') {
        button.setAttribute('aria-label', '自动模式，当前' + (theme === 'dark' ? '暗色' : '亮色'));
        button.title = '白天亮色，夜间暗色（当前' + (theme === 'dark' ? '暗色' : '亮色') + '）';
      }
    });
  }

  function scheduleThemeRefresh() {
    window.clearTimeout(themeRefreshTimer);
    if (themeRoot.dataset.themeMode !== 'auto') return;

    var now = new Date();
    var next = new Date(now);
    if (now.getHours() < 6) {
      next.setHours(6, 0, 1, 0);
    } else if (now.getHours() < 18) {
      next.setHours(18, 0, 1, 0);
    } else {
      next.setDate(next.getDate() + 1);
      next.setHours(6, 0, 1, 0);
    }
    themeRefreshTimer = window.setTimeout(function () {
      applyThemeMode('auto', false, true);
    }, Math.max(1000, next.getTime() - now.getTime()));
  }

  function applyThemeMode(mode, persist, animate) {
    if (mode !== 'light' && mode !== 'dark' && mode !== 'auto') mode = 'light';
    var theme = resolveTheme(mode);
    var themeChanged = themeRoot.dataset.theme !== theme;

    if (animate && themeChanged) {
      window.clearTimeout(themeTransitionTimer);
      themeRoot.classList.add('theme-changing');
      themeTransitionTimer = window.setTimeout(function () {
        themeRoot.classList.remove('theme-changing');
      }, 240);
    }

    themeRoot.dataset.themeMode = mode;
    themeRoot.dataset.theme = theme;
    themeRoot.style.colorScheme = theme;
    var colorSchemeMeta = document.querySelector('meta[name="color-scheme"]');
    var themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (colorSchemeMeta) colorSchemeMeta.setAttribute('content', theme);
    if (themeColorMeta) themeColorMeta.setAttribute('content', theme === 'dark' ? '#111820' : '#e5e8ed');

    if (persist) {
      try { localStorage.setItem(themeStorageKey, mode); } catch (error) {}
    }
    updateThemeControls(mode, theme);
    scheduleThemeRefresh();
  }

  themeButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      applyThemeMode(button.dataset.themeMode, true, true);
    });
  });

  applyThemeMode(themeRoot.dataset.themeMode || 'light', false, false);
  window.addEventListener('focus', function () {
    if (themeRoot.dataset.themeMode === 'auto') applyThemeMode('auto', false, true);
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && themeRoot.dataset.themeMode === 'auto') applyThemeMode('auto', false, true);
  });

  function closeSidebar() {
    if (sidebar) sidebar.classList.remove('open');
    if (menuButton) menuButton.setAttribute('aria-expanded', 'false');
  }

  var sidebarDismiss = document.getElementById('sidebarDismiss');
  var sidebarScrim = document.getElementById('sidebarScrim');
  if (sidebarDismiss) sidebarDismiss.addEventListener('click', closeSidebar);
  if (sidebarScrim) sidebarScrim.addEventListener('click', closeSidebar);

  if (sidebar) {
    sidebar.addEventListener('click', function (event) {
      if (window.innerWidth > 1030) return;
      if (event.target.closest('.component-button, #allCategories')) {
        closeSidebar();
      }
    });
  }

  if (menuButton) {
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.addEventListener('click', function () {
      window.requestAnimationFrame(function () {
        menuButton.setAttribute('aria-expanded', String(Boolean(sidebar && sidebar.classList.contains('open'))));
      });
    });
  }

  var localOnly = document.getElementById('localOnly');
  var resetFilters = document.getElementById('resetFilters');
  if (localOnly) {
    localOnly.addEventListener('click', function () {
      window.requestAnimationFrame(function () {
        localOnly.setAttribute('aria-pressed', String(localOnly.classList.contains('active')));
      });
    });
  }
  if (resetFilters && localOnly) {
    resetFilters.addEventListener('click', function () {
      window.requestAnimationFrame(function () {
        localOnly.setAttribute('aria-pressed', 'false');
      });
    });
  }

  function refreshKnowledgeStatus() {
    var statusElement = document.getElementById('assistantServiceStatus');
    if (!statusElement) return;
    fetch(knowledgeApiRoot + '/api/knowledge/status', { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (status) {
        statusElement.classList.toggle('ready', Boolean(status.ready));
        statusElement.classList.toggle('error', Boolean(status.error));
        if (status.ready) {
          var modeLabels = {
            'remote-model': '云端智能推理',
            'local-model': '本地智能推理',
            'extractive': '原文检索模式'
          };
          var mode = modeLabels[status.answerMode] || '原文检索模式';
          statusElement.querySelector('span').textContent = status.pages + ' 页正文 · ' + status.chunks + ' 个片段 · ' + mode;
          return;
        }
        if (status.error) {
          statusElement.querySelector('span').textContent = '正文索引服务异常';
          return;
        }
        statusElement.querySelector('span').textContent = '正在建立正文索引 ' + status.completed + '/' + status.total;
        window.setTimeout(refreshKnowledgeStatus, 1800);
      })
      .catch(function () {
        statusElement.classList.add('error');
        statusElement.querySelector('span').textContent = window.location.protocol === 'file:' ? '请先启动知识库服务' : '正文索引服务未连接';
        window.setTimeout(refreshKnowledgeStatus, 3000);
      });
  }

  refreshKnowledgeStatus();

  window.addEventListener('resize', function () {
    if (window.innerWidth > 1030) closeSidebar();
  });
})();
