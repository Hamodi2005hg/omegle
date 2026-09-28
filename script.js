// =====================================================
// Omegooo Chat Engine - Cloudflare Pages Compatible
// PeerJS + MQTT Real-time Signaling (Zero-Server-Cost P2P)
// =====================================================

const LINK_REGEX = /(?:https?:\/\/|ftp:\/\/|www\.)[^\s]+|(?:\b[a-zA-Z0-9-]+\.)+(?:com|net|org|edu|gov|io|ai|co|xyz|me|info|biz|ru|cn|uk|de|online|site|app|top|club|vip|live|tv|cc|ly|gg|link|click|space|shop|store|dev|pro|icu|buzz)\b(?:\/[^\s]*)?|(?:t\.me|wa\.me|discord\.gg|telegram\.me|bit\.ly|tinyurl\.com)\/[^\s]+/i;

function getIceServers() {
  const customTurn = window.OMEGOOO_TURN_CONFIG || (function() {
    try {
      return JSON.parse(localStorage.getItem('custom_turn_config'));
    } catch(e) { return null; }
  })();

  const defaultServers = [
    // STUN Servers (For direct P2P when NAT allows)
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },

    // Global High-Availability TURN Relay Servers (Fixes 4G/5G Mobile CGNAT & Strict Firewalls)
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turns:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ];

  if (Array.isArray(customTurn) && customTurn.length > 0) {
    return [...customTurn, ...defaultServers];
  }
  return defaultServers;
}

class ChatApp {
  constructor() {
    this.peer = null;
    this.mqttClient = null;
    this.currentCall = null;
    this.dataConn = null;

    this.myPeerId = 'omegooo_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36);

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
      skipTimestamp: 0,
      faceVerified: false
    };

    this.skipCount = 0;
    this.sessionToken = 0;
    this.timers = new Set();
    this.searchTimer = null;
    this.pauseTimer = null;
    this.typingTimer = null;
    this.searchPulseInterval = null;
    this.skippedPeerFallbackTimer = null;

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

    await this.ensureLibrariesLoaded();
    this.initPeerJS();
    this.initMqttSignaling();

    this.startSearch();
    this.initNSFWJS();
  }

  async ensureLibrariesLoaded() {
    const loadScript = (url) => new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });

    if (!window.mqtt) {
      await loadScript('https://cdn.jsdelivr.net/npm/mqtt@5.3.5/dist/mqtt.min.js');
    }
    if (!window.Peer) {
      await loadScript('https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js');
    }
  }

  initPeerJS() {
    if (!window.Peer) {
      console.warn("PeerJS library not available. Retrying...");
      setTimeout(() => this.initPeerJS(), 1000);
      return;
    }

    try {
      this.peer = new window.Peer(this.myPeerId, {
        config: {
          iceServers: getIceServers(),
          iceCandidatePoolSize: 10
        },
        debug: 1
      });

      this.peer.on('open', (id) => {
        console.log('[PEERJS] Connected to Peer Cloud. Peer ID:', id);
        if (!this.state.partnerId && !this.state.isBanned && this.state.localStream && this.state.localStream.active && this.state.faceVerified) {
          this.startSearchLoop();
        }
      });

      // Handle Incoming Call (Video Stream)
      this.peer.on('call', (call) => {
        console.log('[PEERJS] Incoming call from:', call.peer);
        if (this.state.partnerId && this.state.partnerId !== call.peer) {
          call.close();
          return;
        }

        this.currentCall = call;
        this.state.partnerId = call.peer;

        if (this.state.localStream) {
          call.answer(this.state.localStream);
        } else {
          call.answer();
        }

        call.on('stream', (remoteStream) => {
          console.log('[PEERJS] Remote stream received from:', call.peer);
          if (this.elements.remoteVideo) {
            this.elements.remoteVideo.srcObject = remoteStream;
            this.elements.remoteVideo.play().catch(() => {});
          }
          this.hideAllSpinners();
          this.enableChat();
          this.updateStatusMessage("Hello 👋 You've been contacted by a stranger Say hello 😊🤝");
        });

        call.on('close', () => {
          this.handlePartnerDisconnected();
        });

        call.on('error', (err) => {
          console.warn('[PEERJS] Call error:', err);
          this.handlePartnerDisconnected();
        });
      });

      // Handle Incoming Data Connection (Chat / Typing / Skip signals)
      this.peer.on('connection', (conn) => {
        console.log('[PEERJS] Incoming data connection from:', conn.peer);
        if (this.dataConn && this.dataConn.peer !== conn.peer) {
          try { conn.close(); } catch(e){}
        }
        this.dataConn = conn;
        this.setupDataConnection(conn);
      });

      this.peer.on('error', (err) => {
        console.warn('[PEERJS] Peer error:', err);
      });
    } catch (e) {
      console.error('[PEERJS] Initialization failed:', e);
    }
  }

  initMqttSignaling() {
    if (!window.mqtt) {
      setTimeout(() => this.initMqttSignaling(), 1000);
      return;
    }

    const brokerUrls = [
      'wss://broker.emqx.io:8084/mqtt',
      'wss://broker.hivemq.com:8000/mqtt',
      'wss://test.mosquitto.org:8081/mqtt'
    ];

    let currentBrokerIdx = 0;

    const connectToBroker = (idx) => {
      if (idx >= brokerUrls.length) idx = 0;
      currentBrokerIdx = idx;

      console.log(`[MQTT] Connecting to broker (${idx + 1}/${brokerUrls.length}):`, brokerUrls[idx]);

      try {
        if (this.mqttClient) {
          try { this.mqttClient.end(true); } catch(e){}
        }

        this.mqttClient = window.mqtt.connect(brokerUrls[idx], {
          clientId: 'cli_' + Math.random().toString(36).slice(2, 8) + '_' + this.myPeerId.slice(-8),
          keepalive: 15,
          clean: true,
          reconnectPeriod: 3000,
          connectTimeout: 5000
        });

        this.mqttClient.on('connect', () => {
          console.log('[MQTT] Connected successfully to broker:', brokerUrls[idx]);
          this.mqttClient.subscribe(['omegooo/lobby/v2', 'omegooo/lobby/v2/#']);
          if (!this.state.partnerId && !this.state.isBanned && this.state.localStream && this.state.localStream.active && this.state.faceVerified) {
            this.startSearchLoop();
          }
        });

        this.mqttClient.on('message', (topic, message) => {
          if (topic.startsWith('omegooo/lobby/v2')) {
            try {
              const data = JSON.parse(message.toString());
              this.handleLobbyAnnounce(data);
            } catch(e) {}
          }
        });

        this.mqttClient.on('error', (err) => {
          console.warn('[MQTT] Broker error on:', brokerUrls[idx], err);
          setTimeout(() => connectToBroker((currentBrokerIdx + 1) % brokerUrls.length), 2000);
        });
      } catch (e) {
        console.error('[MQTT] Connection exception:', e);
        setTimeout(() => connectToBroker((currentBrokerIdx + 1) % brokerUrls.length), 2000);
      }
    };

    connectToBroker(0);
  }

  setupDataConnection(conn) {
    conn.on('open', () => {
      console.log('[DATA] Data connection opened with:', conn.peer);
    });

    conn.on('data', (data) => {
      if (!data) return;
      if (data.type === 'chat') {
        this.addMessage(data.message, 'them', '', data.avatar || this.state.partnerAvatar);
      } else if (data.type === 'typing') {
        if (this.typingIndicator) {
          this.typingIndicator.style.display = 'block';
          if (this.elements.chatMessages) this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
        }
      } else if (data.type === 'stop-typing') {
        if (this.typingIndicator) {
          this.typingIndicator.style.display = 'none';
        }
      } else if (data.type === 'skip') {
        this.handlePartnerDisconnected();
      } else if (data.type === 'report') {
        this.handlePartnerDisconnected();
      }
    });

    conn.on('close', () => {
      this.handlePartnerDisconnected();
    });

    conn.on('error', () => {
      this.handlePartnerDisconnected();
    });
  }

  handleLobbyAnnounce(data) {
    if (!data || !data.peerId || data.peerId === this.myPeerId) return;
    if (this.state.partnerId || this.state.isBanned || this.state.isOfferOpen) return;
    if (!this.state.localStream || !this.state.localStream.active || !this.state.faceVerified) return;
    if (this.reportedIds.has(data.peerId)) return;

    const myFilterGender = (typeof window.getActiveGenderFilter === 'function') ? window.getActiveGenderFilter() : 'all';
    const myGender = localStorage.getItem('user_gender') || 'male';

    if (myFilterGender !== 'all' && data.gender !== myFilterGender) return;
    if (data.filterGender && data.filterGender !== 'all' && myGender !== data.filterGender) return;

    const isRecentlySkipped = (data.peerId === this.state.lastSkippedPeerId) && (Date.now() - (this.state.skipTimestamp || 0) < 10000);

    const performConnect = () => {
      if (this.state.partnerId || this.state.isBanned || this.state.isOfferOpen) return;
      if (!this.peer || !this.peer.open) {
        setTimeout(() => performConnect(), 300);
        return;
      }

      console.log('[MATCHMAKING] Auto-connecting with announced peer:', data.peerId);
      this.state.partnerId = data.peerId;
      this.state.isInitiator = true;
      this.state.partnerAvatar = data.avatar || 'https://ui-avatars.com/api/?name=Stranger&background=ff6600&color=fff';
      this.state.partnerName = data.name || 'Stranger';

      this.setSingleSystemMessage('Connected with a stranger. Say hello! 👋😊', 'stranger-connected-msg');
      this.updateStatusMessage("Hello 👋 You've been contacted by a stranger Say hello 😊🤝");

      // Initiate PeerJS Video Call
      if (this.state.localStream) {
        this.currentCall = this.peer.call(data.peerId, this.state.localStream);
      } else {
        this.currentCall = this.peer.call(data.peerId);
      }

      if (this.currentCall) {
        this.currentCall.on('stream', (remoteStream) => {
          if (this.elements.remoteVideo) {
            this.elements.remoteVideo.srcObject = remoteStream;
            this.elements.remoteVideo.play().catch(() => {});
          }
          this.hideAllSpinners();
          this.enableChat();
          this.updateStatusMessage("Hello 👋 You've been contacted by a stranger Say hello 😊🤝");
        });

        this.currentCall.on('close', () => {
          this.handlePartnerDisconnected();
        });
      }

      // Initiate PeerJS Data Connection for Chat
      this.dataConn = this.peer.connect(data.peerId);
      if (this.dataConn) {
        this.setupDataConnection(this.dataConn);
      }
    };

    if (isRecentlySkipped) {
      this.clearSafeTimer(this.skippedPeerFallbackTimer);
      this.skippedPeerFallbackTimer = this.setSafeTimer(() => {
        performConnect();
      }, 1000);
    } else {
      this.clearSafeTimer(this.skippedPeerFallbackTimer);
      performConnect();
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
    if (this.searchPulseInterval) {
      clearInterval(this.searchPulseInterval);
      this.searchPulseInterval = null;
    }
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

    if (this.currentCall) {
      try { this.currentCall.close(); } catch (e) {}
      this.currentCall = null;
    }

    if (this.dataConn) {
      try { this.dataConn.close(); } catch (e) {}
      this.dataConn = null;
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

    if (!this.state.localStream || !this.state.localStream.active || !this.state.faceVerified) {
      console.log('[SEARCH] Camera/Face verification pending. Search deferred until face is visible.');
      return;
    }

    if (this.state.partnerId || this.state.isOfferOpen) return;

    this.showRemoteSpinnerOnly(true);
    this.updateStatusMessage('Searching for a stranger...');

    const sendAnnouncePulse = () => {
      if (this.state.partnerId || this.state.isBanned) return;
      if (!this.mqttClient || !this.mqttClient.connected) return;

      const filterGender = (typeof window.getActiveGenderFilter === 'function') ? window.getActiveGenderFilter() : 'all';
      const user = (typeof window.getGoogleUser === 'function') ? window.getGoogleUser() : (JSON.parse(localStorage.getItem('google_user') || 'null'));
      const avatar = user?.picture || 'https://ui-avatars.com/api/?name=User&background=ff6600&color=fff';
      const name = user?.name || 'User';
      const gender = localStorage.getItem('user_gender') || 'male';

      const payload = {
        peerId: this.myPeerId,
        gender,
        filterGender,
        avatar,
        name,
        ts: Date.now()
      };

      const shardId = Math.floor(Math.random() * 8);
      const topic = `omegooo/lobby/v2/shard_${shardId}`;

      try {
        this.mqttClient.publish(topic, JSON.stringify(payload));
      } catch(e) {}
    };

    sendAnnouncePulse();

    if (this.searchPulseInterval) clearInterval(this.searchPulseInterval);
    this.searchPulseInterval = setInterval(() => {
      if (!this.state.partnerId && !this.state.isBanned) {
        sendAnnouncePulse();
      } else {
        clearInterval(this.searchPulseInterval);
        this.searchPulseInterval = null;
      }
    }, 1000);

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

  async verifyCameraAndFace() {
    if (this.state.isBanned) return false;
    if (!this.state.localStream || !this.state.localStream.active) return false;

    const audioTracks = this.state.localStream.getAudioTracks();
    const videoTracks = this.state.localStream.getVideoTracks();

    if (!audioTracks.length || !videoTracks.length) return false;
    if (!audioTracks.some(t => t.enabled && t.readyState === 'live')) return false;
    if (!videoTracks.some(t => t.enabled && t.readyState === 'live')) return false;

    const video = this.elements.localVideo;
    if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return false;

    // Verify illuminated non-black camera frame (active user video rendering)
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 120;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, 160, 120);
      const imgData = ctx.getImageData(0, 0, 160, 120).data;
      let totalLuma = 0;
      for (let i = 0; i < imgData.length; i += 16) {
        totalLuma += imgData[i] * 0.299 + imgData[i+1] * 0.587 + imgData[i+2] * 0.114;
      }
      const avgLuma = totalLuma / (imgData.length / 16);
      if (avgLuma < 3) { // Pitch black camera feed or covered lens
        return false;
      }
    } catch(e) {}

    return true;
  }

  injectAdInChatMessages() {
    if (!this.elements.chatMessages) return;

    const adContainer = document.createElement('div');
    adContainer.className = 'chat-ad-banner-card';
    adContainer.style.cssText = `
      margin: 12px auto;
      padding: 12px;
      width: 92%;
      max-width: 480px;
      background: rgba(255, 102, 0, 0.08);
      border: 1px dashed rgba(255, 102, 0, 0.5);
      border-radius: 14px;
      text-align: center;
      position: relative;
      box-shadow: 0 4px 15px rgba(0,0,0,0.06);
      z-index: 5;
    `;

    const label = document.createElement('div');
    label.style.cssText = 'font-size: 11px; font-weight: 800; color: #ff6600; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 8px;';
    label.textContent = '📢 Sponsored Advertisement';
    adContainer.appendChild(label);

    const slot = document.createElement('div');
    slot.id = 'ad-slot-' + Math.random().toString(36).substring(2, 9);
    adContainer.appendChild(slot);

    this.elements.chatMessages.appendChild(adContainer);
    this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;

    // Load ad script
    try {
      const script = document.createElement('script');
      script.src = 'https://pl31553496.profitableratecpmnetwork.com/64/da/de/64dadef7a23dce381a832951f9c5d2be.js';
      script.async = true;
      document.body.appendChild(script);
    } catch (e) {
      console.warn("Ad script insertion warning:", e);
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

    if (this.state.localStream && this.state.localStream.active && this.state.faceVerified) {
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

      // Poll and verify camera, microphone, and face rendering
      let verified = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        verified = await this.verifyCameraAndFace();
        if (verified) break;
        await new Promise(r => setTimeout(r, 250));
      }

      if (verified) {
        this.state.faceVerified = true;
        this.hideReenableMediaButton();
        this.setSkipButtonsDisabled(false);
        this.showRemoteSpinnerOnly(true);
        this.updateMicButton();
        this.updateStatusMessage('✅ Camera, Microphone & Face verified. Searching for a stranger...');
        return true;
      } else {
        this.state.faceVerified = false;
        this.updateStatusMessage('📹 Camera & Microphone required. Please position yourself in front of the camera.');
        this.showReenableMediaButton();
        return false;
      }
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

      if (this.dataConn) {
        try { this.dataConn.send({ type: 'skip' }); } catch(e){}
      }

      this.skipCount++;
      if (this.skipCount % 5 === 0) {
        this.injectAdInChatMessages();
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
        if (this.dataConn) {
          try { this.dataConn.send({ type: 'skip' }); } catch(e){}
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

        if (this.dataConn) {
          try {
            this.dataConn.send({ type: 'report' });
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
      if (!this.state.partnerId || this.state.isBanned || !this.dataConn) return;
      if (!this.typing) {
        this.typing = true;
        try { this.dataConn.send({ type: 'typing' }); } catch(e){}
      }
      this.clearSafeTimer(this.typingTimer);
      this.typingTimer = this.setSafeTimer(() => {
        this.typing = false;
        if (this.dataConn) {
          try { this.dataConn.send({ type: 'stop-typing' }); } catch(e){}
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
      if (!msg || !this.state.partnerId || !this.dataConn) return;

      if (LINK_REGEX.test(msg)) {
        this.addMessage("🚫 Sending links or external URLs is prohibited in chat.", "system");
        this.elements.chatInput.value = '';
        this.typing = false;
        if (this.dataConn) {
          try { this.dataConn.send({ type: 'stop-typing' }); } catch(e){}
        }
        return;
      }

      const user = (typeof window.getGoogleUser === 'function') ? window.getGoogleUser() : null;
      const myAvatar = user?.picture || localStorage.getItem('user_avatar') || 'https://ui-avatars.com/api/?name=Me&background=ff6600&color=fff';
      this.addMessage(msg, 'you', '', myAvatar);

      try {
        this.dataConn.send({
          type: 'chat',
          message: msg,
          avatar: myAvatar,
          name: user?.name || 'Me'
        });
      } catch(e) {}

      this.elements.chatInput.value = '';
      this.typing = false;
      try { this.dataConn.send({ type: 'stop-typing' }); } catch(e){}
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
