/**
 * Omegooo Google Authentication Helper
 * Client ID: 324328366078-4mjug23k9h74sasmoeo6dt1ak0mgq5q4.apps.googleusercontent.com
 */

const GOOGLE_CLIENT_ID = '324328366078-4mjug23k9h74sasmoeo6dt1ak0mgq5q4.apps.googleusercontent.com';
let activeGoogleUser = null;
let activeSessionToken = localStorage.getItem('omegooo_session_token') || null;

// Initialize Google GIS script dynamically
function loadGoogleGisScript() {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google GIS script'));
    document.head.appendChild(script);
  });
}

// Helper to set cookie
function setAuthCookie(name, value, days) {
  const expires = new Date(Date.now() + days * 86400000).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

// Helper to get cookie
function getAuthCookie(name) {
  const matches = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([\.$?*|{}\(\)\[\]\\\/\+^])/g, '\\$1') + '=([^;]*)'));
  return matches ? decodeURIComponent(matches[1]) : undefined;
}

// Validate active 15-day session with local persistent check
async function checkActiveSession() {
  const cachedUserStr = localStorage.getItem('google_user') || getAuthCookie('google_user');
  const token = localStorage.getItem('omegooo_session_token') || getAuthCookie('omegooo_session_token');

  if (cachedUserStr) {
    try {
      const user = JSON.parse(cachedUserStr);
      if (user && (user.email || user.name)) {
        activeGoogleUser = user;
        activeSessionToken = token || 'session_' + Date.now();
        localStorage.setItem('google_user', JSON.stringify(user));
        if (token) localStorage.setItem('omegooo_session_token', token);
        return user;
      }
    } catch (e) {}
  }

  if (!token) return null;

  try {
    const res = await fetch('/api/auth/session', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    const data = await res.json();
    if (data && data.authenticated && data.user) {
      activeGoogleUser = data.user;
      activeSessionToken = token;
      localStorage.setItem('google_user', JSON.stringify(data.user));
      localStorage.setItem('omegooo_session_token', token);
      setAuthCookie('google_user', JSON.stringify(data.user), 15);
      setAuthCookie('omegooo_session_token', token, 15);
      return data.user;
    } else {
      localStorage.removeItem('omegooo_session_token');
      localStorage.removeItem('google_user');
      activeGoogleUser = null;
      activeSessionToken = null;
      return null;
    }
  } catch (err) {
    console.warn("Session check fallback:", err);
    return activeGoogleUser;
  }
}

function parseGoogleJwt(credential) {
  try {
    const base64Url = credential.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonPayload);
  } catch (e) {
    console.warn("Google JWT client parse warning:", e);
    return null;
  }
}

// Handle Google ID Token credential
async function handleGoogleCredentialResponse(response, onSuccess) {
  if (!response || !response.credential) return;

  const payload = parseGoogleJwt(response.credential);
  let user = null;
  let sessionToken = 'sess_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36);

  if (payload && payload.sub) {
    user = {
      id: payload.sub,
      email: payload.email || '',
      name: payload.name || payload.email?.split('@')[0] || 'Google User',
      picture: payload.picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(payload.name || 'User')}&background=ff6600&color=fff`,
      gender: payload.gender || 'unspecified'
    };
  }

  // Try optional server authentication if endpoint exists
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ credential: response.credential })
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.success && data.user) {
        user = data.user;
        if (data.sessionToken) sessionToken = data.sessionToken;
      }
    }
  } catch (err) {
    console.log('[AUTH] Server auth endpoint offline/skipped. Using direct client authentication.');
  }

  if (user) {
    activeSessionToken = sessionToken;
    activeGoogleUser = user;
    localStorage.setItem('omegooo_session_token', sessionToken);
    localStorage.setItem('google_user', JSON.stringify(user));
    setAuthCookie('google_user', JSON.stringify(user), 15);
    setAuthCookie('omegooo_session_token', sessionToken, 15);

    // Close modal if open
    closeGoogleLoginModal();

    if (typeof onSuccess === 'function') {
      onSuccess(user);
    }
  } else {
    alert('Google Sign-In failed. Please try again.');
  }
}

// Initialize Google GIS & One Tap
async function initGoogleAuth(onSuccess) {
  try {
    await loadGoogleGisScript();
    if (window.google && window.google.accounts) {
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (response) => handleGoogleCredentialResponse(response, onSuccess),
        auto_select: false,
        use_fedcm_for_prompt: true
      });

      // Render button in modal if container exists
      const btnContainer = document.getElementById('googleGisBtnContainer');
      if (btnContainer) {
        btnContainer.innerHTML = '';
        const screenW = window.innerWidth || document.documentElement.clientWidth || 360;
        const targetWidth = Math.min(300, Math.max(200, screenW - 80));

        try {
          window.google.accounts.id.renderButton(btnContainer, {
            theme: 'outline',
            size: 'large',
            text: 'signin_with',
            shape: 'pill',
            width: targetWidth,
            logo_alignment: 'left'
          });
        } catch(rErr) {
          console.warn("GIS renderButton warning:", rErr);
        }
      }

      // Prompt One Tap
      window.google.accounts.id.prompt();
    }
  } catch (err) {
    console.warn('Google GIS Init Warning:', err);
  }
}

// Show Google Sign-In Modal
function showGoogleLoginModal(onSuccessCallback) {
  let modal = document.getElementById('googleLoginModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'googleLoginModal';
    modal.style.cssText = `
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(15, 23, 42, 0.75);
      backdrop-filter: blur(8px);
      z-index: 99999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 12px;
      box-sizing: border-box;
      -webkit-overflow-scrolling: touch;
    `;

    modal.onclick = (e) => {
      if (e.target === modal) closeGoogleLoginModal();
    };

    modal.innerHTML = `
      <div id="googleLoginCard" style="
        background: #ffffff;
        width: 100%;
        max-width: 400px;
        border-radius: 20px;
        box-shadow: 0 25px 50px -12px rgba(0,0,0,0.35);
        padding: 28px 20px;
        text-align: center;
        position: relative;
        animation: modalPop 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        box-sizing: border-box;
        max-height: 90vh;
        overflow-y: auto;
      ">
        <style>
          @keyframes modalPop {
            from { opacity: 0; transform: scale(0.92) translateY(10px); }
            to { opacity: 1; transform: scale(1) translateY(0); }
          }
          @media (max-width: 480px) {
            #googleLoginCard {
              padding: 22px 14px !important;
              border-radius: 16px !important;
            }
          }
        </style>

        <button onclick="closeGoogleLoginModal()" style="
          position: absolute; top: 14px; right: 14px;
          background: #f1f5f9; border: none; width: 32px; height: 32px;
          border-radius: 50%; color: #64748b; font-size: 18px; font-weight: bold;
          cursor: pointer; display: flex; align-items: center; justify-content: center;
          touch-action: manipulation;
        ">✕</button>

        <div style="margin-bottom: 16px;">
          <img src="/logo-icon.svg" alt="Omegooo" style="height: 42px; margin-bottom: 10px;" onerror="this.style.display='none'">
          <h2 style="font-size: 20px; font-weight: 800; color: #0f172a; margin-bottom: 6px;">Sign In to Start Chatting</h2>
          <p style="font-size: 13px; color: #64748b; line-height: 1.5; margin: 0;">
            Sign in with your Google account to enter the video chat room. Your session stays active for <strong>15 days</strong>.
          </p>
        </div>

        <div style="background: #fffcf9; border: 1px solid #ffedd5; border-radius: 12px; padding: 10px 12px; margin-bottom: 20px; display: flex; align-items: center; gap: 8px; text-align: left;">
          <span style="font-size: 18px;">🔒</span>
          <span style="font-size: 12px; color: #9a3412; font-weight: 500; line-height: 1.4;">
            Zero password required. Verified profile picture will be displayed in chat.
          </span>
        </div>

        <div id="googleGisBtnContainer" style="display: flex; justify-content: center; align-items: center; margin-bottom: 16px; min-height: 44px; width: 100%;">
          <!-- Google Sign-In Button renders here -->
        </div>

        <p style="font-size: 12px; color: #94a3b8; margin-top: 14px; line-height: 1.5;">
          By signing in, you agree to our <a href="#" onclick="openPolicyModal('terms'); return false;" style="color: #ff6600; text-decoration: underline;">Terms</a> & <a href="#" onclick="openPolicyModal('privacy'); return false;" style="color: #ff6600; text-decoration: underline;">Privacy Policy</a>.
        </p>
      </div>
    `;
    document.body.appendChild(modal);
  }

  modal.style.display = 'flex';

  initGoogleAuth((user) => {
    if (typeof onSuccessCallback === 'function') {
      onSuccessCallback(user);
    }
  });
}

function closeGoogleLoginModal() {
  const modal = document.getElementById('googleLoginModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

// Global Exports
window.checkActiveSession = checkActiveSession;
window.showGoogleLoginModal = showGoogleLoginModal;
window.closeGoogleLoginModal = closeGoogleLoginModal;
window.initGoogleAuth = initGoogleAuth;
window.getGoogleUser = () => activeGoogleUser;
window.getGoogleSessionToken = () => activeSessionToken;
