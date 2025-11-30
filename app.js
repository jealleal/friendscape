require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const basicAuth = require('express-basic-auth');
const { Issuer, custom, generators } = require('openid-client');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fetch = require('node-fetch');
const noblox = require('noblox.js');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const ROBLOX_API_BASE = 'https://friends.roproxy.com/v1';
const ROBLOX_USERS_API = 'https://users.roproxy.com/v1';
const ROBLOX_THUMBNAILS_API = 'https://thumbnails.roproxy.com/v1';
const app = express();
const PORT = process.env.PORT || 3000;
// Configuration
const ROBLOX_CLIENT_ID = process.env.ROBLOX_CLIENT_ID;
const ROBLOX_CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET || 'friendscape-jwt-secret';
let oauthClient;

class RateLimiter {
    constructor(maxRequests = 5, timeWindow = 1000) {
        this.maxRequests = maxRequests;
        this.timeWindow = timeWindow;
        this.requests = [];
        this.queue = [];
        this.isProcessing = false;
    }

    async makeRequest(fn, ...args) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, args, resolve, reject });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        while (this.queue.length > 0) {
            const now = Date.now();
            this.requests = this.requests.filter(time => now - time < this.timeWindow);

            if (this.requests.length >= this.maxRequests) {
                const waitTime = this.timeWindow - (now - this.requests[0]);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }

            const { fn, args, resolve, reject } = this.queue.shift();
            this.requests.push(Date.now());

            try {
                const result = await fn(...args);
                resolve(result);
            } catch (error) {
                reject(error);
            }

            // Небольшая задержка между запросами
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        this.isProcessing = false;
    }
}
const userInfoLimiter = new RateLimiter(5, 1000);
const friendsLimiter = new RateLimiter(3, 1000); 
const avatarsLimiter = new RateLimiter(10, 1000);
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, "public")));
app.use(cookieParser(JWT_SECRET));
app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? false : true,
    credentials: true
}));
async function makeRobloxApiRequest(url, options = {}, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const response = await fetch(url, {
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            });

            if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After') || 5;
                const delay = parseInt(retryAfter) * 100;
                console.log(`Rate limited. Waiting ${delay}ms before retry ${attempt + 1}`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            if (!response.ok) {
                throw new Error(`Roblox API error: ${response.status} ${response.statusText}`);
            }

            return await response.json();
        } catch (error) {
            if (attempt === retries - 1) {
                console.error('Roblox API request failed after retries:', error.message);
                throw error;
            }
            
            const delay = Math.pow(2, attempt) * 1000;
            console.log(`Request failed. Waiting ${delay}ms before retry ${attempt + 1}`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}
// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'friendscape-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        httpOnly: true
    }
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: process.env.NODE_ENV === 'production' ? 100 : 1000,
    message: { error: 'Too many requests, please try again later.' }
});
app.use(limiter);


const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'friendscape_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    acquireTimeout: 60000,
    timeout: 60000,
    reconnect: true
});


const MOCK_USERS = new Map();
const MOCK_FRIENDSHIPS = new Map();


function initializeMockData() {

    for (let i = 1; i <= 100; i++) {
        MOCK_USERS.set(i, {
            id: i,
            roblox_id: i.toString(),
            username: `user${i}`,
            displayName: `User ${i}`,
            avatar: `https://via.placeholder.com/150/4f46e5/ffffff?text=User+${i}`,
            isOnline: Math.random() > 0.5,
            created_at: new Date()
        });
    }


    for (let userId = 1; userId <= 50; userId++) {
        const friendsCount = 3 + Math.floor(Math.random() * 15);
        const friends = [];
        
        for (let j = 0; j < friendsCount; j++) {
            let friendId;
            do {
                friendId = 1 + Math.floor(Math.random() * 100);
            } while (friendId === userId || friends.includes(friendId));
            
            friends.push(friendId);
        }
        
        MOCK_FRIENDSHIPS.set(userId, friends);
        

        friends.forEach(friendId => {
            if (!MOCK_FRIENDSHIPS.has(friendId)) {
                MOCK_FRIENDSHIPS.set(friendId, []);
            }
            if (!MOCK_FRIENDSHIPS.get(friendId).includes(userId)) {
                MOCK_FRIENDSHIPS.get(friendId).push(userId);
            }
        });
    }
    
    console.log(`✅ Mock data initialized: ${MOCK_USERS.size} users, ${MOCK_FRIENDSHIPS.size} friendship networks`);
}

async function initializeOAuthClient() {
    if (!ROBLOX_CLIENT_ID || !ROBLOX_CLIENT_SECRET) {
        console.log('⚠️  OAuth credentials not configured, using mock authentication');
        return;
    }

    try {
        console.log('Initializing OAuth client...');
        
        const issuer = await Issuer.discover('https://apis.roproxy.com/oauth/.well-known/openid-configuration');
        
        oauthClient = new issuer.Client({
            client_id: ROBLOX_CLIENT_ID,
            client_secret: ROBLOX_CLIENT_SECRET,
            redirect_uris: 'https://friendscape-1.onrender.com/auth/callback',
            response_types: ['code'],
            scope: 'openid profile',
            id_token_signed_response_alg: 'ES256'
        });

        oauthClient[custom.clock_tolerance] = 180;
        console.log('✅ OAuth client initialized successfully');
    } catch (error) {
        console.error('❌ OAuth initialization error:', error.message);
        console.log('⚠️  Continuing without OAuth - using mock authentication');
    }
}


async function initializeNoblox() {
    if (!process.env.ROBLOX_COOKIE) {
        console.log('⚠️  Roblox cookie not configured, API calls will be limited');
        return;
    }

    try {
        await noblox.setCookie(process.env.ROBLOX_COOKIE);
        console.log('✅ Noblox initialized successfully');
    } catch (error) {
        console.error('❌ Noblox initialization error:', error.message);
    }
}


async function initializeDatabase() {
    try {
        const connection = await pool.getConnection();
        
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                roblox_id VARCHAR(255) UNIQUE NOT NULL,
                username VARCHAR(255) NOT NULL,
                display_name VARCHAR(255),
                avatar VARCHAR(512),
                is_online BOOLEAN DEFAULT FALSE,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_roblox_id (roblox_id),
                INDEX idx_username (username)
            )
        `);
        try {
            await connection.execute(`
                ALTER TABLE users 
                ADD COLUMN IF NOT EXISTS new_column VARCHAR(255) AFTER display_name
            `);
            console.log('✅ Added new_column to users table');
        } catch (error) {
            console.log('ℹ️ new_column already exists or could not be added');
        }
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS friendships (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                friend_id INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE KEY unique_friendship (user_id, friend_id),
                INDEX idx_user_id (user_id),
                INDEX idx_friend_id (friend_id)
            )
        `);
        
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS user_sessions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                access_token TEXT,
                refresh_token TEXT,
                expires_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        connection.release();
        console.log('✅ Database initialized successfully');
    } catch (error) {
        console.error('❌ Database initialization error:', error.message);
        console.log('⚠️  Continuing without database - using mock data');
    }
}


function requireAuth(req, res, next) {
    const token = req.cookies.auth_token || req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        req.userRobloxId = decoded.robloxId;
        next();
    } catch (error) {
        console.error('Token verification error:', error.message);
        res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// OAuth routes
app.get('/api/auth', (req, res) => {
    if (!oauthClient) {
        console.log('Using mock login (OAuth not configured)');
        return res.redirect('/auth/mock-login');
    }

    const state = generators.state();
    const nonce = generators.nonce();

    req.session.oauth_state = state;
    req.session.oauth_nonce = nonce;

    const authUrl = oauthClient.authorizationUrl({
        scope: 'openid profile',
        state,
        nonce,
    });

    res.redirect(authUrl);
});

app.get('/auth/login', (req, res) => {
    res.redirect('/api/auth');
});

app.get('/auth/mock-login', (req, res) => {
    // Mock authentication for development
    const mockUserId = Math.floor(Math.random() * 50) + 1;
    const mockUser = MOCK_USERS.get(mockUserId);
    
    if (!mockUser) {
        return res.status(500).redirect('/?error=mock_user_not_found');
    }
    
    req.session.userId = mockUser.id;
    req.session.user = mockUser;
    
    const token = jwt.sign({ 
        userId: mockUser.id,
        robloxId: mockUser.roblox_id
    }, JWT_SECRET, { expiresIn: '7d' });
    
    res.cookie('auth_token', token, { 
        httpOnly: true, 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    }).redirect('/?login=success&mock=true');
});

app.get('/auth/callback', async (req, res) => {
    try {
        if (!oauthClient) {
            throw new Error('OAuth client not initialized');
        }

        const params = oauthClient.callbackParams(req);
        
        if (!req.session.oauth_state || !req.session.oauth_nonce) {
            throw new Error('Invalid OAuth state');
        }
        
        const tokenSet = await oauthClient.callback(
            'https://friendscape-1.onrender.com/auth/callback',
            params,
            {
                state: req.session.oauth_state,
                nonce: req.session.oauth_nonce,
            }
        );

        const userInfo = await oauthClient.userinfo(tokenSet);
        const { sub, nickname: username, picture } = userInfo;

        const connection = await pool.getConnection();
        try {
            let [users] = await connection.execute('SELECT * FROM users WHERE roblox_id = ?', [sub]);
            let user = users[0];

            if (!user) {
                const [result] = await connection.execute(
                    'INSERT INTO users (roblox_id, username, display_name, avatar) VALUES (?, ?, ?, ?)',
                    [sub, username, username, picture]
                );
                user = {
                    id: result.insertId,
                    roblox_id: sub,
                    username,
                    display_name: username,
                    avatar: picture
                };
            } else {
                // Update user info
                await connection.execute(
                    'UPDATE users SET username = ?, display_name = ?, avatar = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                    [username, username, picture, user.id]
                );
                user.username = username;
                user.display_name = username;
                user.avatar = picture;
            }

            const token = jwt.sign({ 
                userId: user.id,
                robloxId: user.roblox_id
            }, JWT_SECRET, { expiresIn: '7d' });


            req.session.userId = user.id;
            req.session.user = user;

            delete req.session.oauth_state;
            delete req.session.oauth_nonce;

            res.cookie('auth_token', token, { 
                httpOnly: true, 
                secure: process.env.NODE_ENV === 'production',
                maxAge: 315360000000
            }).redirect('/?login=success');
            
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('Authentication error:', error);
        res.status(500).redirect('/?error=auth_failed');
    }
});

app.get('/auth/status', (req, res) => {
    if (req.session.user) {
        res.json({
            authenticated: true,
            user: {
                id: req.session.user.id,
                username: req.session.user.username,
                displayName: req.session.user.display_name || req.session.user.displayName,
                avatar: req.session.user.avatar
            }
        });
    } else {
        res.json({
            authenticated: false,
            user: null
        });
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
            return res.status(500).json({ error: 'Logout failed' });
        }
        res.clearCookie('auth_token')
           .clearCookie('connect.sid')
           .json({ success: true });
    });
});


app.get('/api/user', requireAuth, async (req, res) => {
    try {

        try {
            const connection = await pool.getConnection();
            const [users] = await connection.execute('SELECT * FROM users WHERE id = ?', [req.userId]);
            connection.release();

            if (users.length > 0) {
                const user = users[0];
                return res.json({
                    id: user.id,
                    roblox_id: user.roblox_id,
                    username: user.username,
                    displayName: user.display_name || user.username,
                    avatar: user.avatar,
                    isOnline: user.is_online
                });
            }
        } catch (dbError) {
            console.warn('Database error, falling back to mock data:', dbError.message);
        }


        const mockUser = MOCK_USERS.get(req.userId);
        if (!mockUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            id: mockUser.id,
            roblox_id: mockUser.roblox_id,
            username: mockUser.username,
            displayName: mockUser.displayName,
            avatar: mockUser.avatar,
            isOnline: mockUser.isOnline
        });
    } catch (error) {
        console.error('API user error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


async function getRobloxUserInfo(identifier) {
    return userInfoLimiter.makeRequest(async () => {
        try {
            let userId;
            
            if (!isNaN(identifier)) {
                userId = identifier;
            } else {
                const searchResponse = await makeRobloxApiRequest(
                    `${ROBLOX_USERS_API}/users/search?keyword=${encodeURIComponent(identifier)}&limit=1`
                );
                
                if (!searchResponse.data || searchResponse.data.length === 0) {
                    return null;
                }
                
                userId = searchResponse.data[0].id;
            }

            const [userResponse, avatarResponse] = await Promise.all([
                makeRobloxApiRequest(`${ROBLOX_USERS_API}/users/${userId}`),
                makeRobloxApiRequest(
                    `${ROBLOX_THUMBNAILS_API}/users/avatar?userIds=${userId}&size=150x150&format=Png&isCircular=false`
                )
            ]);

            return {
                id: userResponse.id,
                name: userResponse.name || `user_${userResponse.id}`,
                displayName: userResponse.displayName || userResponse.name || `User ${userResponse.id}`,
                avatar: avatarResponse.data?.[0]?.imageUrl || `https://via.placeholder.com/150/4f46e5/ffffff?text=User+${userResponse.id}`
            };
        } catch (error) {
            console.error('Failed to get Roblox user info:', error.message);
            return null;
        }
    });
}


app.get('/api/user-info/:userId', requireAuth, async (req, res) => {
    try {
        const userId = req.params.userId;
        
        const isNumericId = !isNaN(userId) && userId >= 1;
        
        let userData = null;

        if (isNumericId) {
            try {
                const connection = await pool.getConnection();
                const [users] = await connection.execute(
                    'SELECT id, roblox_id, username, display_name, avatar, is_online, last_seen FROM users WHERE id = ?',
                    [userId]
                );
                connection.release();

                if (users.length > 0) {
                    const user = users[0];
                    userData = {
                        id: user.id,
                        robloxId: user.roblox_id,
                        name: user.username || `user_${user.roblox_id}`,
                        displayName: user.display_name || user.username || `User ${user.roblox_id}`,
                        avatar: user.avatar || `https://via.placeholder.com/150/4f46e5/ffffff?text=User+${user.roblox_id}`,
                        isOnline: user.is_online || false,
                        lastSeen: user.last_seen || new Date().toISOString()
                    };
                }
            } catch (dbError) {
                console.warn('Database error in user-info:', dbError.message);
            }
        }


        if (!userData) {
            try {
                let robloxId = userId;
                
                if (!isNumericId) {
                    const searchResponse = await makeRobloxApiRequest(
                        `${ROBLOX_USERS_API}/users/search?keyword=${encodeURIComponent(userId)}&limit=1`
                    );
                    
                    if (searchResponse.data && searchResponse.data.length > 0) {
                        robloxId = searchResponse.data[0].id;
                    } else {
                        return res.status(404).json({ error: 'User not found' });
                    }
                }

                const userInfo = await getRobloxUserInfo(robloxId);
                if (userInfo) {
                    userData = {
                        id: null,
                        robloxId: userInfo.id,
                        name: userInfo.name,
                        displayName: userInfo.displayName,
                        avatar: userInfo.avatar,
                        isOnline: false,
                        lastSeen: new Date().toISOString()
                    };


                    try {
                        const connection = await pool.getConnection();
                        const [result] = await connection.execute(
                            'INSERT INTO users (roblox_id, username, display_name, avatar, is_online) VALUES (?, ?, ?, ?, ?) ' +
                            'ON DUPLICATE KEY UPDATE username = VALUES(username), display_name = VALUES(display_name), avatar = VALUES(avatar), updated_at = CURRENT_TIMESTAMP',
                            [
                                userData.robloxId.toString(),
                                userData.name || null,
                                userData.displayName || null,
                                userData.avatar || null,
                                userData.isOnline || false
                            ]
                        );
                        
                        if (result.insertId) {
                            userData.id = result.insertId;
                        } else {

                            const [users] = await connection.execute(
                                'SELECT id FROM users WHERE roblox_id = ?',
                                [userData.robloxId.toString()]
                            );
                            if (users.length > 0) {
                                userData.id = users[0].id;
                            }
                        }
                        
                        connection.release();
                    } catch (saveError) {
                        console.warn('Failed to save user to database:', saveError.message);
                    }
                }
            } catch (apiError) {
                console.warn('Roblox API failed in user-info:', apiError.message);
            }
        }


        if (!userData && isNumericId) {
            const mockUser = MOCK_USERS.get(parseInt(userId));
            if (mockUser) {
                userData = {
                    id: mockUser.id,
                    robloxId: mockUser.roblox_id,
                    name: mockUser.username,
                    displayName: mockUser.displayName,
                    avatar: mockUser.avatar,
                    isOnline: mockUser.isOnline,
                    lastSeen: new Date().toISOString()
                };
            }
        }


        if (!userData) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json(userData);
    } catch (error) {
        console.error('User info error:', error);
        res.status(500).json({ error: 'Failed to get user info' });
    }
});


async function getRobloxUserInfo(identifier) {
    try {
        let userId;
        
        if (!isNaN(identifier)) {
            userId = identifier;
        } else {

            const searchResponse = await makeRobloxApiRequest(
                `${ROBLOX_USERS_API}/users/search?keyword=${encodeURIComponent(identifier)}&limit=1`
            );
            
            if (!searchResponse.data || searchResponse.data.length === 0) {
                return null;
            }
            
            userId = searchResponse.data[0].id;
        }

        const userResponse = await makeRobloxApiRequest(
            `${ROBLOX_USERS_API}/users/${userId}`
        );
        
        if (!userResponse) {
            return null;
        }

        const avatarResponse = await makeRobloxApiRequest(
            `${ROBLOX_THUMBNAILS_API}/users/avatar?userIds=${userId}&size=150x150&format=Png&isCircular=false`
        );

        return {
            id: userResponse.id,
            name: userResponse.name,
            displayName: userResponse.displayName || userResponse.name,
            avatar: avatarResponse.data?.[0]?.imageUrl || `https://via.placeholder.com/150/4f46e5/ffffff?text=User+${userResponse.id}`
        };

    } catch (error) {
        console.error('Failed to get Roblox user info:', error.message);
        return null;
    }
}

app.get('/api/friends/:userId', requireAuth, async (req, res) => {
    try {
        const userId = req.params.userId; 
        
        console.log(`API: Getting friends for user ${userId}`);
        

        if (!userId || userId.trim() === '') {
            return res.status(400).json({ error: 'Invalid user ID' });
        }
        

        const friends = await getUserFriends(userId);
        
        console.log(`API: Found ${friends.length} friends for user ${userId}`);
        

        const transformedFriends = friends.map(friend => ({
            id: friend.id,
            robloxId: friend.robloxId,
            name: friend.username,
            username: friend.username,
            displayName: friend.displayName,
            avatar: friend.avatar,
            isOnline: friend.isOnline
        }));
        
        res.json({ 
            data: transformedFriends,
            count: transformedFriends.length 
        });
        
    } catch (error) {
        console.error('Friends API error:', error);
        res.status(500).json({ error: 'Failed to get friends' });
    }
});




app.get('/api/network/:userId', requireAuth, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        
        if (isNaN(userId) || userId < 1) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }
        
        console.log(`Loading initial network for user ${userId}`);
        

        const userData = await getUserData(userId, 0);
        if (!userData) {
            return res.status(404).json({ error: 'User not found' });
        }
        

        const friends = await getUserFriends(userId);
        
        const nodes = [userData];
        const links = [];
        
        friends.forEach(friend => {
            nodes.push({
                ...friend,
                depth: 1,
                radius: 20,
                color: getColorForDepth(1),
                expanded: false,
                x: Math.random() * 800,
                y: Math.random() * 600
            });
            
            links.push({
                source: userId,
                target: friend.id,
                value: 1
            });
        });
        
        const result = { nodes, links };
        console.log(`Initial network: ${result.nodes.length} nodes, ${result.links.length} links`);
        
        res.json(result);
    } catch (error) {
        console.error('Network error:', error);
        res.status(500).json({ error: 'Failed to load network' });
    }
});
app.post('/api/verify-cloudflare', async (req, res) => {
    try {
        const { token } = req.body;
        
        if (!token) {
            return res.status(400).json({ 
                success: false, 
                message: 'Token is required' 
            });
        }

        const verificationUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
        
        const response = await fetch(verificationUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                secret: process.env.CLOUDFLARE_SECRET_KEY,
                response: token,
                remoteip: req.ip
            })
        });

        const data = await response.json();

        if (data.success) {
            res.json({ 
                success: true,
                message: 'Verification successful'
            });
        } else {
            console.error('Cloudflare verification failed:', data['error-codes']);
            res.status(400).json({ 
                success: false, 
                message: data['error-codes']?.join(', ') || 'Verification failed',
                errorCodes: data['error-codes']
            });
        }
    } catch (error) {
        console.error('Cloudflare verification error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error' 
        });
    }
});
async function getUserFriends(userId) {
    console.log(`Getting friends for user ID: ${userId}`);
    
    try {
        const numericUserId = parseInt(userId);
        let robloxId;
        

        const connection = await pool.getConnection();
        

        const [users] = await connection.execute(
            'SELECT id, roblox_id FROM users WHERE id = ? OR roblox_id = ?',
            [numericUserId, userId.toString()]
        );
        
        connection.release();
        
        if (users.length > 0) {
            robloxId = users[0].roblox_id;
            console.log(`Found user in database: ${users[0].id} -> ${robloxId}`);
        } else {

            robloxId = userId.toString();
            console.log(`User not in database, using as Roblox ID: ${robloxId}`);
        }
        

        const friends = await getRobloxUserFriends(robloxId);
        
        if (friends.length === 0) {
            console.log(`No friends found for Roblox user ${robloxId}`);

            if (MOCK_FRIENDSHIPS.has(numericUserId)) {
                console.log(`Using mock data for user ${numericUserId}`);
                const friendIds = MOCK_FRIENDSHIPS.get(numericUserId) || [];
                return friendIds
                    .map(friendId => MOCK_USERS.get(friendId))
                    .filter(user => user)
                    .map(user => ({
                        id: user.id,
                        robloxId: user.roblox_id,
                        username: user.username,
                        displayName: user.displayName,
                        avatar: user.avatar,
                        isOnline: user.isOnline,
                        depth: 1
                    }));
            }
            
            return [];
        }
        
        console.log(`Found ${friends.length} friends from Roblox API`);
        

        const friendIds = friends.map(friend => friend.id);
        const usersInfo = await getRobloxUsersInfo(friendIds);
        const avatars = await getRobloxUsersAvatars(friendIds);
        

        const usersInfoMap = new Map();
        usersInfo.forEach(user => usersInfoMap.set(user.id, user));
        
        const avatarsMap = new Map();
        avatars.forEach(avatar => avatarsMap.set(avatar.targetId, avatar.imageUrl));
        

        const result = friends.map(friend => {
            const userInfo = usersInfoMap.get(friend.id) || {};
            const avatar = avatarsMap.get(friend.id);
            
            return {
                id: friend.id, 
                robloxId: friend.id,
                username: userInfo.name || friend.name || `user_${friend.id}`,
                displayName: userInfo.displayName || userInfo.name || friend.name || `User ${friend.id}`,
                avatar: avatar || `https://via.placeholder.com/150/4f46e5/ffffff?text=User+${friend.id}`,
                isOnline: false, 
                depth: 1
            };
        });
        
        console.log(`Processed ${result.length} friends for user ${robloxId}`);
        return result;
        
    } catch (error) {
        console.error('Error getting user friends:', error.message);

        const numericUserId = parseInt(userId);
        if (MOCK_FRIENDSHIPS.has(numericUserId)) {
            console.log(`Falling back to mock data for user ${numericUserId}`);
            const friendIds = MOCK_FRIENDSHIPS.get(numericUserId) || [];
            return friendIds
                .map(friendId => MOCK_USERS.get(friendId))
                .filter(user => user)
                .map(user => ({
                    id: user.id,
                    robloxId: user.roblox_id,
                    username: user.username,
                    displayName: user.displayName,
                    avatar: user.avatar,
                    isOnline: user.isOnline,
                    depth: 1
                }));
        }
        
        return [];
    }
}
async function getRobloxUserInfo(identifier) {
    return userInfoLimiter.makeRequest(async () => {
        try {
            let userId;
            
            if (!isNaN(identifier)) {
                userId = identifier;
            } else {
                const searchResponse = await makeRobloxApiRequest(
                    `${ROBLOX_USERS_API}/users/search?keyword=${encodeURIComponent(identifier)}&limit=1`
                );
                
                if (!searchResponse.data || searchResponse.data.length === 0) {
                    return null;
                }
                
                userId = searchResponse.data[0].id;
            }

            const [userResponse, avatarResponse] = await Promise.all([
                makeRobloxApiRequest(`${ROBLOX_USERS_API}/users/${userId}`),
                makeRobloxApiRequest(
                    `${ROBLOX_THUMBNAILS_API}/users/avatar?userIds=${userId}&size=150x150&format=Png&isCircular=false`
                )
            ]);

            return {
                id: userResponse.id,
                name: userResponse.name || `user_${userResponse.id}`,
                displayName: userResponse.displayName || userResponse.name || `User ${userResponse.id}`,
                avatar: avatarResponse.data?.[0]?.imageUrl || `https://via.placeholder.com/150/4f46e5/ffffff?text=User+${userResponse.id}`
            };
        } catch (error) {
            console.error('Failed to get Roblox user info:', error.message);
            return null;
        }
    });
}
async function getRobloxUsersInfo(userIds) {
    try {
        if (!userIds.length) return [];
        
        console.log(`Fetching batch user info for ${userIds.length} users`);
        
        const response = await axios.post(
            'https://users.roproxy.com/v1/users',
            { userIds },
            { timeout: 15000 }
        );
        
        return response.data.data || [];
    } catch (error) {
        console.error('Roblox API batch users error:', error.status || error.message);
        return [];
    }
}
app.post('/api/find-connection', requireAuth, async (req, res) => {
    try {
        const { sourceId, targetId, maxDepth = 6 } = req.body;
        
        if (!sourceId || !targetId) {
            return res.status(400).json({ error: 'Source and target IDs are required' });
        }

        console.log(`Finding connection from ${sourceId} to ${targetId}, max depth: ${maxDepth}`);

        const path = await findShortestPath(sourceId, targetId, maxDepth);
        
        if (path && path.length > 0) {
            console.log(`Found path: ${path.join(' -> ')}`);
            res.json({ 
                success: true, 
                path: path,
                degrees: path.length - 1
            });
        } else {
            res.json({ 
                success: false, 
                message: 'No connection found within maximum depth' 
            });
        }
    } catch (error) {
        console.error('Find connection error:', error);
        res.status(500).json({ error: 'Failed to find connection' });
    }
});
async function findShortestPath(sourceId, targetId, maxDepth) {
    const queue = [[sourceId]];
    const visited = new Set([sourceId]);
    
    while (queue.length > 0) {
        const path = queue.shift();
        const currentUserId = path[path.length - 1];
        

        if (currentUserId == targetId) {
            return path;
        }
        

        if (path.length >= maxDepth + 1) {
            continue;
        }
        
        try {

            const friends = await getUserFriendIds(currentUserId);
            
            for (const friendId of friends) {
                if (!visited.has(friendId)) {
                    visited.add(friendId);
                    const newPath = [...path, friendId];
                    queue.push(newPath);
                }
            }
        } catch (error) {
            console.error(`Error getting friends for user ${currentUserId}:`, error.message);
            continue;
        }
    }
    
    return null;
}
async function getUserFriendIds(userId) {
    try {

        const connection = await pool.getConnection();
        const [user] = await connection.execute(
            'SELECT roblox_id FROM users WHERE id = ? OR roblox_id = ?',
            [userId, userId.toString()]
        );
        
        let robloxId;
        if (user.length > 0) {
            robloxId = user[0].roblox_id;
        } else {
            robloxId = userId.toString();
        }
        
        connection.release();

        const friends = await getRobloxUserFriendIds(robloxId);
        
        if (friends.length === 0) {

            const numericUserId = parseInt(userId);
            if (MOCK_FRIENDSHIPS.has(numericUserId)) {
                return MOCK_FRIENDSHIPS.get(numericUserId);
            }
        }
        
        return friends;
    } catch (error) {
        console.error('Error getting friend IDs:', error.message);
        
        const numericUserId = parseInt(userId);
        if (MOCK_FRIENDSHIPS.has(numericUserId)) {
            return MOCK_FRIENDSHIPS.get(numericUserId);
        }
        
        return [];
    }
}
async function getRobloxUserFriendIds(robloxId) {
    try {
        const response = await axios.get(
            `https://friends.roblox.com/v1/users/${robloxId}/friends`, // using my own proxy cuz roproxy is lazy to do that route
            { timeout: 10000 }
        );
        
        if (!response.data || !response.data.data) {
            return [];
        }
        
        return response.data.data.map(friend => friend.id);
    } catch (error) {
        console.error('Roblox API friends error:', error.message);
        return [];
    }
}
async function generateNetwork(userId, maxDepth) {
    const nodes = new Map();
    const links = [];
    const visited = new Set();
    const queue = [{ id: userId, depth: 0 }];
    
    console.log(`Generating network for user ${userId}, max depth ${maxDepth}`);
    
    while (queue.length > 0) {
        const { id: currentUserId, depth } = queue.shift();
        
        if (visited.has(currentUserId) || depth > maxDepth) {
            continue;
        }
        
        visited.add(currentUserId);
        

        const userData = await getUserData(currentUserId, depth);
        if (!userData) continue;
        
        nodes.set(currentUserId, userData);
        

        if (depth < maxDepth) {
            const friends = await getUserFriends(currentUserId);
            
            friends.forEach(friend => {

                if (!visited.has(friend.id)) {
                    queue.push({ id: friend.id, depth: depth + 1 });
                }
                

                links.push({
                    source: currentUserId,
                    target: friend.id,
                    value: 1
                });
            });
        }
    }
    
    const result = {
        nodes: Array.from(nodes.values()),
        links: links.filter(link => 
            nodes.has(link.source) && nodes.has(link.target)
        )
    };
    
    console.log(`Network generated: ${result.nodes.length} nodes, ${result.links.length} links`);
    return result;
}



async function getRobloxUserFriends(robloxId) {
    try {
        console.log(`Fetching friends from Roblox API for user ${robloxId}`);
        
        const response = await axios.get(
            `https://roproxy-production-27a6.up.railway.app/friends/v1/users/${robloxId}/friends`,
            { timeout: 10000 }
        );
        
        if (!response.data || !response.data.data) {
            return [];
        }
        
        console.log(`Found ${response.data.data.length} friends for user ${robloxId}`);
        return response.data.data;
    } catch (error) {
        console.error('Roblox API friends error:', error.response?.data || error.message);
        return [];
    }
}
async function getRobloxUserInfo(identifier) {
    try {
        let userId;
        

        if (!isNaN(identifier)) {
            userId = identifier;
        } else {

            const searchResponse = await makeRobloxApiRequest(
                `${ROBLOX_USERS_API}/users/search?keyword=${encodeURIComponent(identifier)}&limit=1`
            );
            
            if (!searchResponse.data || searchResponse.data.length === 0) {
                return null;
            }
            
            userId = searchResponse.data[0].id;
        }

        const userResponse = await makeRobloxApiRequest(
            `${ROBLOX_USERS_API}/users/${userId}`
        );
        
        if (!userResponse) {
            return null;
        }


        const avatarResponse = await makeRobloxApiRequest(
            `${ROBLOX_THUMBNAILS_API}/users/avatar?userIds=${userId}&size=150x150&format=Png&isCircular=false`
        );

        return {
            id: userResponse.id,
            name: userResponse.name || `user_${userResponse.id}`,
            displayName: userResponse.displayName || userResponse.name || `User ${userResponse.id}`,
            avatar: avatarResponse.data?.[0]?.imageUrl || `https://via.placeholder.com/150/4f46e5/ffffff?text=User+${userResponse.id}`
        };

    } catch (error) {
        console.error('Failed to get Roblox user info:', error.message);
        return null;
    }
}
async function getRobloxUsersAvatars(userIds, batchSize = 50) {
    if (!userIds.length) return [];
    
    const results = [];
    const batches = [];
    

    for (let i = 0; i < userIds.length; i += batchSize) {
        batches.push(userIds.slice(i, i + batchSize));
    }
    
    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const numericBatch = batch.map(id => parseInt(id)).filter(id => !isNaN(id));
        
        if (numericBatch.length === 0) continue;
        
        try {
            const response = await avatarsLimiter.makeRequest(() => 
                makeRobloxApiRequest(
                    `${ROBLOX_THUMBNAILS_API}/users/avatar?userIds=${numericBatch.join(',')}&size=150x150&format=Png&isCircular=false`,
                    { timeout: 15000 }
                )
            );
            
            if (response.data) {
                results.push(...response.data);
            }
            

            if (i < batches.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            
        } catch (batchError) {
            console.error(`Batch ${i + 1} failed:`, batchError.message);
        }
    }
    
    return results;
}

async function getUserData(userId, depth = 0) {
    console.log(`Getting user data for ID: ${userId}, depth: ${depth}`);
    
    try {

        const numericUserId = parseInt(userId);
        let user = null;
        

        const connection = await pool.getConnection();
        const [users] = await connection.execute(
            'SELECT id, roblox_id, username, display_name, avatar, is_online FROM users WHERE id = ? OR roblox_id = ?',
            [numericUserId, userId.toString()]
        );
        
        if (users.length > 0) {
            user = users[0];
            console.log(`Found user in database: ${user.username}`);
        } else {
            console.log(`User ${userId} not found in database, fetching from Roblox API`);
            

            const robloxUserInfo = await getRobloxUserInfo(userId);
            if (!robloxUserInfo) {
                connection.release();
                

                const mockUser = MOCK_USERS.get(numericUserId);
                if (mockUser) {
                    console.log(`Using mock data for user ${numericUserId}`);
                    return {
                        id: mockUser.id,
                        robloxId: mockUser.roblox_id,
                        username: mockUser.username,
                        displayName: mockUser.displayName,
                        avatar: mockUser.avatar,
                        isOnline: mockUser.isOnline,
                        depth: depth,
                        radius: depth === 0 ? 25 : (depth === 1 ? 20 : 15),
                        color: getColorForDepth(depth),
                        expanded: false,
                        x: depth === 0 ? 400 : Math.random() * 800,
                        y: depth === 0 ? 300 : Math.random() * 600
                    };
                }
                
                return null;
            }
            

            try {
                const [result] = await connection.execute(
                    'INSERT INTO users (roblox_id, username, display_name, avatar, is_online) VALUES (?, ?, ?, ?, ?)',
                    [
                        robloxUserInfo.id.toString(),
                        robloxUserInfo.name || null,
                        robloxUserInfo.displayName || null,
                        robloxUserInfo.avatar || null,
                        false
                    ]
                );
                
                user = {
                    id: result.insertId,
                    roblox_id: robloxUserInfo.id.toString(),
                    username: robloxUserInfo.name,
                    display_name: robloxUserInfo.displayName,
                    avatar: robloxUserInfo.avatar,
                    is_online: false
                };
                
                console.log(`Created user ${userId} in database with ID ${result.insertId}`);
            } catch (insertError) {
                console.error('Failed to insert user:', insertError.message);
                connection.release();
                return null;
            }
        }
        
        connection.release();

        return {
            id: user.id,
            robloxId: user.roblox_id,
            username: user.username || `user_${user.roblox_id}`,
            displayName: user.display_name || user.username || `User ${user.roblox_id}`,
            avatar: user.avatar || `https://via.placeholder.com/150/4f46e5/ffffff?text=User+${user.roblox_id}`,
            isOnline: user.is_online || false,
            depth: depth,
            radius: depth === 0 ? 25 : (depth === 1 ? 20 : 15),
            color: getColorForDepth(depth),
            expanded: false,
            loading: false,
            x: depth === 0 ? 400 : Math.random() * 800,
            y: depth === 0 ? 300 : Math.random() * 600
        };
        
    } catch (error) {
        console.error('Error getting user data:', error.message);
        return null;
    }
}

app.get('/api/find-user/:username', async (req, res) => {
    try {
        const username = req.params.username;
        
        if (!username) {
            return res.status(400).json({ error: 'Username is required' });
        }
        

        const response = await axios.get(
            `https://users.roproxy.com/v1/users/search?keyword=${encodeURIComponent(username)}&limit=10`,
            { timeout: 10000 }
        );
        
        if (!response.data.data || response.data.data.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const users = response.data.data;
        const userIds = users.map(user => user.id);
        const avatars = await getRobloxUsersAvatars(userIds);
        
        const avatarsMap = new Map();
        avatars.forEach(avatar => avatarsMap.set(avatar.targetId, avatar.imageUrl));
        
        const result = users.map(user => ({
            id: user.id,
            robloxId: user.id,
            username: user.name,
            displayName: user.displayName || user.name,
            avatar: avatarsMap.get(user.id) || `https://via.placeholder.com/150/4f46e5/ffffff?text=User+${user.id}`,
            isOnline: false
        }));
        
        res.json({ data: result });
        
    } catch (error) {
        console.error('Find user error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to find user' });
    }
});
async function findRobloxUser(identifier) {
    try {

        if (!isNaN(identifier)) {
            const userResponse = await makeRobloxApiRequest(
                `${ROBLOX_USERS_API}/users/${identifier}`
            );
            
            if (userResponse) {
                const avatarResponse = await makeRobloxApiRequest(
                    `${ROBLOX_THUMBNAILS_API}/users/avatar?userIds=${identifier}&size=150x150&format=Png&isCircular=false`
                );
                
                return {
                    id: userResponse.id,
                    robloxId: userResponse.id,
                    username: userResponse.name,
                    displayName: userResponse.displayName || userResponse.name,
                    avatar: avatarResponse.data?.[0]?.imageUrl || `https://via.placeholder.com/150/4f46e5/ffffff?text=User+${userResponse.id}`
                };
            }
        }

        const searchResponse = await makeRobloxApiRequest(
            `${ROBLOX_USERS_API}/users/search?keyword=${encodeURIComponent(identifier)}&limit=10`
        );

        if (searchResponse.data && searchResponse.data.length > 0) {
            const user = searchResponse.data[0];
            const avatarResponse = await makeRobloxApiRequest(
                `${ROBLOX_THUMBNAILS_API}/users/avatar?userIds=${user.id}&size=150x150&format=Png&isCircular=false`
            );
            
            return {
                id: user.id,
                robloxId: user.id,
                username: user.name,
                displayName: user.displayName || user.name,
                avatar: avatarResponse.data?.[0]?.imageUrl || `https://via.placeholder.com/150/4f46e5/ffffff?text=User+${user.id}`
            };
        }

        return null;

    } catch (error) {
        console.error('Failed to find Roblox user:', error.message);
        return null;
    }
}
async function findRobloxUsersByUsername(username) {
    try {
        const response = await makeRobloxApiRequest(
            `${ROBLOX_USERS_API}/users/search?keyword=${encodeURIComponent(username)}&limit=10`
        );

        if (!response.data || response.data.length === 0) {
            return [];
        }

        const userIds = response.data.map(user => user.id);
        const avatarsResponse = await makeRobloxApiRequest(
            `${ROBLOX_THUMBNAILS_API}/users/avatar?userIds=${userIds.join(',')}&size=150x150&format=Png&isCircular=false`
        );

        const avatarsMap = new Map();
        

        if (avatarsResponse.data && Array.isArray(avatarsResponse.data)) {
            avatarsResponse.data.forEach(avatar => {
                if (avatar && avatar.targetId && avatar.imageUrl) {
                    avatarsMap.set(avatar.targetId, avatar.imageUrl);
                }
            });
        }

        return response.data.map(user => ({
            id: user.id,
            robloxId: user.id,
            username: user.name,
            displayName: user.displayName || user.name,
            avatar: avatarsMap.get(user.id) || `https://via.placeholder.com/150/4f46e5/ffffff?text=User+${user.id}`
        }));

    } catch (error) {
        console.error('Roblox users search failed:', error.message);
        throw error;
    }
}
app.post('/api/search-user', requireAuth, async (req, res) => {
    try {
        const { username } = req.body;
        
        if (!username || username.length < 1) {
            return res.status(400).json({ error: 'Username is required' });
        }

        const searchTerm = username.toLowerCase();
        let results = [];


        try {
            const robloxUsers = await findRobloxUsersByUsername(searchTerm);
            results = robloxUsers.map(user => ({
                id: user.id,
                name: user.username,
                displayName: user.displayName,
                avatar: user.avatar,
                isOnline: true // this ex.
            }));
        } catch (apiError) {
            console.warn('Roblox API search failed, falling back to database:', apiError.message);
            

            try {
                const connection = await pool.getConnection();
                const [users] = await connection.execute(
                    'SELECT id, roblox_id, username, display_name, avatar, is_online FROM users WHERE LOWER(username) LIKE ? OR LOWER(display_name) LIKE ? LIMIT 10',
                    [`%${searchTerm}%`, `%${searchTerm}%`]
                );
                connection.release();

                results = users.map(user => ({
                    id: user.id,
                    name: user.username,
                    displayName: user.display_name || user.username,
                    avatar: user.avatar,
                    isOnline: user.is_online
                }));
            } catch (dbError) {
                console.warn('Database error, falling back to mock data:', dbError.message);
                

                results = Array.from(MOCK_USERS.values())
                    .filter(user => 
                        user.username.toLowerCase().includes(searchTerm) || 
                        user.displayName.toLowerCase().includes(searchTerm)
                    )
                    .slice(0, 10)
                    .map(user => ({
                        id: user.id,
                        name: user.username,
                        displayName: user.displayName,
                        avatar: user.avatar,
                        isOnline: user.isOnline
                    }));
            }
        }
        
        res.json({ data: results });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Search failed' });
    }
});
function getColorForDepth(depth) {
    const colors = ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#ef4444'];
    return colors[depth % colors.length];
}


app.get('/health', async (req, res) => {
    let dbStatus = false;
    try {
        const connection = await pool.getConnection();
        await connection.ping();
        connection.release();
        dbStatus = true;
    } catch (error) {
        console.error('Database health check failed:', error.message);
    }

    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        oauth_configured: !!oauthClient,
        database_connected: dbStatus,
        mock_data_loaded: MOCK_USERS.size > 0,
        environment: process.env.NODE_ENV || 'development'
    });
});


app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large' });
    }
    
    res.status(500).json({ 
        error: 'Something went wrong!',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
});


app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});


process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    await pool.end();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down gracefully...');
    await pool.end();
    process.exit(0);
});


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

