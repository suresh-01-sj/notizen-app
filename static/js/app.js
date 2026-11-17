/**
 * Notizen — Frontend Application Logic
 * Integrates Web Speech Recognition, Web Audio Synthesized Alarms,
 * WebSockets for real-time alerts, and Natural Language Parsing.
 */


// Server API Configuration & Offline Fallback for APK / Web
const IS_APK = window.location.protocol === 'file:' || !window.location.host;
const DEFAULT_SERVER_URL = 'http://127.0.0.1:8000';

function getApiBase() {
    if (!IS_APK) return '';
    let saved = localStorage.getItem('notizen_server_url');
    if (!saved || saved.includes('10.58.182.102')) {
        saved = DEFAULT_SERVER_URL;
        try { localStorage.setItem('notizen_server_url', saved); } catch (e) {}
    }
    return saved;
}

function getLocalMeetings() {
    try {
        const raw = localStorage.getItem('notizen_local_meetings');
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        return [];
    }
}

function saveLocalMeetings(meetings) {
    try {
        localStorage.setItem('notizen_local_meetings', JSON.stringify(meetings));
    } catch (e) {}
}

function clientParseNlp(text) {
    const now = new Date();
    let targetDate = new Date(now);
    let targetTime = '09:00';
    let personName = '';
    let reminder = 15;
    let cleanText = text.trim();

    if (/tomorrow/i.test(cleanText)) {
        targetDate.setDate(targetDate.getDate() + 1);
    } else if (/next week/i.test(cleanText)) {
        targetDate.setDate(targetDate.getDate() + 7);
    }

    const timeMatch = cleanText.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    if (timeMatch) {
        let h = parseInt(timeMatch[1], 10);
        const min = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
        const ampm = timeMatch[3].toLowerCase();
        if (ampm === 'pm' && h < 12) h += 12;
        if (ampm === 'am' && h === 12) h = 0;
        targetTime = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    }

    const personMatch = cleanText.match(/with\s+([A-Za-z]+)/i);
    if (personMatch) personName = personMatch[1];

    const remMatch = cleanText.match(/(\d+)\s*(?:min|minute)s?\s*before/i);
    if (remMatch) reminder = parseInt(remMatch[1], 10);

    const [h, m] = targetTime.split(':').map(Number);
    targetDate.setHours(h, m, 0, 0);

    const year = targetDate.getFullYear();
    const month = String(targetDate.getMonth() + 1).padStart(2, '0');
    const day = String(targetDate.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    let title = cleanText
        .replace(/tomorrow|today|next week/gi, '')
        .replace(/at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi, '')
        .replace(/with\s+[A-Za-z]+/gi, '')
        .replace(/\d+\s*(?:min|minute)s?\s*before/gi, '')
        .trim();

    if (!title || title.length < 2) title = personName ? `Meeting with ${personName}` : 'Meeting';

    return {
        title,
        personName,
        targetDate: dateStr,
        targetTime,
        dateTimeMillis: targetDate.getTime(),
        reminderMinutesBefore: reminder
    };
}

class NotizenApp {
    constructor() {
        this.meetings = [];
        this.currentFilter = 'upcoming'; // upcoming, today, past, all
        this.currentCategory = 'ALL';
        this.searchQuery = '';
        this.currentParsedData = null;
        this.activeAlarmMeeting = null;
        this.alarmCountdownTimer = null;
        this.alarmSecondsLeft = 60;

        // Audio synthesizer
        this.audioCtx = null;
        this.alarmOscillators = [];
        this.isAlarmAudioPlaying = false;

        // Speech recognition
        this.recognition = null;
        this.isRecording = false;

        // WebSocket
        this.ws = null;

        this.init();
    }

    
    async apiFetch(endpoint, options = {}) {
        const base = getApiBase();
        const url = base ? `${base.replace(/\/+$/, '')}${endpoint}` : endpoint;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);
        try {
            const res = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);
            return res;
        } catch (err) {
            clearTimeout(timeoutId);
            throw err;
        }
    }

    checkClientAlarms() {
        if (this.activeAlarmMeeting || !this.meetings) return;
        const now = Date.now();
        for (const m of this.meetings) {
            if (!m.isCompleted && m.dateTimeMillis) {
                const reminderTime = m.dateTimeMillis - ((m.reminderMinutesBefore || 0) * 60 * 1000);
                if (now >= reminderTime && (now - reminderTime) < 60000 && !m._alarmFired) {
                    m._alarmFired = true;
                    this.triggerAlarmUI(m);
                    break;
                }
            }
        }
    }

    async init() {
        this.initElements();
        this.initLiveClock();
        this.initSettings();
        this.initDateInput();
        this.initSpeechRecognition();
        this.initWebSocket();
        this.bindEvents();
        await this.loadMeetings();
        this.checkActiveAlarmOnServer();
    }

    initElements() {
        this.liveClock = document.getElementById('liveClock');
        this.nlpInput = document.getElementById('nlpInput');
        this.quickScheduleBtn = document.getElementById('quickScheduleBtn');
        this.voiceInputBtn = document.getElementById('voiceInputBtn');
        this.nlpPreviewContainer = document.getElementById('nlpPreviewContainer');
        this.chipTitle = document.getElementById('chipTitle');
        this.chipPerson = document.getElementById('chipPerson');
        this.chipDate = document.getElementById('chipDate');
        this.chipTime = document.getElementById('chipTime');
        this.chipReminder = document.getElementById('chipReminder');

        this.meetingsList = document.getElementById('meetingsList');
        this.emptyState = document.getElementById('emptyState');
        this.loadingSpinner = document.getElementById('loadingSpinner');
        this.emptyTitle = document.getElementById('emptyTitle');
        this.emptyDesc = document.getElementById('emptyDesc');

        this.countUpcoming = document.getElementById('countUpcoming');
        this.countToday = document.getElementById('countToday');
        this.countCompleted = document.getElementById('countCompleted');

        this.tabBtns = document.querySelectorAll('.tab-btn');
        this.categoryPills = document.querySelectorAll('.pill');
        this.searchInput = document.getElementById('searchInput');
        this.clearSearchBtn = document.getElementById('clearSearchBtn');

        // Modal elements
        this.openNewMeetingBtn = document.getElementById('openNewMeetingBtn');
        this.meetingModal = document.getElementById('meetingModal');
        this.closeModalBtn = document.getElementById('closeModalBtn');
        this.cancelModalBtn = document.getElementById('cancelModalBtn');
        this.meetingForm = document.getElementById('meetingForm');
        this.modalTitle = document.getElementById('modalTitle');
        this.modalVoiceBtn = document.getElementById('modalVoiceBtn');
        this.modalSmartFillGroup = document.getElementById('modalSmartFillGroup');
        this.voiceAssistantStatus = document.getElementById('voiceAssistantStatus');
        this.voiceQaContainer = document.getElementById('voiceQaContainer');
        this.voiceBotMessage = document.getElementById('voiceBotMessage');
        this.voiceUserBubble = document.getElementById('voiceUserBubble');
        this.voiceUserMessage = document.getElementById('voiceUserMessage');
        this.voiceListeningWave = document.getElementById('voiceListeningWave');
        this.voiceStopBtn = document.getElementById('voiceStopBtn');

        // Voice QA State
        this.isVoiceAssistantActive = false;
        this.voiceBotState = 'IDLE';
        this.voiceNoResponseTimer = null;
        this.isSpeechHandled = false;

        // Form fields
        this.formMeetingId = document.getElementById('formMeetingId');
        this.formTitle = document.getElementById('formTitle');
        this.formPerson = document.getElementById('formPerson');
        this.formDate = document.getElementById('formDate');
        this.formDateDisplay = document.getElementById('formDateDisplay');
        this.formTime = document.getElementById('formTime');
        this.formReminder = document.getElementById('formReminder');
        this.formCategory = document.getElementById('formCategory');
        this.formAlarmAudio = document.getElementById('formAlarmAudio');
        this.previewToneBtn = document.getElementById('previewToneBtn');
        this.previewToneText = document.getElementById('previewToneText');
        this.formNotes = document.getElementById('formNotes');

        // Alarm Overlay elements
        this.alarmOverlay = document.getElementById('alarmOverlay');
        this.alarmTitle = document.getElementById('alarmTitle');
        this.alarmPersonName = document.getElementById('alarmPersonName');
        this.alarmPersonBadge = document.getElementById('alarmPersonBadge');
        this.alarmTimeDetails = document.getElementById('alarmTimeDetails');
        this.alarmTonePill = document.getElementById('alarmTonePill');
        this.alarmToneName = document.getElementById('alarmToneName');
        this.alarmCountdownBar = document.getElementById('alarmCountdownBar');
        this.alarmCountdownText = document.getElementById('alarmCountdownText');
        this.alarmDismissBtn = document.getElementById('alarmDismissBtn');
        this.alarmSnoozeBtn = document.getElementById('alarmSnoozeBtn');

        // Preview state
        this.isPreviewPlaying = false;
        this.previewInterval = null;
        this.previewTimeout = null;
        this.previewAudioCtx = null;
        this.currentTonePlaying = 'Default alarm sound';

        // Settings Elements
        this.settingsBtn = document.getElementById('settingsBtn');
        this.settingsMenu = document.getElementById('settingsMenu');
        this.themeSelect = document.getElementById('themeSelect');
        this.notificationSelect = document.getElementById('notificationSelect');
        this.notifStatusDesc = document.getElementById('notifStatusDesc');

        this.enableNotificationBtn = document.getElementById('enableNotificationBtn');
        this.notifBtnText = document.getElementById('notifBtnText');
        this.toastContainer = document.getElementById('toastContainer');
    }

    initSettings() {
        // 1. Theme initialization
        const savedTheme = localStorage.getItem('notizen_theme') || localStorage.getItem('meetmate_theme') || 'dark';
        if (this.themeSelect) {
            this.themeSelect.value = savedTheme;
            this.applyTheme(savedTheme);
            this.themeSelect.addEventListener('change', (e) => {
                const newTheme = e.target.value;
                this.applyTheme(newTheme);
                localStorage.setItem('notizen_theme', newTheme);
                const themeName = this.themeSelect.options[this.themeSelect.selectedIndex].text;
                this.showToast(`Theme updated to ${themeName}`, 'info');
            });
        }

        // 2. Notification initialization
        const savedNotif = localStorage.getItem('notizen_notifications') || localStorage.getItem('meetmate_notifications') || 'on';
        if (this.notificationSelect) {
            this.notificationSelect.value = savedNotif;
            this.updateNotificationDesc(savedNotif);

            this.notificationSelect.addEventListener('change', async (e) => {
                const val = e.target.value;
                localStorage.setItem('notizen_notifications', val);
                if (val === 'on') {
                    await this.requestNotificationPermission();
                    this.updateNotificationDesc('on');
                    this.showToast('🔔 Notifications enabled', 'success');
                } else {
                    this.updateNotificationDesc('off');
                    this.showToast('🔕 Notifications muted', 'info');
                }
            });
        }

        // 3. Dropdown toggle and outside click
        if (this.settingsBtn && this.settingsMenu) {
            this.settingsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = this.settingsMenu.style.display !== 'none';
                this.settingsMenu.style.display = isOpen ? 'none' : 'flex';
                this.settingsBtn.classList.toggle('active', !isOpen);
            });

            this.settingsMenu.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            document.addEventListener('click', () => {
                if (this.settingsMenu.style.display !== 'none') {
                    this.settingsMenu.style.display = 'none';
                    this.settingsBtn.classList.remove('active');
                }
            });
        }
    }

    initDateInput() {
        this.formDate = document.getElementById('formDate');
        this.formDateDisplay = document.getElementById('formDateDisplay');
        const openDatePickerBtn = document.getElementById('openDatePickerBtn');

        if (!this.formDate || !this.formDateDisplay) return;

        // Formats YYYY-MM-DD -> DD/MM/YYYY for the user display
        this.syncDateDisplayFromIso = () => {
            const iso = this.formDate ? this.formDate.value : '';
            if (iso && iso.includes('-')) {
                const parts = iso.split('-');
                if (parts.length === 3) {
                    this.formDateDisplay.value = `${parts[2]}/${parts[1]}/${parts[0]}`;
                    return;
                }
            }
            this.formDateDisplay.value = '';
        };

        // Formats DD/MM/YYYY typed text -> YYYY-MM-DD for native date input
        this.syncDateIsoFromDisplay = () => {
            const text = this.formDateDisplay.value.trim();
            const parts = text.split(/[\/\-\.]/);
            if (parts.length === 3) {
                const d = parts[0].padStart(2, '0');
                const m = parts[1].padStart(2, '0');
                let y = parts[2];
                if (y.length === 2) y = '20' + y;
                if (d.length === 2 && m.length === 2 && y.length === 4) {
                    const day = parseInt(d, 10);
                    const month = parseInt(m, 10);
                    const year = parseInt(y, 10);
                    if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 1970 && year <= 2100) {
                        if (this.formDate) this.formDate.value = `${y}-${m}-${d}`;
                    }
                }
            }
        };

        // Two-way synchronization on picker events
        this.formDate.addEventListener('input', () => this.syncDateDisplayFromIso());
        this.formDate.addEventListener('change', () => this.syncDateDisplayFromIso());

        // Intercept programmatic value changes on this.formDate.value
        try {
            const origDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            const self = this;
            Object.defineProperty(this.formDate, 'value', {
                get() {
                    return origDescriptor.get.call(this);
                },
                set(newVal) {
                    origDescriptor.set.call(this, newVal);
                    self.syncDateDisplayFromIso();
                }
            });
        } catch (e) {
            console.warn('Property descriptor interception not supported', e);
        }

        const triggerPicker = () => {
            try {
                if (typeof this.formDate.showPicker === 'function') {
                    this.formDate.showPicker();
                    return;
                }
            } catch (e) {}
            this.formDate.focus();
        };

        if (openDatePickerBtn) {
            openDatePickerBtn.addEventListener('click', (e) => {
                e.preventDefault();
                triggerPicker();
            });
        }

        // On mobile / touch devices, tapping the display input opens the native date picker
        const isMobileOrTouch = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
            (window.innerWidth <= 768 && 'ontouchstart' in window);
        if (isMobileOrTouch) {
            this.formDateDisplay.addEventListener('click', (e) => {
                e.preventDefault();
                triggerPicker();
            });
            this.formDateDisplay.setAttribute('readonly', 'true');
        }

        // On desktop, auto-insert slashes as the user types digits
        this.formDateDisplay.addEventListener('input', (e) => {
            if (isMobileOrTouch) return;
            let val = e.target.value.replace(/[^\d]/g, '');
            if (val.length > 8) val = val.slice(0, 8);
            if (val.length > 4) {
                val = val.slice(0, 2) + '/' + val.slice(2, 4) + '/' + val.slice(4);
            } else if (val.length > 2) {
                val = val.slice(0, 2) + '/' + val.slice(2);
            }
            e.target.value = val;
            this.syncDateIsoFromDisplay();
        });

        this.formDateDisplay.addEventListener('blur', () => {
            this.syncDateIsoFromDisplay();
            if (this.formDate && this.formDate.value) {
                this.syncDateDisplayFromIso();
            }
        });
    }

    applyTheme(theme) {
        document.body.classList.remove('light-theme', 'midnight-theme');
        if (theme === 'light') {
            document.body.classList.add('light-theme');
        } else if (theme === 'midnight') {
            document.body.classList.add('midnight-theme');
        }
    }

    updateNotificationDesc(status) {
        if (!this.notifStatusDesc) return;
        if (status === 'off') {
            this.notifStatusDesc.textContent = 'Muted / Disabled';
        } else {
            if ('Notification' in window && Notification.permission === 'granted') {
                this.notifStatusDesc.textContent = 'Active on this device';
            } else {
                this.notifStatusDesc.textContent = 'Alerts & alarms';
            }
        }
    }

    initLiveClock() {
        const updateClock = () => {
            const now = new Date();
            if (this.liveClock) {
                this.liveClock.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
            }
            this.checkClientAlarms();
        };
        updateClock();
        setInterval(updateClock, 1000);
    }

    initWebSocket() {
        let wsUrl;
        if (window.location.protocol === 'file:' || !window.location.host) {
            const base = getApiBase();
            try {
                const u = new URL(base);
                const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:';
                wsUrl = `${wsProto}//${u.host}/ws`;
            } catch (e) {
                wsUrl = 'ws://127.0.0.1:8000/ws';
            }
        } else {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            wsUrl = `${protocol}//${window.location.host}/ws`;
        }

        const connect = () => {
            try {
                this.ws = new WebSocket(wsUrl);

                this.ws.onopen = () => {
                    console.log('Notizen WebSocket connected to ' + wsUrl);
                };

                this.ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        this.handleWebSocketMessage(data);
                    } catch (e) {
                        console.error('Error parsing WS message', e);
                    }
                };

                this.ws.onclose = () => {
                    setTimeout(connect, 5000);
                };

                this.ws.onerror = (err) => {
                    // Handled silently
                };
            } catch (err) {
                console.warn('WebSocket init bypassed in offline/local mode:', err);
            }
        };

        try {
            connect();
        } catch (e) {}
    }

    handleWebSocketMessage(data) {
        if (data.event === 'ALARM_TRIGGERED') {
            console.log('Alarm Triggered event received:', data.meeting);
            this.triggerAlarmUI(data.meeting);
        } else if (data.event === 'ALARM_DISMISSED') {
            if (this.activeAlarmMeeting && this.activeAlarmMeeting.id === data.id) {
                this.dismissAlarmUI(false);
            }
        } else if (data.event === 'MEETINGS_UPDATED') {
            this.loadMeetings(false);
        }
    }

    initSpeechRecognition() {
        /*
        const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRec) {
            if (this.voiceInputBtn) this.voiceInputBtn.title = 'Speech recognition not supported in this browser';
            if (this.modalVoiceBtn) this.modalVoiceBtn.title = 'Speech recognition not supported in this browser';
            return;
        }

        this.recognition = new SpeechRec();
        this.recognition.continuous = false;
        this.recognition.interimResults = true;
        this.recognition.lang = 'en-US';

        this.recognition.onstart = () => {
            this.isRecording = true;
            if (this.voiceInputBtn) this.voiceInputBtn.classList.add('recording');
            if (this.modalVoiceBtn) this.modalVoiceBtn.classList.add('recording');
            if (this.voiceListeningWave) this.voiceListeningWave.style.display = 'flex';
            if (this.voiceAssistantStatus && this.isVoiceAssistantActive) {
                this.voiceAssistantStatus.textContent = 'Listening to you...';
            }
        };

        this.recognition.onresult = (event) => {
            let transcript = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                transcript += event.results[i][0].transcript;
            }

            if (this.meetingModal && this.meetingModal.style.display !== 'none' && this.isVoiceAssistantActive) {
                if (this.voiceUserBubble) this.voiceUserBubble.style.display = 'flex';
                if (this.voiceUserMessage) this.voiceUserMessage.textContent = transcript;

                if (event.results[event.results.length - 1].isFinal) {
                    this.isSpeechHandled = true;
                    this.handleVoiceQaInput(transcript);
                }
            } else if (this.nlpInput) {
                this.nlpInput.value = transcript;
                this.handleNlpInputDebounced();
            }
        };

        this.recognition.onerror = (event) => {
            console.warn('Speech error:', event.error);
            this.isRecording = false;
            if (this.voiceInputBtn) this.voiceInputBtn.classList.remove('recording');
            if (this.modalVoiceBtn) this.modalVoiceBtn.classList.remove('recording');
            if (this.voiceListeningWave) this.voiceListeningWave.style.display = 'none';

            if (event.error === 'no-speech' && this.isVoiceAssistantActive) {
                this.handleVoiceNoResponse();
            } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
                this.showToast(`Voice input: ${event.error}`, 'error');
            }
        };

        this.recognition.onend = () => {
            this.isRecording = false;
            if (this.voiceInputBtn) this.voiceInputBtn.classList.remove('recording');
            if (this.modalVoiceBtn) this.modalVoiceBtn.classList.remove('recording');
            if (this.voiceListeningWave) this.voiceListeningWave.style.display = 'none';

            if (this.isVoiceAssistantActive && !this.isSpeechHandled) {
                const pending = this.voiceUserMessage ? this.voiceUserMessage.textContent.trim() : '';
                if (pending && pending !== '...') {
                    this.isSpeechHandled = true;
                    this.handleVoiceQaInput(pending);
                } else {
                    this.handleVoiceNoResponse();
                }
            }
        };
        */
    }

    // =========================================================================
    // Voice QA Scheduling Chatbot
    // =========================================================================

    toggleVoiceAssistant() {
        if (!this.recognition) {
            this.showToast('Speech recognition not supported in this browser. Please use Chrome/Edge.', 'error');
            return;
        }

        if (this.isVoiceAssistantActive) {
            this.stopVoiceAssistant();
            this.showToast('Voice assistant paused', 'info');
        } else {
            this.startVoiceAssistant();
        }
    }

    startVoiceAssistant() {
        this.isVoiceAssistantActive = true;
        this.voiceBotState = 'ASK_DETAILS';
        this.isSpeechHandled = false;

        if (this.modalVoiceBtn) {
            this.modalVoiceBtn.classList.add('active');
        }
        if (this.voiceQaContainer) {
            this.voiceQaContainer.style.display = 'flex';
        }
        if (this.voiceUserBubble) {
            this.voiceUserBubble.style.display = 'none';
        }

        // As user requested:
        // "when user click on voice icon it pass messgae what is meeting title , date , person"
        this.speakAndListen(
            "What is the meeting title, date, and person?",
            'ASK_DETAILS',
            7500
        );
    }

    stopVoiceAssistant() {
        this.isVoiceAssistantActive = false;
        this.voiceBotState = 'IDLE';
        this.clearVoiceTimer();

        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
        }

        if (this.recognition && this.isRecording) {
            try { this.recognition.stop(); } catch (e) {}
        }

        if (this.modalVoiceBtn) {
            this.modalVoiceBtn.classList.remove('active', 'recording');
        }
        if (this.voiceListeningWave) {
            this.voiceListeningWave.style.display = 'none';
        }
        if (this.voiceAssistantStatus) {
            this.voiceAssistantStatus.textContent = 'Tap the mic to schedule by voice';
        }
    }

    clearVoiceTimer() {
        if (this.voiceNoResponseTimer) {
            clearTimeout(this.voiceNoResponseTimer);
            this.voiceNoResponseTimer = null;
        }
    }

    speakAndListen(botText, nextState, noResponseDelay = 8000) {
        if (!this.isVoiceAssistantActive) return;
        this.clearVoiceTimer();
        this.isSpeechHandled = false;

        if (this.voiceBotMessage) {
            this.voiceBotMessage.textContent = botText;
        }
        if (this.voiceListeningWave) {
            this.voiceListeningWave.style.display = 'none';
        }
        if (this.voiceAssistantStatus) {
            this.voiceAssistantStatus.textContent = 'Assistant speaking...';
        }

        // Stop microphone while bot speaks to prevent echo
        if (this.recognition && this.isRecording) {
            try { this.recognition.stop(); } catch (e) {}
        }

        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(botText);
            utterance.rate = 1.0;
            utterance.pitch = 1.0;
            utterance.lang = 'en-US';

            utterance.onend = () => {
                if (!this.isVoiceAssistantActive) return;
                this.listenForUserAnswer(nextState, noResponseDelay);
            };

            utterance.onerror = () => {
                if (!this.isVoiceAssistantActive) return;
                this.listenForUserAnswer(nextState, noResponseDelay);
            };

            window.speechSynthesis.speak(utterance);
        } else {
            this.listenForUserAnswer(nextState, noResponseDelay);
        }
    }

    speakAndEnd(botText) {
        this.clearVoiceTimer();
        if (this.voiceBotMessage) {
            this.voiceBotMessage.textContent = botText;
        }
        if (this.voiceListeningWave) {
            this.voiceListeningWave.style.display = 'none';
        }
        if (this.voiceAssistantStatus) {
            this.voiceAssistantStatus.textContent = botText;
        }

        if (this.recognition && this.isRecording) {
            try { this.recognition.stop(); } catch (e) {}
        }

        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(botText);
            utterance.rate = 1.0;
            utterance.lang = 'en-US';
            window.speechSynthesis.speak(utterance);
        }
        this.stopVoiceAssistant();
    }

    listenForUserAnswer(nextState, noResponseDelay) {
        this.voiceBotState = nextState;
        this.isSpeechHandled = false;

        if (this.voiceListeningWave) {
            this.voiceListeningWave.style.display = 'flex';
        }
        if (this.voiceAssistantStatus) {
            this.voiceAssistantStatus.textContent = 'Listening... Speak now';
        }

        if (this.recognition) {
            try {
                this.recognition.start();
            } catch (e) {}
        }

        this.clearVoiceTimer();
        this.voiceNoResponseTimer = setTimeout(() => {
            this.handleVoiceNoResponse();
        }, noResponseDelay);
    }

    handleVoiceNoResponse() {
        if (!this.isVoiceAssistantActive) return;
        this.clearVoiceTimer();

        // If user already was asked to cancel and didn't respond, pause
        if (this.voiceBotState === 'ASK_CANCEL_CONFIRMATION') {
            this.stopVoiceAssistant();
            if (this.voiceAssistantStatus) {
                this.voiceAssistantStatus.textContent = 'Voice assistant paused. Tap mic to restart.';
            }
            this.showToast('Voice assistant paused due to inactivity', 'info');
            return;
        }

        // As user requested:
        // "if user not response then ask if you cacle this meeting then tell me if they said yes then cancle if say no shedule this"
        this.speakAndListen(
            "Do you want to cancel this meeting? Say yes to cancel, or no to schedule.",
            'ASK_CANCEL_CONFIRMATION',
            8000
        );
    }

    async handleVoiceQaInput(rawTranscript) {
        this.clearVoiceTimer();
        const text = rawTranscript.trim();
        if (!text) return;

        if (this.voiceUserBubble) {
            this.voiceUserBubble.style.display = 'flex';
        }
        if (this.voiceUserMessage) {
            this.voiceUserMessage.textContent = text;
        }

        const lower = text.toLowerCase();

        // 1. Handling Cancel Confirmation State:
        // "if user not response then ask if you cacle this meeting then tell me if they said yes then cancle if say no shedule this"
        if (this.voiceBotState === 'ASK_CANCEL_CONFIRMATION') {
            const isYes = /\b(yes|cancel|close|stop|discard|yeah|yep|haan|ha)\b/i.test(lower);
            const isNo = /\b(no|don'?t|schedule|shedule|keep|save|confirm|nahi|nah|nope)\b/i.test(lower);

            if (isYes) {
                this.speakAndEnd("Meeting cancelled.");
                setTimeout(() => {
                    this.closeModal();
                }, 1000);
                return;
            } else if (isNo) {
                // If user said "no", user wants to schedule this meeting!
                if (!this.formTitle.value.trim()) {
                    this.formTitle.value = "New Meeting";
                }
                if (!this.formDate.value) {
                    const tomorrow = new Date();
                    tomorrow.setDate(tomorrow.getDate() + 1);
                    this.formDate.value = tomorrow.toISOString().split('T')[0];
                }
                if (!this.formTime.value) {
                    this.formTime.value = "10:00";
                }
                this.speakAndEnd("Okay, scheduling your meeting now.");
                setTimeout(() => {
                    this.handleFormSubmit();
                }, 1000);
                return;
            } else {
                this.speakAndListen("Please say yes to cancel, or no to schedule this meeting.", 'ASK_CANCEL_CONFIRMATION', 7000);
                return;
            }
        }

        // 2. Handling Schedule Confirmation State
        if (this.voiceBotState === 'CONFIRM_SCHEDULE') {
            const isConfirm = /\b(yes|sure|schedule|shedule|ok|okay|save|confirm|yeah|yep|haan)\b/i.test(lower);
            const isCancel = /\b(no|cancel|stop|close|discard)\b/i.test(lower);

            if (isConfirm) {
                this.speakAndEnd("Scheduling your meeting now.");
                setTimeout(() => {
                    this.handleFormSubmit();
                }, 1000);
                return;
            } else if (isCancel) {
                this.speakAndEnd("Meeting cancelled.");
                setTimeout(() => {
                    this.closeModal();
                }, 1000);
                return;
            }
        }

        // 3. Process utterance through NLP server endpoint for structured extraction
        let parsed = null;
        try {
            const res = await this.apiFetch('/api/parse', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
            if (res.ok) {
                parsed = await res.json();
            }
        } catch (e) {
            console.warn('NLP check error', e);
        }

        // 4. Update form fields based on parsed or extracted data
        if (parsed) {
            if (parsed.title && parsed.title.toLowerCase() !== 'meeting') {
                this.formTitle.value = parsed.title;
            }
            if (parsed.personName) {
                this.formPerson.value = parsed.personName;
            }
            if (parsed.targetDate) {
                this.formDate.value = parsed.targetDate;
            }
            if (parsed.targetTime) {
                this.formTime.value = parsed.targetTime;
            }
            if (parsed.reminderMinutesBefore !== undefined) {
                this.formReminder.value = String(parsed.reminderMinutesBefore);
            }
        }

        // If title still empty after NLP, try basic cleanup
        if (!this.formTitle.value.trim()) {
            const clean = text
                .replace(/^meeting\s+(title\s+)?(is\s+)?/i, '')
                .replace(/\b(tomorrow|today|yesterday|at\s+\d+|on\s+\w+day)\b/gi, '')
                .trim();
            if (clean && !clean.toLowerCase().startsWith('with ')) {
                this.formTitle.value = clean.charAt(0).toUpperCase() + clean.slice(1);
            } else if (clean && clean.toLowerCase().startsWith('with ')) {
                const personPart = clean.replace(/^with\s+/i, '').trim();
                if (personPart) this.formPerson.value = personPart;
            }
        }

        // 5. Intelligent Multi-turn Dialogue Progression
        const hasTitle = Boolean(this.formTitle.value.trim());
        const hasPerson = Boolean(this.formPerson.value.trim());
        const hasDateTime = Boolean(this.formDate.value && this.formTime.value);

        if (hasTitle && (hasDateTime || parsed?.hasDateMention)) {
            const timeStr = this.formTime.value ? this.formatTime12Hour(this.formTime.value) : '10:00 AM';
            const personStr = this.formPerson.value ? ` with ${this.formPerson.value}` : '';
            this.speakAndListen(
                `All set for "${this.formTitle.value}"${personStr} on ${this.formatDateDisplay(this.formDate.value)} at ${timeStr}. Should I schedule it now?`,
                'CONFIRM_SCHEDULE',
                8000
            );
        } else if (!hasTitle) {
            this.speakAndListen("What is the meeting title?", 'ASK_DETAILS', 7500);
        } else if (!hasPerson) {
            this.speakAndListen(`Got it, "${this.formTitle.value}". Who is this meeting with, and what date or time?`, 'ASK_DETAILS', 7500);
        } else {
            this.speakAndListen(`What date and time should I schedule "${this.formTitle.value}" for?`, 'ASK_DETAILS', 7500);
        }
    }

    bindEvents() {
        // Voice Assistant mic & stop buttons
        if (this.modalVoiceBtn) {
            this.modalVoiceBtn.addEventListener('click', () => this.toggleVoiceAssistant());
        }
        if (this.voiceStopBtn) {
            this.voiceStopBtn.addEventListener('click', () => this.stopVoiceAssistant());
        }
        if (this.voiceInputBtn) {
            this.voiceInputBtn.addEventListener('click', () => this.toggleVoiceAssistant());
        }

        // NLP input events
        let debounceTimer = null;
        this.handleNlpInputDebounced = () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => this.parseCurrentInput(), 250);
        };

        if (this.nlpInput) {
            this.nlpInput.addEventListener('input', this.handleNlpInputDebounced);
            this.nlpInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.scheduleFromNlp();
                }
            });
        }

        if (this.quickScheduleBtn) {
            this.quickScheduleBtn.addEventListener('click', () => this.scheduleFromNlp());
        }

        // Navigation Tabs
        this.tabBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.tabBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.currentFilter = btn.dataset.tab;
                this.loadMeetings();
            });
        });

        // Category Pills
        this.categoryPills.forEach(pill => {
            pill.addEventListener('click', () => {
                this.categoryPills.forEach(p => p.classList.remove('active'));
                pill.classList.add('active');
                this.currentCategory = pill.dataset.category;
                this.renderMeetings();
            });
        });

        // Search Input
        this.searchInput.addEventListener('input', (e) => {
            this.searchQuery = e.target.value.trim().toLowerCase();
            this.clearSearchBtn.style.display = this.searchQuery ? 'block' : 'none';
            this.renderMeetings();
        });

        this.clearSearchBtn.addEventListener('click', () => {
            this.searchInput.value = '';
            this.searchQuery = '';
            this.clearSearchBtn.style.display = 'none';
            this.renderMeetings();
        });

        // Modal Open / Close
        this.openNewMeetingBtn.addEventListener('click', () => this.openAddModal());
        this.closeModalBtn.addEventListener('click', () => this.closeModal());
        this.cancelModalBtn.addEventListener('click', () => this.closeModal());

        this.meetingModal.addEventListener('click', (e) => {
            if (e.target === this.meetingModal) this.closeModal();
        });

        // Close on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (this.meetingModal.style.display !== 'none') {
                    this.closeModal();
                }
            }
        });

        // Modal form submission
        this.meetingForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleFormSubmit();
        });

        // Play tone sound automatically when user selects/changes an alarm sound in dropdown
        if (this.formAlarmAudio) {
            this.formAlarmAudio.addEventListener('change', () => {
                this.playTonePreview(this.formAlarmAudio.value);
            });
            this.formAlarmAudio.addEventListener('input', () => {
                this.playTonePreview(this.formAlarmAudio.value);
            });
        }

        // Alarm overlay actions
        this.alarmDismissBtn.addEventListener('click', () => this.dismissActiveAlarm());
        this.alarmSnoozeBtn.addEventListener('click', () => this.snoozeActiveAlarm());

        // Notification permission request
        if (this.enableNotificationBtn) {
            this.enableNotificationBtn.addEventListener('click', () => this.requestNotificationPermission());
        }

        // Stats cards click filter
        document.querySelectorAll('.stat-card').forEach(card => {
            card.addEventListener('click', () => {
                const filter = card.dataset.filter;
                const matchingTab = document.querySelector(`.tab-btn[data-tab="${filter}"]`);
                if (matchingTab) matchingTab.click();
            });
        });
    }

    async parseCurrentInput() {
        const text = this.nlpInput.value.trim();
        if (!text) {
            if (this.nlpPreviewContainer) this.nlpPreviewContainer.style.display = 'none';
            this.currentParsedData = null;
            return;
        }

        let data = null;
        try {
            const res = await this.apiFetch('/api/parse', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
            if (res.ok) data = await res.json();
        } catch (err) {
            // Client-side regex parser fallback
            data = clientParseNlp(text);
        }

        if (!data) data = clientParseNlp(text);
        this.currentParsedData = data;

        if (this.chipTitle) this.chipTitle.querySelector('strong').textContent = data.title || 'Meeting';
        if (this.chipPerson) this.chipPerson.querySelector('strong').textContent = data.personName || 'None';
        if (this.chipDate) this.chipDate.querySelector('strong').textContent = this.formatDateDisplay(data.targetDate);
        if (this.chipTime) this.chipTime.querySelector('strong').textContent = this.formatTime12Hour(data.targetTime);
        if (this.chipReminder) this.chipReminder.querySelector('strong').textContent = `${data.reminderMinutesBefore}m before`;

        if (this.nlpPreviewContainer) this.nlpPreviewContainer.style.display = 'block';
    }

    async scheduleFromNlp() {
        const text = this.nlpInput.value.trim();
        if (!text) {
            this.showToast('Please enter a phrase or click "New Meeting"', 'info');
            return;
        }

        let parsed = this.currentParsedData;
        if (!parsed) {
            await this.parseCurrentInput();
            parsed = this.currentParsedData;
        }

        if (!parsed) {
            this.showToast('Unable to parse meeting sentence.', 'error');
            return;
        }

        const payload = {
            title: parsed.title,
            personName: parsed.personName,
            dateTimeMillis: parsed.dateTimeMillis,
            reminderMinutesBefore: parsed.reminderMinutesBefore,
            category: 'General',
            notes: ''
        };

        try {
            const res = await this.apiFetch('/api/meetings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) throw new Error('Failed to create meeting');

            const result = await res.json();
            this.showToast(`Scheduled: "${payload.title}" for ${this.formatDateDisplay(parsed.targetDate)} at ${this.formatTime12Hour(parsed.targetTime)}`, 'success');

            this.nlpInput.value = '';
            this.nlpPreviewContainer.style.display = 'none';
            this.currentParsedData = null;

            await this.loadMeetings();
        } catch (err) {
            // Local offline fallback
            const local = getLocalMeetings();
            payload.id = 'local_' + Date.now();
            payload.isCompleted = false;
            local.unshift(payload);
            saveLocalMeetings(local);
            this.showToast(`Scheduled (offline): "${payload.title}"`, 'success');

            this.nlpInput.value = '';
            this.nlpPreviewContainer.style.display = 'none';
            this.currentParsedData = null;

            await this.loadMeetings();
        }
    }

    async loadMeetings(showSpinner = true) {
        if (showSpinner && this.loadingSpinner) {
            this.loadingSpinner.style.display = 'flex';
            if (this.meetingsList) this.meetingsList.style.display = 'none';
            if (this.emptyState) this.emptyState.style.display = 'none';
        }

        let loaded = false;
        try {
            const res = await this.apiFetch(`/api/meetings?filter=${this.currentFilter}`);
            if (res.ok) {
                const data = await res.json();
                this.meetings = data.meetings || [];
                const local = getLocalMeetings();
                const map = new Map(local.map(m => [String(m.id), m]));
                for (const m of this.meetings) {
                    map.set(String(m.id), m);
                }
                saveLocalMeetings(Array.from(map.values()));
                loaded = true;
            }
        } catch (err) {
            console.warn('Backend server not reachable; loading local offline meetings.', err);
        }

        if (!loaded) {
            const allLocal = getLocalMeetings();
            const now = Date.now();
            const startOfToday = new Date();
            startOfToday.setHours(0, 0, 0, 0);
            const endOfToday = new Date();
            endOfToday.setHours(23, 59, 59, 999);

            if (this.currentFilter === 'today') {
                this.meetings = allLocal.filter(m => m.dateTimeMillis >= startOfToday.getTime() && m.dateTimeMillis <= endOfToday.getTime());
            } else if (this.currentFilter === 'completed') {
                this.meetings = allLocal.filter(m => m.isCompleted);
            } else if (this.currentFilter === 'past') {
                this.meetings = allLocal.filter(m => m.dateTimeMillis < startOfToday.getTime());
            } else if (this.currentFilter === 'all') {
                this.meetings = allLocal;
            } else {
                this.meetings = allLocal.filter(m => !m.isCompleted && m.dateTimeMillis >= now - 3600000);
            }
        }

        this.updateStats();
        this.renderMeetings();
        if (this.loadingSpinner) this.loadingSpinner.style.display = 'none';
    }

    updateStats() {
        const now = Date.now();
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const endOfToday = new Date();
        endOfToday.setHours(23, 59, 59, 999);

        const applyCounts = (all) => {
            const upcomingCount = all.filter(m => !m.isCompleted && m.dateTimeMillis >= now - 3600000).length;
            const todayCount = all.filter(m => m.dateTimeMillis >= startOfToday.getTime() && m.dateTimeMillis <= endOfToday.getTime()).length;
            const completedCount = all.filter(m => m.isCompleted).length;

            if (this.countUpcoming) this.countUpcoming.textContent = upcomingCount;
            if (this.countToday) this.countToday.textContent = todayCount;
            if (this.countCompleted) this.countCompleted.textContent = completedCount;
        };

        this.apiFetch('/api/meetings?filter=all')
            .then(r => r.json())
            .then(data => {
                const all = data.meetings || [];
                saveLocalMeetings(all);
                applyCounts(all);
            })
            .catch(() => {
                applyCounts(getLocalMeetings());
            });
    }

    renderMeetings() {
        let filtered = this.meetings;

        // Apply category filter
        if (this.currentCategory && this.currentCategory.toUpperCase() !== 'ALL') {
            filtered = filtered.filter(m => {
                const cat = (m.category || 'General').trim().toLowerCase();
                return cat === this.currentCategory.trim().toLowerCase();
            });
        }

        // Apply search query
        if (this.searchQuery) {
            filtered = filtered.filter(m => {
                const title = (m.title || '').toLowerCase();
                const person = (m.personName || '').toLowerCase();
                const notes = (m.notes || '').toLowerCase();
                const category = (m.category || '').toLowerCase();
                return title.includes(this.searchQuery) ||
                    person.includes(this.searchQuery) ||
                    notes.includes(this.searchQuery) ||
                    category.includes(this.searchQuery);
            });
        }

        if (filtered.length === 0) {
            this.meetingsList.innerHTML = '';
            this.meetingsList.style.display = 'none';
            this.emptyState.style.display = 'block';

            if (this.searchQuery) {
                this.emptyTitle.textContent = 'No Matches Found';
                this.emptyDesc.textContent = `No meetings match "${this.searchQuery}". Try a different keyword.`;
            } else if (this.currentCategory && this.currentCategory.toUpperCase() !== 'ALL') {
                this.emptyTitle.textContent = `No ${this.currentCategory} Meetings`;
                this.emptyDesc.textContent = `No meetings found in "${this.currentCategory}" category for this tab.`;
            } else if (this.currentFilter === 'today') {
                this.emptyTitle.textContent = 'No Meetings Today';
                this.emptyDesc.textContent = 'Your schedule is clear for today! Tap the + button to add one.';
            } else if (this.currentFilter === 'past' || this.currentFilter === 'completed') {
                this.emptyTitle.textContent = 'No Completed Meetings';
                this.emptyDesc.textContent = 'Completed meetings will appear here.';
            } else {
                this.emptyTitle.textContent = 'No Upcoming Meetings';
                this.emptyDesc.textContent = 'Speak and type on + button to schedule a meeting.';
            }
            return;
        }

        this.emptyState.style.display = 'none';
        this.meetingsList.style.display = 'flex';
        this.meetingsList.innerHTML = '';

        filtered.forEach(meeting => {
            const card = this.createMeetingCardElement(meeting);
            this.meetingsList.appendChild(card);
        });
    }

    createMeetingCardElement(meeting) {
        const card = document.createElement('div');
        card.className = `meeting-card ${meeting.isCompleted ? 'completed' : ''}`;
        card.dataset.id = meeting.id;
        card.dataset.cat = meeting.category || 'General';

        const dt = new Date(meeting.dateTimeMillis);
        const timeFormatted = dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const dateFormatted = this.formatCardDate(dt);
        const relativeTime = this.getRelativeTimeText(meeting.dateTimeMillis);

        card.innerHTML = `
            <div class="card-left">
                <button class="complete-checkbox-btn" title="${meeting.isCompleted ? 'Mark Incomplete' : 'Mark Completed'}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                </button>
                <div class="card-info">
                    <div class="card-header-row">
                        <h4 class="card-title">${this.escapeHtml(meeting.title)}</h4>
                        <span class="category-tag">${this.escapeHtml(meeting.category || 'General')}</span>
                    </div>
                    <div class="card-meta-row">
                        ${meeting.personName ? `
                            <span class="meta-item person">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path>
                                    <circle cx="12" cy="7" r="4"></circle>
                                </svg>
                                ${this.escapeHtml(meeting.personName)}
                            </span>
                        ` : ''}
                        <span class="meta-item time">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="10"></circle>
                                <polyline points="12 6 12 12 16 14"></polyline>
                            </svg>
                            ${dateFormatted} at ${timeFormatted} (${relativeTime})
                        </span>
                        <span class="meta-item reminder-badge">
                            🔔 ${meeting.reminderMinutesBefore}m
                        </span>
                        <span class="meta-item tone-badge" title="Alarm sound: ${this.escapeHtml(meeting.alarmAudio || 'Default alarm sound')}">
                            🎵 ${this.escapeHtml(meeting.alarmAudio || 'Default alarm sound')}
                        </span>
                    </div>
                    ${meeting.notes ? `<div class="card-notes">${this.escapeHtml(meeting.notes)}</div>` : ''}
                </div>
            </div>
            <div class="card-right">
                <button class="action-icon-btn edit" title="Edit Meeting">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                    </svg>
                </button>
                <button class="action-icon-btn delete" title="Delete Meeting">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                </button>
            </div>
        `;

        // Bind Card actions
        const checkboxBtn = card.querySelector('.complete-checkbox-btn');
        checkboxBtn.addEventListener('click', () => this.toggleCompleteMeeting(meeting));

        const editBtn = card.querySelector('.action-icon-btn.edit');
        editBtn.addEventListener('click', () => this.openEditModal(meeting));

        const deleteBtn = card.querySelector('.action-icon-btn.delete');
        deleteBtn.addEventListener('click', () => this.deleteMeeting(meeting.id));

        return card;
    }

    async toggleCompleteMeeting(meeting) {
        const nextState = !meeting.isCompleted;
        meeting.isCompleted = nextState;

        // 1. Instant optimistic UI update on card
        const card = document.querySelector(`.meeting-card[data-id="${meeting.id}"]`);
        if (card) {
            if (nextState) {
                card.classList.add('completed');
                const chk = card.querySelector('.complete-checkbox-btn');
                if (chk) chk.title = 'Mark Incomplete';
            } else {
                card.classList.remove('completed');
                const chk = card.querySelector('.complete-checkbox-btn');
                if (chk) chk.title = 'Mark Completed';
            }
        }

        // 2. Instant local memory and storage update
        const local = getLocalMeetings();
        const target = local.find(m => String(m.id) === String(meeting.id));
        if (target) target.isCompleted = nextState;
        saveLocalMeetings(local);

        this.updateStats();
        this.showToast(nextState ? `Completed "${meeting.title}"` : `Marked "${meeting.title}" active`, 'success');

        // 3. Background server sync (no lag)
        try {
            await this.apiFetch(`/api/meetings/${meeting.id}/complete?completed=${nextState}`, { method: 'POST' });
        } catch (e) {}
    }

    async deleteMeeting(meetingId) {
        if (!confirm('Are you sure you want to delete this meeting?')) return;

        // 1. Instant optimistic UI removal with smooth animation (0ms lag)
        const card = document.querySelector(`.meeting-card[data-id="${meetingId}"]`);
        if (card) {
            card.style.transition = 'all 0.2s ease';
            card.style.opacity = '0';
            card.style.transform = 'scale(0.95)';
            setTimeout(() => card.remove(), 200);
        }
        this.meetings = this.meetings.filter(m => String(m.id) !== String(meetingId));

        // 2. Instant local storage & stats update
        const local = getLocalMeetings().filter(m => String(m.id) !== String(meetingId));
        saveLocalMeetings(local);
        this.updateStats();
        this.showToast('Meeting deleted', 'info');

        // 3. Background server sync
        try {
            await this.apiFetch(`/api/meetings/${meetingId}`, { method: 'DELETE' });
        } catch (e) {
            console.warn('Delete sync offline:', e);
        }
    }

    async triggerTestAlarm(meetingId) {
        try {
            await this.apiFetch(`/api/alarms/${meetingId}/test`, { method: 'POST' });
            this.showToast('Testing alarm now...', 'info');
        } catch (e) {
            this.showToast('Failed to test alarm', 'error');
        }
    }

    openAddModal() {
        this.modalTitle.textContent = 'Schedule New Meeting';
        this.formMeetingId.value = '';
        this.formTitle.value = '';
        this.formPerson.value = '';
        if (this.modalSmartFillGroup) this.modalSmartFillGroup.style.display = 'block';
        if (this.voiceQaContainer) this.voiceQaContainer.style.display = 'none';
        if (this.voiceUserBubble) this.voiceUserBubble.style.display = 'none';
        if (this.voiceAssistantStatus) this.voiceAssistantStatus.textContent = 'Tap the mic to schedule by voice';
        this.stopVoiceAssistant();

        // Default tomorrow 10am
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        this.formDate.value = tomorrow.toISOString().split('T')[0];
        if (this.syncDateDisplayFromIso) this.syncDateDisplayFromIso();
        this.formTime.value = '10:00';
        this.formReminder.value = '30';
        this.formCategory.value = 'General';
        if (this.formAlarmAudio) this.formAlarmAudio.value = 'Default alarm sound';
        this.formNotes.value = '';

        this.stopTonePreview();
        this.meetingModal.style.display = 'flex';
        this.formTitle.focus();
    }

    openEditModal(meeting) {
        this.modalTitle.textContent = 'Edit Meeting';
        this.formMeetingId.value = meeting.id;
        this.formTitle.value = meeting.title;
        this.formPerson.value = meeting.personName || '';
        if (this.modalSmartFillGroup) this.modalSmartFillGroup.style.display = 'none';
        this.stopVoiceAssistant();

        const dt = new Date(meeting.dateTimeMillis);
        const yyyy = dt.getFullYear();
        const mm = String(dt.getMonth() + 1).padStart(2, '0');
        const dd = String(dt.getDate()).padStart(2, '0');
        const hh = String(dt.getHours()).padStart(2, '0');
        const min = String(dt.getMinutes()).padStart(2, '0');

        this.formDate.value = `${yyyy}-${mm}-${dd}`;
        if (this.syncDateDisplayFromIso) this.syncDateDisplayFromIso();
        this.formTime.value = `${hh}:${min}`;
        this.formReminder.value = String(meeting.reminderMinutesBefore);
        this.formCategory.value = meeting.category || 'General';
        if (this.formAlarmAudio) this.formAlarmAudio.value = meeting.alarmAudio || 'Default alarm sound';
        this.formNotes.value = meeting.notes || '';

        this.stopTonePreview();
        this.meetingModal.style.display = 'flex';
    }

    closeModal() {
        this.stopVoiceAssistant();
        this.stopTonePreview();
        this.meetingModal.style.display = 'none';
    }

    async handleFormSubmit() {
        this.stopVoiceAssistant();
        const title = this.formTitle.value.trim();
        const person = this.formPerson.value.trim();
        let dateVal = this.formDate ? this.formDate.value : '';
        if (!dateVal && this.formDateDisplay && this.formDateDisplay.value) {
            const parts = this.formDateDisplay.value.trim().split(/[\/\-\.]/);
            if (parts.length === 3) {
                const d = parts[0].padStart(2, '0');
                const m = parts[1].padStart(2, '0');
                let y = parts[2];
                if (y.length === 2) y = '20' + y;
                dateVal = `${y}-${m}-${d}`;
                if (this.formDate) this.formDate.value = dateVal;
            }
        }
        const timeVal = this.formTime.value;
        const reminder = parseInt(this.formReminder.value);
        const category = this.formCategory.value;
        const alarmAudio = this.formAlarmAudio ? this.formAlarmAudio.value : 'Default alarm sound';
        const notes = this.formNotes.value.trim();

        if (!title || !dateVal || !timeVal) {
            this.showToast('Please fill in title, date and time', 'error');
            return;
        }

        const [year, month, day] = dateVal.split('-').map(Number);
        const [hour, minute] = timeVal.split(':').map(Number);
        const meetingDate = new Date(year, month - 1, day, hour, minute);
        const dateTimeMillis = meetingDate.getTime();

        const payload = {
            title,
            personName: person,
            dateTimeMillis,
            reminderMinutesBefore: reminder,
            category,
            alarmAudio,
            notes
        };

        const meetingId = this.formMeetingId.value;

        let savedOnline = false;
        try {
            if (meetingId) {
                const res = await this.apiFetch(`/api/meetings/${meetingId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (res.ok) savedOnline = true;
            } else {
                const res = await this.apiFetch('/api/meetings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (res.ok) savedOnline = true;
            }
        } catch (e) {
            console.warn('Saving to local offline database.');
        }

        // Always ensure local storage is up to date
        const local = getLocalMeetings();
        if (meetingId) {
            const idx = local.findIndex(m => String(m.id) === String(meetingId));
            if (idx >= 0) {
                local[idx] = { ...local[idx], ...payload, id: Number(meetingId) };
            } else {
                local.push({ ...payload, id: Number(meetingId), isCompleted: false });
            }
            saveLocalMeetings(local);
            this.showToast(savedOnline ? 'Meeting updated successfully' : 'Meeting updated (offline)', 'success');
        } else {
            const newId = Date.now();
            local.push({ ...payload, id: newId, isCompleted: false });
            saveLocalMeetings(local);
            this.showToast(savedOnline ? 'Meeting created & alarm scheduled' : 'Meeting created (offline)', 'success');
        }

        this.closeModal();
        await this.loadMeetings(false);
    }

    // =========================================================================
    // Alarm Alert & Sound System (All 25 Distinct Audio Synthesizers)
    // =========================================================================

    triggerAlarmUI(meeting) {
        this.activeAlarmMeeting = meeting;
        this.alarmTitle.textContent = meeting.title;

        if (meeting.personName) {
            this.alarmPersonName.textContent = `With ${meeting.personName}`;
            this.alarmPersonBadge.style.display = 'inline-flex';
        } else {
            this.alarmPersonBadge.style.display = 'none';
        }

        const dt = new Date(meeting.dateTimeMillis);
        const timeStr = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        this.alarmTimeDetails.textContent = `Scheduled for ${this.formatCardDate(dt)} at ${timeStr} (${meeting.reminderMinutesBefore}m alarm)`;

        // Show tone name on alarm modal
        if (this.alarmToneName) {
            this.alarmToneName.textContent = meeting.alarmAudio || 'Default alarm sound';
        }

        // Show overlay
        this.alarmOverlay.style.display = 'flex';

        // Play loud pulsing Web Audio Synthesizer Alarm Sound using the selected tone
        this.startAlarmAudio(meeting.alarmAudio || 'Default alarm sound');

        // Show native desktop system notification
        this.showDesktopNotification(meeting);

        // Start 60-second auto-stop timer (Section 7.4)
        this.startAlarmCountdown(60);
    }

    getToneInterval(toneName) {
        switch (toneName) {
            case 'Beep':
            case 'Pulse Signal':
                return 650;
            case 'Alarm':
            case 'Default alarm sound':
                return 600;
            case 'Modulator':
            case 'Thad Wetland':
                return 750;
            case 'Drift':
            case 'Synth Arpeggio':
                return 900;
            case 'Interesting':
                return 950;
            case 'Busy Marimba':
                return 1050;
            case 'Waltz Alarm':
            case 'Waltz Piano':
                return 1150;
            case 'Kalimbells':
            case 'Guitar':
                return 1200;
            case 'After The Rain':
            case 'Rainy Day':
            case 'Sunrise':
                return 1350;
            case 'Bell':
            case 'Cuckoo Clock':
            case 'Ding':
            case 'Dreamer\'s Alarm':
            case 'Floating':
            case 'Harp Echo':
            case 'Slowly Wind':
            case 'Warm Night':
            default:
                return 1500;
        }
    }

    playTonePattern(toneName, now) {
        if (!this.audioCtx) return;
        const ctx = this.audioCtx;

        const playNote = (freq, startOffset, dur, type = 'sine', maxGain = 0.28, endGain = 0.001) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, now + startOffset);
            gain.gain.setValueAtTime(maxGain, now + startOffset);
            gain.gain.exponentialRampToValueAtTime(Math.max(endGain, 0.0001), now + startOffset + dur);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now + startOffset);
            osc.stop(now + startOffset + dur);
        };

        const playGlide = (startFreq, endFreq, startOffset, dur, type = 'sine', maxGain = 0.25) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(startFreq, now + startOffset);
            osc.frequency.exponentialRampToValueAtTime(endFreq, now + startOffset + dur);
            gain.gain.setValueAtTime(maxGain, now + startOffset);
            gain.gain.exponentialRampToValueAtTime(0.001, now + startOffset + dur);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now + startOffset);
            osc.stop(now + startOffset + dur);
        };

        switch (toneName) {
            case 'After The Rain':
                // Calming pentatonic rain chimes (C5, E5, G5, A5, C6)
                playNote(523.25, 0.00, 0.45, 'sine', 0.22);
                playNote(659.25, 0.18, 0.45, 'triangle', 0.20);
                playNote(783.99, 0.36, 0.45, 'sine', 0.22);
                playNote(880.00, 0.54, 0.45, 'triangle', 0.18);
                playNote(1046.5, 0.72, 0.60, 'sine', 0.24);
                break;

            case 'Alarm':
                // Rapid classic vintage alarm buzzer
                playNote(800, 0.00, 0.08, 'sawtooth', 0.28);
                playNote(1000, 0.10, 0.08, 'sawtooth', 0.28);
                playNote(800, 0.20, 0.08, 'sawtooth', 0.28);
                playNote(1000, 0.30, 0.08, 'sawtooth', 0.30);
                break;

            case 'Beep':
                // Crisp electronic triple beep
                playNote(1046.5, 0.00, 0.06, 'sine', 0.25);
                playNote(1046.5, 0.10, 0.06, 'sine', 0.25);
                playNote(1046.5, 0.20, 0.07, 'sine', 0.28);
                break;

            case 'Bell':
                // Resonant deep brass chime with harmonics
                playNote(523.25, 0.00, 1.4, 'sine', 0.30);
                playNote(1046.5, 0.00, 1.1, 'triangle', 0.18);
                playNote(1567.9, 0.00, 0.8, 'sine', 0.10);
                break;

            case 'Busy Marimba':
                // Cheerful rapid marimba arpeggio run
                playNote(523.25, 0.00, 0.18, 'triangle', 0.26);
                playNote(659.25, 0.10, 0.18, 'triangle', 0.26);
                playNote(783.99, 0.20, 0.18, 'triangle', 0.26);
                playNote(1046.5, 0.30, 0.22, 'triangle', 0.28);
                playNote(783.99, 0.40, 0.18, 'triangle', 0.24);
                playNote(659.25, 0.50, 0.22, 'triangle', 0.22);
                break;

            case 'Cuckoo Clock':
                // Classic cuckoo bird call: "Cuck-oo!" twice
                playNote(659.25, 0.00, 0.18, 'sine', 0.25);
                playNote(523.25, 0.18, 0.30, 'sine', 0.28);
                // Tick
                playNote(1200, 0.52, 0.02, 'triangle', 0.10);
                // Second call
                playNote(659.25, 0.58, 0.18, 'sine', 0.25);
                playNote(523.25, 0.76, 0.32, 'sine', 0.28);
                break;

            case 'Ding':
                // Bright high-crystal reception ding
                playNote(2093.0, 0.00, 1.8, 'sine', 0.32);
                playNote(4186.0, 0.00, 0.7, 'triangle', 0.12);
                break;

            case 'Dreamer\'s Alarm':
                // Warm ambient F-major 7th chords
                playNote(349.23, 0.00, 1.2, 'sine', 0.18);
                playNote(440.00, 0.05, 1.2, 'sine', 0.18);
                playNote(523.25, 0.10, 1.2, 'triangle', 0.16);
                playNote(659.25, 0.15, 1.4, 'sine', 0.20);
                break;

            case 'Drift':
                // Spacey upward pitch-drift glide
                playGlide(440, 880, 0.00, 0.55, 'sine', 0.28);
                playNote(880, 0.55, 0.35, 'triangle', 0.22);
                break;

            case 'Floating':
                // Weightless ethereal sine chord with beating
                playNote(440.0, 0.00, 1.2, 'sine', 0.20);
                playNote(444.0, 0.00, 1.2, 'sine', 0.20);
                playNote(659.25, 0.15, 1.1, 'triangle', 0.18);
                break;

            case 'Guitar':
                // Acoustic guitar D-major strum pluck
                playNote(146.83, 0.00, 0.7, 'triangle', 0.26);
                playNote(220.00, 0.04, 0.6, 'sawtooth', 0.18);
                playNote(293.66, 0.08, 0.6, 'triangle', 0.22);
                playNote(369.99, 0.12, 0.6, 'sawtooth', 0.16);
                playNote(440.00, 0.16, 0.7, 'sine', 0.24);
                break;

            case 'Harp Echo':
                // Ascending harp ripple with echoing delay
                playNote(261.63, 0.00, 0.35, 'sine', 0.22);
                playNote(329.63, 0.08, 0.35, 'triangle', 0.22);
                playNote(392.00, 0.16, 0.35, 'sine', 0.22);
                playNote(523.25, 0.24, 0.40, 'triangle', 0.24);
                playNote(659.25, 0.32, 0.45, 'sine', 0.24);
                // Soft trailing echo
                playNote(523.25, 0.52, 0.35, 'sine', 0.12);
                playNote(659.25, 0.64, 0.40, 'sine', 0.10);
                break;

            case 'Interesting':
                // Playful bouncy staccato hook
                playNote(523.25, 0.00, 0.10, 'triangle', 0.26);
                playNote(783.99, 0.12, 0.10, 'sine', 0.26);
                playNote(659.25, 0.24, 0.10, 'triangle', 0.26);
                playNote(880.00, 0.36, 0.14, 'sine', 0.28);
                playNote(587.33, 0.50, 0.18, 'triangle', 0.24);
                break;

            case 'Kalimbells':
                // High crystalline kalimba tines
                playNote(659.25, 0.00, 0.55, 'sine', 0.26);
                playNote(830.61, 0.12, 0.55, 'triangle', 0.26);
                playNote(987.77, 0.24, 0.55, 'sine', 0.28);
                playNote(1318.5, 0.36, 0.70, 'sine', 0.30);
                break;

            case 'Modulator':
                // Sci-fi FM frequency modulation wobble
                try {
                    const oscM = ctx.createOscillator();
                    const gainM = ctx.createGain();
                    const lfo = ctx.createOscillator();
                    const lfoGain = ctx.createGain();
                    oscM.type = 'sine';
                    oscM.frequency.setValueAtTime(560, now);
                    lfo.type = 'sawtooth';
                    lfo.frequency.setValueAtTime(22, now);
                    lfoGain.gain.setValueAtTime(140, now);
                    lfo.connect(oscM.frequency);
                    gainM.gain.setValueAtTime(0.25, now);
                    gainM.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
                    oscM.connect(gainM);
                    gainM.connect(ctx.destination);
                    lfo.start(now);
                    oscM.start(now);
                    lfo.stop(now + 0.55);
                    oscM.stop(now + 0.55);
                } catch (e) {}
                break;

            case 'Pulse Signal':
                // Clean sonar beacon pulse
                playNote(920, 0.00, 0.35, 'sine', 0.30);
                playNote(1840, 0.00, 0.18, 'triangle', 0.14);
                break;

            case 'Rainy Day':
                // Cozy low-pass A-minor felt notes
                playNote(220.00, 0.00, 0.7, 'triangle', 0.24);
                playNote(261.63, 0.15, 0.7, 'sine', 0.22);
                playNote(329.63, 0.30, 0.7, 'triangle', 0.22);
                playNote(493.88, 0.45, 0.8, 'sine', 0.24);
                break;

            case 'Slowly Wind':
                // Sweeping harmonic wind swell
                playGlide(240, 520, 0.00, 0.7, 'triangle', 0.22);
                playGlide(520, 240, 0.70, 0.6, 'sine', 0.20);
                break;

            case 'Sunrise':
                // Uplifting morning fanfare (C-G-C-E-G)
                playNote(261.63, 0.00, 0.25, 'triangle', 0.24);
                playNote(392.00, 0.14, 0.25, 'sine', 0.24);
                playNote(523.25, 0.28, 0.25, 'triangle', 0.26);
                playNote(659.25, 0.42, 0.28, 'sine', 0.28);
                playNote(783.99, 0.56, 0.50, 'sine', 0.30);
                break;

            case 'Synth Arpeggio':
                // Driving retro synthwave 16th-note electro
                playNote(261.63, 0.00, 0.10, 'sawtooth', 0.25);
                playNote(311.13, 0.09, 0.10, 'sawtooth', 0.25);
                playNote(392.00, 0.18, 0.10, 'sawtooth', 0.25);
                playNote(466.16, 0.27, 0.10, 'sawtooth', 0.25);
                playNote(523.25, 0.36, 0.22, 'square', 0.22);
                break;

            case 'Thad Wetland':
                // Hollow organic bamboo drop
                playGlide(540, 180, 0.00, 0.12, 'sine', 0.30);
                playGlide(420, 140, 0.16, 0.12, 'sine', 0.25);
                break;

            case 'Waltz Alarm':
                // Cheerful 3/4 Viennese waltz tempo
                // Beat 1 (Bass)
                playNote(130.81, 0.00, 0.28, 'triangle', 0.30);
                // Beat 2 (Chord)
                playNote(392.00, 0.32, 0.22, 'sine', 0.20);
                playNote(659.25, 0.32, 0.22, 'triangle', 0.18);
                // Beat 3 (Chord)
                playNote(392.00, 0.64, 0.24, 'sine', 0.20);
                playNote(659.25, 0.64, 0.24, 'triangle', 0.18);
                break;

            case 'Waltz Piano':
                // Classical acoustic piano waltz in Ab
                playNote(103.83, 0.00, 0.35, 'triangle', 0.28);
                // Beat 2 piano chord
                playNote(261.63, 0.33, 0.26, 'sine', 0.20);
                playNote(311.13, 0.33, 0.26, 'triangle', 0.18);
                playNote(415.30, 0.33, 0.26, 'sine', 0.18);
                // Beat 3 piano chord
                playNote(261.63, 0.66, 0.28, 'sine', 0.20);
                playNote(311.13, 0.66, 0.28, 'triangle', 0.18);
                playNote(415.30, 0.66, 0.28, 'sine', 0.18);
                break;

            case 'Warm Night':
                // Lush Rhodes lullaby chord
                playNote(155.56, 0.00, 1.2, 'triangle', 0.22);
                playNote(233.08, 0.05, 1.2, 'sine', 0.20);
                playNote(293.66, 0.10, 1.2, 'triangle', 0.18);
                playNote(349.23, 0.15, 1.2, 'sine', 0.18);
                playNote(392.00, 0.20, 1.4, 'sine', 0.22);
                break;

            case 'Default alarm sound':
            default:
                // Urgent dual-tone pulsing alarm (880Hz / 1200Hz)
                playNote(880, 0.00, 0.14, 'sawtooth', 0.28);
                playNote(1200, 0.16, 0.16, 'square', 0.32);
                break;
        }
    }

    startAlarmAudio(toneName = 'Default alarm sound') {
        this.stopAlarmAudio();
        this.currentTonePlaying = toneName || 'Default alarm sound';

        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            this.audioCtx = new AudioCtx();
            if (this.audioCtx.state === 'suspended') {
                this.audioCtx.resume();
            }

            this.isAlarmAudioPlaying = true;
            const interval = this.getToneInterval(this.currentTonePlaying);

            const playCycle = () => {
                if (!this.isAlarmAudioPlaying || !this.audioCtx) return;
                const now = this.audioCtx.currentTime;
                this.playTonePattern(this.currentTonePlaying, now);
            };

            playCycle();
            this.audioPulseInterval = setInterval(playCycle, interval);
        } catch (err) {
            console.error('Audio synthesizer error', err);
        }
    }

    stopAlarmAudio() {
        this.isAlarmAudioPlaying = false;
        if (this.audioPulseInterval) {
            clearInterval(this.audioPulseInterval);
            this.audioPulseInterval = null;
        }
        if (this.audioCtx) {
            try {
                this.audioCtx.close();
            } catch (e) { }
            this.audioCtx = null;
        }
    }

    // =========================================================================
    // Alarm Tone Preview on Dropdown Selection
    // =========================================================================

    playTonePreview(toneName) {
        const tone = toneName || (this.formAlarmAudio ? this.formAlarmAudio.value : 'Default alarm sound');
        this.stopTonePreview();
        this.isPreviewPlaying = true;

        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            this.previewAudioCtx = new AudioCtx();
            if (this.previewAudioCtx.state === 'suspended') {
                this.previewAudioCtx.resume();
            }

            const interval = this.getToneInterval(tone);
            const playCycle = () => {
                if (!this.isPreviewPlaying || !this.previewAudioCtx) return;
                const origCtx = this.audioCtx;
                this.audioCtx = this.previewAudioCtx;
                const now = this.previewAudioCtx.currentTime;
                this.playTonePattern(tone, now);
                this.audioCtx = origCtx;
            };

            playCycle();
            this.previewInterval = setInterval(playCycle, interval);

            // Preview plays 2 cycles then automatically stops
            const previewDuration = Math.min(Math.max(interval * 2, 2500), 4000);
            this.previewTimeout = setTimeout(() => {
                this.stopTonePreview();
            }, previewDuration);
        } catch (e) {
            console.error('Tone preview error', e);
            this.stopTonePreview();
        }
    }

    stopTonePreview() {
        this.isPreviewPlaying = false;
        if (this.previewInterval) {
            clearInterval(this.previewInterval);
            this.previewInterval = null;
        }
        if (this.previewTimeout) {
            clearTimeout(this.previewTimeout);
            this.previewTimeout = null;
        }
        if (this.previewAudioCtx) {
            try { this.previewAudioCtx.close(); } catch (e) {}
            this.previewAudioCtx = null;
        }
    }

    startAlarmCountdown(seconds) {
        clearInterval(this.alarmCountdownTimer);
        this.alarmSecondsLeft = seconds;
        this.alarmCountdownBar.style.width = '100%';
        this.alarmCountdownText.textContent = `Auto-stops in ${seconds}s`;

        const total = seconds;
        this.alarmCountdownTimer = setInterval(() => {
            this.alarmSecondsLeft -= 1;
            const pct = Math.max(0, (this.alarmSecondsLeft / total) * 100);
            this.alarmCountdownBar.style.width = `${pct}%`;
            this.alarmCountdownText.textContent = `Auto-stops in ${this.alarmSecondsLeft}s`;

            if (this.alarmSecondsLeft <= 0) {
                // Auto stop after 60s
                clearInterval(this.alarmCountdownTimer);
                this.dismissActiveAlarm();
            }
        }, 1000);
    }

    async dismissActiveAlarm() {
        const meeting = this.activeAlarmMeeting;
        this.stopAlarmAudio();
        clearInterval(this.alarmCountdownTimer);
        this.alarmOverlay.style.display = 'none';

        if (meeting) {
            try {
                await this.apiFetch(`/api/alarms/${meeting.id}/dismiss`, { method: 'POST' });
            } catch (e) { }
            this.activeAlarmMeeting = null;
        }
        this.showToast('Alarm dismissed', 'info');
    }

    async snoozeActiveAlarm() {
        const meeting = this.activeAlarmMeeting;
        this.stopAlarmAudio();
        clearInterval(this.alarmCountdownTimer);
        this.alarmOverlay.style.display = 'none';

        if (meeting) {
            try {
                await this.apiFetch(`/api/alarms/${meeting.id}/snooze`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ snoozeMinutes: 5 })
                });
                this.showToast(`Alarm snoozed for 5 minutes`, 'info');
            } catch (e) {
                this.showToast('Failed to snooze', 'error');
            }
            this.activeAlarmMeeting = null;
        }
    }

    dismissAlarmUI(notifyBackend = true) {
        this.stopAlarmAudio();
        clearInterval(this.alarmCountdownTimer);
        this.alarmOverlay.style.display = 'none';
        this.activeAlarmMeeting = null;
    }

    async checkActiveAlarmOnServer() {
        try {
            const res = await this.apiFetch('/api/alarms/active');
            const data = await res.json();
            if (data.isActive && data.meeting) {
                this.triggerAlarmUI(data.meeting);
            }
        } catch (e) { }
    }

    // =========================================================================
    // Desktop Notifications
    // =========================================================================

    checkNotificationPermission() {
        if (!('Notification' in window)) return;
        if (this.notifBtnText && Notification.permission === 'granted') {
            this.notifBtnText.textContent = 'Notifications Active';
            if (this.enableNotificationBtn) this.enableNotificationBtn.classList.add('active');
        } else if (this.notifBtnText && Notification.permission === 'denied') {
            this.notifBtnText.textContent = 'Notifications Blocked';
        }
    }

    async requestNotificationPermission() {
        if (!('Notification' in window)) {
            this.showToast('Desktop notifications not supported in this browser', 'error');
            return;
        }
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
            if (this.notifBtnText) this.notifBtnText.textContent = 'Notifications Active';
            this.updateNotificationDesc('on');
            this.showToast('Desktop notifications enabled!', 'success');
        } else {
            this.showToast('Notification permission was not granted', 'info');
        }
    }

    showDesktopNotification(meeting) {
        const notifPref = localStorage.getItem('notizen_notifications') || localStorage.getItem('meetmate_notifications') || 'on';
        if (notifPref === 'off') return;
        if (!('Notification' in window) || Notification.permission !== 'granted') return;

        const options = {
            body: `With ${meeting.personName || 'Attendees'} — Reminder ${meeting.reminderMinutesBefore}m before meeting starts`,
            icon: '/static/images/notizen_logo.webp',
            requireInteraction: true,
            tag: `notizen-${meeting.id}`
        };

        const notif = new Notification(`⏰ Notizen: ${meeting.title}`, options);
        notif.onclick = () => {
            window.focus();
            notif.close();
        };
    }

    // =========================================================================
    // Helpers & UI formatters
    // =========================================================================

    formatDateDisplay(isoDate) {
        if (!isoDate) return '--';
        const [y, m, d] = isoDate.split('-').map(Number);
        const target = new Date(y, m - 1, d);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const diffDays = Math.round((target - today) / (1000 * 60 * 60 * 24));
        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Tomorrow';
        if (diffDays === 2) return 'Day after tomorrow';

        return target.toLocaleDateString([], { month: 'short', day: 'numeric', weekday: 'short' });
    }

    formatCardDate(dt) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const checkDate = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());

        const diffDays = Math.round((checkDate - today) / (1000 * 60 * 60 * 24));
        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Tomorrow';
        if (diffDays === -1) return 'Yesterday';

        return dt.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    }

    formatTime12Hour(time24) {
        if (!time24) return '--';
        const [h, m] = time24.split(':').map(Number);
        const period = h >= 12 ? 'PM' : 'AM';
        const hour12 = h % 12 || 12;
        return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
    }

    getRelativeTimeText(millis) {
        const diffMs = millis - Date.now();
        const diffMins = Math.round(diffMs / 60000);

        if (diffMins > 0) {
            if (diffMins < 60) return `in ${diffMins} min`;
            const hours = Math.floor(diffMins / 60);
            const remainingMins = diffMins % 60;
            if (hours < 24) return `in ${hours}h ${remainingMins > 0 ? remainingMins + 'm' : ''}`;
            const days = Math.round(hours / 24);
            return `in ${days} day${days > 1 ? 's' : ''}`;
        } else {
            const pastMins = Math.abs(diffMins);
            if (pastMins < 60) return `${pastMins}m ago`;
            const hours = Math.floor(pastMins / 60);
            return `${hours}h ago`;
        }
    }

    escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
        toast.innerHTML = `<span>${icon}</span><span>${this.escapeHtml(message)}</span>`;

        this.toastContainer.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(8px)';
            toast.style.transition = 'all 0.25s ease';
            setTimeout(() => toast.remove(), 250);
        }, 3200);
    }
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
    window.notizenApp = new NotizenApp();
    window.meetMate = window.notizenApp;

    // Register Service Worker for Mobile PWA
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => {
                console.log('PWA ServiceWorker registered', reg.scope);
                reg.update();
            })
            .catch(err => console.log('ServiceWorker registration error', err));
    }
});
