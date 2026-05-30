(() => {
  const STORAGE_KEY = 'recipe-planner-theme';
  const DARK_THEME = 'dark';
  const LIGHT_THEME = 'light';
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function getStoredTheme() {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      return stored === DARK_THEME || stored === LIGHT_THEME ? stored : null;
    } catch (error) {
      return null;
    }
  }

  function resolveTheme(theme) {
    if (theme === DARK_THEME || theme === LIGHT_THEME) {
      return theme;
    }

    return mediaQuery.matches ? DARK_THEME : LIGHT_THEME;
  }

  function setTheme(theme, persist = false) {
    const resolvedTheme = resolveTheme(theme);
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;

    if (persist) {
      try {
        window.localStorage.setItem(STORAGE_KEY, resolvedTheme);
      } catch (error) {
        void error;
      }
    }

    updateToggle(resolvedTheme);
  }

  function createToggle() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-toggle';
    button.setAttribute('aria-live', 'polite');
    button.innerHTML = '<span class="theme-toggle-icon" aria-hidden="true"></span>';

    button.addEventListener('click', () => {
      const currentTheme = document.documentElement.dataset.theme === DARK_THEME ? DARK_THEME : LIGHT_THEME;
      setTheme(currentTheme === DARK_THEME ? LIGHT_THEME : DARK_THEME, true);
    });

    document.body.appendChild(button);
    return button;
  }

  function updateToggle(theme) {
    const toggle = document.querySelector('.theme-toggle');
    if (!toggle) {
      return;
    }

    const icon = toggle.querySelector('.theme-toggle-icon');
    const isDark = theme === DARK_THEME;

    if (icon) {
      icon.innerHTML = isDark
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.75v2.5M12 17.75v2.5M5.64 5.64l1.77 1.77M16.59 16.59l1.77 1.77M3.75 12h2.5M17.75 12h2.5M5.64 18.36l1.77-1.77M16.59 7.41l1.77-1.77M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.35 14.95A8.25 8.25 0 0 1 9.05 3.65a8.25 8.25 0 1 0 11.3 11.3Z"/></svg>';
    }

    toggle.setAttribute('aria-label', isDark ? 'Aktifkan light mode' : 'Aktifkan dark mode');
    toggle.setAttribute('title', isDark ? 'Aktifkan light mode' : 'Aktifkan dark mode');
  }

  const initialTheme = getStoredTheme();
  setTheme(initialTheme);

  document.addEventListener('DOMContentLoaded', () => {
    if (!document.querySelector('.theme-toggle')) {
      createToggle();
      updateToggle(document.documentElement.dataset.theme || resolveTheme(initialTheme));
    }
  });

  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', () => {
      if (!getStoredTheme()) {
        setTheme(null);
      }
    });
  }
})();
