(() => {
    const API_BASE = window.location.origin.includes('media.larpgod.xyz')
        ? 'https://media.larpgod.xyz/api'
        : '/api';

    // UI refs
    const notificationsBtn = byId('notificationsBtn');
    const notificationsPanel = byId('notificationsPanel');
    const notificationsClose = byId('notificationsClose');
    const notificationsList = byId('notificationsList');
    const notificationsBadge = byId('notificationsBadge');

    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');

    const chatMessagesEl = byId('chatMessages');
    const chatForm = byId('chatForm');
    const chatInput = byId('chatInput');
    const onlineCount = byId('onlineCount');

    const externalMailInline = byId('externalMailInline');

    const bucketsContainer = byId('mediaBucketsList');
    const mediaUploadForm = byId('mediaUploadForm');
    const bucketSelect = byId('mediaBucketSelect');
    const titleInput = byId('mediaAssetName');
    const fileInput = byId('mediaAssetFile');
    const uploadFeedback = byId('mediaUploadFeedback');
    const sharedGrid = byId('sharedAssetsGrid');
    const privateGrid = byId('privateAssetsGrid');
    const mediaTabButtons = document.querySelectorAll('.media-tab-btn');
    const mediaTabPanes = document.querySelectorAll('.media-tab-pane');

    const embedTitleAdmin = byId('embedTitleAdmin');
    const embedDescAdmin = byId('embedDescAdmin');
    const embedColorAdmin = byId('embedColorAdmin');
    const embedSaveBtn = byId('embedSaveBtn');
    const embedSaveStatus = byId('embedSaveStatus');
    const embedAdminCard = byId('embedAdminCard');

    const mediaViewer = byId('mediaViewer');
    const mediaViewerBody = byId('mediaViewerBody');
    const mediaViewerTitle = byId('mediaViewerTitle');
    const mediaViewerCopy = byId('mediaViewerCopy');
    const mediaViewerOpen = byId('mediaViewerOpen');
    const mediaViewerClose = byId('mediaViewerClose');

    // State
    let currentUser = null;
    let embedPrefs = { title: '', desc: '', color: '#151521' };
    let embedEditable = false;
    let notificationsInterval = null;
    let chatInterval = null;
    let externalMailInterval = null;
    let audioContext = null;

    document.addEventListener('DOMContentLoaded', () => {
        initTabs();
        initNotificationsUI();
        initChatUI();
        initMediaViewer();
        initMediaForm();
        initMediaTabs();
        initEmbedAdminUI();
        initTicTacToe();
        initAdminPanel();

        currentUser = window.dashboardState?.getCurrentUser?.() || null;
        handleUserChange();

        window.addEventListener('larp:user-change', (event) => {
            currentUser = event.detail;
            handleUserChange();
        });
    });

    // ----- Tabs -----
    function initTabs() {
        tabButtons.forEach((btn) =>
            btn.addEventListener('click', () => setActiveTab(btn.dataset.tab))
        );
        setActiveTab('overview');
    }

    function setActiveTab(tab) {
        tabButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
        tabPanes.forEach((pane) => {
            const isActive = pane.id.toLowerCase() === `tab${tab.toLowerCase()}`;
            pane.classList.toggle('active', isActive);
            pane.style.display = isActive ? 'block' : 'none';
        });
        if (tab === 'media' && currentUser?.isApproved) {
            setActiveMediaTab('shared');
            loadMedia();
        }
    }

    function initMediaTabs() {
        mediaTabButtons.forEach((btn) =>
            btn.addEventListener('click', () => setActiveMediaTab(btn.dataset.mediaTab))
        );
        setActiveMediaTab('shared');
    }

    function setActiveMediaTab(tab) {
        mediaTabButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.mediaTab === tab));
        mediaTabPanes.forEach((pane) => {
            const isActive = pane.dataset.mediaPane === tab;
            pane.classList.toggle('active', isActive);
            pane.style.display = isActive ? 'block' : 'none';
        });
    }

    // ----- User State -----
    async function handleUserChange() {
        if (currentUser) {
            // Chat is available to all logged-in users
            loadChat();
            sendHeartbeat();
            
            if (currentUser.isApproved) {
                await loadEmbedPrefsFromServer();
                loadMedia();
                fetchNotifications();
                loadExternalMail();
                loadTicTacToeStatus();
                loadApprovedUsers();
                startPolling();
            } else {
                embedEditable = false;
                embedPrefs = { title: '', desc: '', color: '#151521' };
                applyEmbedPrefsToForm();
                clearMediaUI();
                renderNotifications([]);
                renderExternalMail([]);
                const gs = byId('gameStatus');
                const tb = byId('tttBoard');
                if (gs) gs.textContent = 'Queue idle.';
                if (tb) tb.classList.add('hidden');
                stopPolling();
            }
        } else {
            embedEditable = false;
            embedPrefs = { title: '', desc: '', color: '#151521' };
            applyEmbedPrefsToForm();
            clearMediaUI();
            renderNotifications([]);
            renderExternalMail([]);
            renderChat([]);
            const gs = byId('gameStatus');
            const tb = byId('tttBoard');
            if (gs) gs.textContent = 'Queue idle.';
            if (tb) tb.classList.add('hidden');
            stopPolling();
        }
    }

    function startPolling() {
        stopPolling();
        // Chat polling for all logged-in users
        if (currentUser) {
            chatInterval = setInterval(() => {
                loadChat();
                sendHeartbeat();
            }, 10000);
        }
        
        if (currentUser?.isApproved) {
            notificationsInterval = setInterval(fetchNotifications, 15000);
            externalMailInterval = setInterval(loadExternalMail, 20000);
            tttInterval = setInterval(loadTicTacToeStatus, 5000);
        }
    }

    function stopPolling() {
        clearInterval(notificationsInterval);
        clearInterval(chatInterval);
        clearInterval(externalMailInterval);
        clearInterval(tttInterval);
    }

    // ----- Notifications -----
    function initNotificationsUI() {
        notificationsBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            toggleNotifications();
        });
        notificationsClose?.addEventListener('click', () => toggleNotifications(false));
        document.addEventListener('click', (e) => {
            if (!notificationsPanel || !notificationsBtn) return;
            if (notificationsPanel.contains(e.target) || notificationsBtn.contains(e.target)) return;
            toggleNotifications(false);
        });
    }

    function toggleNotifications(forceOpen) {
        const open = forceOpen !== undefined ? forceOpen : !notificationsPanel.classList.contains('active');
        notificationsPanel?.classList.toggle('active', open);
        if (open) markAllNotificationsRead();
    }

    async function fetchNotifications() {
        const token = getToken();
        if (!token) return;
        try {
            const res = await fetch(`${API_BASE}/notifications`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) return;
            const data = await res.json();
            renderNotifications(data.notifications || []);
        } catch (err) {
            console.error('Notifications failed', err);
        }
    }

    async function markAllNotificationsRead() {
        const token = getToken();
        if (!token) return;
        try {
            await fetch(`${API_BASE}/notifications/read-all`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
            });
            fetchNotifications();
        } catch (err) {
            console.error('Mark read failed', err);
        }
    }

    function renderNotifications(items) {
        if (!notificationsList) return;
        if (!items.length) {
            notificationsList.innerHTML = '<div class="empty-state">No notifications.</div>';
        } else {
            notificationsList.innerHTML = items
                .map(
                    (n) => `
                <div class="notification-item ${n.read ? '' : 'unread'}">
                    <div>${escapeHtml(n.message)}</div>
                    <div class="meta-line">${formatDate(n.createdAt)}</div>
                </div>`
                )
                .join('');
        }
        const unread = items.filter((i) => !i.read).length;
        if (notificationsBadge) {
            if (unread > 0) {
                notificationsBadge.textContent = unread;
                notificationsBadge.classList.remove('hidden');
                playNotificationSound();
            } else {
                notificationsBadge.classList.add('hidden');
            }
        }
    }

    function playNotificationSound() {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            if (!audioContext) {
                audioContext = new AudioCtx();
            }

            if (audioContext.state === 'suspended') {
                audioContext.resume();
            }

            const duration = 0.15;
            const ctxNow = audioContext.currentTime;
            const osc = audioContext.createOscillator();
            const gain = audioContext.createGain();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(1046.5, ctxNow); // C6 tone

            gain.gain.setValueAtTime(0.18, ctxNow);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctxNow + duration);

            osc.connect(gain).connect(audioContext.destination);
            osc.start(ctxNow);
            osc.stop(ctxNow + duration);
        } catch (err) {
            // If audio context is blocked (e.g., by autoplay restrictions), silently skip.
        }
    }

    // ----- Chat -----
    function initChatUI() {
        chatForm?.addEventListener('submit', sendChatMessage);
    }

    async function sendChatMessage(e) {
        e?.preventDefault();
        const token = getToken();
        if (!token || !currentUser) return; // Allow all logged-in users
        const text = (chatInput?.value || '').trim();
        if (!text || text.length > 200) return;
        try {
            const res = await fetch(`${API_BASE}/chat/message`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ text }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                if (res.status === 429) {
                    alert('Too many messages! Please wait a moment before sending another.');
                } else {
                    throw new Error(data.message || 'send failed');
                }
                return;
            }
            chatInput.value = '';
            loadChat();
        } catch (err) {
            console.error('Chat send failed', err);
        }
    }

    async function loadChat() {
        const token = getToken();
        if (!token || !chatMessagesEl) return;
        try {
            const res = await fetch(`${API_BASE}/chat/messages`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            if (!res.ok) throw new Error('chat fetch failed');
            renderChat(data.messages || []);
        } catch (err) {
            console.error('Chat fetch failed', err);
        }
    }

    async function sendHeartbeat() {
        const token = getToken();
        if (!token) return;
        try {
            await fetch(`${API_BASE}/chat/heartbeat`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
            });
            const res = await fetch(`${API_BASE}/chat/online`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            if (res.ok && onlineCount) onlineCount.textContent = data.online ?? 0;
        } catch (err) {
            console.error('Heartbeat failed', err);
        }
    }

    function renderChat(list) {
        if (!chatMessagesEl) return;
        if (!list.length) {
            chatMessagesEl.innerHTML = '<div class="empty-state">No chat yet. Say hi!</div>';
            return;
        }
        chatMessagesEl.innerHTML = list
            .map(
                (m) => {
                    const date = new Date(m.createdAt);
                    const timeStr = date.toLocaleTimeString('en-US', { 
                        hour: 'numeric', 
                        minute: '2-digit',
                        hour12: true 
                    });
                    const dateStr = date.toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric'
                    });
                    const isToday = new Date().toDateString() === date.toDateString();
                    const timeDisplay = isToday ? timeStr : `${dateStr} ${timeStr}`;
                    
                    return `
            <div class="chat-message">
                <div class="chat-meta">
                    <span class="chat-username">${escapeHtml(m.username)}</span>
                    <span class="chat-time">${timeDisplay}</span>
                </div>
                <div class="chat-text">${escapeHtml(m.text)}</div>
            </div>`;
                }
            )
            .join('');
        chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }

    // ----- External mail (inbox) -----
    async function loadExternalMail() {
        const token = getToken();
        if (!token || !currentUser?.isApproved || !externalMailInline) return;
        try {
            const res = await fetch(`${API_BASE}/external-mails`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            if (!res.ok) throw new Error('mail fetch failed');
            renderExternalMail(data.emails || []);
        } catch (err) {
            console.error('External mail load failed', err);
            renderExternalMail([]);
        }
    }

    function renderExternalMail(items) {
        if (!externalMailInline) return;
        if (!items.length) {
            externalMailInline.innerHTML = '<div class="empty-state">No forwarded messages yet.</div>';
            return;
        }
        externalMailInline.innerHTML = items
            .map(
                (m) => `
            <div class="message-item">
                <div class="from">From: ${escapeHtml(m.from)}</div>
                <div class="subject">Subject: ${escapeHtml(m.subject)}</div>
                <div class="meta">${escapeHtml(m.date || '')}</div>
                <div class="preview">${escapeHtml(m.body || '')}</div>
            </div>`
            )
            .join('');
    }

    // ----- Media -----
    function initMediaForm() {
        mediaUploadForm?.addEventListener('submit', handleUpload);
    }

    function initEmbedAdminUI() {
        embedSaveBtn?.addEventListener('click', saveEmbedPrefsAdmin);
    }

    async function loadEmbedPrefsFromServer() {
        const token = getToken();
        if (!token) return;
        try {
            const res = await fetch(`${API_BASE}/embed-prefs`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error('failed to load embed prefs');
            const data = await res.json();
            embedPrefs = data.prefs || embedPrefs;
            embedEditable = Boolean(data.editable);
            applyEmbedPrefsToForm();
        } catch (err) {
            console.error('Embed prefs load failed', err);
        }
    }

    function applyEmbedPrefsToForm() {
        if (embedAdminCard) embedAdminCard.classList.toggle('hidden', !embedEditable);
        if (embedTitleAdmin) embedTitleAdmin.value = embedPrefs.title || '';
        if (embedDescAdmin) embedDescAdmin.value = embedPrefs.desc || '';
        if (embedColorAdmin) embedColorAdmin.value = embedPrefs.color || '#151521';
        if (embedTitleAdmin) embedTitleAdmin.disabled = !embedEditable;
        if (embedDescAdmin) embedDescAdmin.disabled = !embedEditable;
        if (embedColorAdmin) embedColorAdmin.disabled = !embedEditable;
        if (embedSaveBtn) embedSaveBtn.disabled = !embedEditable;
        if (embedSaveStatus) embedSaveStatus.textContent = '';
    }

    async function saveEmbedPrefsAdmin() {
        if (!embedEditable) return;
        const token = getToken();
        if (!token) return;
        try {
            setFeedback(embedSaveStatus, 'Saving...', 'info');
            const payload = {
                title: embedTitleAdmin?.value || '',
                desc: embedDescAdmin?.value || '',
                color: embedColorAdmin?.value || '#151521',
            };
            const res = await fetch(`${API_BASE}/embed-prefs`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'save failed');
            embedPrefs = data.prefs || payload;
            loadMedia();
            setFeedback(embedSaveStatus, 'Saved', 'success');
        } catch (err) {
            console.error('Embed prefs save failed', err);
            setFeedback(embedSaveStatus, 'Save failed', 'error');
        }
    }

    async function handleUpload(e) {
        e.preventDefault();
        const token = getToken();
        if (!token || !currentUser?.isApproved) return;
        const bucketId = bucketSelect?.value;
        const file = fileInput?.files?.[0];
        const title = (titleInput?.value || '').trim();
        if (!bucketId || !file) {
            setFeedback(uploadFeedback, 'Pick a destination and file', 'error');
            return;
        }
        try {
            const formData = new FormData();
            formData.append('file', file);
            if (title) formData.append('title', title);
            const res = await fetch(`${API_BASE}/media/upload?bucketId=${encodeURIComponent(bucketId)}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: formData,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'upload failed');
            mediaUploadForm.reset();
            setFeedback(uploadFeedback, 'Upload complete', 'success');
            loadMedia();
        } catch (err) {
            console.error('Upload failed', err);
            setFeedback(uploadFeedback, 'Upload failed', 'error');
        }
    }

    async function loadMedia() {
        const token = getToken();
        if (!token) return;
        try {
            const res = await fetch(`${API_BASE}/media/buckets`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error('media buckets failed');
            const data = await res.json();
            const buckets = data.buckets || [];
            renderBucketSummary(buckets);
            populateBucketSelect(buckets);

            const assets = await Promise.all(
                buckets.map(async (bucket) => {
                    const list = await fetchBucketAssets(bucket.id);
                    return { bucket, assets: list };
                })
            );
            renderAssets(assets);
        } catch (err) {
            console.error('Media load failed', err);
            clearMediaUI();
        }
    }

    async function fetchBucketAssets(bucketId) {
        const token = getToken();
        if (!token) return [];
        try {
            const res = await fetch(`${API_BASE}/media/buckets/${bucketId}/assets`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) return [];
            const data = await res.json();
            return data.assets || [];
        } catch (err) {
            console.error('Assets fetch failed', err);
            return [];
        }
    }

    function renderBucketSummary(buckets = []) {
        if (!bucketsContainer) return;
        if (!buckets.length) {
            bucketsContainer.innerHTML = '<div class="empty-hint">No media buckets available.</div>';
            return;
        }
        bucketsContainer.innerHTML = buckets
            .map(
                (bucket) => `
            <div class="media-bucket-item">
                <h3>${bucket.name}</h3>
                <p class="bucket-meta">${bucket.type === 'shared' ? 'Shared by everyone' : 'Only you can manage this bucket.'}</p>
                <p class="bucket-meta">URL prefix: <code>${bucket.urlPrefix}</code></p>
            </div>`
            )
            .join('');
    }

    function populateBucketSelect(buckets = []) {
        if (!bucketSelect) return;
        if (!buckets.length) {
            bucketSelect.innerHTML = '';
            bucketSelect.disabled = true;
            return;
        }
        bucketSelect.disabled = false;
        bucketSelect.innerHTML = buckets.map((b) => `<option value="${b.id}">${b.name}</option>`).join('');
    }

    function renderAssets(entries = []) {
        const shared = entries.find((entry) => entry.bucket.type === 'shared');
        const personal = entries.find((entry) => entry.bucket.type === 'private');
        renderAssetGrid(sharedGrid, shared?.assets || [], false);
        renderAssetGrid(privateGrid, personal?.assets || [], true);
    }

    function renderAssetGrid(container, assets, allowDelete) {
        if (!container) return;
        if (!assets.length) {
            container.innerHTML = '<div class="empty-state">No files yet.</div>';
            return;
        }
        container.innerHTML = assets
            .map((asset) => {
                // Get clean URL without query parameters
                let cleanUrl = asset.url || '';
                if (cleanUrl && !cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
                    cleanUrl = new URL(cleanUrl, window.location.origin).toString();
                }
                // Remove any existing query parameters from the URL
                try {
                    const urlObj = new URL(cleanUrl);
                    cleanUrl = `${urlObj.origin}${urlObj.pathname}`;
                } catch (e) {
                    // If URL parsing fails, use as-is
                }

                // Embed URL with prefs (for embed button only)
                let embedUrl = asset.embedUrl || cleanUrl;
                if (embedUrl && !embedUrl.startsWith('http://') && !embedUrl.startsWith('https://')) {
                    embedUrl = new URL(embedUrl, window.location.origin).toString();
                }

                const videoThumb = isVideo(cleanUrl)
                    ? `<video class="thumb-video" src="${cleanUrl}" muted playsinline loop preload="metadata"></video><span class="play-icon">&#9658;</span>`
                    : '';
                const imageStyle = !isVideo(cleanUrl) ? thumbStyle(cleanUrl) : thumbStyle('');
                const fileName = escapeHtml(asset.name || 'Untitled');
                const fileSize = formatBytes(asset.size);
                const fileDate = formatDate(asset.createdAt);
                return `
                <div class="media-card">
                    <div class="media-thumb" style="${imageStyle}" onclick="event.stopPropagation(); document.querySelector('[data-url=\\'${escapeHtml(cleanUrl)}\\']')?.click();">
                        ${videoThumb}
                    </div>
                    <div class="media-meta">
                        <div class="name" title="${fileName}">${fileName}</div>
                        <div class="meta-line">${fileSize} &bull; ${fileDate}</div>
                        <div class="actions">
                            <button type="button" class="ghost-btn tiny copy-link" data-url="${escapeHtml(cleanUrl)}">Copy URL</button>
                            <button type="button" class="ghost-btn tiny copy-embed" data-embed="${escapeHtml(embedUrl)}">Copy Embed</button>
                            <button type="button" class="ghost-btn tiny open-preview" data-url="${escapeHtml(cleanUrl)}" data-name="${fileName}">Preview</button>
                            ${allowDelete ? `<button type="button" class="ghost-btn tiny delete-asset" data-bucket="${escapeHtml(asset.bucketId)}" data-name="${escapeHtml(asset.name)}">Delete</button>` : ''}
                        </div>
                    </div>
                </div>`;
            })
            .join('');
        
        // Attach event listeners to the newly rendered buttons
        const actionButtons = container.querySelectorAll('.copy-link, .copy-embed, .open-preview, .delete-asset');
        console.log('Attaching media action listeners to', actionButtons.length, 'buttons');
        actionButtons.forEach(btn => {
            btn.addEventListener('click', handleAssetActions);
        });
    }

    function clearMediaUI() {
        renderBucketSummary([]);
        renderAssetGrid(sharedGrid, [], false);
        renderAssetGrid(privateGrid, [], true);
        setFeedback(uploadFeedback, '', 'info');
        if (bucketSelect) {
            bucketSelect.innerHTML = '';
            bucketSelect.disabled = true;
        }
        closeMediaViewer();
        if (externalMailInline) externalMailInline.innerHTML = '<div class="empty-state">Login to view forwarded mail.</div>';
    }

    function handleAssetActions(event) {
        const target = event.target;
        if (target.classList.contains('copy-link')) {
            copyToClipboard(target.dataset.url, target);
        }
        if (target.classList.contains('copy-embed')) {
            copyToClipboard(target.dataset.embed, target);
        }
        if (target.classList.contains('open-preview')) {
            openMediaViewer(target.dataset.url, target.dataset.name);
        }
        if (target.classList.contains('delete-asset')) {
            deleteAsset(target.dataset.bucket, target.dataset.name, target);
        }
    }

    async function deleteAsset(bucketId, fileName, trigger) {
        const token = getToken();
        if (!token || !bucketId || !fileName) return;
        if (!confirm('Delete this file?')) return;
        try {
            const res = await fetch(`${API_BASE}/media/${encodeURIComponent(bucketId)}/assets/${encodeURIComponent(fileName)}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'delete failed');
            loadMedia();
        } catch (err) {
            console.error('Delete asset failed', err);
            setFeedback(uploadFeedback, 'Delete failed', 'error');
        }
    }

    function copyToClipboard(text, button) {
        if (!text) {
            console.warn('No text to copy');
            return;
        }
        
        // For copy-link: use clean URL without query params
        if (button?.classList.contains('copy-link')) {
            const cleanUrl = button.dataset.url || text;
            if (!cleanUrl || cleanUrl === 'undefined') {
                console.error('Invalid URL');
                if (button) {
                    const original = button.textContent;
                    button.textContent = 'Error';
                    button.style.background = 'rgba(255, 142, 142, 0.2)';
                    setTimeout(() => {
                        button.textContent = original;
                        button.style.background = '';
                    }, 2000);
                }
                return;
            }
            // Remove any query parameters
            try {
                const urlObj = new URL(cleanUrl);
                text = `${urlObj.origin}${urlObj.pathname}`;
            } catch (e) {
                text = cleanUrl;
            }
        }
        
        // For copy-embed: use embed URL with prefs
        if (button?.classList.contains('copy-embed')) {
            const embedUrl = button.dataset.embed || text;
            if (!embedUrl || embedUrl === 'undefined') {
                console.error('Invalid embed URL');
                if (button) {
                    const original = button.textContent;
                    button.textContent = 'Error';
                    button.style.background = 'rgba(255, 142, 142, 0.2)';
                    setTimeout(() => {
                        button.textContent = original;
                        button.style.background = '';
                    }, 2000);
                }
                return;
            }
            text = embedUrl;
        }
        
        navigator.clipboard.writeText(text).then(() => {
            if (button) {
                const original = button.textContent;
                button.textContent = 'Copied!';
                button.style.background = 'rgba(168, 255, 191, 0.2)';
                button.style.borderColor = 'rgba(168, 255, 191, 0.4)';
                setTimeout(() => {
                    button.textContent = original;
                    button.style.background = '';
                    button.style.borderColor = '';
                }, 2000);
            }
        }).catch(() => {
            // Fallback for older browsers
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            textarea.style.pointerEvents = 'none';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                const success = document.execCommand('copy');
                if (success && button) {
                    const original = button.textContent;
                    button.textContent = 'Copied!';
                    button.style.background = 'rgba(168, 255, 191, 0.2)';
                    setTimeout(() => {
                        button.textContent = original;
                        button.style.background = '';
                    }, 2000);
                } else if (button) {
                    button.textContent = 'Failed';
                    setTimeout(() => {
                        button.textContent = button.dataset.embed ? 'Copy Embed' : 'Copy URL';
                    }, 2000);
                }
            } catch (err) {
                console.error('Copy failed', err);
                if (button) {
                    button.textContent = 'Error';
                    setTimeout(() => {
                        button.textContent = button.dataset.embed ? 'Copy Embed' : 'Copy URL';
                    }, 2000);
                }
            }
            document.body.removeChild(textarea);
        });
    }

    // ----- Media Viewer -----
    function initMediaViewer() {
        mediaViewerClose?.addEventListener('click', closeMediaViewer);
        mediaViewerCopy?.addEventListener('click', () => {
            const url = mediaViewerCopy?.dataset.url;
            copyToClipboard(url, mediaViewerCopy);
        });
        mediaViewerOpen?.addEventListener('click', () => setTimeout(closeMediaViewer, 50));
        mediaViewer?.addEventListener('click', (e) => {
            if (e.target === mediaViewer || e.target.classList.contains('media-viewer__backdrop')) {
                closeMediaViewer();
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeMediaViewer();
        });
    }

    function openMediaViewer(url, name) {
        if (!mediaViewer || !mediaViewerBody || !mediaViewerTitle) return;
        mediaViewerTitle.textContent = name || 'Media';
        mediaViewerBody.innerHTML = '';

        const lower = (url || '').toLowerCase();
        let el;
        if (isVideo(lower)) {
            el = document.createElement('video');
            el.src = url;
            el.controls = true;
            el.autoplay = true;
        } else if (isImage(lower)) {
            el = document.createElement('img');
            el.src = url;
            el.alt = name || 'media';
        } else {
            el = document.createElement('div');
            el.className = 'empty-state';
            el.textContent = 'Preview not available for this file type.';
        }

        mediaViewerBody.appendChild(el);
        mediaViewerCopy.dataset.url = url || '';
        mediaViewerOpen.href = url || '#';
        mediaViewer.classList.remove('hidden');
    }

    function closeMediaViewer() {
        mediaViewer?.classList.add('hidden');
        if (mediaViewerBody) mediaViewerBody.innerHTML = '';
    }

    // ----- Helpers -----
    function isVideo(url = '') {
        const clean = cleanUrl(url);
        return /\.(mp4|webm|ogg|mov|m4v)$/i.test(clean);
    }

    function isImage(url = '') {
        const clean = cleanUrl(url);
        return /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(clean);
    }

    function thumbStyle(url = '') {
        if (isVideo(url)) {
            return 'background: rgba(255,255,255,0.04);';
        }
        if (isImage(url)) {
            return `background-image:url('${url}'); background-size:cover; background-position:center; background-repeat:no-repeat;`;
        }
        return 'background: linear-gradient(135deg, rgba(90,110,255,0.15), rgba(0,0,0,0.25));';
    }

    function getToken() {
        return window.dashboardState?.getAuthToken?.();
    }

    function formatBytes(bytes = 0) {
        if (!bytes) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
    }

    function formatDate(value) {
        return new Date(value).toLocaleString();
    }

    function setFeedback(el, message, state = 'info') {
        if (!el) return;
        el.textContent = message || '';
        el.dataset.state = state;
    }

    function escapeHtml(str = '') {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function cleanUrl(url = '') {
        return url.split('#')[0].split('?')[0];
    }

    // ----- Tic Tac Toe -----
    const matchmakeBtn = byId('matchmakeBtn');
    const leaveQueueBtn = byId('leaveQueueBtn');
    const tttBoard = byId('tttBoard');
    const gameStatus = byId('gameStatus');
    let tttInterval = null;

    function initTicTacToe() {
        console.log('Initializing Tic Tac Toe...', { matchmakeBtn, leaveQueueBtn, tttBoard });
        matchmakeBtn?.addEventListener('click', handleMatchmake);
        leaveQueueBtn?.addEventListener('click', handleLeaveQueue);
        if (tttBoard) {
            tttBoard.querySelectorAll('button').forEach((btn, idx) => {
                btn.addEventListener('click', () => handleTicTacToeMove(idx));
            });
        }
    }

    async function handleMatchmake() {
        const token = getToken();
        if (!token || !currentUser?.isApproved) return;
        try {
            const res = await fetch(`${API_BASE}/tictactoe/queue`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error('queue failed');
            await loadTicTacToeStatus();
        } catch (err) {
            console.error('Matchmake failed', err);
        }
    }

    async function handleLeaveQueue() {
        const token = getToken();
        if (!token) return;
        try {
            await fetch(`${API_BASE}/tictactoe/leave`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
            });
            await loadTicTacToeStatus();
        } catch (err) {
            console.error('Leave queue failed', err);
        }
    }

    async function handleTicTacToeMove(cell) {
        const token = getToken();
        if (!token || !currentUser?.isApproved) return;
        try {
            const res = await fetch(`${API_BASE}/tictactoe/move`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ cell }),
            });
            if (!res.ok) {
                const data = await res.json();
                if (data.error) {
                    setFeedback(gameStatus, data.error, 'error');
                }
                return;
            }
            await loadTicTacToeStatus();
        } catch (err) {
            console.error('Move failed', err);
        }
    }

    async function loadTicTacToeStatus() {
        const token = getToken();
        if (!token || !currentUser?.isApproved) return;
        try {
            const res = await fetch(`${API_BASE}/tictactoe/status`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) return;
            const data = await res.json();
            renderTicTacToe(data);
        } catch (err) {
            console.error('TicTacToe status failed', err);
        }
    }

    function renderTicTacToe(data) {
        if (!gameStatus || !tttBoard) return;
        
        const { queue, game } = data || {};
        
        if (queue) {
            gameStatus.textContent = 'In queue...';
            tttBoard.classList.add('hidden');
            matchmakeBtn?.classList.add('hidden');
            leaveQueueBtn?.classList.remove('hidden');
        } else {
            matchmakeBtn?.classList.remove('hidden');
            leaveQueueBtn?.classList.add('hidden');
        }

        if (game) {
            gameStatus.textContent = game.message || 'Game active';
            tttBoard.classList.remove('hidden');
            
            const board = game.board || [];
            tttBoard.querySelectorAll('button').forEach((btn, idx) => {
                const value = board[idx] || '';
                btn.textContent = value;
                btn.dataset.value = value;
                btn.disabled = game.status !== 'active' || value !== '' || game.turn !== game.yourSymbol;
            });
        } else {
            tttBoard.classList.add('hidden');
            if (!queue) {
                gameStatus.textContent = 'Queue idle.';
            }
        }
    }


    // ----- Admin Panel -----
    const adminApproveForm = byId('adminApproveForm');
    const adminUsernameInput = byId('adminUsernameInput');
    const adminRemoveBtn = byId('adminRemoveBtn');
    const adminFeedback = byId('adminFeedback');
    const approvedUsersList = byId('approvedUsersList');

    function initAdminPanel() {
        console.log('Initializing Admin Panel...', { adminApproveForm, adminRemoveBtn, currentUser });
        adminApproveForm?.addEventListener('submit', handleAdminApprove);
        adminRemoveBtn?.addEventListener('click', handleAdminRemove);
        if (currentUser) {
            loadApprovedUsers();
        }
    }

    async function handleAdminApprove(e) {
        e.preventDefault();
        const token = getToken();
        if (!token) return;
        const username = (adminUsernameInput?.value || '').trim();
        if (!username) return;
        
        try {
            const res = await fetch(`${API_BASE}/admin/approvals`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ username }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'approve failed');
            setFeedback(adminFeedback, `Approved: ${username}`, 'success');
            adminUsernameInput.value = '';
            loadApprovedUsers();
        } catch (err) {
            console.error('Approve failed', err);
            setFeedback(adminFeedback, err.message || 'Approve failed', 'error');
        }
    }

    async function handleAdminRemove() {
        const token = getToken();
        if (!token) return;
        const username = (adminUsernameInput?.value || '').trim();
        if (!username) return;
        if (!confirm(`Remove ${username} from approved users?`)) return;
        
        try {
            const res = await fetch(`${API_BASE}/admin/approvals/${encodeURIComponent(username)}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'remove failed');
            setFeedback(adminFeedback, `Removed: ${username}`, 'success');
            adminUsernameInput.value = '';
            loadApprovedUsers();
        } catch (err) {
            console.error('Remove failed', err);
            setFeedback(adminFeedback, err.message || 'Remove failed', 'error');
        }
    }

    const unapprovedUsersList = byId('unapprovedUsersList');

    async function loadApprovedUsers() {
        const token = getToken();
        if (!token || !approvedUsersList) return;
        try {
            const res = await fetch(`${API_BASE}/admin/approvals`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) return;
            const data = await res.json();
            const approvedUsers = data.approvedUsers || [];
            const unapprovedUsers = data.unapprovedUsers || [];
            
            // Render approved users
            if (approvedUsers.length === 0) {
                approvedUsersList.innerHTML = '<div class="empty-state">No approved users yet.</div>';
            } else {
                approvedUsersList.innerHTML = approvedUsers
                    .map((u) => `<div class="media-bucket">${escapeHtml(u)}</div>`)
                    .join('');
            }
            
            // Render unapproved users
            if (unapprovedUsersList) {
                if (unapprovedUsers.length === 0) {
                    unapprovedUsersList.innerHTML = '<div class="empty-state">All users are approved.</div>';
                } else {
                    unapprovedUsersList.innerHTML = unapprovedUsers
                        .map((u) => {
                            const date = new Date(u.createdAt).toLocaleDateString();
                            return `<div class="media-bucket" style="opacity: 0.7;">
                                <div>
                                    <strong>${escapeHtml(u.username)}</strong>
                                    <div class="bucket-meta">Registered: ${date}</div>
                                </div>
                                <button type="button" class="ghost-btn tiny approve-user-btn" data-username="${escapeHtml(u.username)}">Approve</button>
                            </div>`;
                        })
                        .join('');
                    
                    // Add click handlers for approve buttons
                    unapprovedUsersList.querySelectorAll('.approve-user-btn').forEach(btn => {
                        btn.addEventListener('click', () => {
                            const username = btn.dataset.username;
                            if (username) {
                                adminUsernameInput.value = username;
                                handleAdminApprove({ preventDefault: () => {} });
                            }
                        });
                    });
                }
            }
        } catch (err) {
            console.error('Load approved users failed', err);
        }
    }


    // DOM helper
    function byId(id) {
        return document.getElementById(id);
    }
})();

