/**
 * Omegooo Universal Auto-Translation & Language Switcher
 * Supports IP-based automatic language detection and manual switching across all pages.
 */

(function () {
  const STORAGE_KEY = 'omegooo_user_lang';
  
  const SUPPORTED_LANGUAGES = [
    { code: 'en', name: 'English', flag: '🇺🇸' },
    { code: 'he', name: 'עברית (Hebrew)', flag: '🇮🇱' },
    { code: 'es', name: 'Español (Spanish)', flag: '🇪🇸' },
    { code: 'ru', name: 'Русский (Russian)', flag: '🇷🇺' },
    { code: 'de', name: 'Deutsch (German)', flag: '🇩🇪' },
    { code: 'fr', name: 'Français (French)', flag: '🇫🇷' },
    { code: 'zh-CN', name: '中文 (Chinese)', flag: '🇨🇳' },
    { code: 'it', name: 'Italiano (Italian)', flag: '🇮🇹' },
    { code: 'pt', name: 'Português (Portuguese)', flag: '🇵🇹' },
    { code: 'tr', name: 'Türkçe (Turkish)', flag: '🇹🇷' },
    { code: 'ja', name: '日本語 (Japanese)', flag: '🇯🇵' },
    { code: 'ko', name: '한국어 (Korean)', flag: '🇰🇷' },
    { code: 'ar', name: 'العربية (Arabic)', flag: '🇸🇦' }
  ];

  function setGoogleTranslateCookie(langCode) {
    if (!langCode || langCode === 'en') {
      document.cookie = "googtrans=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
      document.cookie = "googtrans=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=" + location.hostname + ";";
      return;
    }
    const val = "/en/" + langCode;
    document.cookie = "googtrans=" + val + "; path=/;";
    document.cookie = "googtrans=" + val + "; path=/; domain=" + location.hostname + ";";
  }

  function applyLanguage(langCode, reloadIfChanged = true) {
    const currentStored = localStorage.getItem(STORAGE_KEY);
    localStorage.setItem(STORAGE_KEY, langCode);
    setGoogleTranslateCookie(langCode);

    if (reloadIfChanged && currentStored !== langCode) {
      window.location.reload();
    }
  }

  async function autoDetectAndSetLanguage() {
    let savedLang = localStorage.getItem(STORAGE_KEY);
    
    if (!savedLang) {
      try {
        const res = await fetch('/api/detect-language');
        const data = await res.json();
        if (data && data.success && data.detectedLang) {
          savedLang = data.detectedLang;
        }
      } catch (e) {
        console.warn("Language detection fallback:", e);
      }

      if (!savedLang) {
        const navLang = (navigator.language || navigator.userLanguage || 'en').toLowerCase();
        if (navLang.startsWith('he') || navLang.startsWith('iw')) savedLang = 'he';
        else if (navLang.startsWith('es')) savedLang = 'es';
        else if (navLang.startsWith('ru')) savedLang = 'ru';
        else if (navLang.startsWith('de')) savedLang = 'de';
        else if (navLang.startsWith('fr')) savedLang = 'fr';
        else if (navLang.startsWith('zh')) savedLang = 'zh-CN';
        else if (navLang.startsWith('ar')) savedLang = 'en'; // Arabic visitors get English by default
        else savedLang = 'en';
      }

      localStorage.setItem(STORAGE_KEY, savedLang);
      setGoogleTranslateCookie(savedLang);
    } else {
      setGoogleTranslateCookie(savedLang);
    }
  }

  // Inject CSS Styles for Floating Language Switcher
  function injectStyles() {
    const style = document.createElement('style');
    style.innerHTML = `
      .gtrans-switcher-wrap {
        position: fixed;
        bottom: 20px;
        left: 20px;
        z-index: 9999999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .gtrans-btn {
        background: #0f172a;
        color: #ffffff;
        border: 1px solid rgba(255,255,255,0.2);
        padding: 8px 14px;
        border-radius: 30px;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.4);
        transition: all 0.2s ease;
        user-select: none;
      }
      .gtrans-btn:hover {
        background: #1e293b;
        transform: translateY(-2px);
      }
      .gtrans-dropdown {
        display: none;
        position: absolute;
        bottom: calc(100% + 8px);
        left: 0;
        width: 200px;
        max-height: 320px;
        overflow-y: auto;
        background: #0f172a;
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 16px;
        box-shadow: 0 15px 35px rgba(0,0,0,0.5);
        padding: 6px;
        flex-direction: column;
        gap: 2px;
      }
      .gtrans-dropdown.open {
        display: flex;
      }
      .gtrans-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        color: #cbd5e1;
        font-size: 13px;
        font-weight: 600;
        border-radius: 10px;
        cursor: pointer;
        transition: background 0.15s, color 0.15s;
        text-decoration: none;
      }
      .gtrans-item:hover, .gtrans-item.active {
        background: rgba(255,255,255,0.12);
        color: #ffffff;
      }
      .goog-te-banner-frame, .goog-te-balloon-frame { display: none !important; }
      body { top: 0 !important; }
      #google_translate_element { display: none !important; }
      .skiptranslate { display: none !important; }
    `;
    document.head.appendChild(style);
  }

  // Build Language Switcher Button & Dropdown
  function renderLanguageSwitcher() {
    const currentLang = localStorage.getItem(STORAGE_KEY) || 'en';
    const activeLangObj = SUPPORTED_LANGUAGES.find(l => l.code === currentLang) || SUPPORTED_LANGUAGES[0];

    const wrap = document.createElement('div');
    wrap.className = 'gtrans-switcher-wrap';

    const btn = document.createElement('button');
    btn.className = 'gtrans-btn';
    btn.type = 'button';
    btn.innerHTML = `<span>${activeLangObj.flag}</span> <span>${activeLangObj.code.toUpperCase()}</span> <span style="font-size:10px;">▲</span>`;

    const dropdown = document.createElement('div');
    dropdown.className = 'gtrans-dropdown';

    SUPPORTED_LANGUAGES.forEach(lang => {
      const item = document.createElement('div');
      item.className = 'gtrans-item' + (lang.code === currentLang ? ' active' : '');
      item.innerHTML = `<span>${lang.flag}</span> <span>${lang.name}</span>`;
      item.addEventListener('click', () => {
        applyLanguage(lang.code, true);
      });
      dropdown.appendChild(item);
    });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });

    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) {
        dropdown.classList.remove('open');
      }
    });

    wrap.appendChild(dropdown);
    wrap.appendChild(btn);

    const container = document.createElement('div');
    container.id = 'google_translate_element';
    document.body.appendChild(container);
    document.body.appendChild(wrap);
  }

  // Load Google Translate Widget Script
  function loadGoogleTranslateScript() {
    window.googleTranslateElementInit = function () {
      if (window.google && window.google.translate) {
        new window.google.translate.TranslateElement({
          pageLanguage: 'en',
          autoDisplay: false
        }, 'google_translate_element');
      }
    };

    const s = document.createElement('script');
    s.type = 'text/javascript';
    s.src = '//translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
    s.async = true;
    document.body.appendChild(s);
  }

  // Initialize Translator
  document.addEventListener('DOMContentLoaded', async () => {
    injectStyles();
    await autoDetectAndSetLanguage();
    renderLanguageSwitcher();
    loadGoogleTranslateScript();
  });
})();
