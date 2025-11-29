let simulation;
let nodes = [];
let links = [];
let canvas, ctx;
let transform = d3.zoomIdentity;
let physicsEnabled = true;
let startTime;
let userDataCache = new Map();
let loadedUsers = new Set();
let loadingUsers = new Set(); 

async function init() {
    try {
        loadSavedTheme();
        const loadingScreen = document.getElementById('loadingScreen');
        if (loadingScreen) {
            loadingScreen.style.display = 'flex';
        }
        
        updateLoadingProgress(10, 'Loading FriendScape...');
        
        await new Promise(resolve => setTimeout(resolve, 800));
        
        updateLoadingProgress(30, 'Initializing security...');
        
        const isProtected = await verifyCloudflareProtection();
        
        if (!isProtected) {
            throw new Error('Cloudflare verification failed');
        }
        
        updateLoadingProgress(80, 'Security verified! Loading application...');
        toggleCloudflareCheck(false);
        
        await Promise.all([
            checkAuthStatus(),
            setupCanvas(),
            setupEventListeners()
        ]);
        
        updateLoadingProgress(100, 'Ready!');
        
        await new Promise(resolve => setTimeout(resolve, 600));
        
        if (loadingScreen) {
            loadingScreen.opacity = '0';
            setTimeout(() => {
                loadingScreen.style.display = 'none';
            }, 500);
        }
        
        loadFromUrl();
        
    } catch (error) {
        console.error('Initialization error:', error);
        showError(error.message || 'Failed to initialize application');
    }
}
function updateLoadingProgress(progress, text) {
    const progressFill = document.getElementById('progressFill');
    const loadingText = document.getElementById('loadingText');
    
    if (progressFill) {
        progressFill.style.width = `${progress}%`;
    }
    
    if (loadingText && text) {
        loadingText.textContent = text;
        loadingText.style.color = ''; 
    }
}
function toggleCloudflareCheck(show) {
    const cloudflareCheck = document.getElementById('cloudflareCheck');
    if (cloudflareCheck) {
        cloudflareCheck.style.display = show ? 'flex' : 'none';
    }
}

const CLOUDFLARE_SITE_KEY = '0x4AAAAAAB1Cp1P3EaDkTG_U'; // key here
const CLOUDFLARE_VERIFY_URL = '/api/verify-cloudflare';
let turnstileWidgetId = null;
let isVerifying = false;

async function checkAuthStatus() {
    try {
        const response = await fetch('/auth/status');
        const data = await response.json();
        
        updateAuthUI(data);
        return data;
    } catch (error) {
        console.error('Error checking auth status:', error);
        updateAuthUI({ authenticated: false });
        return { authenticated: false };
    }
}
async function verifyCloudflareProtection() {
    return new Promise(async (resolve, reject) => {
        try {
            updateLoadingProgress(50, 'Security verification required');
            toggleCloudflareCheck(true);
            
            await waitForTurnstile();
            
            const turnstileContainer = document.getElementById('cf-turnstile');
            turnstileContainer.style.display = 'block';
            
            turnstileWidgetId = turnstile.render('#cf-turnstile', {
                sitekey: CLOUDFLARE_SITE_KEY,
                theme: document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
                callback: async function(token) {
                    try {
                        isVerifying = true;
                        updateLoadingProgress(70, 'Verifying token...');
                        
                        const verificationResult = await verifyTokenOnServer(token);
                        
                        if (verificationResult.success) {
                            turnstileContainer.style.display = 'none';
                            toggleCloudflareCheck(false);
                            resolve(true);
                        } else {
                            throw new Error(verificationResult.message || 'Verification failed');
                        }
                    } catch (error) {
                        if (turnstileWidgetId) {
                            turnstile.reset(turnstileWidgetId);
                        }
                        reject(error);
                    } finally {
                        isVerifying = false;
                    }
                },
                'error-callback': function() {
                    reject(new Error('Turnstile verification failed'));
                },
                'expired-callback': function() {
                    if (!isVerifying) {
                        turnstile.reset(turnstileWidgetId);
                    }
                }
            });
            
            setTimeout(() => {
                if (!isVerifying) {
                    reject(new Error('Verification timeout'));
                }
            }, 30000);
            
        } catch (error) {
            reject(error);
        }
    });
}
function waitForTurnstile() {
    return new Promise((resolve, reject) => {
        const maxWaitTime = 10000; 
        const startTime = Date.now();
        
        function checkTurnstile() {
            if (typeof turnstile !== 'undefined') {
                resolve();
            } else if (Date.now() - startTime > maxWaitTime) {
                reject(new Error('Turnstile failed to load'));
            } else {
                setTimeout(checkTurnstile, 100);
            }
        }
        
        checkTurnstile();
    });
}
async function verifyTokenOnServer(token) {
    try {
        const response = await fetch(CLOUDFLARE_VERIFY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ token })
        });
        
        if (!response.ok) {
            throw new Error(`Server error: ${response.status}`);
        }
        
        return await response.json();
    } catch (error) {
        console.error('Token verification error:', error);
        throw new Error('Failed to verify token with server');
    }
}
function showError(message) {
    const errorMessage = document.getElementById('errorMessage');
    const loadingText = document.getElementById('loadingText');
    
    if (errorMessage) {
        errorMessage.textContent = message;
        errorMessage.style.display = 'block';
    }
    
    if (loadingText) {
        loadingText.textContent = 'Verification failed';
        loadingText.style.color = '#ef4444';
    }
    
    toggleCloudflareCheck(false);
    
    const loadingContent = document.querySelector('.loading-content');
    const existingRetryBtn = document.querySelector('.retry-btn');
    
    if (loadingContent && !existingRetryBtn) {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'retry-btn';
        retryBtn.textContent = 'Retry Verification';
        retryBtn.onclick = () => window.location.reload();
        loadingContent.appendChild(retryBtn);
    }
}
async function loadUserAndFriends(userId, isRootUser = false, isPathNode = false) {
    if ((!isPathNode && loadedUsers.has(userId)) || loadingUsers.has(userId)) {
        console.log(`User ${userId} already loaded or loading`);
        return;
    }
    
    try {
        if (isRootUser) {
            startTime = Date.now();
        }
        
        loadingUsers.add(userId);
        
        if (isRootUser) {
            showLoading(true);
            updateUrl(userId, 1);
        }
        
        console.log(`Loading friends for user ${userId}`);
        
        const userInfo = await fetchUserInfo(userId);
        if (!userInfo || userInfo.id === -1) {
            throw new Error('User not found or banned');
        }
        const robloxId = userInfo.robloxId || userId;
        
        showLoading(true);
        const existingNode = nodes.find(n => n.id === userId);
        if (!existingNode) {
            const newNode = {
                id: userId,
                robloxId: robloxId,
                username: userInfo.name || userInfo.username || `user_${userId}`,
                displayName: userInfo.displayName || userInfo.name || userInfo.username || `User ${userId}`,
                avatar: userInfo.avatar || `https://via.placeholder.com/150/4f46e5/ffffff?text=User+${userId}`,
                avatarImage: null,
                isOnline: userInfo.isOnline || false,
                depth: isRootUser ? 0 : 1,
                radius: isRootUser ? 25 : 20,
                color: getColorForDepth(isRootUser ? 0 : 1),
                expanded: false,
                loading: false,
                selected: false,
                x: isRootUser ? canvas.width / 2 : Math.random() * canvas.width,
                y: isRootUser ? canvas.height / 2 : Math.random() * canvas.height,
                isPathNode: isPathNode
            };
            nodes.push(newNode);
            
            loadAvatar(newNode);
        }
        
        if (!isPathNode || isRootUser) {
            const response = await fetch(`/api/friends/${robloxId}`);
            if (!response.ok) {
                throw new Error(`Failed to load friends: ${response.status}`);
            }
            
            const friendsData = await response.json();
            const friends = friendsData.data || [];
            
            console.log(`Found ${friends.length} friends for user ${robloxId}`);
            
            if (friends.length > 0) {
                for (const friend of friends) {
                    const friendInfo = await fetchUserInfo(friend.id);
                    if (!friendInfo) continue;
                    
                    const friendInternalId = friendInfo.id || friend.id;
                    const existingFriend = nodes.find(n => n.id === friendInternalId);
                    
                    if (!existingFriend) {
                        const friendNode = {
                            id: friendInternalId,
                            robloxId: friend.id,
                            username: friend.name || friend.username || `user_${friend.id}`,
                            displayName: friend.displayName || friend.name || friend.username || `User ${friend.id}`,
                            avatar: friend.avatar || `https://via.placeholder.com/150/4f46e5/ffffff?text=User+${friend.id}`,
                            avatarImage: null,
                            isOnline: friend.isOnline || false,
                            depth: isRootUser ? 1 : 2,
                            radius: isRootUser ? 20 : 15,
                            color: getColorForDepth(isRootUser ? 1 : 2),
                            expanded: false,
                            loading: false,
                            selected: false,
                            x: Math.random() * canvas.width,
                            y: Math.random() * canvas.height,
                            isPathNode: false
                        };
                        nodes.push(friendNode);
                        
                        loadAvatar(friendNode);
                    }
                    
                    const linkExists = links.find(l => 
                        (l.source === userId && l.target === friendInternalId) ||
                        (l.source === friendInternalId && l.target === userId)
                    );
                    
                    if (!linkExists) {
                        links.push({
                            source: userId,
                            target: friendInternalId,
                            value: 1
                        });
                    }
                }
                
                const userNode = nodes.find(n => n.id === userId);
                if (userNode) {
                    userNode.expanded = true;
                }
            }
        }
        
        if (!isPathNode) {
            loadedUsers.add(userId);
        }
        updateSimulation();
        updateStatistics();
        showLoading(false);
        if (isRootUser && friends.length === 0) {
            showNotification('No friends found for this user', 'warning');
        }
        
    } catch (error) {
        console.error('Error loading user friends:', error);
    } finally {
        loadingUsers.delete(userId);
        if (isRootUser) {
            showLoading(false);
        }
    }
}
function updateAuthUI(authData) {
    const authSection = document.getElementById('auth-section');
    
    if (authData.authenticated && authData.user) {
        authSection.innerHTML = `
            <div class="user-profile" onclick="toggleUserDropdown()">
                <div class="user-avatar">
                    <img src="${authData.user.avatar}" alt="${authData.user.username}">
                    <div class="online-status ${authData.user.isOnline ? 'online' : 'offline'}"></div>
                </div>
                <div class="user-info">
                    <span class="username">${authData.user.username}</span>
                    <span class="user-status">${authData.user.isOnline ? 'Online' : 'Offline'}</span>
                </div>
                <div class="user-dropdown">
                    <i class="fas fa-chevron-down"></i>
                </div>
            </div>
            <div class="dropdown-menu" style="display: none;">
                <button class="dropdown-item" onclick="viewProfile()">
                    <i class="fas fa-user"></i>
                    <span>Load my friends</span>
                </button>
                <button class="dropdown-item" onclick="logout()">
                    <i class="fas fa-sign-out-alt"></i>
                    <span>Logout</span>
                </button>
            </div>
        `;
        
        localStorage.setItem('authData', JSON.stringify(authData));
    } else {
        authSection.innerHTML = `
            <button class="auth-btn" onclick="window.location.href='/auth/login'">
                <i class="fas fa-sign-in-alt"></i> Login with Roblox
            </button>
        `;
        localStorage.removeItem('authData');
    }
}

async function logout() {
    try {
        await fetch('/logout', { method: 'POST' });
        window.location.reload();
    } catch (error) {
        console.error('Logout error:', error);
    }
}
function toggleUserDropdown() {
    const dropdown = document.querySelector('.dropdown-menu');
    const chevron = document.querySelector('.user-dropdown i');
    
    if (dropdown.style.display === 'block') {
        dropdown.style.display = 'none';
        chevron.style.transform = 'rotate(0deg)';
    } else {
        dropdown.style.display = 'block';
        chevron.style.transform = 'rotate(180deg)';
        dropdown.classList.add('show');
    }
}
document.addEventListener('click', (e) => {
    const dropdown = document.querySelector('.dropdown-menu');
    const userProfile = document.querySelector('.user-profile');
    
    if (dropdown.style.display === 'block' && 
        !dropdown.contains(e.target) && 
        !userProfile.contains(e.target)) {
        dropdown.style.display = 'none';
        document.querySelector('.user-dropdown i').style.transform = 'rotate(0deg)';
    }
});
function viewProfile() {
    const authData = JSON.parse(localStorage.getItem('authData') || '{}');
    if (authData.user) {
        clearNetwork();
        loadUserAndFriends(authData.user.id, true);
    }
}
function setupCanvas() {
    return new Promise((resolve) => {
        canvas = document.getElementById('network-canvas');
        ctx = canvas.getContext('2d');
        
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
        
        const zoom = d3.zoom()
            .scaleExtent([0.1, 8])
            .on('zoom', (event) => {
                transform = event.transform;
                render();
            });
        
        d3.select(canvas).call(zoom);
        
        resolve();
    });
}

function resizeCanvas() {
    const container = document.querySelector('.network-container');
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    render();
}

function setupEventListeners() {
    document.getElementById('userInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            loadUserNetwork();
        }
    });
    
    canvas.addEventListener('click', handleCanvasClick);
    
    document.addEventListener('keydown', handleKeyPress);
}

function toggleMenu() {
    const sideMenu = document.getElementById('sideMenu');
    sideMenu.classList.toggle('show');
}
function toggleTheme() {
    const body = document.body;
    const themeIcon = document.getElementById('themeIcon');
    const currentTheme = body.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    
    body.setAttribute('data-theme', newTheme);
    themeIcon.className = newTheme === 'light' ? 'fas fa-moon' : 'fas fa-sun';
    
    document.querySelectorAll('.theme-option').forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('onclick').includes(newTheme)) {
            btn.classList.add('active');
        }
    });
    
    localStorage.setItem('theme', newTheme);
}
function setTheme(theme) {
    const body = document.body;
    const themeIcon = document.getElementById('themeIcon');
    
    body.setAttribute('data-theme', theme);
    themeIcon.className = theme === 'light' ? 'fas fa-moon' : 'fas fa-sun';
    
    document.querySelectorAll('.theme-option').forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('onclick').includes(theme)) {
            btn.classList.add('active');
        }
    });
    
    localStorage.setItem('theme', theme);
    
    const themeItemIcon = document.querySelector('.dropdown-item:nth-child(2) .item-icon i');
    if (themeItemIcon) {
        themeItemIcon.className = theme === 'light' ? 'fas fa-moon' : 'fas fa-sun';
    }
}
function toggleTheme() {
    const currentTheme = document.body.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    toggleUserDropdown();
}
function loadSavedTheme() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme);
}

function togglePhysics() {
    physicsEnabled = !physicsEnabled;
    const physicsBtn = document.getElementById('physicsBtn');
    
    if (physicsEnabled) {
        physicsBtn.innerHTML = '<i class="fas fa-play"></i> Physics: ON';
        physicsBtn.classList.add('active');
        if (simulation) {
            simulation.alphaTarget(0.3).restart();
        }
    } else {
        physicsBtn.innerHTML = '<i class="fas fa-pause"></i> Physics: OFF';
        physicsBtn.classList.remove('active');
        if (simulation) {
            simulation.alphaTarget(0);
        }
    }
}

function centerView() {
    if (nodes.length === 0) return;
    
    const xExtent = d3.extent(nodes, d => d.x);
    const yExtent = d3.extent(nodes, d => d.y);
    
    const width = xExtent[1] - xExtent[0];
    const height = yExtent[1] - yExtent[0];
    
    const scale = 0.85 / Math.max(width / canvas.width, height / canvas.height);
    const translate = [
        canvas.width / 2 - scale * (xExtent[0] + xExtent[1]) / 2,
        canvas.height / 2 - scale * (yExtent[0] + yExtent[1]) / 2
    ];
    
    transform = d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale);
    d3.select(canvas).call(d3.zoom().transform, transform);
    
    render();
}

function updateTurnstileTheme() {
    if (turnstileWidgetId) {
        const theme = document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        turnstile.setTheme(turnstileWidgetId, theme);
    }
}

function clearNetwork() {
    if (simulation) {
        simulation.stop();
    }
    
    nodes = [];
    links = [];
    loadedUsers.clear();
    loadingUsers.clear();
    userDataCache.clear();
    
    updateStatistics();
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    window.history.replaceState({}, '', '/');
}

function exportNetwork() {
    const dataURL = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = 'friendscape-network.png';
    link.href = dataURL;
    link.click();
}

async function loadUserNetwork() {
    const userInput = document.getElementById('userInput').value.trim();
    if (!userInput) return;
    
    let userId = userInput;
    
    if (isNaN(Number(userInput))) {
        try {
            showLoading(true);
            const response = await fetch('/api/search-user', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: userInput })
            });
            
            if (!response.ok) throw new Error('User not found');
            
            const data = await response.json();
            if (!data.data || !data.data.length) throw new Error('User not found');
            
            userId = data.data[0].id;
        } catch (error) {
            console.error('User search error:', error);
            showNotification("Please login first, or user not found", 'error');
            showLoading(false);
            return;
        }
    }
    
    clearNetwork();
    
    await loadUserAndFriends(Number(userId), true);
}
async function fetchUserInfo(userId) {
    try {
        console.log(`Fetching user info for ID: ${userId}`);
        
        const res = await fetch(`/api/user-info/${userId}`);
        const data = await res.json();

        if (!data) {
            console.log(`User ${userId} not found`);
            return null;
        }

        console.log(`User data received:`, data);
        
        return {
            ...data,
            avatar: data.avatar || null
        };
    } catch (err) {
        console.error("Error in fetchUserInfo:", err);
        return null;
    }
}

function updateSimulation() {
    if (simulation) {
        simulation.stop();
    }
    
    if (nodes.length === 0) return;
    
    console.log(`Updating simulation with ${nodes.length} nodes and ${links.length} links`);
    
    simulation = d3.forceSimulation(nodes)
        .force('charge', d3.forceManyBody().strength(-400))
        .force('link', d3.forceLink(links).id(d => d.id).distance(120))
        .force('center', d3.forceCenter(canvas.width / 2, canvas.height / 2))
        .force('collision', d3.forceCollide().radius(d => d.radius + 25))
        .alphaTarget(0)
        .alphaDecay(0.05);
    
    simulation.on('tick', () => {
        if (physicsEnabled) {
            render();
        }
    });
    
    render();
    
    setTimeout(centerView, 500);
}

async function handleCanvasClick(event) {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left - transform.x) / transform.k;
    const y = (event.clientY - rect.top - transform.y) / transform.k;
    
    const clickedNode = nodes.find(node => {
        const distance = Math.sqrt(Math.pow(node.x - x, 2) + Math.pow(node.y - y, 2));
        return distance <= node.radius;
    });
    
    if (clickedNode) {
        nodes.forEach(node => node.selected = false);
        
        clickedNode.selected = true;
        
        console.log(`Clicked on node: ${clickedNode.displayName} (Internal ID: ${clickedNode.id}, Roblox ID: ${clickedNode.robloxId})`);
        
        if (!clickedNode.expanded && !loadingUsers.has(clickedNode.id)) {
            showNotification(`Loading friends for ${clickedNode.displayName}...`, 'info');
            clickedNode.loading = true;
            render();
            
            await loadUserAndFriends(clickedNode.id, false);
            
            clickedNode.loading = false;
        } else if (clickedNode.expanded) {
            showNotification(`${clickedNode.displayName} friends already loaded`, 'info');
        } else {
            showNotification(`Loading friends for ${clickedNode.displayName}...`, 'info');
        }
        
        render();
    }
}

function render() {
    if (!ctx) return;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);
    
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--link-color') || '#e5e7eb';
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.6;
    
    links.forEach(link => {
        if (link.source && link.target && 
            typeof link.source.x === 'number' && 
            typeof link.target.x === 'number' &&
            link.source.id !== -1 &&
            link.target.id !== -1) {
            ctx.beginPath();
            ctx.moveTo(link.source.x, link.source.y);
            ctx.lineTo(link.target.x, link.target.y);
            ctx.stroke();
        }
    });
    
    ctx.globalAlpha = 1;
    
    nodes.forEach(node => {
        if (node.id === -1) return;
        
        if (typeof node.x !== 'number' || typeof node.y !== 'number') return;
        
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, 2 * Math.PI);
        ctx.fillStyle = node.color || '#6366f1';
        ctx.fill();
        
        if (node.avatarImage && node.avatarImage.complete && node.avatarImage.naturalWidth !== 0) {
            try {
                ctx.save();
                
                ctx.beginPath();
                ctx.arc(node.x, node.y, node.radius, 0, 2 * Math.PI);
                ctx.clip();
                
                const imageSize = node.radius * 2;
                ctx.drawImage(
                    node.avatarImage,
                    node.x - node.radius,
                    node.y - node.radius,
                    imageSize,
                    imageSize
                );
                
                ctx.restore();
            } catch (e) {
                console.warn('Error drawing avatar:', e);
                ctx.beginPath();
                ctx.arc(node.x, node.y, node.radius, 0, 2 * Math.PI);
                ctx.fillStyle = node.color || '#6366f1';
                ctx.fill();
            }
        }
        
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, 2 * Math.PI);
        ctx.strokeStyle = node.selected ? '#ef4444' : 
                         node.loading ? '#f59e0b' : 
                         node.expanded ? '#10b981' : '#ffffff';
        ctx.lineWidth = node.selected ? 3 : 2;
        ctx.stroke();
        
        if (!node.expanded && node.depth < 2) {
            ctx.beginPath();
            ctx.arc(node.x + node.radius - 6, node.y - node.radius + 6, 4, 0, 2 * Math.PI);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.strokeStyle = '#4f46e5';
            ctx.lineWidth = 1;
            ctx.stroke();
            
            ctx.strokeStyle = '#4f46e5';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(node.x + node.radius - 8, node.y - node.radius + 6);
            ctx.lineTo(node.x + node.radius - 4, node.y - node.radius + 6);
            ctx.moveTo(node.x + node.radius - 6, node.y - node.radius + 4);
            ctx.lineTo(node.x + node.radius - 6, node.y - node.radius + 8);
            ctx.stroke();
        }
        
        if (node.loading) {
            const time = Date.now() * 0.01;
            ctx.save();
            ctx.translate(node.x, node.y);
            ctx.rotate(time);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(0, 0, node.radius + 5, 0, Math.PI);
            ctx.stroke();
            ctx.restore();
        }
        
        if (transform.k > 0.5) {
            const isDarkTheme = document.body.getAttribute('data-theme') === 'dark';
            ctx.fillStyle = isDarkTheme ? '#ffffff' : '#000000';
            ctx.font = `${Math.max(10, 12 * Math.min(transform.k, 1))}px Arial`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            
            ctx.shadowColor = isDarkTheme ? 'rgba(0, 0, 0, 0.8)' : 'rgba(255, 255, 255, 0.8)';
            ctx.shadowBlur = 2;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 1;
            
            const displayName = node.displayName || node.username || `User ${node.id}`;
            ctx.fillText(displayName, node.x, node.y + node.radius + 15);
            
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
        }
    });
    
    ctx.restore();
}
function loadAvatar(node) {
    if (node.avatarImage || node.avatarLoading) return;
    
    console.log(`Loading avatar for ${node.username}: ${node.avatar}`);
    node.avatarLoading = true;
    
    const img = new Image();
    
    img.onload = () => {
        console.log(`✅ Avatar loaded for ${node.username}`);
        node.avatarImage = img;
        node.avatarLoading = false;
        render();
    };
    
    img.onerror = (e) => {
        console.warn(`❌ Failed to load avatar for ${node.username}: ${node.avatar}`, e);
        node.avatarLoading = false;
        node.avatarImage = null;
        render();
    };
    
    if (node.avatar && node.avatar.startsWith('http')) {
        img.crossOrigin = 'Anonymous';
    }
    
    img.src = node.avatar;
}
function updateStatistics() {
    const loadTime = startTime ? ((Date.now() - startTime) / 1000).toFixed(2) : '0';
    
    document.getElementById('totalNodes').textContent = nodes.length;
    document.getElementById('totalConnections').textContent = links.length;
    document.getElementById('networkDepth').textContent = Math.max(...nodes.map(n => n.depth), 0);
    document.getElementById('loadTime').textContent = `${loadTime}s`;
}

function handleKeyPress(event) {
    if (event.key === 'r' || event.key === 'R') {
        centerView();
    } else if (event.key === ' ') {
        event.preventDefault();
        togglePhysics();
    } else if (event.key === 'Escape') {
        clearNetwork();
    }
}

function updateUrl(userId, depth) {
    const url = new URL(window.location);
    url.searchParams.set('user', userId);
    url.searchParams.set('depth', depth);
    window.history.pushState({}, '', url);

}

async function findShortestPath() {
    const startUser = document.getElementById('startUser').value.trim();
    const endUser = document.getElementById('endUser').value.trim();
    
    if (!startUser || !endUser) {
        showNotification('Please enter both start and target users', 'error');
        return;
    }

    try {
        showLoading(true, 'Finding shortest path...');
        
        const startId = await getUserIdFromInput(startUser);
        const endId = await getUserIdFromInput(endUser);
        
        if (!startId || !endId) {
            showNotification('One or both users not found', 'error');
            return;
        }

        const path = await findConnectionPath(startId, endId);
        
        if (path && path.length > 0) {
            const degrees = path.length - 1;
            showNotification(`Found path with ${degrees} degrees of separation!`, 'success');
            
            showPathResult(path, degrees);
            
            clearNetwork();
            
            await loadConnectionPath(path);
        } else {
            showNotification('No connection found between these users', 'warning');
            hidePathResult();
        }
    } catch (error) {
        console.error('Shortest path error:', error);
        showNotification('Failed to find connection', 'error');
        hidePathResult();
    } finally {
        showLoading(false);
    }
}
async function getUserIdFromInput(input) {
    if (!isNaN(Number(input))) {
        return Number(input);
    }
    
    try {
        const response = await fetch('/api/search-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: input })
        });
        
        if (!response.ok) throw new Error('User not found');
        
        const data = await response.json();
        if (!data.data || !data.data.length) throw new Error('User not found');
        
        return data.data[0].id;
    } catch (error) {
        console.error('User search error:', error);
        return null;
    }
}
async function findConnectionPath(sourceId, targetId, maxDepth = 6) {
    try {
        const response = await fetch('/api/find-connection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                sourceId, 
                targetId, 
                maxDepth 
            })
        });
        
        if (!response.ok) throw new Error('Failed to find connection');
        
        const data = await response.json();
        return data.path || [];
    } catch (error) {
        console.error('Find connection error:', error);
        return null;
    }
}
async function loadConnectionPath(path) {
    if (!path || path.length < 2) return;
    
    for (let i = 0; i < path.length; i++) {
        const userId = path[i];
        const isRootUser = i === 0;
        
        await loadUserAndFriends(userId, isRootUser);
        
        if (i < path.length - 1) {
            const nextUserId = path[i + 1];
            
            const linkExists = links.find(l => 
                (l.source === userId && l.target === nextUserId) ||
                (l.source === nextUserId && l.target === userId)
            );
            
            if (!linkExists) {
                links.push({
                    source: userId,
                    target: nextUserId,
                    value: 1
                });
            }
        }
    }
    
    updateSimulation();
    centerView();
}

function showPathResult(path, degrees) {
    const pathResult = document.getElementById('pathResult');
    if (!pathResult) return;
    
    let html = `<div class="path-result">
        <h4>Connection Found!</h4>
        <p><strong>${degrees} degrees</strong> of separation</p>
        <div class="path-steps">`;
    
    path.forEach((userId, index) => {
        html += `<div class="path-step">
            <span class="step-number">${index + 1}</span>
            <span class="step-user">${userId}</span>
        </div>`;
        if (index < path.length - 1) {
            html += '<div class="step-arrow">→</div>';
        }
    });
    
    html += `</div></div>`;
    
    pathResult.innerHTML = html;
    pathResult.style.display = 'block';
}
function hidePathResult() {
    const pathResult = document.getElementById('pathResult');
    if (pathResult) {
        pathResult.style.display = 'none';
    }
}
function showLoading(show, message = 'Loading...') {
    const loading = document.getElementById('loading');
    const loadingText = document.getElementById('loadingText');
    
    if (loading) {
        loading.style.display = show ? 'flex' : 'none';
    }
    
    if (loadingText && message) {
        loadingText.textContent = message;
    }
}
function loadFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    const userId = urlParams.get('user');
    
    if (userId) {
        loadUserAndFriends(parseInt(userId), true);
    }
}

function zoomIn() {
    transform = transform.scale(1.2);
    d3.select(canvas).call(d3.zoom().transform, transform);
    render();
}

function zoomOut() {
    transform = transform.scale(0.8);
    d3.select(canvas).call(d3.zoom().transform, transform);
    render();
}

function resetZoom() {
    transform = d3.zoomIdentity;
    d3.select(canvas).call(d3.zoom().transform, transform);
    render();
}

function showLoading(show) {
    const loading = document.getElementById('loading');
    if (loading) {
        loading.style.display = show ? 'flex' : 'none';
    }
}

function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.innerHTML = `
        <i class="fas fa-${type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i>
        ${message}
    `;
    
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 12px 16px;
        border-radius: 6px;
        color: white;
        font-size: 14px;
        z-index: 10000;
        opacity: 0;
        transform: translateX(100%);
        transition: all 0.3s ease;
        background-color: ${type === 'error' ? '#ef4444' : type === 'warning' ? '#f59e0b' : '#10b981'};
        max-width: 300px;
    `;
    
    document.body.appendChild(notification);
    

    setTimeout(() => {
        notification.style.opacity = '1';
        notification.style.transform = 'translateX(0)';
    }, 100);

    setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transform = 'translateX(100%)';
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }, 3000);
}


function getColorForDepth(depth) {
    const colors = ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#ef4444'];
    return colors[depth % colors.length];
}


document.addEventListener('DOMContentLoaded', init);



window.addEventListener('popstate', loadFromUrl);
