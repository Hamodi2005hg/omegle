// =====================================================
// Omegooo Chat Engine - Direct Socket.io WebRTC
// High performance, instant matchmaking, 100% reliable
// =====================================================

const LINK_REGEX = /(?:https?:\/\/|ftp:\/\/|www\.)[^\s]+|(?:\b[a-zA-Z0-9-]+\.)+(?:com|net|org|edu|gov|io|ai|co|xyz|me|info|biz|ru|cn|uk|de|online|site|app|top|club|vip|live|tv|cc|ly|gg|link|click|space|shop|store|dev|pro|icu|buzz)\b(?:\/[^\s]*)?|(?:t\.me|wa\.me|discord\.gg|telegram\.me|bit\.ly|tinyurl\.com)\/[^\s]+/i;

class ChatApp {
  constructor() {
    this.socket = null;
    this.pc = null;

    this.config = {
      SEARCH_TIMEOUT: 5000,
      NORMAL_PAUSE_DURATION: 1500,
      TYPING_PAUSE: 1500
    };

    this.state = {
      localStream: null,
      partnerId: null,
      isInitiator: false,
      micEnabled: true,
      isBanned: false,
      isOfferOpen: false,
      partnerAvatar: 'https://ui-avatars.com/api/?name=Stranger&background=ff6600&color=fff',
      partnerName: 'Stranger',
      lastSkippedPeerId: null,
      skipTimestamp: 0
    };

    this.sessionToken = 0;
    this.timers = new Set();
    this.searchTimer = null;
    this.pauseTimer = null;
    this.typingTimer = null;

    this.reportedIds = new Set();
    this.typing = false;

    this.init();
  }

  // =====================================================
  // App Initialization
  // =====================================================
  async init() {
    this.setupDOMElements();
    this.setupEventListeners();
    this.setupTypingIndicator();
    this.ensureNotifyEmpty();
    this.updateMicButton();
    this.setupChatScrollEffect();

    await this.initSocket();
    this.startSearch();
    this.initNSFWJS();
  }

  async ensureSocketIoLoaded() {
    if (window.io) return true;
    const loadScript = (url) => new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });

    let loaded = await loadScript('/socket.io/socket.io.js');
    if (!loaded) {
      loaded = await loadScript('https://cdn.socket.io/4.7.5/socket.io.min.js');
    }
    return loaded;
  }

  async initSocket() {
    await this.ensureSocketIoLoaded();

    if (window.io) {
      this.socket = window.io({
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000
      });

      this.socket.on('connect', () => {
        console.log('Socket.io connected:', this.socket.id);
        const fp = localStorage.getItem('user_fp') || this.socket.id;
        this.socket.emit('identify', { fingerprint: fp });

        if (this.state.partnerId) {
          this.socket.emit('reclaim-session', { oldSocketId: this.socket.id });
        }
      });

      this.socket.on('partner-found', (data) => {
        this.handlePartnerFound(data);
      });

      this.socket.on('partner-disconnected', () => {
        this.handlePartnerDisconnected();
      });

      this.socket.on('signal', (data) => {
        this.handleSignal(data);
      });

      this.socket.on('chat-message', (data) => {
        this.addMessage(data.message, 'them', '', data.avatar || this.state.partnerAvatar);
      });

      this.socket.on('typing', () => {
        if (this.typingIndicator) {
          this.typingIndicator.style.display = 'block';
          if (this.elements.chatMessages) this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
        }
      });

      this.socket.on('stop-typing', () => {
        if (this.typingIndicator) {
          this.typingIndicator.style.display = 'none';
        }
      });

      this.socket.on('banned', (data) => {
        this.state.isBanned = true;
        this.showBanModal({
          title: data.title || 'Account Suspended',
          message: data.message || 'You have been temporarily suspended due to policy violations.',
          offenseCount: data.offenseCount || 1,
          banDurationHours: data.banDurationHours || 24
        });
        this.cleanupConnection();
        this.disableChat();
      });

      this.socket.on('chat-warning', (data) => {
        if (data && data.message) {
          this.addMessage(data.message, 'system');
        }
      });
    }
  }

  setupDOMElements() {
    this.elements = {
      notifyBell: document.getElementById('notifyIcon'),
      notifyDot: document.getElementById('notifyDot'),
      notifyMenu: document.getElementById('notifyMenu'),
      localVideo: document.getElementById('localVideo'),
      remoteVideo: document.getElementById('remoteVideo'),
      localSpinner: document.getElementById('localSpinner'),
      remoteSpinner: document.getElementById('remoteSpinner'),
      reportBtn: document.getElementById('reportBtn'),
      micBtn: document.getElementById('micBtn'),
      chatMessages: document.getElementById('chatMessages'),
      chatInput: document.getElementById('chatInput'),
      sendBtn: document.getElementById('sendBtn'),
      skipBtn: document.getElementById('skipBtn'),
      exitBtn: document.getElementById('exitBtn')
    };
  }

  setupChatScrollEffect() {
    const chat = this.elements.chatMessages;
    if (!chat) return;

    const updateMessagesOpacity = () => {
      const scrollTop = chat.scrollTop;
      const scrollHeight = chat.scrollHeight;
      const clientHeight = chat.clientHeight;
      const distanceFromBottom = scrollHeight - clientHeight - scrollTop;
      const fadeStart = 600;

      const messages = chat.querySelectorAll('.msg');
      messages.forEach(msg => {
        if (distanceFromBottom > fadeStart) {
          const fadeFactor = Math.min(1, (distanceFromBottom - fadeStart) / 1000);
          const opacity = Math.max(0.2, 1 - fadeFactor);
          msg.style.opacity = opacity;
          msg.style.transition = 'opacity 0.4s ease';
        } else {
          msg.style.opacity = '1';
        }
      });
    };

    chat.addEventListener('scroll', updateMessagesOpacity);
    this.updateMessagesOpacity = updateMessagesOpacity;
  }

  // =====================================================
  // Timer Management
  // =====================================================
  setSafeTimer(callback, delay) {
    const timerId = setTimeout(() => {
      this.timers.delete(timerId);
      callback();
    }, delay);
    this.timers.add(timerId);
    return timerId;
  }

  clearSafeTimer(timerId) {
    if (timerId) {
      clearTimeout(timerId);
      this.timers.delete(timerId);
    }
  }

  clearAllTimers() {
    this.timers.forEach(timerId => clearTimeout(timerId));
    this.timers.clear();
  }

  // =====================================================
  // UI Management
  // =====================================================
  addMessage(msg, type = 'system', extraClass = '', avatarUrl = '') {
    const d = document.createElement('div');
    d.className = `msg ${type} ${extraClass}`.trim();

    if (type === 'you' || type === 'them' || type === 'stranger') {
      const isYou = (type === 'you');
      d.style.cssText = `
        display: flex;
        align-items: flex-end;
        gap: 8px;
        margin: 6px 0;
        align-self: ${isYou ? 'flex-end' : 'flex-start'};
        flex-direction: ${isYou ? 'row-reverse' : 'row'};
        max-width: 85%;
      `;

      const user = (typeof window.getGoogleUser === 'function') ? window.getGoogleUser() : null;
      const myAvatar = user?.picture || localStorage.getItem('user_avatar') || 'https://ui-avatars.com/api/?name=Me&background=ff6600&color=fff';
      const fallbackName = isYou ? 'Me' : (this.state.partnerName || 'Stranger');
      const finalAvatar = avatarUrl || (isYou ? myAvatar : this.state.partnerAvatar) || `https://ui-avatars.com/api/?name=${encodeURIComponent(fallbackName)}&background=ff6600&color=fff`;

      const img = document.createElement('img');
      img.src = finalAvatar;
      img.alt = fallbackName;
      img.className = 'chat-avatar';
      img.style.cssText = 'width: 34px; height: 34px; border-radius: 50%; object-fit: cover; flex-shrink: 0; border: 2px solid #ff6600; box-shadow: 0 2px 6px rgba(0,0,0,0.15);';
      img.onerror = function() {
        this.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(fallbackName)}&background=ff6600&color=fff`;
      };

      const bubble = document.createElement('div');
      bubble.style.cssText = isYou ? `
        background: var(--msgYou);
        border: 2px solid var(--msgYouBorder);
        color: #0d47a1;
        padding: 10px 14px;
        border-radius: 14px 14px 2px 14px;
        font-size: 14px;
        font-weight: 500;
        box-shadow: 0 2px 5px rgba(0,0,0,0.08);
        word-break: break-word;
      ` : `
        background: var(--msgStranger);
        border: 2px solid var(--msgStrangerBorder);
        color: #e65100;
        padding: 10px 14px;
        border-radius: 14px 14px 14px 2px;
        font-size: 14px;
        font-weight: 500;
        box-shadow: 0 2px 5px rgba(0,0,0,0.08);
        word-break: break-word;
      `;
      bubble.textContent = msg;

      d.appendChild(img);
      d.appendChild(bubble);
    } else {
      d.textContent = msg;
    }

    d.style.opacity = '1';
    d.style.transition = 'opacity 0.4s ease';

    const typing = document.querySelector('.msg.system[style*="italic"]');
    if (typing && typing.parentNode === this.elements.chatMessages) {
      this.elements.chatMessages.insertBefore(d, typing);
    } else {
      this.elements.chatMessages.appendChild(d);
    }

    this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;

    if (this.updateMessagesOpacity) {
      requestAnimationFrame(() => this.updateMessagesOpacity());
    }
    return d;
  }

  setSingleSystemMessage(text, extraClass = '') {
    if (!this.elements.chatMessages) return;

    const statusMsgs = this.elements.chatMessages.querySelectorAll('.stranger-connected-msg, .stranger-disconnected-msg, .status-system-msg');
    statusMsgs.forEach(el => el.remove());

    const initialConnecting = Array.from(this.elements.chatMessages.querySelectorAll('.msg.system')).filter(el => el.textContent.includes('Connecting'));
    initialConnecting.forEach(el => el.remove());

    this.addMessage(text, 'system', `${extraClass} status-system-msg`.trim());
  }

  updateStatusMessage(msg) {
    let statusMsg = document.getElementById('statusMessage');
    if (statusMsg) {
      statusMsg.textContent = msg;
    } else {
      statusMsg = document.createElement('div');
      statusMsg.id = 'statusMessage';
      statusMsg.className = 'msg status';
      statusMsg.textContent = msg;
      const typing = document.querySelector('.msg.system[style*="italic"]');
      if (typing && typing.parentNode === this.elements.chatMessages) {
        this.elements.chatMessages.insertBefore(statusMsg, typing);
      } else {
        this.elements.chatMessages.appendChild(statusMsg);
      }
    }
    this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
    if (this.updateMessagesOpacity) {
      requestAnimationFrame(() => this.updateMessagesOpacity());
    }
  }

  ensureNotifyEmpty() {
    if (this.elements.notifyMenu && this.elements.notifyMenu.children.length === 0) {
      const d = document.createElement('div');
      d.textContent = 'No notifications';
      d.className = 'notify-empty';
      this.elements.notifyMenu.appendChild(d);
    }
  }

  enableChat() {
    if (this.elements.chatInput) this.elements.chatInput.disabled = this.state.isBanned;
    if (this.elements.sendBtn) this.elements.sendBtn.disabled = this.state.isBanned;
  }

  disableChat() {
    if (this.elements.chatInput) this.elements.chatInput.disabled = true;
    if (this.elements.sendBtn) this.elements.sendBtn.disabled = true;
  }

  setSkipButtonsDisabled(disabled) {
    if (this.elements.skipBtn) this.elements.skipBtn.disabled = disabled;
  }

  updateMicButton() {
    if (!this.elements.micBtn) return;
    this.elements.micBtn.textContent = this.state.micEnabled ? '🎤' : '🔇';
    this.elements.micBtn.disabled = !this.state.localStream || this.state.isBanned;
    this.elements.micBtn.style.opacity = (this.state.localStream && !this.state.isBanned) ? '1' : '0.8';
  }

  showRemoteSpinnerOnly(show) {
    if (this.elements.remoteSpinner) this.elements.remoteSpinner.style.display = show ? 'block' : 'none';
    if (this.elements.remoteVideo) this.elements.remoteVideo.style.display = show ? 'none' : 'block';
    if (this.elements.localVideo) this.elements.localVideo.style.display = 'block';
  }

  hideAllSpinners() {
    if (this.elements.remoteSpinner) this.elements.remoteSpinner.style.display = 'none';
    if (this.elements.localSpinner) this.elements.localSpinner.style.display = 'none';
    if (this.elements.remoteVideo) this.elements.remoteVideo.style.display = 'block';
    if (this.elements.localVideo) this.elements.localVideo.style.display = 'block';
  }

  // =====================================================
  // Connection Cleanup
  // =====================================================
  cleanupConnection() {
    this.sessionToken++;
    this.clearAllTimers();

    if (this.pc) {
      try {
        this.pc.ontrack = null;
        this.pc.onicecandidate = null;
        this.pc.close();
      } catch (e) {}
      this.pc = null;
    }

    if (this.elements.remoteVideo) {
      try {
        if (this.elements.remoteVideo.srcObject) {
          const oldTracks = this.elements.remoteVideo.srcObject.getTracks ? this.elements.remoteVideo.srcObject.getTracks() : [];
          oldTracks.forEach(t => { try { t.stop(); } catch (e) {} });
        }
        this.elements.remoteVideo.pause();
        this.elements.remoteVideo.srcObject = null;
      } catch (e) {}
    }

    this.state.partnerId = null;
    this.state.isInitiator = false;
  }

  // =====================================================
  // WebRTC Matchmaking & Signaling
  // =====================================================
  handlePartnerFound(data) {
    this.sessionToken++;
    const currentSession = this.sessionToken;

    this.clearAllTimers();
    this.state.partnerId = data.id;
    this.state.isInitiator = data.initiator;
    this.state.partnerAvatar = data.partnerAvatar || 'https://ui-avatars.com/api/?name=Stranger&background=ff6600&color=fff';
    this.state.partnerName = data.partnerName || 'Stranger';

    this.hideAllSpinners();
    this.setSingleSystemMessage('Connected with a stranger. Say hello! 👋😊', 'stranger-connected-msg');
    this.updateStatusMessage("Hello 👋 You've been contacted by a stranger Say hello 😊🤝");
    this.enableChat();

    this.initPeerConnection(data.id, data.initiator, currentSession);
  }

  initPeerConnection(partnerId, isInitiator, session) {
    if (this.pc) {
      try { this.pc.close(); } catch(e){}
      this.pc = null;
    }

    const rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
      ]
    };

    this.pc = new RTCPeerConnection(rtcConfig);

    if (this.state.localStream) {
      this.state.localStream.getTracks().forEach(track => {
        try { this.pc.addTrack(track, this.state.localStream); } catch(e){}
      });
    }

    this.pc.ontrack = (event) => {
      if (this.sessionToken !== session) return;
      if (this.elements.remoteVideo && event.streams && event.streams[0]) {
        this.elements.remoteVideo.srcObject = event.streams[0];
        this.elements.remoteVideo.play().catch(() => {});
      }
      this.hideAllSpinners();
      this.enableChat();
      this.updateStatusMessage("Hello 👋 You've been contacted by a stranger Say hello 😊🤝");
    };

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.socket && this.state.partnerId === partnerId) {
        this.socket.emit('signal', {
          to: partnerId,
          data: { candidate: event.candidate }
        });
      }
    };

    if (isInitiator) {
      this.pc.createOffer()
        .then(offer => this.pc.setLocalDescription(offer))
        .then(() => {
          if (this.socket && this.state.partnerId === partnerId) {
            this.socket.emit('signal', {
              to: partnerId,
              data: { sdp: this.pc.localDescription }
            });
          }
        })
        .catch(err => console.error("Create offer error:", err));
    }
  }

  async handleSignal({ from, data }) {
    if (!this.pc || from !== this.state.partnerId) return;

    try {
      if (data.sdp) {
        await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === 'offer') {
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          if (this.socket && this.state.partnerId === from) {
            this.socket.emit('signal', {
              to: from,
              data: { sdp: this.pc.localDescription }
            });
          }
        }
      } else if (data.candidate) {
        await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    } catch(e) {
      console.warn("Signal error:", e);
    }
  }

  handlePartnerDisconnected() {
    if (this.state.isBanned) return;
    if (this.state.partnerId) {
      this.state.lastSkippedPeerId = this.state.partnerId;
      this.state.skipTimestamp = Date.now();
    }
    this.setSingleSystemMessage('Stranger has disconnected.', 'stranger-disconnected-msg');
    this.updateStatusMessage('Searching for a stranger...');
    this.disableChat();
    this.cleanupConnection();
    this.showRemoteSpinnerOnly(false);
    this.clearSafeTimer(this.searchTimer);
    this.clearSafeTimer(this.pauseTimer);

    this.pauseTimer = this.setSafeTimer(() => {
      if (!this.state.partnerId && !this.state.isBanned) {
        this.startSearchLoop();
      }
    }, this.config.NORMAL_PAUSE_DURATION);
  }

  startSearchLoop() {
    if (this.state.isBanned) {
      this.updateStatusMessage('⛔ You have been banned for violating our policy terms. ⚠️');
      this.showRemoteSpinnerOnly(false);
      return;
    }

    if (this.state.partnerId || this.state.isOfferOpen) return;

    this.showRemoteSpinnerOnly(true);
    this.updateStatusMessage('Searching for a stranger...');

    const sendFindPartner = () => {
      if (this.state.partnerId || this.state.isBanned || !this.socket) return;
      const filterGender = (typeof window.getActiveGenderFilter === 'function') ? window.getActiveGenderFilter() : 'all';
      const user = (typeof window.getGoogleUser === 'function') ? window.getGoogleUser() : (JSON.parse(localStorage.getItem('google_user') || 'null'));
      const avatar = user?.picture || 'https://ui-avatars.com/api/?name=User&background=ff6600&color=fff';
      const name = user?.name || 'User';
      const gender = localStorage.getItem('user_gender') || 'male';

      this.socket.emit('find-partner', {
        interests: [],
        gender,
        filterGender,
        avatar,
        name,
        user
      });
    };

    sendFindPartner();

    this.clearSafeTimer(this.searchTimer);
    this.clearSafeTimer(this.pauseTimer);

    this.searchTimer = this.setSafeTimer(() => {
      if (!this.state.partnerId && !this.state.isBanned) {
        this.showRemoteSpinnerOnly(false);
        this.updateStatusMessage('Searching for a stranger...');
        this.pauseTimer = this.setSafeTimer(() => {
          if (!this.state.partnerId && !this.state.isBanned) {
            this.startSearchLoop();
          }
        }, this.config.NORMAL_PAUSE_DURATION);
      }
    }, this.config.SEARCH_TIMEOUT);
  }

  async startSearch() {
    if (this.state.isBanned) {
      this.updateStatusMessage('⛔ You have been banned for violating our terms of service.');
      this.showRemoteSpinnerOnly(false);
      return;
    }

    this.cleanupConnection();
    if (this.elements.chatMessages) {
      this.elements.chatMessages.innerHTML = '';
      if (this.typingIndicator) this.elements.chatMessages.appendChild(this.typingIndicator);
    }

    this.hideAllSpinners();
    this.setSkipButtonsDisabled(true);

    const mediaReady = await this.initMedia();
    if (mediaReady) {
      this.setSkipButtonsDisabled(false);
      this.showRemoteSpinnerOnly(true);
      this.startSearchLoop();
    }
  }

  // =====================================================
  // Media Management
  // =====================================================
  async initMedia() {
    if (this.state.isBanned) {
      this.updateStatusMessage('⛔ You have been banned for violating our policy terms. ⚠️');
      return false;
    }

    if (this.state.localStream && this.state.localStream.active) {
      if (this.elements.localVideo) {
        if (this.elements.localVideo.srcObject !== this.state.localStream) {
          this.elements.localVideo.srcObject = this.state.localStream;
        }
        this.elements.localVideo.muted = true;
        this.elements.localVideo.playsInline = true;
        this.elements.localVideo.play().catch(e => console.warn('localVideo play error:', e));
      }
      return true;
    }

    const acquireStream = async () => {
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
      } catch (e1) {
        console.warn("Stage 1 getUserMedia failed:", e1);
      }

      try {
        return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch (e2) {
        console.warn("Stage 2 getUserMedia failed:", e2);
      }

      try {
        return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (e3) {
        console.error("Stage 3 getUserMedia failed:", e3);
        throw e3;
      }
    };

    try {
      if (this.elements.localSpinner) this.elements.localSpinner.style.display = 'block';

      this.state.localStream = await acquireStream();

      if (this.elements.localVideo) {
        this.elements.localVideo.srcObject = this.state.localStream;
        this.elements.localVideo.muted = true;
        this.elements.localVideo.volume = 0;
        this.elements.localVideo.playsInline = true;
        this.elements.localVideo.style.display = 'block';

        try {
          await this.elements.localVideo.play();
        } catch (pErr) {
          console.warn("localVideo autoplay warning:", pErr);
        }
      }

      if (this.elements.localSpinner) this.elements.localSpinner.style.display = 'none';

      this.hideReenableMediaButton();
      this.setSkipButtonsDisabled(false);
      this.showRemoteSpinnerOnly(true);
      this.updateMicButton();
      this.updateStatusMessage('Camera connected. Searching for a stranger...');

      return true;
    } catch (e) {
      console.error('Media access failed:', e);
      if (this.elements.localSpinner) this.elements.localSpinner.style.display = 'none';
      this.hideAllSpinners();
      this.updateStatusMessage('📹 Camera & Microphone permission required. Click below to grant access.');
      this.showReenableMediaButton();
      return false;
    }
  }

  showReenableMediaButton() {
    let btn = document.getElementById('reenableMediaBtn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'reenableMediaBtn';
      btn.type = 'button';
      btn.innerHTML = '🎥 <span>Enable Camera & Microphone</span>';
      btn.style.cssText = `
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
        color: #ffffff;
        border: none;
        padding: 14px 22px;
        border-radius: 14px;
        font-size: 14px;
        font-weight: 800;
        cursor: pointer;
        z-index: 100;
        box-shadow: 0 10px 25px rgba(37, 99, 235, 0.5);
        display: flex;
        align-items: center;
        gap: 8px;
        white-space: nowrap;
        transition: transform 0.2s, background 0.2s;
      `;

      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.style.opacity = '0.7';
        const ok = await this.initMedia();
        if (ok) {
          this.hideReenableMediaButton();
          this.startSearch();
        } else {
          btn.disabled = false;
          btn.style.opacity = '1';
        }
      });

      const videoFrame = document.querySelector('.video-frame.bottom') || document.querySelector('.video-frame.top') || document.querySelector('.left-col');
      if (videoFrame) videoFrame.appendChild(btn);
      else document.body.appendChild(btn);
    }
    btn.style.display = 'flex';
  }

  hideReenableMediaButton() {
    const btn = document.getElementById('reenableMediaBtn');
    if (btn) btn.style.display = 'none';
  }

  // =====================================================
  // Setup Event Listeners
  // =====================================================
  setupEventListeners() {
    if (this.elements.notifyBell) {
      this.elements.notifyBell.onclick = (e) => {
        e.stopPropagation();
        if (this.elements.notifyDot) this.elements.notifyDot.style.display = 'none';
        this.elements.notifyBell.classList.remove('shake');
        this.elements.notifyMenu.style.display = this.elements.notifyMenu.style.display === 'block' ? 'none' : 'block';
      };
    }

    document.onclick = () => { if (this.elements.notifyMenu) this.elements.notifyMenu.style.display = 'none'; };
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && this.elements.notifyMenu) this.elements.notifyMenu.style.display = 'none'; });

    // Skip button
    const handleSkip = () => {
      if (this.state.isBanned) return;

      if (this.state.partnerId) {
        this.state.lastSkippedPeerId = this.state.partnerId;
        this.state.skipTimestamp = Date.now();
      }

      if (this.socket) {
        try { this.socket.emit('skip'); } catch (e) {}
      }

      this.disableChat();
      this.cleanupConnection();
      this.showRemoteSpinnerOnly(false);
      this.updateStatusMessage('Searching for a stranger...');
      this.clearSafeTimer(this.searchTimer);
      this.clearSafeTimer(this.pauseTimer);

      this.pauseTimer = this.setSafeTimer(() => {
        if (!this.state.partnerId && !this.state.isBanned) {
          this.startSearchLoop();
        }
      }, this.config.NORMAL_PAUSE_DURATION);
    };

    if (this.elements.skipBtn) this.elements.skipBtn.onclick = handleSkip;

    // Exit button
    if (this.elements.exitBtn) {
      this.elements.exitBtn.onclick = () => {
        if (this.socket) {
          try { this.socket.emit('stop'); } catch (e) {}
        }
        this.cleanupConnection();
        if (this.state.localStream) {
          this.state.localStream.getTracks().forEach(t => t.stop());
        }
        location.href = 'index.html';
      };
    }

    // Mic button
    if (this.elements.micBtn) {
      this.elements.micBtn.onclick = () => {
        if (!this.state.localStream || this.state.isBanned) return;
        this.state.micEnabled = !this.state.micEnabled;
        this.state.localStream.getAudioTracks().forEach(t => t.enabled = this.state.micEnabled);
        this.updateMicButton();
      };
    }

    // Report button
    if (this.elements.reportBtn) {
      this.elements.reportBtn.style.display = 'flex';
      this.elements.reportBtn.onclick = async () => {
        if (!this.state.partnerId) {
          this.updateStatusMessage("No user to report.");
          return;
        }

        if (this.socket) {
          try {
            this.socket.emit('report', { partnerId: this.state.partnerId, reason: 'reported_by_user' });
            this.socket.emit('skip');
          } catch (e) {}
        }

        this.reportedIds.add(this.state.partnerId);
        this.cleanupConnection();
        this.disableChat();
        this.updateStatusMessage('You reported the user — skipping...');
        this.clearSafeTimer(this.searchTimer);
        this.clearSafeTimer(this.pauseTimer);
        this.startSearchLoop();
      };
    }
  }

  setupTypingIndicator() {
    this.typingIndicator = document.createElement('div');
    this.typingIndicator.className = 'msg system';
    this.typingIndicator.style.display = 'none';
    this.typingIndicator.style.fontStyle = 'italic';
    this.typingIndicator.textContent = 'Stranger is typing...';
    if (this.elements.chatMessages) {
      this.elements.chatMessages.appendChild(this.typingIndicator);
    }

    const sendTyping = () => {
      if (!this.state.partnerId || this.state.isBanned || !this.socket) return;
      if (!this.typing) {
        this.typing = true;
        this.socket.emit('typing', { to: this.state.partnerId });
      }
      this.clearSafeTimer(this.typingTimer);
      this.typingTimer = this.setSafeTimer(() => {
        this.typing = false;
        if (this.socket && this.state.partnerId) {
          this.socket.emit('stop-typing', { to: this.state.partnerId });
        }
      }, this.config.TYPING_PAUSE);
    };

    if (this.elements.chatInput) {
      this.elements.chatInput.oninput = () => {
        if (!this.elements.chatInput.disabled && !this.state.isBanned) sendTyping();
      };
    }

    const sendMessage = () => {
      if (this.state.isBanned) return;
      const msg = this.elements.chatInput.value.trim();
      if (!msg || !this.state.partnerId || !this.socket) return;

      if (LINK_REGEX.test(msg)) {
        this.addMessage("🚫 Sending links or external URLs is prohibited in chat.", "system");
        this.elements.chatInput.value = '';
        this.typing = false;
        if (this.socket) this.socket.emit('stop-typing', { to: this.state.partnerId });
        return;
      }

      const user = (typeof window.getGoogleUser === 'function') ? window.getGoogleUser() : null;
      const myAvatar = user?.picture || localStorage.getItem('user_avatar') || 'https://ui-avatars.com/api/?name=Me&background=ff6600&color=fff';
      this.addMessage(msg, 'you', '', myAvatar);

      this.socket.emit('chat-message', {
        to: this.state.partnerId,
        message: msg,
        avatar: myAvatar,
        name: user?.name || 'Me'
      });

      this.elements.chatInput.value = '';
      this.typing = false;
      this.socket.emit('stop-typing', { to: this.state.partnerId });
    };

    if (this.elements.sendBtn) this.elements.sendBtn.onclick = sendMessage;
    if (this.elements.chatInput) {
      this.elements.chatInput.onkeypress = e => { if (e.key === 'Enter' && !this.state.isBanned) sendMessage(); };
    }
  }

  // =====================================================
  // NSFW AI Moderation
  // =====================================================
  async initNSFWJS() {
    let attempts = 0;
    const modelEndpoints = [
      'https://cdn.jsdelivr.net/npm/nsfwjs-models@1.0.0/mobile_net_v2/',
      'https://unpkg.com/nsfwjs-models@1.0.0/mobile_net_v2/'
    ];

    const loadModel = async () => {
      attempts++;
      if (!window.nsfwjs) {
        if (attempts < 15) setTimeout(loadModel, 1000);
        return;
      }

      for (const endpoint of modelEndpoints) {
        try {
          this.nsfwModel = await window.nsfwjs.load(endpoint, { type: 'graph' });
          if (this.nsfwModel) {
            console.log("NSFWJS AI Model loaded successfully via CDN endpoint.");
            this.startNSFWLoop();
            return;
          }
        } catch (e) {}
      }

      try {
        this.nsfwModel = await window.nsfwjs.load();
        if (this.nsfwModel) {
          console.log("NSFWJS AI Model loaded successfully.");
          this.startNSFWLoop();
          return;
        }
      } catch (e) {}
    };
    loadModel();
  }

  startNSFWLoop() {
    setInterval(async () => {
      if (this.state.isBanned || !this.nsfwModel) return;

      if (this.elements.localVideo && this.elements.localVideo.readyState >= 2 && this.elements.localVideo.videoWidth > 0) {
        try {
          const video = this.elements.localVideo;
          const canvas = document.createElement('canvas');
          canvas.width = 224;
          canvas.height = 224;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, 224, 224);

          const predictions = await this.nsfwModel.classify(canvas);
          let pornOrSexyProb = 0;
          let details = {};
          predictions.forEach(p => {
            details[p.className] = p.probability;
            if (p.className === 'Porn' || p.className === 'Sexy') {
              pornOrSexyProb += p.probability;
            }
          });

          if (this.socket) {
            this.socket.emit('nsfw-log', { details });
          }

          if (pornOrSexyProb >= 0.75 || (details.Porn && details.Porn >= 0.65)) {
            console.warn("NSFW violation detected (>75%):", pornOrSexyProb, details);
            this.handleNSFWViolation({ probability: pornOrSexyProb, details });
          }
        } catch (err) {}
      }
    }, 3000);
  }

  handleNSFWViolation(details = {}) {
    if (this.state.isBanned) return;
    this.state.isBanned = true;

    if (this.socket) {
      this.socket.emit('nsfw-violation', details);
    }

    this.showBanModal({
      title: 'Account Suspended',
      message: 'Inappropriate content was detected on your camera. You have been banned to maintain community safety.',
      offenseCount: 1,
      banDurationHours: 24
    });

    this.cleanupConnection();
    this.disableChat();
    if (this.state.localStream) {
      this.state.localStream.getTracks().forEach(t => t.stop());
      this.state.localStream = null;
    }
    if (this.elements.localVideo) this.elements.localVideo.srcObject = null;
  }

  showBanModal({ title, message, offenseCount = 1, banDurationHours = 24 }) {
    const existing = document.getElementById('bannedOverlayModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'bannedOverlayModal';
    modal.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(8, 10, 15, 0.95); backdrop-filter: blur(12px);
      z-index: 999999; display: flex; align-items: center; justify-content: center;
      padding: 20px; font-family: system-ui, sans-serif;
    `;

    modal.innerHTML = `
      <div style="background:#161922;border:1px solid #2a3142;border-radius:18px;max-width:520px;width:100%;padding:32px;text-align:center;color:#f1f5f9;position:relative;">
        <button type="button" onclick="document.getElementById('bannedOverlayModal')?.remove()" style="position:absolute;top:16px;right:16px;background:#ef4444;border:none;color:#ffffff;padding:6px 14px;border-radius:20px;font-size:13px;font-weight:bold;cursor:pointer;">✕ Close</button>
        <div style="width:64px;height:64px;background:rgba(239,68,68,0.15);border:2px solid #ef4444;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:28px;">🚫</div>
        <h2 style="font-size:22px;font-weight:800;color:#fff;margin-bottom:12px;">${title}</h2>
        <p style="font-size:15px;color:#94a3b8;line-height:1.7;margin-bottom:24px;">${message}</p>
        <a href="index.html" style="padding:12px 24px;background:#3b82f6;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;">🏠 Return to Homepage</a>
      </div>
    `;

    document.body.appendChild(modal);
  }

  pauseSearchForOffer() {
    this.state.isOfferOpen = true;
    this.clearSafeTimer(this.searchTimer);
    this.clearSafeTimer(this.pauseTimer);
    this.showRemoteSpinnerOnly(false);
    this.updateStatusMessage('Search paused while completing offer.');
  }

  resumeSearchAfterOffer() {
    this.state.isOfferOpen = false;
    if (!this.state.partnerId && !this.state.isBanned) {
      this.showRemoteSpinnerOnly(true);
      this.updateStatusMessage('Searching for a stranger...');
      this.startSearchLoop();
    }
  }

  updateGenderFilter() {
    this.state.isOfferOpen = false;
    if (!this.state.partnerId) {
      this.clearSafeTimer(this.searchTimer);
      this.clearSafeTimer(this.pauseTimer);
      this.startSearchLoop();
    }
  }
}

// =====================================================
// Initialize application when DOM is loaded
// =====================================================
window.addEventListener('DOMContentLoaded', () => {
  const app = new ChatApp();
  window.chatApp = app;

  window.addEventListener('error', (e) => {
    console.error('Global error:', e.error);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled promise rejection:', e.reason);
  });
  window.onbeforeunload = () => {
    app.cleanupConnection();
    if (app.state.localStream) {
      app.state.localStream.getTracks().forEach(t => t.stop());
    }
  };
});
