/**
 * Omegooo Universal Auto-Translation & Language Switcher
 * Real-time IP location detection, Google Translate trigger, and header / floating UI positioning.
 */

(function () {
  const STORAGE_KEY = 'omegooo_user_lang_v2';
  const IS_CHAT_PAGE = window.location.pathname.includes('chat.html');

  const SUPPORTED_LANGUAGES = [
    { code: 'en', name: 'English', flag: '🇺🇸' },
    { code: 'fr', name: 'Français (French)', flag: '🇫🇷' },
    { code: 'es', name: 'Español (Spanish)', flag: '🇪🇸' },
    { code: 'he', name: 'עברית (Hebrew)', flag: '🇮🇱' },
    { code: 'ru', name: 'Русский (Russian)', flag: '🇷🇺' },
    { code: 'de', name: 'Deutsch (German)', flag: '🇩🇪' },
    { code: 'zh-CN', name: '中文 (Chinese)', flag: '🇨🇳' },
    { code: 'it', name: 'Italiano (Italian)', flag: '🇮🇹' },
    { code: 'pt', name: 'Português (Portuguese)', flag: '🇵🇹' },
    { code: 'tr', name: 'Türkçe (Turkish)', flag: '🇹🇷' },
    { code: 'ja', name: '日本語 (Japanese)', flag: '🇯🇵' },
    { code: 'ko', name: '한국어 (Korean)', flag: '🇰🇷' },
    { code: 'ar', name: 'العربية (Arabic)', flag: '🇸🇦' }
  ];

  function setGoogleTranslateCookie(langCode) {
    const domain = location.hostname;
    if (!langCode || langCode === 'en') {
      document.cookie = "googtrans=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
      document.cookie = "googtrans=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=" + domain + ";";
      document.cookie = "googtrans=/en/en; path=/;";
      return;
    }
    const val = "/en/" + langCode;
    document.cookie = "googtrans=" + val + "; path=/;";
    document.cookie = "googtrans=" + val + "; path=/; domain=" + domain + ";";
  }

  function triggerGoogleTranslateCombo(langCode) {
    if (!langCode || langCode === 'en') return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      const combo = document.querySelector('.goog-te-combo');
      if (combo) {
        if (combo.value !== langCode) {
          combo.value = langCode;
          combo.dispatchEvent(new Event('change'));
        }
        clearInterval(timer);
      }
      if (attempts > 35) clearInterval(timer);
    }, 150);
  }

  function applyLanguage(langCode, reloadIfChanged = true) {
    const currentStored = localStorage.getItem(STORAGE_KEY);
    localStorage.setItem(STORAGE_KEY, langCode);
    setGoogleTranslateCookie(langCode);

    if (reloadIfChanged && currentStored !== langCode) {
      window.location.reload();
    } else {
      triggerGoogleTranslateCombo(langCode);
    }
  }

  async function autoDetectAndSetLanguage() {
    const urlParams = new URLSearchParams(window.location.search);
    const urlLang = urlParams.get('lang');
    
    let targetLang = urlLang;

    if (!targetLang) {
      targetLang = localStorage.getItem(STORAGE_KEY);
    }

    if (!targetLang || !localStorage.getItem(STORAGE_KEY)) {
      try {
        const res = await fetch('/api/detect-language');
        const data = await res.json();
        if (data && data.success && data.detectedLang) {
          targetLang = data.detectedLang;
        }
      } catch (e) {
        console.warn("GeoIP detect warning:", e);
      }

      if (!targetLang) {
        const navLang = (navigator.language || 'en').toLowerCase();
        if (navLang.startsWith('fr')) targetLang = 'fr';
        else if (navLang.startsWith('es')) targetLang = 'es';
        else if (navLang.startsWith('he') || navLang.startsWith('iw')) targetLang = 'he';
        else if (navLang.startsWith('ru')) targetLang = 'ru';
        else if (navLang.startsWith('de')) targetLang = 'de';
        else if (navLang.startsWith('zh')) targetLang = 'zh-CN';
        else if (navLang.startsWith('ar')) targetLang = 'en';
        else targetLang = 'en';
      }
    }

    localStorage.setItem(STORAGE_KEY, targetLang);
    setGoogleTranslateCookie(targetLang);
    return targetLang;
  }

  function injectStyles() {
    const style = document.createElement('style');
    const positionCSS = `
      .gtrans-switcher-wrap {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 9999999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .gtrans-switcher-wrap.in-nav {
        position: relative;
        top: auto;
        left: auto;
        right: auto;
        bottom: auto;
        z-index: 1000;
        display: inline-flex;
        align-items: center;
      }
      .gtrans-btn {
        background: #1e293b;
        color: #ffffff;
        border: 1.5px solid rgba(255,255,255,0.25);
        padding: 6px 12px;
        border-radius: 20px;
        font-size: 12.5px;
        font-weight: 700;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.25);
        transition: all 0.2s ease;
        user-select: none;
        white-space: nowrap;
      }
      .gtrans-btn:hover {
        background: #334155;
        border-color: #3b82f6;
      }
      .gtrans-dropdown {
        display: none;
        position: absolute;
        bottom: calc(100% + 8px);
        right: 0;
        width: 190px;
        max-height: 280px;
        overflow-y: auto;
        background: #0f172a;
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 14px;
        box-shadow: 0 15px 35px rgba(0,0,0,0.6);
        padding: 6px;
        flex-direction: column;
        gap: 2px;
        z-index: 9999999;
      }
      .gtrans-switcher-wrap.in-nav .gtrans-dropdown {
        top: calc(100% + 8px);
        bottom: auto;
        right: 0;
        left: auto;
      }
      .gtrans-dropdown.open {
        display: flex;
      }
      .gtrans-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        color: #cbd5e1;
        font-size: 12.5px;
        font-weight: 600;
        border-radius: 8px;
        cursor: pointer;
        transition: background 0.15s, color 0.15s;
        text-decoration: none;
      }
      .gtrans-item:hover, .gtrans-item.active {
        background: rgba(255,255,255,0.15);
        color: #ffffff;
      }
      .goog-te-banner-frame, .goog-te-balloon-frame { display: none !important; }
      body { top: 0 !important; }
      #google_translate_element { display: none !important; }
      .skiptranslate { display: none !important; }
    `;
    document.head.appendChild(style);
  }

  function renderLanguageSwitcher(currentLang) {
    const activeLangObj = SUPPORTED_LANGUAGES.find(l => l.code === currentLang) || SUPPORTED_LANGUAGES[0];
    const navBox = document.getElementById('gtransNavBox');

    const wrap = document.createElement('div');
    wrap.className = 'gtrans-switcher-wrap' + (navBox ? ' in-nav' : '');

    const btn = document.createElement('button');
    btn.className = 'gtrans-btn';
    btn.type = 'button';
    btn.innerHTML = `<span>${activeLangObj.flag}</span> <span>${activeLangObj.code.toUpperCase()}</span> <span style="font-size:9px;">▼</span>`;

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

    if (navBox) {
      navBox.innerHTML = '';
      navBox.appendChild(wrap);
    } else {
      document.body.appendChild(wrap);
    }
  }

  function loadGoogleTranslateScript(currentLang) {
    window.googleTranslateElementInit = function () {
      if (window.google && window.google.translate) {
        new window.google.translate.TranslateElement({
          pageLanguage: 'en',
          autoDisplay: false
        }, 'google_translate_element');

        if (currentLang && currentLang !== 'en') {
          triggerGoogleTranslateCombo(currentLang);
        }
      }
    };

    const s = document.createElement('script');
    s.type = 'text/javascript';
    s.src = '//translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
    s.async = true;
    document.body.appendChild(s);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    injectStyles();
    const currentLang = await autoDetectAndSetLanguage();
    renderLanguageSwitcher(currentLang);
    loadGoogleTranslateScript(currentLang);
  });
})();
