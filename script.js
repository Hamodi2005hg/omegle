// =====================================================
// Connection Management System - Chat Application
// =====================================================
class ChatApp {
  constructor() {
    this.socket = io();
    this.config = {
      PING_INTERVAL: 4000,
      PONG_TIMEOUT: 20000,
      STATS_POLL_MS: 2500,
      BITRATE_HIGH: 900000,
      BITRATE_MEDIUM: 450000,
      BITRATE_LOW: 180000,
      BITRATE_RECOVERY: 90000,
      TYPING_PAUSE: 1500,
      SEARCH_TIMEOUT: 3500,
      AD_TIMEOUT: 50000,
      MAX_CONSECUTIVE_FAILS: 3,
      NORMAL_PAUSE_DURATION: 3000
    };
 
    this.state = {
      localStream: null,
      peerConnection: null,
      partnerId: null,
      isInitiator: false,
      micEnabled: true,
      isBanned: false,
      consecutiveSearchFails: 0,
      makingOffer: false,
      ignoreOffer: false,
      restartingIce: false,
      partnerVideoReady: false,
      localVideoReadySent: false,
      isAdPlaying: false,
      currentAdIndex: 0
    };
    this.sessionToken = 0;
    this.timers = new Set();
    this.statsInterval = null;
    this.pingTimer = null;
    this.searchTimer = null;
    this.pauseTimer = null;
    this.typingTimer = null;
    this.disconnectGraceTimer = null;
    this.reconnectAttempts = 0;
 
    this.bufferedRemoteCandidates = [];
    this.reportedIds = new Set();
    this.reportCounts = new Map();

    // High-availability STUN servers for instant, rock-solid P2P connectivity & NAT traversal
    this.servers = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' },
        { urls: 'stun:stun.cloudflare.com:3478' }
      ],
      iceCandidatePoolSize: 10,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    };

    this.adVideosList = [];
 
    this.adVideo = null;
    this.keepAliveChannel = null;
    this.lastPong = Date.now();
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
    this.createAdVideoElement();
    this.ensureNotifyEmpty();
    this.updateMicButton();
    this.setupChatScrollEffect(); // Setup new scroll fading effect

    this.socket.on('connect', async () => {
      console.log('Socket connected with ID:', this.socket.id);
      if (this.oldSocketId && this.state.partnerId) {
        console.log('Attempting to reclaim session from old socket ID:', this.oldSocketId);
        this.safeEmit('reclaim-session', { oldSocketId: this.oldSocketId });
      } else {
        await this.sendIdentify();
      }
      this.oldSocketId = this.socket.id;
    });
 
    this.startSearch();
    this.initNSFWJS();
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
      mobileSkipBtn: document.getElementById('mobileSkipBtn'),
      exitBtn: document.getElementById('exitBtn')
    };
  }

  // =====================================================
  // Scroll effect: Fade out older messages when scrolling up
  // =====================================================
  setupChatScrollEffect() {
    const chat = this.elements.chatMessages;
    if (!chat) return;

    const updateMessagesOpacity = () => {
      const scrollTop = chat.scrollTop;
      const scrollHeight = chat.scrollHeight;
      const clientHeight = chat.clientHeight;

      // Distance from bottom
      const distanceFromBottom = scrollHeight - clientHeight - scrollTop;

      // If user is near the bottom (less than 600px), show all messages clearly
      // The further up they scroll, the older messages fade out
      const fadeStart = 600; // Start fading after 600px from the bottom

      const messages = chat.querySelectorAll('.msg');
      messages.forEach(msg => {
        const rect = msg.getBoundingClientRect();
        const chatRect = chat.getBoundingClientRect();
        const msgTopRelativeToChat = rect.top - chatRect.top + scrollTop;

        // If the message is at the top of the chat (old) and we scroll up
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

    // Update when new messages are added too
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
    if (this.statsInterval) clearInterval(this.statsInterval);
    if (this.pingTimer) clearInterval(this.pingTimer);
  }
  // =====================================================
  // Data & Connection Management
  // =====================================================
  safeEmit(event, data) {
    try {
      if (this.socket.connected) {
        this.socket.emit(event, data);
        return true;
      }
      console.warn(`Socket not connected, cannot emit ${event}`);
      return false;
    } catch (e) {
      console.error(`Error emitting ${event}:`, e);
      return false;
    }
  }
  async generateFingerprint() {
    try {
      const components = [
        navigator.userAgent,
        navigator.language,
        screen.colorDepth,
        screen.width,
        screen.height,
        navigator.hardwareConcurrency || 0,
        new Date().getTimezoneOffset(),
        Intl.DateTimeFormat().resolvedOptions().timeZone || ''
      ];
   
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('fingerprint', 2, 15);
      ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
      ctx.fillText('fingerprint', 4, 17);
      components.push(canvas.toDataURL());
   
      try {
        const audioCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
        const oscillator = audioCtx.createOscillator();
        oscillator.type = 'triangle';
        oscillator.frequency.setValueAtTime(10000, audioCtx.currentTime);
        oscillator.connect(audioCtx.destination);
        oscillator.start();
        oscillator.stop();
        components.push('audio-supported');
      } catch (e) {
        components.push('audio-unsupported');
      }
   
      const hashCode = (str) => {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
          const char = str.charCodeAt(i);
          hash = ((hash << 5) - hash) + char;
          hash = hash & hash;
        }
        return hash.toString(16);
      };
   
      return hashCode(components.join('||'));
    } catch (e) {
      console.error('Fingerprint generation failed:', e);
      return 'default-fp-' + Math.random().toString(36).substr(2, 9);
    }
  }
  async sendIdentify() {
    try {
      const fingerprint = await this.generateFingerprint();
      this.safeEmit('identify', { fingerprint });
    } catch (e) {
      console.error('Failed to send fingerprint:', e);
    }
  }
  // =====================================================
  // UI Management
  // =====================================================
  addMessage(msg, type = 'system') {
    const d = document.createElement('div');
    d.className = `msg ${type}`;
    d.textContent = msg;
    d.style.opacity = '1'; // Ensure new message is fully visible
    d.style.transition = 'opacity 0.4s ease';

    const typing = document.querySelector('.msg.system[style*="italic"]');
    if (typing && typing.parentNode === this.elements.chatMessages) {
      this.elements.chatMessages.insertBefore(d, typing);
    } else {
      this.elements.chatMessages.appendChild(d);
    }

    // Always scroll to the bottom when adding a new message
    this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;

    // Update the fade opacity effect after adding a message
    if (this.updateMessagesOpacity) {
      requestAnimationFrame(() => this.updateMessagesOpacity());
    }
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
  pushAdminNotification(text) {
    const item = document.createElement('div');
    item.className = 'notify-item';
    item.textContent = text;
    this.elements.notifyMenu.prepend(item);
    const empty = this.elements.notifyMenu.querySelector('.notify-empty');
    if (empty) empty.remove();
  }
  ensureNotifyEmpty() {
    if (this.elements.notifyMenu.children.length === 0) {
      const d = document.createElement('div');
      d.textContent = 'No notifications';
      d.className = 'notify-empty';
      this.elements.notifyMenu.appendChild(d);
    }
  }
  enableChat() {
    this.elements.chatInput.disabled = this.state.isBanned;
    this.elements.sendBtn.disabled = this.state.isBanned;
  }
  disableChat() {
    this.elements.chatInput.disabled = true;
    this.elements.sendBtn.disabled = true;
  }
  setSkipButtonsDisabled(disabled) {
    if (this.elements.skipBtn) this.elements.skipBtn.disabled = false;
    if (this.elements.mobileSkipBtn) this.elements.mobileSkipBtn.disabled = false;
  }
  updateMicButton() {
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
  // Ad Management
  // =====================================================
  createAdVideoElement() {
    if (this.adVideo) {
      this.adVideo.remove();
    }
    this.adVideo = document.createElement('video');
    this.adVideo.id = 'adVideo';
    this.adVideo.autoplay = false;
    this.adVideo.muted = true;
    this.adVideo.playsInline = true;
    this.adVideo.preload = 'auto';
    this.adVideo.style.position = 'absolute';
    this.adVideo.style.top = '0';
    this.adVideo.style.left = '0';
    this.adVideo.style.width = '100%';
    this.adVideo.style.height = '100%';
    this.adVideo.style.objectFit = 'cover';
    this.adVideo.style.zIndex = '100';
    this.adVideo.style.display = 'none';
    this.adVideo.style.backgroundColor = '#000';
    this.adVideo.controls = false;
    this.elements.remoteVideo.parentNode.appendChild(this.adVideo);
  }
  playAdVideo() {
    if (this.state.isAdPlaying || this.adVideosList.length === 0) {
      this.state.consecutiveSearchFails = 0;
      this.config.NORMAL_PAUSE_DURATION = 3000;
      this.updateStatusMessage('Searching...');
      this.startSearchLoop();
      return;
    }
 
    this.clearSafeTimer(this.searchTimer);
    this.clearSafeTimer(this.pauseTimer);
    this.searchTimer = null;
    this.pauseTimer = null;
    this.state.isAdPlaying = true;
 
    const adUrl = this.adVideosList[this.state.currentAdIndex];
    this.state.currentAdIndex = (this.state.currentAdIndex + 1) % this.adVideosList.length;
 
    this.updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');
 
    this.adVideo.onerror = () => {
      console.error('Error loading ad video:', adUrl);
      this.hideAdVideo();
    };
 
    this.adVideo.oncanplay = () => {
      this.adVideo.play().catch(e => {
        console.warn('Auto-play prevented:', e);
        document.addEventListener('click', this.tryPlayAdOnClick.bind(this), { once: true });
      });
    };
 
    this.adVideo.onended = this.hideAdVideo.bind(this);
    this.adVideo.src = adUrl;
    this.adVideo.style.display = 'block';
    this.elements.remoteVideo.style.display = 'none';
 
    const adTimeout = this.setSafeTimer(this.hideAdVideo.bind(this), this.config.AD_TIMEOUT);
 
    this.adTimeout = adTimeout;
  }
  tryPlayAdOnClick() {
    this.adVideo.play().catch(console.warn);
  }
  hideAdVideo() {
    if (!this.state.isAdPlaying) return;
 
    this.clearSafeTimer(this.adTimeout);
    document.removeEventListener('click', this.tryPlayAdOnClick.bind(this));
    this.adVideo.pause();
    this.adVideo.style.display = 'none';
    this.elements.remoteVideo.style.display = 'block';
    this.adVideo.src = '';
    this.state.isAdPlaying = false;
    this.state.consecutiveSearchFails = 0;
    this.config.NORMAL_PAUSE_DURATION = 3000;
    this.updateStatusMessage('Searching...');
    this.startSearchLoop();
  }
  // =====================================================
  // Connection Cleanup & Memory Leak Prevention
  // =====================================================
  cleanupConnection() {
    this.sessionToken++;
    this.clearAllTimers();

    if (this.keepAliveChannel) {
      try {
        this.keepAliveChannel.onopen = null;
        this.keepAliveChannel.onmessage = null;
        this.keepAliveChannel.onclose = null;
        this.keepAliveChannel.onerror = null;
        this.keepAliveChannel.close();
      } catch (e) {}
      this.keepAliveChannel = null;
    }

    if (this.state.peerConnection) {
      try {
        // Clear all event listeners on old RTCPeerConnection FIRST
        this.state.peerConnection.ontrack = null;
        this.state.peerConnection.onicecandidate = null;
        this.state.peerConnection.oniceconnectionstatechange = null;
        this.state.peerConnection.onconnectionstatechange = null;
        this.state.peerConnection.onsignalingstatechange = null;
        this.state.peerConnection.onnegotiationneeded = null;
        this.state.peerConnection.ondatachannel = null;

        // Remove and detach all tracks from old connection
        const senders = this.state.peerConnection.getSenders();
        senders.forEach(sender => {
          try {
            this.state.peerConnection.removeTrack(sender);
          } catch (e) {}
        });

        // Close peer connection
        this.state.peerConnection.close();
      } catch (e) {}
      this.state.peerConnection = null;
    }

    // Completely detach remote video/audio stream and pause playback
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

    this.bufferedRemoteCandidates = [];
    this.state.partnerId = null;
    this.state.isInitiator = false;
    this.state.makingOffer = false;
    this.state.ignoreOffer = false;
    this.state.partnerVideoReady = false;
    this.state.localVideoReadySent = false;
    this.stopStatsMonitor();
    this.stopPingLoop();
  }

  sendLocalVideoReady() {
    if (this.state.localVideoReadySent || !this.state.partnerId) return;
    this.state.localVideoReadySent = true;
    this.safeEmit('video-ready', { to: this.state.partnerId });
  }
  // =====================================================
  // Search & Matchmaking Management
  // =====================================================
  startSearchLoop() {
    if (this.state.isBanned) {
      this.updateStatusMessage('⛔ You have been banned for 24 hours 🕐 for engaging in inappropriate behavior 🚫 and violating our policy terms 📜. ⚠️');
      this.showRemoteSpinnerOnly(false);
      return;
    }
 
    if (this.state.partnerId || this.state.isAdPlaying) return;
 
    this.showRemoteSpinnerOnly(true);
    this.updateStatusMessage('Searching...');
    const interests = JSON.parse(localStorage.getItem('user_interests') || '[]');
    this.safeEmit('find-partner', { interests });
 
    this.clearSafeTimer(this.searchTimer);
    this.searchTimer = this.setSafeTimer(() => {
      if (!this.state.partnerId) {
        this.safeEmit('stop');
        this.showRemoteSpinnerOnly(false);
        this.clearSafeTimer(this.pauseTimer);
        this.pauseTimer = this.setSafeTimer(() => {
          this.startSearchLoop();
        }, this.config.NORMAL_PAUSE_DURATION);
      }
    }, this.config.SEARCH_TIMEOUT);
  }
  async startSearch() {
    if (this.state.isBanned) {
      this.updateStatusMessage('⛔ You have been banned for 24 hours 🕐 for engaging in inappropriate behavior 🚫 and violating our policy terms 📜. ⚠️');
      this.showRemoteSpinnerOnly(false);
      return;
    }
 
    this.cleanupConnection();
    this.elements.chatMessages.innerHTML = '';
    this.elements.chatMessages.appendChild(this.typingIndicator);
    
    // Hide all spinners initially until camera is ready
    this.hideAllSpinners();
    this.setSkipButtonsDisabled(true);
    this.state.consecutiveSearchFails = 0;
    this.config.NORMAL_PAUSE_DURATION = 3000;

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
      this.updateStatusMessage('⛔ You have been banned for 24 hours 🕐 for engaging in inappropriate behavior 🚫 and violating our policy terms 📜. ⚠️');
      return false;
    }
 
    if (this.state.localStream) return true;
 
    const attempt = async () => {
      try {
        if (this.elements.localSpinner) {
          this.elements.localSpinner.style.display = 'block';
        }
        this.state.localStream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640, max: 1280 },
            height: { ideal: 480, max: 720 },
            frameRate: { ideal: 24, max: 30 }
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        this.elements.localVideo.srcObject = this.state.localStream;
      
        if (this.elements.localSpinner) {
          this.elements.localSpinner.style.display = 'none';
        }
        
        this.setSkipButtonsDisabled(false);
        this.showRemoteSpinnerOnly(true);
        this.updateMicButton();
        this.updateStatusMessage('Media access granted. Starting search...');
        
        // Explicitly start matchmaking loop since camera/mic are now active
        this.startSearchLoop();
        return true;
      } catch (e) {
        console.error('Media access denied:', e);
        if (this.elements.localSpinner) {
          this.elements.localSpinner.style.display = 'none';
        }
        this.hideAllSpinners();
        this.updateStatusMessage('📹🎤 Please allow camera and microphone access to continue. Retrying in 2 seconds...');
        this.setSafeTimer(attempt, 2000);
        return false;
      }
    };
 
    return await attempt();
  }
  // =====================================================
  // WebRTC & Connection Stability Management
  // =====================================================
  createPeerConnection() {
    if (this.state.peerConnection) {
      try {
        this.state.peerConnection.ontrack = null;
        this.state.peerConnection.onicecandidate = null;
        this.state.peerConnection.onconnectionstatechange = null;
        this.state.peerConnection.oniceconnectionstatechange = null;
        this.state.peerConnection.onsignalingstatechange = null;
        this.state.peerConnection.onnegotiationneeded = null;
        this.state.peerConnection.ondatachannel = null;
        const senders = this.state.peerConnection.getSenders();
        senders.forEach(s => { try { this.state.peerConnection.removeTrack(s); } catch (e) {} });
        this.state.peerConnection.close();
      } catch (e) {}
      this.state.peerConnection = null;
    }

    try {
      this.state.peerConnection = new RTCPeerConnection(this.servers);
      this.state.makingOffer = false;
      this.state.ignoreOffer = false;
      this.state.restartingIce = false;
   
      if (this.state.localStream) {
        this.state.localStream.getTracks().forEach(t => {
          try {
            this.state.peerConnection.addTrack(t, this.state.localStream);
          } catch (e) {}
        });
      }
   
      if (this.state.isInitiator) {
        try {
          this.keepAliveChannel = this.state.peerConnection.createDataChannel('keepAlive', { ordered: true });
          this.setupKeepAliveChannel(this.keepAliveChannel);
        } catch (e) {
          this.keepAliveChannel = null;
        }
      } else {
        this.state.peerConnection.ondatachannel = (ev) => {
          this.keepAliveChannel = ev.channel;
          this.setupKeepAliveChannel(this.keepAliveChannel);
        };
      }
   
      this.state.peerConnection.ontrack = e => {
        if (!e.streams || e.streams.length === 0) return;
        const remoteStream = e.streams[0];
        if (this.elements.remoteVideo.srcObject !== remoteStream) {
          this.elements.remoteVideo.srcObject = remoteStream;
          this.elements.remoteVideo.play().catch(() => {});
        }
        this.sendLocalVideoReady();
     
        this.state.partnerVideoReady = true;
        this.updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');
        this.hideAllSpinners();
        this.enableChat();
        this.startStatsMonitor();
      };
   
      this.state.peerConnection.onicecandidate = e => {
        if (e.candidate && this.state.partnerId) {
          this.safeEmit('signal', { to: this.state.partnerId, data: { candidate: e.candidate } });
        }
      };
   
      const mySession = this.sessionToken;

      const handleConnectionRecovery = async (stateName) => {
        if (!this.state.peerConnection || this.sessionToken !== mySession) return;
        
        if (stateName === 'connected') {
          if (this.disconnectGraceTimer) {
            clearTimeout(this.disconnectGraceTimer);
            this.disconnectGraceTimer = null;
          }
          this.reconnectAttempts = 0;
          this.hideAllSpinners();
          this.enableChat();
          this.updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');
        } else if (stateName === 'disconnected') {
          console.warn('⚠️ WebRTC connection transient disconnect detected. Scheduling recovery check...');
          
          if (this.disconnectGraceTimer) {
            clearTimeout(this.disconnectGraceTimer);
            this.disconnectGraceTimer = null;
          }

          this.disconnectGraceTimer = setTimeout(async () => {
            if (this.sessionToken === mySession && this.state.peerConnection && !this.state.isBanned && this.state.partnerId) {
              const currentConn = this.state.peerConnection.connectionState;
              const currentIce = this.state.peerConnection.iceConnectionState;
              if (currentConn === 'disconnected' || currentIce === 'disconnected' || currentConn === 'failed' || currentIce === 'failed') {
                this.updateStatusMessage('⚠️ Weak connection, stabilizing connection...');
                await this.setSenderMaxBitrate(this.config.BITRATE_RECOVERY, 2.0);
                this.attemptIceRestart();
              }
            }
          }, 1200);
        } else if (stateName === 'failed') {
          console.warn('⚠️ WebRTC connection failed. Attempting automatic ICE restart recovery...');
          this.attemptIceRestart();
        }
      };

      this.state.peerConnection.onconnectionstatechange = () => {
        if (!this.state.peerConnection || this.sessionToken !== mySession) return;
        handleConnectionRecovery(this.state.peerConnection.connectionState);
      };

      this.state.peerConnection.oniceconnectionstatechange = () => {
        if (!this.state.peerConnection || this.sessionToken !== mySession) return;
        handleConnectionRecovery(this.state.peerConnection.iceConnectionState);
      };
   
      this.state.peerConnection.onnegotiationneeded = async () => {
        if (!this.state.peerConnection || this.state.makingOffer || !this.state.partnerId || !this.state.isInitiator || this.sessionToken !== mySession) return;
     
        try {
          this.state.makingOffer = true;
          const offer = await this.state.peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
          });
          if (this.sessionToken !== mySession || !this.state.peerConnection || this.state.peerConnection.signalingState !== 'stable') return;
          await this.state.peerConnection.setLocalDescription(offer);
          if (this.sessionToken !== mySession) return;
          this.safeEmit('signal', { to: this.state.partnerId, data: offer });
        } catch (e) {
          // Handled silently to avoid crashing on rapid transitions
        } finally {
          if (this.sessionToken === mySession) {
            this.state.makingOffer = false;
          }
        }
      };
    } catch (e) {
      console.error('Failed to create peer connection:', e);
      throw e;
    }
  }

  // =====================================================
  // Attempt ICE Restart on connection loss or degradation
  // =====================================================
  async attemptIceRestart() {
    if (!this.state.peerConnection || !this.state.partnerId || this.state.isBanned) return;
    if (this.state.restartingIce) return;
    this.state.restartingIce = true;
    this.reconnectAttempts++;

    console.log(`🔄 Attempting ICE Restart recovery (attempt #${this.reconnectAttempts})...`);
    this.updateStatusMessage('⚠️ Weak connection, attempting to reconnect...');
    await this.setSenderMaxBitrate(this.config.BITRATE_RECOVERY, 2.0);

    try {
      if (this.state.isInitiator) {
        if (this.state.peerConnection.signalingState === 'stable') {
          const offer = await this.state.peerConnection.createOffer({
            iceRestart: true,
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
          });
          await this.state.peerConnection.setLocalDescription(offer);
          this.safeEmit('signal', { to: this.state.partnerId, data: offer });
        }
      } else {
        // Request the initiator peer to trigger ICE restart
        this.safeEmit('reconnect-request', { to: this.state.partnerId });
      }
    } catch (err) {
      console.warn('ICE restart attempt error:', err);
    } finally {
      setTimeout(() => {
        this.state.restartingIce = false;
      }, 4000);
    }
  }

  setupKeepAliveChannel(dc) {
    if (!dc) return;
 
    dc.onopen = () => {
      this.lastPong = Date.now();
      this.startPingLoop();
    };
 
    dc.onmessage = (ev) => {
      if (!ev.data) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'ping') {
          dc.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        } else if (msg.type === 'pong') {
          this.lastPong = Date.now();
        }
      } catch (e) {}
    };
 
    dc.onclose = () => this.stopPingLoop();
    dc.onerror = (err) => console.error('keepAlive error:', err);
  }

  startPingLoop() {
    this.stopPingLoop();
    this.pingTimer = setInterval(async () => {
      if (!this.keepAliveChannel || this.keepAliveChannel.readyState !== 'open') {
        return;
      }
   
      try {
        this.keepAliveChannel.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      } catch (e) {}
   
      // If data channel pongs are delayed, adaptively reduce quality rather than disconnecting!
      const timeSincePong = Date.now() - this.lastPong;
      if (timeSincePong > 10000) {
        await this.setSenderMaxBitrate(this.config.BITRATE_LOW, 1.5);
      }
      if (timeSincePong > this.config.PONG_TIMEOUT) {
        console.warn('Data channel ping timed out. Attempting ICE restart to stabilize connection...');
        this.attemptIceRestart();
      }
    }, this.config.PING_INTERVAL);
  }

  stopPingLoop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  async setSenderMaxBitrate(targetBps, scaleResolutionDownBy = 1.0) {
    if (!this.state.peerConnection) return;
 
    try {
      const senders = this.state.peerConnection.getSenders();
      for (const sender of senders) {
        if (!sender.track || sender.track.kind !== 'video') continue;
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings = params.encodings.map(enc => {
          const newEnc = { ...enc, maxBitrate: targetBps };
          if (scaleResolutionDownBy > 1.0) {
            newEnc.scaleResolutionDownBy = scaleResolutionDownBy;
          } else {
            delete newEnc.scaleResolutionDownBy;
          }
          return newEnc;
        });
        if (params.degradationPreference !== 'maintain-framerate') {
          params.degradationPreference = 'maintain-framerate';
        }
        await sender.setParameters(params);
      }
    } catch (e) {
      console.debug('setSenderMaxBitrate failed', e);
    }
  }

  startStatsMonitor() {
    this.stopStatsMonitor();
    this.statsInterval = setInterval(async () => {
      if (!this.state.peerConnection || this.state.peerConnection.connectionState !== 'connected') {
        return;
      }
   
      try {
        const stats = await this.state.peerConnection.getStats(null);
        let outboundVideoReport = null;
        let remoteInboundRtp = null;
     
        stats.forEach(report => {
          if (report.type === 'outbound-rtp' && report.kind === 'video') outboundVideoReport = report;
          if (report.type === 'remote-inbound-rtp' && report.kind === 'video') remoteInboundRtp = report;
        });
     
        let lossRatio = 0;
        if (outboundVideoReport?.packetsSent > 0) {
          if (remoteInboundRtp?.packetsLost >= 0) {
            const lost = remoteInboundRtp.packetsLost;
            const sent = (remoteInboundRtp.packetsReceived || 0) + lost;
            lossRatio = sent > 0 ? lost / sent : 0;
          } else if (outboundVideoReport.packetsLost >= 0) {
            lossRatio = outboundVideoReport.packetsLost / Math.max(1, outboundVideoReport.packetsSent);
          }
        }
     
        let rtt = 0;
        stats.forEach(r => { if (r.type === 'candidate-pair' && r.currentRtt) rtt = r.currentRtt; });
     
        // Dynamic adaptive bitrate & resolution downscaling based on real-time network conditions
        if (lossRatio > 0.15 || rtt > 0.6) {
          // Severe congestion / weak signal: drop to ultra-lightweight recovery mode
          await this.setSenderMaxBitrate(this.config.BITRATE_RECOVERY, 2.0);
        } else if (lossRatio > 0.07 || rtt > 0.35) {
          // Moderate congestion: low bitrate + 1.5x resolution scale down
          await this.setSenderMaxBitrate(this.config.BITRATE_LOW, 1.5);
        } else if (lossRatio > 0.02 || rtt > 0.20) {
          // Slight jitter: medium bitrate
          await this.setSenderMaxBitrate(this.config.BITRATE_MEDIUM, 1.0);
        } else {
          // Clean & fast connection: high quality
          await this.setSenderMaxBitrate(this.config.BITRATE_HIGH, 1.0);
        }
      } catch (e) {
        console.debug('Stats monitor error:', e);
      }
    }, this.config.STATS_POLL_MS);
  }

  stopStatsMonitor() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }
  // =====================================================
  // Candidate Management
  // =====================================================
  bufferRemoteCandidate(candidateObj) {
    this.bufferedRemoteCandidates.push(candidateObj);
  }
  flushBufferedCandidates() {
    while (this.bufferedRemoteCandidates.length && this.state.peerConnection) {
      const c = this.bufferedRemoteCandidates.shift();
      try {
        this.state.peerConnection.addIceCandidate(c).catch(() => {});
      } catch (e) {}
    }
  }
  // =====================================================
  // Report Management
  // =====================================================
  async captureRemoteVideoFrame() {
    return new Promise((resolve, reject) => {
      try {
        const v = this.elements.remoteVideo;
        if (!v || !v.srcObject) {
          return reject(new Error('Remote video not available'));
        }
     
        const width = v.videoWidth || v.clientWidth || 640;
        const height = v.videoHeight || v.clientHeight || 480;
     
        if (width === 0 || height === 0) {
          setTimeout(() => {
            const w2 = v.videoWidth || v.clientWidth || 640;
            const h2 = v.videoHeight || v.clientHeight || 480;
            if (w2 === 0 || h2 === 0) return reject(new Error('Remote video has no frames yet'));
            const canvas2 = document.createElement('canvas');
            canvas2.width = w2;
            canvas2.height = h2;
            const ctx2 = canvas2.getContext('2d');
            ctx2.drawImage(v, 0, 0, w2, h2);
            resolve(canvas2.toDataURL('image/png'));
          }, 250);
          return;
        }
     
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(v, 0, 0, width, height);
        resolve(canvas.toDataURL('image/png'));
      } catch (err) {
        reject(err);
      }
    });
  }
  // =====================================================
  // Setup Event Listeners
  // =====================================================
  setupEventListeners() {
    // Notification menu
    this.elements.notifyBell.onclick = (e) => {
      e.stopPropagation();
      if (this.elements.notifyDot) this.elements.notifyDot.style.display = 'none';
      this.elements.notifyBell.classList.remove('shake');
      this.elements.notifyMenu.style.display = this.elements.notifyMenu.style.display === 'block' ? 'none' : 'block';
    };
 
    document.onclick = () => { this.elements.notifyMenu.style.display = 'none'; };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') this.elements.notifyMenu.style.display = 'none'; });
 
    // Skip button
    const handleSkip = () => {
      if (this.state.isBanned) return;
      this.safeEmit('skip');
      this.disableChat();
      this.cleanupConnection();
      this.clearSafeTimer(this.searchTimer);
      this.clearSafeTimer(this.pauseTimer);
      this.state.consecutiveSearchFails = 0;
      this.startSearchLoop();
    };
    if (this.elements.skipBtn) this.elements.skipBtn.onclick = handleSkip;
    if (this.elements.mobileSkipBtn) this.elements.mobileSkipBtn.onclick = handleSkip;
 
    // Exit button
    this.elements.exitBtn.onclick = () => {
      this.safeEmit('stop');
      this.cleanupConnection();
      if (this.state.localStream) {
        this.state.localStream.getTracks().forEach(t => t.stop());
      }
      location.href = 'index.html';
    };
 
    // Mic button
    this.elements.micBtn.onclick = () => {
      if (!this.state.localStream || this.state.isBanned) return;
      this.state.micEnabled = !this.state.micEnabled;
      this.state.localStream.getAudioTracks().forEach(t => t.enabled = this.state.micEnabled);
      this.updateMicButton();
    };
 
    // Report button
    if (this.elements.reportBtn) {
      this.elements.reportBtn.style.display = 'flex';
      this.elements.reportBtn.onclick = async () => {
        if (!this.state.partnerId) {
          this.updateStatusMessage("No user to report.");
          return;
        }
     
        const prev = this.reportCounts.get(this.state.partnerId) || 0;
        const now = prev + 1;
        this.reportCounts.set(this.state.partnerId, now);
        this.reportedIds.add(this.state.partnerId);
     
        this.safeEmit("report", { partnerId: this.state.partnerId });
        this.safeEmit("skip");
     
        if (now === 1) {
          try {
            this.addMessage("Capturing screenshot for admin review...", "system");
            const image = await this.captureRemoteVideoFrame();
            this.safeEmit("admin-screenshot", { image, partnerId: this.state.partnerId });
            this.addMessage("📋 A report about this user has been sent ✉️⚠️. Action is being reviewed 🔍⏳.", "system");
          } catch (err) {
            console.error('Screenshot capture failed', err);
            this.addMessage("Failed to capture screenshot (no remote frame available).", "system");
          }
        }
     
        this.cleanupConnection();
        this.disableChat();
        this.updateStatusMessage('You reported the user — skipping...');
        this.clearSafeTimer(this.searchTimer);
        this.clearSafeTimer(this.pauseTimer);
        this.state.consecutiveSearchFails = 0;
        this.config.NORMAL_PAUSE_DURATION = 3000;
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
    this.elements.chatMessages.appendChild(this.typingIndicator);
 
    const sendTyping = () => {
      if (!this.state.partnerId || this.state.isBanned) return;
      if (!this.typing) {
        this.typing = true;
        this.safeEmit('typing', { to: this.state.partnerId });
      }
      this.clearSafeTimer(this.typingTimer);
      this.typingTimer = this.setSafeTimer(() => {
        this.typing = false;
        this.safeEmit('stop-typing', { to: this.state.partnerId });
      }, this.config.TYPING_PAUSE);
    };
 
    this.elements.chatInput.oninput = () => {
      if (!this.elements.chatInput.disabled && !this.state.isBanned) sendTyping();
    };
 
    const sendMessage = () => {
      if (this.state.isBanned) return;
      const msg = this.elements.chatInput.value.trim();
      if (!msg || !this.state.partnerId) return;
      this.addMessage(msg, 'you');
      this.safeEmit('chat-message', { to: this.state.partnerId, message: msg });
      this.elements.chatInput.value = '';
      this.typing = false;
      this.safeEmit('stop-typing', { to: this.state.partnerId });
    };
 
    this.elements.sendBtn.onclick = sendMessage;
    this.elements.chatInput.onkeypress = e => { if (e.key === 'Enter' && !this.state.isBanned) sendMessage(); };
  }
  // =====================================================
  // Socket Listeners
  // =====================================================
  setupSocketListeners() {
    this.socket.on('waiting', msg => {
      if (!this.state.isBanned) this.updateStatusMessage(msg);
    });
 
    this.socket.on('chat-message', ({ message }) => {
      if (!this.state.isBanned) this.addMessage(message, 'them');
    });
 
    this.socket.on('typing', () => {
      if (!this.state.isBanned) {
        this.typingIndicator.style.display = 'block';
        this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
      }
    });
 
    this.socket.on('stop-typing', () => {
      if (!this.state.isBanned) this.typingIndicator.style.display = 'none';
    });
 
    this.socket.on('adminMessage', msg => {
      if (this.elements.notifyDot) this.elements.notifyDot.style.display = 'block';
      this.elements.notifyBell.classList.add('shake');
      this.pushAdminNotification('📢 ' + msg);
      this.addMessage('📢 Admin: ' + msg, 'system');
    });
 
    this.socket.on('banned', (data) => {
      this.state.isBanned = true;
      const title = data?.title || 'Account Suspended';
      const message = data?.message || 'You have been banned for violating our terms of service.';
      const offenseCount = data?.offenseCount || 1;
      const banDurationHours = data?.banDurationHours || 24;
      const bannedUntil = data?.bannedUntil;
      const expiryMs = data?.expiryMs;

      this.showBanModal({ title, message, offenseCount, banDurationHours, bannedUntil, expiryMs });
      this.cleanupConnection();
      this.disableChat();
      if (this.state.localStream) {
        this.state.localStream.getTracks().forEach(t => t.stop());
        this.state.localStream = null;
      }
      if (this.elements.localVideo) this.elements.localVideo.srcObject = null;
      this.updateMicButton();
    });
 
    this.socket.on('unbanned', ({ message }) => {
      this.state.isBanned = false;
      this.addMessage(message || 'You have been unbanned.', 'system');
      this.updateStatusMessage('You have been unbanned.');
      this.startSearch();
    });
 
    this.socket.on('partner-disconnected', () => {
      if (!this.state.isBanned) {
        this.updateStatusMessage('Partner disconnected.');
        this.disableChat();
        this.cleanupConnection();
        this.clearSafeTimer(this.searchTimer);
        this.clearSafeTimer(this.pauseTimer);
        this.state.consecutiveSearchFails = 0;
        this.setSafeTimer(() => this.startSearchLoop(), 100);
      }
    });

    this.socket.on('video-ready', ({ from }) => {
      if (this.state.partnerId && from === this.state.partnerId) {
        this.state.partnerVideoReady = true;
        this.hideAllSpinners();
        if (this.state.localVideoReadySent) {
          this.updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');
          this.startStatsMonitor();
        }
      }
    });

    this.socket.on('partner-found', async data => {
      if (this.state.isBanned) {
        this.safeEmit('skip');
        return;
      }

      const foundId = data?.id || data?.partnerId;
      if (!foundId) {
        this.startSearchLoop();
        return;
      }

      if (this.reportedIds.has(foundId)) {
        this.safeEmit('skip');
        this.cleanupConnection();
        this.setSafeTimer(() => this.startSearchLoop(), 100);
        return;
      }

      this.cleanupConnection();
      const currentSession = ++this.sessionToken;

      this.state.partnerId = foundId;
      this.state.isInitiator = !!data.initiator;
      this.state.partnerVideoReady = false;
      this.state.localVideoReadySent = false;

      this.hideAllSpinners();
      this.updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');
      this.enableChat();
      this.state.consecutiveSearchFails = 0;
      this.config.NORMAL_PAUSE_DURATION = 3000;

      try {
        this.createPeerConnection();
        if (this.sessionToken !== currentSession) return;

        if (this.state.isInitiator) {
          this.state.makingOffer = true;
          const offer = await this.state.peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
          });
          if (this.sessionToken !== currentSession || !this.state.peerConnection || this.state.peerConnection.signalingState === 'closed') return;
          await this.state.peerConnection.setLocalDescription(offer);
          if (this.sessionToken !== currentSession) return;
          this.safeEmit('signal', { to: this.state.partnerId, data: offer });
        }
      } catch (e) {
        if (this.sessionToken !== currentSession) return;
        this.cleanupConnection();
        this.startSearchLoop();
      } finally {
        if (this.sessionToken === currentSession) {
          this.state.makingOffer = false;
        }
      }
    });

    this.socket.on('reconnect-request', async ({ from }) => {
      if (this.state.partnerId === from && this.state.isInitiator && !this.state.isBanned) {
        console.log('Received reconnect-request from partner. Triggering ICE restart...');
        this.attemptIceRestart();
      }
    });

    this.socket.on('signal', async ({ from, data }) => {
      if (this.state.isBanned || !from || !data) return;

      if (this.state.partnerId !== from) return;

      const currentSession = this.sessionToken;

      if (!this.state.peerConnection || this.state.peerConnection.signalingState === 'closed') {
        try {
          this.createPeerConnection();
        } catch (e) {
          return;
        }
      }

      if (this.sessionToken !== currentSession || !this.state.peerConnection) return;

      if (data.candidate && !this.state.peerConnection.remoteDescription) {
        this.bufferRemoteCandidate(data.candidate);
        return;
      }

      try {
        if (data.type === 'offer') {
          const offerCollision = (this.state.makingOffer || this.state.peerConnection.signalingState !== 'stable');
          this.state.ignoreOffer = !this.state.isInitiator && offerCollision;
          if (this.state.ignoreOffer) return;

          await this.state.peerConnection.setRemoteDescription(new RTCSessionDescription(data));
          if (this.sessionToken !== currentSession || !this.state.peerConnection || this.state.peerConnection.signalingState === 'closed') return;
          this.flushBufferedCandidates();
          const answer = await this.state.peerConnection.createAnswer();
          if (this.sessionToken !== currentSession || !this.state.peerConnection || this.state.peerConnection.signalingState === 'closed') return;
          await this.state.peerConnection.setLocalDescription(answer);
          if (this.sessionToken !== currentSession) return;
          this.safeEmit('signal', { to: from, data: answer });
        } else if (data.type === 'answer') {
          if (this.state.peerConnection.signalingState === 'have-local-offer') {
            await this.state.peerConnection.setRemoteDescription(new RTCSessionDescription(data));
            if (this.sessionToken !== currentSession || !this.state.peerConnection) return;
            this.flushBufferedCandidates();
          }
        } else if (data.candidate) {
          try {
            if (this.state.peerConnection.remoteDescription && this.state.peerConnection.signalingState !== 'closed') {
              await this.state.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
            }
          } catch (candErr) {
            // Ignored safely
          }
        }
      } catch (e) {
        console.warn('Signaling message handling warning:', e);
        // Do NOT automatically skip partner on minor signaling timing errors
      }
    });

    this.socket.on('partner-lagging', () => {
      this.updateStatusMessage('⚠️ Stranger is experiencing connection issues. Reconnecting automatically, please wait...');
      this.showRemoteSpinnerOnly(true);
      this.disableChat();
    });

    this.socket.on('partner-reconnected', ({ newPartnerId }) => {
      this.state.partnerId = newPartnerId;
      this.updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');
      this.hideAllSpinners();
      this.enableChat();
      this.attemptIceRestart();
    });

    this.socket.on('reclaim-success', ({ partnerId }) => {
      this.state.partnerId = partnerId;
      this.updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');
      this.hideAllSpinners();
      this.enableChat();
      this.attemptIceRestart();
    });

    this.socket.on('reclaim-failed', () => {
      console.warn('Session reclamation failed. Starting new search...');
      this.cleanupConnection();
      this.startSearchLoop();
    });
  }

  async initNSFWJS() {
    try {
      if (window.nsfwjs) {
        this.nsfwModel = await window.nsfwjs.load();
        console.log("NSFWJS AI Model loaded successfully.");
        this.startNSFWLoop();
      }
    } catch (e) {
      console.warn("NSFWJS failed to load:", e);
    }
  }

  startNSFWLoop() {
    setInterval(async () => {
      if (this.state.isBanned) return;
      if (this.nsfwModel && this.elements.localVideo && this.elements.localVideo.readyState === 4) {
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

          // Threshold for NSFW violation
          if (pornOrSexyProb >= 0.75) {
            console.warn("NSFW violation detected (>75%):", pornOrSexyProb, details);
            this.handleNSFWViolation({ probability: pornOrSexyProb, details });
          }
        } catch (err) {
          console.error("Error during NSFW classification:", err);
        }
      }
    }, 3000);
  }

  handleNSFWViolation(details = {}) {
    if (this.state.isBanned) return;
    this.state.isBanned = true;
    this.socket.emit("nsfw-violation", details);
  }

  showBanModal({ title, message, offenseCount = 1, banDurationHours = 24, bannedUntil, expiryMs }) {
    // Remove existing ban modal if any
    const existing = document.getElementById('bannedOverlayModal');
    if (existing) existing.remove();

    const tierBadge = offenseCount === 1 
      ? '<span style="background:rgba(239,68,68,0.2);color:#ef4444;border:1px solid #ef4444;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:700;">First Offense: 24-Hour Ban (24h Ban)</span>'
      : offenseCount === 2
      ? '<span style="background:rgba(245,158,11,0.2);color:#f59e0b;border:1px solid #f59e0b;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:700;">Second Offense: 3-Day Ban (72h Ban)</span>'
      : '<span style="background:rgba(220,38,38,0.3);color:#f87171;border:1px solid #dc2626;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:700;">Repeated Offense: Strict 7-Day Ban</span>';

    const modal = document.createElement('div');
    modal.id = 'bannedOverlayModal';
    modal.style.cssText = `
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(8, 10, 15, 0.95);
      backdrop-filter: blur(12px);
      z-index: 999999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      direction: ltr;
    `;

    const untilText = bannedUntil ? new Date(bannedUntil).toLocaleString('en-US') : 'Soon';

    modal.innerHTML = `
      <div style="background:#161922;border:1px solid #2a3142;border-radius:18px;max-width:520px;width:100%;padding:32px;text-align:center;box-shadow:0 25px 50px -12px rgba(0,0,0,0.8);color:#f1f5f9;">
        <div style="width:64px;height:64px;background:rgba(239,68,68,0.15);border:2px solid #ef4444;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:28px;">
          🚫
        </div>
        
        <div style="margin-bottom:16px;">
          ${tierBadge}
        </div>

        <h2 style="font-size:22px;font-weight:800;color:#fff;margin-bottom:12px;">${title}</h2>
        
        <p style="font-size:15px;color:#94a3b8;line-height:1.7;margin-bottom:24px;text-align:left;">
          ${message}
        </p>

        <div style="background:#0f1219;border:1px solid #1e2536;border-radius:12px;padding:16px;margin-bottom:24px;text-align:left;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:13px;color:#64748b;">
            <span>Ban Duration Applied:</span>
            <strong style="color:#f8fafc;">${banDurationHours} Hours</strong>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#64748b;">
            <span>Ban Expires On:</span>
            <strong style="color:#38bdf8;" dir="ltr">${untilText}</strong>
          </div>
        </div>

        <div style="font-size:13px;color:#64748b;line-height:1.6;margin-bottom:24px;text-align:center;">
          Our automated moderation system works 24/7 to ensure a safe and clean experience for all users.
        </div>

        <a href="index.html" style="display:inline-block;width:100%;padding:14px;background:#3b82f6;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;transition:0.2s;">
          Return to Homepage
        </a>
      </div>
    `;

    document.body.appendChild(modal);
  }
}
// =====================================================
// Initialize application when DOM is loaded
// =====================================================
window.addEventListener('DOMContentLoaded', () => {
  const app = new ChatApp();
  app.setupSocketListeners();
  window.addEventListener('error', (e) => {
    console.error('Global error:', e.error);
    // Log and handle gracefully without tearing down the connection or skipping
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled promise rejection:', e.reason);
    // Log and handle gracefully without tearing down the connection or skipping
  });
  window.onbeforeunload = () => {
    app.safeEmit('stop');
    app.cleanupConnection();
    if (app.state.localStream) {
      app.state.localStream.getTracks().forEach(t => t.stop());
    }
  };
});
