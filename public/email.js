// API configuration
const API_BASE = window.location.origin.includes('media.larpgod.xyz') 
    ? 'https://media.larpgod.xyz/api'
    : '/api';
const ownerUsername = (window.__LARP_CONFIG__?.ownerUsername || 'dot').toLowerCase();

// State
let authToken = null;
let currentUser = null;
let currentAuthMode = 'login';
window.dashboardState = {
    getAuthToken: () => authToken,
    getCurrentUser: () => currentUser
};

function emitUserChange() {
    window.dashboardState.getAuthToken = () => authToken;
    window.dashboardState.getCurrentUser = () => currentUser;
    window.dispatchEvent(new CustomEvent('larp:user-change', { detail: currentUser }));
}

function isOwnerUser(user = currentUser) {
    if (!user || !user.username) return false;
    return user.username.toLowerCase() === ownerUsername;
}

function safeParseUser(raw) {
    try {
        return JSON.parse(raw || '');
    } catch {
        return null;
    }
}

function clearDataDisplays() {
    const emailList = document.getElementById('emailAddressesList');
    const messagesList = document.getElementById('messagesList');
    const pendingMessage = '<div class="empty-state">Pending approval.</div>';
    if (emailList) emailList.innerHTML = pendingMessage;
    if (messagesList) messagesList.innerHTML = pendingMessage;
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setAuthMode('login');
    initParticles();
    setupEventListeners();
    initPasswordToggles();
    checkAuth();
});

// Check if user is authenticated
async function checkAuth() {
    const token = localStorage.getItem('authToken');
    const cachedUser = safeParseUser(localStorage.getItem('currentUser'));

    if (!token) {
        showAuthUI();
        return;
    }

    // Use cached session immediately for smoother reloads
    if (cachedUser) {
        authToken = token;
        currentUser = cachedUser;
        emitUserChange();
        showAuthenticatedUI();
        updateBodyState();
    }

    try {
        const response = await fetch(`${API_BASE}/me`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.status === 401 || response.status === 403) {
            // Only bounce to login if we have no cached user to trust
            if (!cachedUser) {
                throw new Error('unauthorized');
            }
            return;
        }

        if (response.ok) {
            const data = await response.json();
            authToken = token;
            currentUser = data.user;
            localStorage.setItem('authToken', authToken);
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            emitUserChange();
            showAuthenticatedUI();
            handlePostLoginState();
        } else {
            console.warn('Auth refresh failed, keeping cached session');
        }
    } catch (err) {
        if ((err.message || '').includes('unauthorized')) {
            console.error('Auth check failed, staying on auth UI:', err);
            showAuthUI();
        } else {
            console.warn('Auth check error, using cached session if available:', err);
        }
    }
}

// Setup event listeners
function setupEventListeners() {
    document.querySelectorAll('.js-auth-switch').forEach(btn => {
        btn.addEventListener('click', () => setAuthMode(btn.dataset.authMode));
    });

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', logout);
    }

    document.getElementById('loginForm')?.addEventListener('submit', handleLogin);
    document.getElementById('registerForm')?.addEventListener('submit', handleRegister);

    const createEmailBtn = document.getElementById('createEmailBtn');
    if (createEmailBtn) {
        createEmailBtn.addEventListener('click', createEmailAddress);
    }

    const refreshMessagesBtn = document.getElementById('refreshMessagesBtn');
    if (refreshMessagesBtn) {
        refreshMessagesBtn.addEventListener('click', () => {
            loadEmailAddresses();
            loadMessages();
        });
    }

    const showAllMessagesBtn = document.getElementById('showAllMessagesBtn');
    if (showAllMessagesBtn) {
        showAllMessagesBtn.addEventListener('click', () => {
            loadMessages();
        });
    }

    document.querySelectorAll('.close').forEach(closeBtn => {
        closeBtn.addEventListener('click', (e) => {
            e.target.closest('.modal').style.display = 'none';
        });
    });

    window.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal')) {
            e.target.style.display = 'none';
        }
    });
}

// Password toggle functionality
function initPasswordToggles() {
    const toggles = document.querySelectorAll('.password-toggle');
    toggles.forEach(toggle => {
        toggle.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const wrapper = toggle.closest('.password-input-wrapper');
            const input = wrapper?.querySelector('input[type="password"], input[type="text"]');
            const eyeIcon = toggle.querySelector('.eye-icon');
            if (!input) return;

            const showing = input.type === 'password';
            input.type = showing ? 'text' : 'password';
            toggle.setAttribute('aria-label', showing ? 'Hide password' : 'Show password');
            if (eyeIcon) {
                eyeIcon.textContent = showing ? '👁' : '🙈';
            }
        });
    });
}

function setAuthMode(mode) {
    currentAuthMode = mode === 'register' ? 'register' : 'login';
    const authCard = document.querySelector('.auth-card');
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    const title = document.getElementById('authTitle');

    if (authCard) {
        authCard.setAttribute('data-mode', currentAuthMode);
    }

    if (title) {
        title.textContent = currentAuthMode === 'register' ? 'Register' : 'Sign In';
    }

    if (loginForm && registerForm) {
        loginForm.classList.toggle('active', currentAuthMode === 'login');
        registerForm.classList.toggle('active', currentAuthMode === 'register');
    }

    document.querySelectorAll('.auth-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.authMode === currentAuthMode);
    });
}

function initParticles() {
    if (typeof particlesJS === 'undefined') return;

    particlesJS("particles-js", {
        "particles": {
            "number": {
                "value": 355,
                "density": {
                    "enable": true,
                    "value_area": 789.15
                }
            },
            "color": {
                "value": "#ffffff"
            },
            "shape": {
                "type": "circle",
                "stroke": {
                    "width": 0,
                    "color": "#000000"
                },
                "polygon": {
                    "nb_sides": 5
                },
                "image": {
                    "src": "img/github.svg",
                    "width": 100,
                    "height": 100
                }
            },
            "opacity": {
                "value": 0.6,
                "random": true,
                "anim": {
                    "enable": true,
                    "speed": 0.3,
                    "opacity_min": 0.2,
                    "sync": false
                }
            },
            "size": {
                "value": 2,
                "random": true,
                "anim": {
                    "enable": true,
                    "speed": 0.333,
                    "size_min": 0,
                    "sync": false
                }
            },
            "line_linked": {
                "enable": false,
                "distance": 150,
                "color": "#ffffff",
                "opacity": 0.4,
                "width": 1
            },
            "move": {
                "enable": true,
                "speed": 0.8,
                "direction": "none",
                "random": true,
                "straight": false,
                "out_mode": "out",
                "bounce": false,
                "attract": {
                    "enable": false,
                    "rotateX": 600,
                    "rotateY": 1200
                }
            }
        },
        "interactivity": {
            "detect_on": "canvas",
            "events": {
                "onhover": {
                    "enable": true,
                    "mode": "bubble"
                },
                "onclick": {
                    "enable": true,
                    "mode": "push"
                },
                "resize": true
            },
            "modes": {
                "grab": {
                    "distance": 400,
                    "line_linked": {
                        "opacity": 1
                    }
                },
                "bubble": {
                    "distance": 150,
                    "size": 4,
                    "duration": 2,
                    "opacity": 1,
                    "speed": 3
                },
                "repulse": {
                    "distance": 200,
                    "duration": 0.4
                },
                "push": {
                    "particles_nb": 4
                },
                "remove": {
                    "particles_nb": 2
                }
            }
        },
        "retina_detect": true
    });
}

// Auth functions
async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    const errorDiv = document.getElementById('loginError');

    try {
        const response = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (response.ok) {
            persistSession(data.token, data.user);
            errorDiv.textContent = '';
        } else {
            errorDiv.textContent = data.error || 'Login failed';
        }
    } catch (err) {
        errorDiv.textContent = 'Network error. Please try again.';
    }
}

async function handleRegister(e) {
    e.preventDefault();
    const username = document.getElementById('registerUsername').value;
    const password = document.getElementById('registerPassword').value;
    const errorDiv = document.getElementById('registerError');

    try {
        const response = await fetch(`${API_BASE}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (response.ok) {
            persistSession(data.token, data.user);
            errorDiv.textContent = '';
        } else {
            errorDiv.textContent = data.error || 'Registration failed';
        }
    } catch (err) {
        errorDiv.textContent = 'Network error. Please try again.';
    }
}

function logout() {
    authToken = null;
    currentUser = null;
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    emitUserChange();
    clearDataDisplays();
    showAuthUI();
}

function persistSession(token, user) {
    authToken = token;
    currentUser = user;
    localStorage.setItem('authToken', authToken);
    localStorage.setItem('currentUser', JSON.stringify(currentUser));
    emitUserChange();
    showAuthenticatedUI();
    handlePostLoginState();
}

function showAuthUI() {
    const authShell = document.getElementById('authShell');
    const mainContent = document.getElementById('mainContent');
    const appShell = document.querySelector('.app-shell');

    if (authShell) {
        authShell.style.display = 'flex';
    }

    if (mainContent) {
        mainContent.style.display = 'none';
    }

    setAuthMode('login');

    if (appShell) {
        appShell.classList.remove('dashboard-view');
    }

    document.body.classList.remove('pending-account', 'is-owner');
}

function showAuthenticatedUI() {
    const authShell = document.getElementById('authShell');
    const mainContent = document.getElementById('mainContent');
    const appShell = document.querySelector('.app-shell');

    if (authShell) {
        authShell.style.display = 'none';
    }

    if (mainContent) {
        mainContent.style.display = 'block';
    }

    updateBodyState();

    const usernameDisplay = document.getElementById('usernameDisplay');
    if (usernameDisplay) {
        usernameDisplay.textContent = currentUser.username;
    }

    if (appShell) {
        appShell.classList.add('dashboard-view');
    }
}

function updateBodyState() {
    document.body.classList.toggle('pending-account', Boolean(currentUser && !currentUser.isApproved));
    document.body.classList.toggle('is-owner', isOwnerUser());
}

function handlePostLoginState() {
    const hasEmailUI = Boolean(document.getElementById('emailAddressesList') || document.getElementById('messagesList'));
    if (!hasEmailUI) return;

    if (currentUser && currentUser.isApproved) {
        loadEmailAddresses();
        loadMessages();
    } else {
        clearDataDisplays();
    }
}

// Modal functions
function showModal(modalId) {
    document.getElementById(modalId).style.display = 'block';
}

function hideModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
}

// Email address functions
async function createEmailAddress() {
    if (!currentUser || !currentUser.isApproved) {
        alert('Account pending approval.');
        return;
    }

    const ttlInput = document.getElementById('ttlInput');
    const ttlHours = parseInt(ttlInput?.value, 10) || 5;
    
    try {
        const response = await fetch(`${API_BASE}/email-addresses`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ ttlHours })
        });

        const data = await response.json();

        if (response.ok) {
            loadEmailAddresses();
        } else {
            alert(data.error || 'Failed to create email address');
        }
    } catch (err) {
        alert('Network error. Please try again.');
    }
}

async function loadEmailAddresses() {
    if (!authToken || !currentUser || !currentUser.isApproved) {
        clearDataDisplays();
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/email-addresses`, {
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });

        const data = await response.json();

        if (response.ok) {
            displayEmailAddresses(data.emailAddresses);
        } else {
            if (response.status === 401) {
                logout();
            }
        }
    } catch (err) {
        console.error('Error loading email addresses:', err);
    }
}

function displayEmailAddresses(addresses) {
    const listDiv = document.getElementById('emailAddressesList');
    if (!listDiv) return;
    
    if (!Array.isArray(addresses) || addresses.length === 0) {
        listDiv.innerHTML = '<div class="empty-state">No email addresses yet. Create one to get started!</div>';
        return;
    }

    listDiv.innerHTML = addresses.map(addr => {
        const expiresAt = new Date(addr.expiresAt);
        const timeRemaining = getTimeRemaining(expiresAt);
        
        return `
            <div class="email-item">
                <h3>${addr.fullAddress}</h3>
                <div class="meta">
                    Created: ${new Date(addr.createdAt).toLocaleString()}<br>
                    Expires: ${expiresAt.toLocaleString()} (${timeRemaining})
                </div>
                <button class="delete-btn" onclick="deleteEmailAddress(${addr.id})">Delete</button>
                <button class="secondary" onclick="viewMessagesForAddress(${addr.id})">View Messages</button>
            </div>
        `;
    }).join('');
}

async function deleteEmailAddress(id) {
    if (!currentUser || !currentUser.isApproved) {
        return;
    }

    if (!confirm('Are you sure you want to delete this email address? All messages will be lost.')) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/email-addresses/${id}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });

        if (response.ok) {
            loadEmailAddresses();
            loadMessages();
        } else {
            alert('Failed to delete email address');
        }
    } catch (err) {
        alert('Network error. Please try again.');
    }
}

async function viewMessagesForAddress(addressId) {
    if (!currentUser || !currentUser.isApproved) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/email-addresses/${addressId}/messages`, {
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });

        const data = await response.json();

        if (response.ok) {
            displayMessages(data.messages);
        }
    } catch (err) {
        console.error('Error loading messages:', err);
    }
}

// Message functions
async function loadMessages() {
    if (!authToken || !currentUser || !currentUser.isApproved) {
        clearDataDisplays();
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/messages`, {
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });

        const data = await response.json();

        if (response.ok) {
            displayMessages(data.messages);
        } else {
            if (response.status === 401) {
                logout();
            }
        }
    } catch (err) {
        console.error('Error loading messages:', err);
    }
}

function displayMessages(messages) {
    const listDiv = document.getElementById('messagesList');
    if (!listDiv) return;
    
    if (!Array.isArray(messages) || messages.length === 0) {
        listDiv.innerHTML = '<div class="empty-state">No messages yet. Share your email address to receive mail!</div>';
        return;
    }

    listDiv.innerHTML = messages.map(msg => {
        const preview = msg.bodyText ? msg.bodyText.substring(0, 100) : '(No content)';
        
        return `
            <div class="message-item" onclick="viewMessage(${msg.id}, '${escapeHtml(msg.bodyHtml || msg.bodyText || '')}')">
                <div class="from">From: ${escapeHtml(msg.fromAddress)}</div>
                <div class="subject">To: ${escapeHtml(msg.emailAddress || '')}</div>
                <div class="subject">Subject: ${escapeHtml(msg.subject)}</div>
                <div class="preview">${escapeHtml(preview)}</div>
                <div class="meta" style="margin-top: 5px; font-size: 12px;">
                    ${new Date(msg.receivedAt).toLocaleString()}
                </div>
            </div>
        `;
    }).join('');
}

function viewMessage(id, bodyHtml) {
    const messages = Array.from(document.querySelectorAll('.message-item'));
    const messageElement = messages.find(el => el.onclick.toString().includes(`viewMessage(${id}`));
    
    if (!messageElement) return;

    const contentDiv = document.getElementById('messageContent');
    const modal = document.getElementById('messageModal');
    if (!contentDiv || !modal) return;

    const fromAddress = messageElement.querySelector('.from').textContent.replace('From: ', '');
    const subject = messageElement.querySelector('.subject').textContent.replace('To: ', '').split('Subject: ')[1] || '';
    const receivedAt = messageElement.querySelector('.meta').textContent;

    contentDiv.innerHTML = `
        <div class="message-header">
            <h3>${escapeHtml(subject)}</h3>
            <div class="meta">
                <strong>From:</strong> ${escapeHtml(fromAddress)}<br>
                <strong>Received:</strong> ${receivedAt}
            </div>
        </div>
        <div class="message-body ${bodyHtml.includes('<') ? 'html' : ''}">
            ${bodyHtml || '<em>No content</em>'}
        </div>
    `;

    showModal('messageModal');
}

// Utility functions
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function getTimeRemaining(expiresAt) {
    const now = new Date();
    const diff = expiresAt - now;
    
    if (diff <= 0) return 'Expired';
    
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    
    if (hours > 0) {
        return `${hours}h ${minutes}m remaining`;
    } else {
        return `${minutes}m remaining`;
    }
}

setInterval(() => {
    if (authToken && currentUser && currentUser.isApproved) {
        loadMessages();
    }
}, 30000);
