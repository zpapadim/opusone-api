require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const Tesseract = require('tesseract.js');

// Database and Storage
const db = require('./lib/db');
const { uploadFile, deleteFile } = require('./lib/storage');

// Import pdf-parse directly from lib to avoid test code in index.js
const pdfParse = require('pdf-parse/lib/pdf-parse');

// Auth routes and middleware
const authRoutes = require('./routes/auth');
const { authenticate, optionalAuth } = require('./middleware/auth');

const app = express();
const port = process.env.PORT || 5000;

// CORS configuration - allow frontend origins
app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (mobile apps, Postman, etc.)
        if (!origin) return callback(null, true);

        const allowedOrigins = [
            'http://localhost:5173',      // Vite dev
            'http://localhost:3000',      // React dev
        ];

        // Add production frontend URL if set
        if (process.env.FRONTEND_URL) {
            // Add both with and without trailing slash to be safe
            const productionUrl = process.env.FRONTEND_URL.replace(/\/$/, '');
            allowedOrigins.push(productionUrl);
            allowedOrigins.push(productionUrl + '/');
        }

        if (allowedOrigins.includes(origin) || allowedOrigins.includes(origin.replace(/\/$/, ''))) {
            callback(null, true);
        } else {
            // Log the blocked origin for debugging
            console.log('BLOCKED CORS ORIGIN:', origin);
            console.log('ALLOWED ORIGINS:', allowedOrigins);
            
            // For now, in production, we will allow it if it matches the general domain shape 
            // to prevent issues during the initial deployment phase.
            // In strict mode, you should uncomment the error return.
            // callback(new Error('CORS not allowed'));
            callback(null, true); 
        }
    },
    credentials: true
}));
app.use(express.json());

// Ensure uploads directory exists (for temporary files during OCR)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir);
}

// --- MULTER CONFIGURATION ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage });

// Health check endpoint for Render
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok-v2', timestamp: new Date().toISOString() });
});

// Auth routes
app.use('/api/auth', authRoutes);

// Helper to calculate file hash
function calculateFileHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', data => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

// --- OCR HELPER ---
// OCR language: defaults to English, can be configured via OCR_LANGUAGE env var
// Common values: 'eng' (English), 'ell' (Greek), 'deu' (German), 'fra' (French), 'ita' (Italian)
// Multiple languages can be specified: 'eng+ell' for English and Greek
const OCR_LANGUAGE = process.env.OCR_LANGUAGE || 'eng';

async function extractMetadataFromImage(imagePath) {
    const worker = await Tesseract.createWorker(OCR_LANGUAGE, 1, {
        logger: m => console.log('Tesseract:', m.status, m.progress ? Math.round(m.progress * 100) + '%' : '')
    });
    const ret = await worker.recognize(imagePath);
    await worker.terminate();

    console.log('=== OCR RAW TEXT ===');
    console.log(ret.data.text);
    console.log('=== OCR LINES COUNT:', ret.data.lines?.length || 0, '===');

    return processSmartMetadata(ret.data);
}

async function extractMetadataFromPdf(pdfPath) {
    const dataBuffer = fs.readFileSync(pdfPath);
    const data = await pdfParse(dataBuffer);

    const lines = data.text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    return {
        title: lines[0] || "",
        composer: lines[1] || "",
        rawText: data.text
    };
}

function processSmartMetadata(tesseractData) {
    const rawText = tesseractData.text || "";
    const textLines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    if (textLines.length === 0) return { title: "", composer: "", rawText: "" };

    let title = "";
    let composer = "";

    const isCleanLine = (text) => {
        const greekLetters = (text.match(/[Α-Ωα-ωά-ώ]/g) || []).length;
        const latinLetters = (text.match(/[A-Za-z]/g) || []).length;
        const totalLetters = greekLetters + latinLetters;
        const noiseChars = (text.match(/[̓̀́̈͂ͅ᾽῾᾿῎῍῏῝῞῟῭΅`΄''‛""‟․‥…‧\-–—―\.·•○●◦◘◙◌◍◎◐◑◒◓◔◕◖◗◰◱◲◳◴◵◶◷◸◹◺◻◼◽◾◿☀☁☂☃☄★☆☇☈☉☊☋☌☍☎☏☐☑☒☓☔☕☖☗☘☙☚☛☜☝☞☟☠☡☢☣☤☥☦☧☨☩☪☫☬☭☮☯☰☱☲☳☴☵☶☷☸☹☺☻☼☽☾☿♀♁♂♃♄♅♆♇♈♉♊♋♌♍♎♏♐♑♒♓♔♕♖♗♘♙♚♛♜♝♞♟♠♡♢♣♤♥♦♧♨♩♪♫♬♭♮♯]/g) || []).length;
        return totalLetters >= 3 && totalLetters > noiseChars;
    };

    for (const line of textLines) {
        if (!isCleanLine(line)) continue;
        if (line.match(/^(Μουσική|Στίχοι|Music|Lyrics|Composer):/i)) continue;
        if (line.length >= 4) {
            title = line;
            break;
        }
    }

    for (const line of textLines) {
        const musicMatch = line.match(/Μουσική[:\s]+([Α-Ωα-ωά-ώA-Za-z\s]+?)(?:\s+Στίχοι|\s+Lyrics|$)/i);
        if (musicMatch) {
            composer = musicMatch[1].trim();
            break;
        }
        const lyricsMatch = line.match(/Στίχοι[:\s]+([Α-Ωα-ωά-ώA-Za-z\s]+?)(?:\s+Μουσική|\s+Music|$)/i);
        if (lyricsMatch && !composer) {
            composer = lyricsMatch[1].trim();
        }
    }

    if (!composer) {
        let foundTitle = false;
        for (const line of textLines) {
            if (!isCleanLine(line)) continue;
            if (!foundTitle) {
                foundTitle = true;
                continue;
            }
            if (line !== title && line.length >= 3) {
                composer = line;
                break;
            }
        }
    }

    console.log('Extracted - Title:', title, '| Composer:', composer);

    return {
        title: title || "",
        composer: composer || "",
        rawText: rawText
    };
}

// --- ROUTES ---

// --- ADMIN & LOGGING SYSTEM ---

// In-memory log buffer
const LOG_BUFFER_SIZE = 1000;
const logBuffer = [];

// Intercept console.log and console.error
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

function formatLog(type, args) {
    const timestamp = new Date().toISOString();
    const message = args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');
    return { timestamp, type, message };
}

function pushLog(logEntry) {
    logBuffer.unshift(logEntry);
    if (logBuffer.length > LOG_BUFFER_SIZE) {
        logBuffer.pop();
    }
}

console.log = function(...args) {
    pushLog(formatLog('INFO', args));
    originalConsoleLog.apply(console, args);
};

console.error = function(...args) {
    pushLog(formatLog('ERROR', args));
    originalConsoleError.apply(console, args);
};

// Admin Middleware
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123'; // Default key if not set

const requireAdmin = (req, res, next) => {
    const key = req.query.key || req.headers['x-admin-key'];
    if (key && key === ADMIN_KEY) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized: Invalid Admin Key' });
    }
};

// --- ROUTES ---

// Admin Dashboard (HTML)
app.get('/', async (req, res) => {
    const key = req.query.key;
    
    // If no key provided, show login form
    if (!key || key !== ADMIN_KEY) {
        return res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>OpusOne Admin Login</title>
                <script src="https://cdn.tailwindcss.com"></script>
                <script src="https://unpkg.com/lucide@latest"></script>
            </head>
            <body class="bg-gray-900 text-gray-100 min-h-screen flex items-center justify-center p-4">
                <div class="bg-gray-800 p-8 rounded-2xl shadow-2xl w-full max-w-md border border-gray-700">
                    <div class="flex justify-center mb-6">
                        <div class="bg-indigo-600 p-3 rounded-xl">
                            <i data-lucide="music" class="w-8 h-8 text-white"></i>
                        </div>
                    </div>
                    <h1 class="text-2xl font-bold text-center mb-2">OpusOne API</h1>
                    <p class="text-gray-400 text-center text-sm mb-8">Enter Admin Key to access dashboard</p>
                    
                    <form onsubmit="handleLogin(event)" class="space-y-4">
                        <div>
                            <label class="block text-xs font-bold uppercase text-gray-500 mb-1">Admin Key</label>
                            <div class="relative">
                                <i data-lucide="lock" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500"></i>
                                <input type="password" id="adminKey" required 
                                    class="w-full bg-gray-900 border border-gray-600 rounded-lg py-2.5 pl-10 pr-4 text-white focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all"
                                    placeholder="••••••••••••"
                                >
                            </div>
                        </div>
                        <button type="submit" 
                            class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2">
                            <span>Access Dashboard</span>
                            <i data-lucide="arrow-right" class="w-4 h-4"></i>
                        </button>
                    </form>
                    
                    <div class="mt-6 text-center">
                        <span class="px-2 py-1 bg-green-900/30 text-green-400 text-xs rounded border border-green-800">
                            System Operational
                        </span>
                    </div>
                </div>

                <script>
                    lucide.createIcons();
                    function handleLogin(e) {
                        e.preventDefault();
                        const key = document.getElementById('adminKey').value;
                        if (key) {
                            window.location.href = '/?key=' + encodeURIComponent(key);
                        }
                    }
                </script>
            </body>
            </html>
        `);
    }

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OpusOne Admin Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <style>
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .log-entry { font-family: monospace; font-size: 12px; }
    </style>
</head>
<body class="bg-gray-900 text-gray-100 min-h-screen">
    <div class="container mx-auto p-6 max-w-7xl">
        <header class="flex justify-between items-center mb-8 border-b border-gray-700 pb-4">
            <div class="flex items-center gap-3">
                <div class="bg-indigo-600 p-2 rounded-lg">
                    <i data-lucide="music" class="text-white"></i>
                </div>
                <h1 class="text-2xl font-bold">OpusOne <span class="text-indigo-400">Admin</span></h1>
            </div>
            <div class="flex gap-4 text-sm text-gray-400">
                <span id="server-time"></span>
                <span class="px-2 py-1 bg-green-900/30 text-green-400 rounded border border-green-800">System Healthy</span>
            </div>
        </header>

        <!-- Stats Grid -->
        <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8" id="stats-container">
            <!-- Stats loaded via JS -->
            <div class="animate-pulse bg-gray-800 h-24 rounded-xl"></div>
            <div class="animate-pulse bg-gray-800 h-24 rounded-xl"></div>
            <div class="animate-pulse bg-gray-800 h-24 rounded-xl"></div>
            <div class="animate-pulse bg-gray-800 h-24 rounded-xl"></div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <!-- User Management (2 cols) -->
            <div class="lg:col-span-2 bg-gray-800 rounded-xl border border-gray-700 overflow-hidden flex flex-col h-[600px]">
                <div class="p-4 border-b border-gray-700 flex justify-between items-center bg-gray-800/50">
                    <h2 class="font-bold flex items-center gap-2"><i data-lucide="users" size="18"></i> User Management</h2>
                    <button onclick="fetchUsers()" class="p-1 hover:bg-gray-700 rounded"><i data-lucide="refresh-cw" size="16"></i></button>
                </div>
                <div class="overflow-auto flex-1 p-0">
                    <table class="w-full text-left border-collapse">
                        <thead class="bg-gray-900/50 text-gray-400 text-xs uppercase sticky top-0">
                            <tr>
                                <th class="p-4 font-medium">User</th>
                                <th class="p-4 font-medium">Sheets</th>
                                <th class="p-4 font-medium">Storage</th>
                                <th class="p-4 font-medium">Joined</th>
                                <th class="p-4 font-medium text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody id="users-table-body" class="text-sm divide-y divide-gray-700/50">
                            <!-- Users loaded here -->
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- Server Logs (1 col) -->
            <div class="bg-black/50 rounded-xl border border-gray-700 overflow-hidden flex flex-col h-[600px]">
                <div class="p-4 border-b border-gray-700 flex justify-between items-center bg-gray-800/50">
                    <h2 class="font-bold flex items-center gap-2"><i data-lucide="terminal" size="18"></i> Live Logs</h2>
                    <div class="flex gap-2 items-center">
                        <button onclick="copyLogs()" class="p-1.5 hover:bg-gray-700 rounded text-gray-400 hover:text-white transition-colors" title="Copy Logs">
                            <i data-lucide="copy" size="14"></i>
                        </button>
                        <button onclick="downloadLogs()" class="p-1.5 hover:bg-gray-700 rounded text-gray-400 hover:text-white transition-colors" title="Download Logs">
                            <i data-lucide="download" size="14"></i>
                        </button>
                        <span class="w-px h-4 bg-gray-700 mx-1"></span>
                        <span class="text-xs text-gray-500 flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span> Live</span>
                    </div>
                </div>
                <div id="logs-container" class="flex-1 overflow-auto p-4 space-y-2 font-mono text-xs">
                    <!-- Logs loaded here -->
                </div>
            </div>
        </div>
    </div>

    <script>
        lucide.createIcons();
        const ADMIN_KEY = "${key}";
        const API_BASE = window.location.origin;

        // Utilities
        const formatBytes = (bytes) => {
            if (!bytes) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        };

        // Fetch Stats
        async function fetchStats() {
            try {
                const res = await fetch(\`\${API_BASE}/api/admin/stats?key=\${ADMIN_KEY}\`);
                const data = await res.json();
                
                const statsHtml = \`
                    <div class="bg-gray-800 p-6 rounded-xl border border-gray-700">
                        <div class="text-gray-400 text-xs uppercase font-bold mb-1">Total Users</div>
                        <div class="text-3xl font-bold text-white">\${data.usersCount}</div>
                    </div>
                    <div class="bg-gray-800 p-6 rounded-xl border border-gray-700">
                        <div class="text-gray-400 text-xs uppercase font-bold mb-1">Total Sheets</div>
                        <div class="text-3xl font-bold text-white">\${data.sheetsCount}</div>
                    </div>
                    <div class="bg-gray-800 p-6 rounded-xl border border-gray-700">
                        <div class="text-gray-400 text-xs uppercase font-bold mb-1">Total Folders</div>
                        <div class="text-3xl font-bold text-white">\${data.foldersCount}</div>
                    </div>
                    <div class="bg-gray-800 p-6 rounded-xl border border-gray-700">
                        <div class="text-gray-400 text-xs uppercase font-bold mb-1">Total Storage</div>
                        <div class="text-3xl font-bold text-indigo-400">\${formatBytes(data.totalStorage)}</div>
                    </div>
                \`;
                document.getElementById('stats-container').innerHTML = statsHtml;
            } catch (e) {
                console.error('Failed to fetch stats', e);
            }
        }

        // Fetch Users
        async function fetchUsers() {
            try {
                const res = await fetch(\`\${API_BASE}/api/admin/users?key=\${ADMIN_KEY}\`);
                const users = await res.json();
                
                const html = users.map(u => \`
                    <tr class="hover:bg-gray-700/30 transition-colors">
                        <td class="p-4">
                            <div class="font-bold text-white">\${u.display_name || 'No Name'}</div>
                            <div class="text-gray-500 text-xs">\${u.email}</div>
                        </td>
                        <td class="p-4">\${u.sheet_count}</td>
                        <td class="p-4 text-gray-400">\${formatBytes(u.storage_used)}</td>
                        <td class="p-4 text-gray-500">\${new Date(u.created_at).toLocaleDateString()}</td>
                        <td class="p-4 text-right">
                            <button onclick="deleteUser('\${u.id}', '\${u.email}')" class="text-red-400 hover:text-red-300 hover:bg-red-900/30 p-2 rounded transition-colors" title="Delete User">
                                <i data-lucide="trash-2" width="16"></i>
                            </button>
                        </td>
                    </tr>
                \`).join('');
                
                document.getElementById('users-table-body').innerHTML = html;
                lucide.createIcons();
            } catch (e) {
                console.error('Failed to fetch users', e);
            }
        }

        // Delete User
        async function deleteUser(id, email) {
            if (!confirm(\`Are you sure you want to delete user \${email}? This will delete ALL their sheets and cannot be undone.\`)) return;
            
            try {
                const res = await fetch(\`\${API_BASE}/api/admin/users/\${id}?key=\${ADMIN_KEY}\`, { method: 'DELETE' });
                if (res.ok) {
                    fetchUsers();
                    fetchStats(); // Refresh stats
                } else {
                    alert('Failed to delete user');
                }
            } catch (e) {
                alert('Error deleting user');
            }
        }

        // Fetch Logs
        let currentLogs = [];
        async function fetchLogs() {
            try {
                const res = await fetch(\`\${API_BASE}/api/admin/logs?key=\${ADMIN_KEY}\`);
                currentLogs = await res.json();
                
                const html = currentLogs.map(l => \`
                    <div class="log-entry p-2 rounded hover:bg-white/5 \${l.type === 'ERROR' ? 'text-red-400 border-l-2 border-red-500 bg-red-900/10' : 'text-gray-300 border-l-2 border-gray-600'}">
                        <span class="opacity-50 mr-2">[\${new Date(l.timestamp).toLocaleTimeString()}]</span>
                        <span class="\${l.type === 'INFO' ? 'text-blue-400' : 'text-red-400'} font-bold mr-2">\${l.type}</span>
                        <span>\${l.message}</span>
                    </div>
                \`).join('');
                
                document.getElementById('logs-container').innerHTML = html;
            } catch (e) { console.error(e); }
        }

        function getLogText() {
            return currentLogs.map(l => \`[\${l.timestamp}] [\${l.type}] \${l.message}\`).join('\\n');
        }

        function copyLogs() {
            navigator.clipboard.writeText(getLogText()).then(() => {
                alert('Logs copied to clipboard!');
            });
        }

        function downloadLogs() {
            const blob = new Blob([getLogText()], { type: 'text/plain' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = \`opusone-logs-\${new Date().toISOString()}.txt\`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        }

        // Init
        fetchStats();
        fetchUsers();
        fetchLogs();
        
        // Auto-refresh logs every 3s
        setInterval(fetchLogs, 3000);
        
        // Clock
        setInterval(() => {
            document.getElementById('server-time').innerText = new Date().toUTCString();
        }, 1000);
    </script>
</body>
</html>
    `);
});

// Admin API: Stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    try {
        const usersCount = await db.query('SELECT COUNT(*) FROM users');
        const sheetsCount = await db.query('SELECT COUNT(*) FROM sheets');
        const foldersCount = await db.query('SELECT COUNT(*) FROM folders');
        const storageStats = await db.query('SELECT SUM(file_size) as total FROM sheets');
        
        res.json({
            usersCount: parseInt(usersCount.rows[0].count),
            sheetsCount: parseInt(sheetsCount.rows[0].count),
            foldersCount: parseInt(foldersCount.rows[0].count),
            totalStorage: parseInt(storageStats.rows[0].total || 0)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Admin API: Users List
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT u.id, u.email, u.display_name, u.created_at,
                   COUNT(s.id) as sheet_count,
                   SUM(s.file_size) as storage_used
            FROM users u
            LEFT JOIN sheets s ON u.id = s.user_id
            GROUP BY u.id
            ORDER BY u.created_at DESC
        `);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Admin API: Delete User
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        // First delete storage files
        const files = await db.query('SELECT storage_key FROM sheets WHERE user_id = $1', [id]);
        for (const file of files.rows) {
            if (file.storage_key) await deleteFile(file.storage_key);
        }
        
        // Delete user (cascade will handle sheets/folders/shares if schema configured, otherwise manual)
        // Assuming cascade for simplicity, or manual clean up
        await db.query('DELETE FROM sheets WHERE user_id = $1', [id]);
        await db.query('DELETE FROM folders WHERE user_id = $1', [id]);
        await db.query('DELETE FROM users WHERE id = $1', [id]);
        
        console.log(`Admin deleted user ${id}`);
        res.json({ success: true });
    } catch (e) {
        console.error('Admin delete user failed:', e);
        res.status(500).json({ error: e.message });
    }
});

// Admin API: Logs
app.get('/api/admin/logs', requireAdmin, (req, res) => {
    res.json(logBuffer);
});

// OCR Route
app.post('/api/ocr', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    console.log('OCR Request - File:', req.file.originalname, 'Type:', req.file.mimetype);

    try {
        let metadata = { title: "", composer: "" };

        if (req.file.mimetype === 'application/pdf') {
            metadata = await extractMetadataFromPdf(req.file.path);
            if (!metadata.title && !metadata.composer && !metadata.rawText) {
                return res.json({
                    title: "",
                    composer: "",
                    warning: "No embedded text found in PDF. Please convert to image for OCR."
                });
            }
        } else if (req.file.mimetype.startsWith('image/')) {
            metadata = await extractMetadataFromImage(req.file.path);
        } else {
            return res.json({ title: "", composer: "", warning: "Unsupported file type for OCR" });
        }

        // Clean up temp file
        fs.unlinkSync(req.file.path);

        res.json(metadata);
    } catch (e) {
        console.error("OCR Failed", e);
        res.status(500).json({ error: "OCR Failed: " + e.message });
    }
});


// YouTube Search
app.get('/api/youtube/search', authenticate, async (req, res) => {
    const query = req.query.q;
    const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

    if (!YOUTUBE_API_KEY) {
        return res.status(503).json({ 
            error: 'YouTube Search is not configured', 
            hint: 'Add YOUTUBE_API_KEY to your server .env file.' 
        });
    }

    if (!query) return res.json({ results: [] });

    try {
        const response = await fetch(
            `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=5&q=${encodeURIComponent(query)}&type=video&key=${YOUTUBE_API_KEY}`,
            { headers: { 'Accept': 'application/json' } }
        );

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error?.message || 'YouTube API error');
        }

        const data = await response.json();
        const results = (data.items || []).map(item => ({
            id: item.id.videoId,
            title: item.snippet.title,
            description: item.snippet.description,
            thumbnail: item.snippet.thumbnails?.default?.url,
            url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
            channelTitle: item.snippet.channelTitle,
            source: 'youtube'
        }));

        res.json({ results });
    } catch (e) {
        console.error('YouTube Search Failed:', e);
        res.status(500).json({ error: e.message });
    }
});

// MusicBrainz Search
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ results: [] });

    console.log('MusicBrainz Search:', query);

    const performSearch = async (attempt = 1) => {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

            const response = await fetch(
                `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=10`,
                {
                    headers: {
                        'User-Agent': 'SheetMusicApp/1.0 (zpapadim@gmail.com)',
                        'Accept': 'application/json'
                    },
                    signal: controller.signal
                }
            );
            clearTimeout(timeoutId);

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`MusicBrainz API Error: ${response.status} ${response.statusText} - ${text.substring(0, 100)}`);
            }

            const data = await response.json();

            const results = (data.recordings || []).slice(0, 5).map(rec => {
                const artists = rec['artist-credit'] || [];
                const composer = artists.map(a => a.artist?.name || a.name).join(', ');
                const releases = rec.releases || [];
                const firstRelease = releases[0] || {};
                const year = firstRelease.date ? firstRelease.date.substring(0, 4) : '';
                const tags = (rec.tags || []).map(t => t.name).slice(0, 3).join(', ');

                return {
                    title: rec.title,
                    composer: composer,
                    artist: composer,
                    year: year,
                    album: firstRelease.title || '',
                    tags: tags,
                    mbid: rec.id,
                    link: `https://musicbrainz.org/recording/${rec.id}`,
                    source: 'MusicBrainz',
                    metadata: {
                        title: rec.title,
                        composer: composer,
                        copyrightYear: year,
                        tags: tags
                    }
                };
            });

            console.log('MusicBrainz found', results.length, 'results');
            return results;

        } catch (e) {
            if (attempt < 2) {
                console.log(`MusicBrainz search attempt ${attempt} failed, retrying...`);
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s
                return performSearch(attempt + 1);
            }
            throw e;
        }
    };

    try {
        const results = await performSearch();
        res.json({ results, query });
    } catch (e) {
        console.error("MusicBrainz Search Failed:", e.message, e.cause);
        res.json({
            results: [],
            error: e.message,
            hint: e.message.includes('fetch failed') 
                ? 'Network connectivity issue to MusicBrainz. Please try again.' 
                : null
        });
    }
});

// Autosuggestion endpoint
app.get('/api/suggestions', authenticate, async (req, res) => {
    const { field, q } = req.query;
    
    // Allowed fields for security
    const ALLOWED_FIELDS = ['composer', 'arranger', 'lyricist', 'publisher', 'opus', 'subtitle'];
    
    if (!field || !ALLOWED_FIELDS.includes(field)) {
        return res.status(400).json({ error: 'Invalid or missing field parameter' });
    }
    
    if (!q || q.length < 2) {
        return res.json([]);
    }

    try {
        // Query for distinct values, ordered by frequency (popularity)
        // ILIKE for case-insensitive matching
        const query = `
            SELECT ${field} as value, COUNT(*) as freq 
            FROM sheets 
            WHERE ${field} ILIKE $1 
            AND ${field} IS NOT NULL 
            AND length(${field}) > 0
            GROUP BY ${field} 
            ORDER BY freq DESC, ${field} ASC 
            LIMIT 10
        `;
        
        const result = await db.query(query, [`%${q}%`]);
        res.json(result.rows.map(row => row.value));
    } catch (e) {
        console.error('Autosuggest failed:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- FOLDERS ---

app.get('/api/folders', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT f.*,
                   CASE WHEN f.user_id = $1 THEN true ELSE false END as is_owner,
                   CASE WHEN f.user_id != $1 THEN u.display_name ELSE null END as shared_by,
                   fs.permission as share_permission
            FROM folders f
            LEFT JOIN folder_shares fs ON f.id = fs.folder_id AND fs.shared_with_user_id = $1
            LEFT JOIN users u ON f.user_id = u.id
            WHERE f.user_id = $1 OR fs.shared_with_user_id = $1
            ORDER BY f.display_order, f.name
        `, [req.user.id]);
        res.json(result.rows);
    } catch (e) {
        console.error('Get folders failed:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/folders', authenticate, async (req, res) => {
    const { name, parentId, color } = req.body;

    try {
        const result = await db.query(
            `INSERT INTO folders (name, parent_id, color, user_id)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [name, parentId || null, color || null, req.user.id]
        );
        res.status(201).json(result.rows[0]);
    } catch (e) {
        console.error('Create folder failed:', e);
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/folders/:id', authenticate, async (req, res) => {
    const { id } = req.params;

    try {
        await db.query('DELETE FROM folders WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        res.status(204).send();
    } catch (e) {
        console.error('Delete folder failed:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- FOLDER SHARING ---

// Share a folder with another user by email
app.post('/api/folders/:id/share', authenticate, async (req, res) => {
    const { id } = req.params;
    const { email, permission = 'view' } = req.body;

    if (!email) return res.status(400).json({ error: 'Email is required' });
    if (!VALID_PERMISSIONS.includes(permission)) {
        return res.status(400).json({ error: 'Invalid permission level' });
    }

    try {
        const folderCheck = await db.query('SELECT id FROM folders WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        if (folderCheck.rows.length === 0) return res.status(404).json({ error: 'Folder not found or you do not own it' });

        const userResult = await db.query('SELECT id, email FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        if (userResult.rows.length === 0) return res.status(404).json({ error: 'Email not registered to a user' });
        const targetUser = userResult.rows[0];

        if (targetUser.id === req.user.id) return res.status(400).json({ error: 'Cannot share with yourself' });

        const existing = await db.query('SELECT id FROM folder_shares WHERE folder_id = $1 AND shared_with_user_id = $2', [id, targetUser.id]);
        if (existing.rows.length > 0) return res.status(409).json({ error: 'Folder already shared with this user' });

        const result = await db.query(`
            INSERT INTO folder_shares (folder_id, shared_with_user_id, shared_by_user_id, permission)
            VALUES ($1, $2, $3, $4)
            RETURNING id, permission, created_at
        `, [id, targetUser.id, req.user.id, permission]);

        res.status(201).json({
            message: 'Folder shared successfully',
            share: {
                id: result.rows[0].id,
                folder_id: id,
                permission: result.rows[0].permission,
                shared_with: { id: targetUser.id, email: targetUser.email },
                created_at: result.rows[0].created_at
            }
        });
    } catch (e) {
        console.error('Share folder failed:', e);
        res.status(500).json({ error: e.message });
    }
});

// Get folder shares
app.get('/api/folders/:id/shares', authenticate, async (req, res) => {
    const { id } = req.params;
    try {
        const folderCheck = await db.query('SELECT id FROM folders WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        if (folderCheck.rows.length === 0) return res.status(404).json({ error: 'Folder not found or access denied' });

        const result = await db.query(`
            SELECT fs.id, fs.permission, fs.created_at,
                   u.id as user_id, u.email, u.display_name
            FROM folder_shares fs
            JOIN users u ON fs.shared_with_user_id = u.id
            WHERE fs.folder_id = $1
            ORDER BY fs.created_at DESC
        `, [id]);

        res.json(result.rows.map(row => ({
            id: row.id,
            permission: row.permission,
            user: { id: row.user_id, email: row.email, display_name: row.display_name },
            created_at: row.created_at
        })));
    } catch (e) {
        console.error('Get folder shares failed:', e);
        res.status(500).json({ error: e.message });
    }
});

// Remove folder share
app.delete('/api/folders/:id/share', authenticate, async (req, res) => {
    const { id } = req.params;
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    try {
        const folderCheck = await db.query('SELECT id FROM folders WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        if (folderCheck.rows.length === 0) return res.status(404).json({ error: 'Folder not found or access denied' });

        const userResult = await db.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        const targetUserId = userResult.rows[0].id;

        await db.query('DELETE FROM folder_shares WHERE folder_id = $1 AND shared_with_user_id = $2', [id, targetUserId]);
        res.status(200).json({ message: 'Share removed' });
    } catch (e) {
        console.error('Remove folder share failed:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- SHEETS ---

app.get('/api/sheets', authenticate, async (req, res) => {
    try {
        const { 
            q, 
            composer, 
            instrument, 
            genre, 
            difficulty,
            key_signature,
            time_signature,
            tempo,
            publisher,
            sort_by = 'created_at', 
            order = 'desc',
            folder_id
        } = req.query;

        let query = `
            SELECT s.*, g.name as genre_name,
                   COALESCE(
                       (SELECT array_agg(sf.folder_id)
                        FROM sheet_folders sf
                        WHERE sf.sheet_id = s.id),
                       ARRAY[]::uuid[]
                   ) as folder_ids,
                   (SELECT i.name FROM sheet_instruments si
                    JOIN instruments i ON si.instrument_id = i.id
                    WHERE si.sheet_id = s.id AND si.is_primary = true
                    LIMIT 1) as instrument,
                   CASE WHEN s.user_id = $1 THEN true ELSE false END as is_owner,
                   CASE WHEN s.user_id != $1 THEN u.display_name ELSE null END as shared_by,
                   COALESCE(
                       ss.permission, 
                       (SELECT fs.permission 
                        FROM folder_shares fs
                        JOIN sheet_folders sf ON fs.folder_id = sf.folder_id
                        WHERE sf.sheet_id = s.id AND fs.shared_with_user_id = $1
                        LIMIT 1)
                   ) as share_permission
            FROM sheets s
            LEFT JOIN genres g ON s.genre_id = g.id
            LEFT JOIN sheet_shares ss ON s.id = ss.sheet_id AND ss.shared_with_user_id = $1
            LEFT JOIN users u ON s.user_id = u.id
            WHERE (s.user_id = $1 
               OR ss.shared_with_user_id = $1
               OR EXISTS (
                   SELECT 1 FROM sheet_folders sf
                   JOIN folder_shares fs ON sf.folder_id = fs.folder_id
                   WHERE sf.sheet_id = s.id AND fs.shared_with_user_id = $1
               ))
        `;

        const params = [req.user.id];
        let paramIndex = 2;

        if (q) {
            query += ` AND (s.search_vector @@ plainto_tsquery('english', $${paramIndex}) OR s.title ILIKE $${paramIndex + 1} OR s.composer ILIKE $${paramIndex + 1} OR array_to_string(s.tags, ',') ILIKE $${paramIndex + 1})`;
            params.push(q, `%${q}%`);
            paramIndex += 2;
        }

        if (composer) {
            query += ` AND s.composer ILIKE $${paramIndex}`;
            params.push(`%${composer}%`);
            paramIndex++;
        }

        if (instrument) {
            query += ` AND EXISTS (
                SELECT 1 FROM sheet_instruments si 
                JOIN instruments i ON si.instrument_id = i.id 
                WHERE si.sheet_id = s.id AND i.name ILIKE $${paramIndex}
            )`;
            params.push(`%${instrument}%`);
            paramIndex++;
        }

        if (genre) {
            query += ` AND g.name ILIKE $${paramIndex}`;
            params.push(`%${genre}%`);
            paramIndex++;
        }

        if (difficulty) {
            query += ` AND s.difficulty = $${paramIndex}`;
            params.push(difficulty);
            paramIndex++;
        }

        if (key_signature) {
            query += ` AND s.key_signature = $${paramIndex}`;
            params.push(key_signature);
            paramIndex++;
        }

        if (time_signature) {
            query += ` AND s.time_signature = $${paramIndex}`;
            params.push(time_signature);
            paramIndex++;
        }
        
        if (tempo) {
            query += ` AND s.tempo ILIKE $${paramIndex}`;
            params.push(`%${tempo}%`);
            paramIndex++;
        }

        if (publisher) {
            query += ` AND s.publisher ILIKE $${paramIndex}`;
            params.push(`%${publisher}%`);
            paramIndex++;
        }
        
        if (folder_id) {
             query += ` AND EXISTS (SELECT 1 FROM sheet_folders sf WHERE sf.sheet_id = s.id AND sf.folder_id = $${paramIndex})`;
             params.push(folder_id);
             paramIndex++;
        }

        // Allowed sort columns to prevent SQL injection
        const allowedSorts = ['title', 'composer', 'created_at', 'updated_at', 'difficulty', 'genre_name', 'instrument'];
        const sortColumn = allowedSorts.includes(sort_by) ? sort_by : 'created_at';
        const sortOrder = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

        query += ` ORDER BY ${sortColumn} ${sortOrder}`;

        const result = await db.query(query, params);
        res.json(result.rows);
    } catch (e) {
        console.error('Get sheets failed:', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/sheets/:id', authenticate, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await db.query(`
            SELECT s.*,
                   CASE WHEN s.user_id = $2 THEN true ELSE false END as is_owner
            FROM sheets s
            LEFT JOIN sheet_shares ss ON s.id = ss.sheet_id AND ss.shared_with_user_id = $2
            WHERE s.id = $1 AND (s.user_id = $2 OR ss.shared_with_user_id = $2)
        `, [id, req.user.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Sheet not found' });
        }
        res.json(result.rows[0]);
    } catch (e) {
        console.error('Get sheet failed:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/sheets', authenticate, upload.single('file'), async (req, res) => {
    const {
        title, subtitle, composer, arranger, lyricist,
        instrument, keySignature, timeSignature, tempo,
        genre, difficulty, opus, publisher, copyrightYear,
        tags, notes, folderId, folderIds, mediaLinks
    } = req.body;

    try {
        let fileUrl = null;
        let fileName = null;
        let fileSize = null;
        let fileType = null;
        let storageKey = null;
        let fileHash = null;

        console.log('Create sheet - req.file:', req.file ? req.file.originalname : 'NO FILE');

        // Upload file to Supabase Storage if provided
        if (req.file) {
            // Calculate Hash
            fileHash = await calculateFileHash(req.file.path);
            
            // Check for duplicate content (per-user)
            const dupCheck = await db.query('SELECT id, title, composer FROM sheets WHERE file_hash = $1 AND user_id = $2', [fileHash, req.user.id]);
            if (dupCheck.rows.length > 0) {
                if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                return res.status(409).json({
                    error: 'Duplicate file content detected',
                    duplicate: dupCheck.rows[0]
                });
            }

            console.log('Uploading to Supabase Storage:', req.file.path);
            try {
                const uploadResult = await uploadFile(req.file.path, req.file.originalname);
                console.log('Upload success:', uploadResult.url);
                fileUrl = uploadResult.url;
                storageKey = uploadResult.storageKey;
                fileName = req.file.originalname;
                fileSize = uploadResult.size;
                fileType = req.file.mimetype;
            } catch (uploadErr) {
                console.error('Storage upload failed:', uploadErr);
            }

            // Clean up local temp file
            if (fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
        }

        // Parse tags to array
        const tagsArray = tags ? tags.split(',').map(t => t.trim()).filter(t => t) : [];

        // Handle legacy folder IDs (convert non-UUID to null)
        const isValidUUID = (str) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

        // Parse folderIds (can be JSON string or array)
        let parsedFolderIds = [];
        if (folderIds) {
            try {
                parsedFolderIds = typeof folderIds === 'string' ? JSON.parse(folderIds) : folderIds;
                parsedFolderIds = parsedFolderIds.filter(id => isValidUUID(id));
            } catch (e) {
                parsedFolderIds = [];
            }
        }
        // Legacy support: if folderId provided but no folderIds
        if (parsedFolderIds.length === 0 && folderId && isValidUUID(folderId)) {
            parsedFolderIds = [folderId];
        }

        // Parse media links
        let parsedMediaLinks = [];
        if (mediaLinks) {
            try {
                parsedMediaLinks = typeof mediaLinks === 'string' ? JSON.parse(mediaLinks) : mediaLinks;
            } catch (e) {
                parsedMediaLinks = [];
            }
        }

        // Look up genre_id if genre name provided
        let genreId = null;
        if (genre) {
            const genreResult = await db.query(
                'SELECT id FROM genres WHERE name = $1',
                [genre]
            );
            if (genreResult.rows.length > 0) {
                genreId = genreResult.rows[0].id;
            }
        }

        const result = await db.query(`
            INSERT INTO sheets (
                title, subtitle, composer, arranger, lyricist,
                key_signature, time_signature, tempo,
                difficulty, genre_id, opus, publisher, copyright_year,
                tags, notes, media_links,
                file_url, file_name, file_size, file_type, storage_key, storage_provider,
                status, user_id, file_hash
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
            RETURNING *
        `, [
            title || 'Untitled',
            subtitle || null,
            composer || null,
            arranger || null,
            lyricist || null,
            keySignature || null,
            timeSignature || null,
            tempo || null,
            difficulty || null,
            genreId,
            opus || null,
            publisher || null,
            copyrightYear ? parseInt(copyrightYear) : null,
            tagsArray,
            notes || null,
            JSON.stringify(parsedMediaLinks),
            fileUrl,
            fileName,
            fileSize,
            fileType,
            storageKey,
            fileUrl ? 'supabase' : null,
            fileUrl ? 'uploaded' : 'registered',
            req.user.id,
            fileHash
        ]);

        const sheetId = result.rows[0].id;

        // Insert folder associations (many-to-many) - validate folder IDs exist first
        let validFolderIds = [];
        if (parsedFolderIds.length > 0) {
            const validFoldersResult = await db.query(
                'SELECT id FROM folders WHERE id = ANY($1::uuid[])',
                [parsedFolderIds]
            );
            validFolderIds = validFoldersResult.rows.map(r => r.id);

            if (validFolderIds.length > 0) {
                const folderValues = validFolderIds.map((fid, i) => `($1, $${i + 2})`).join(', ');
                await db.query(
                    `INSERT INTO sheet_folders (sheet_id, folder_id) VALUES ${folderValues}`,
                    [sheetId, ...validFolderIds]
                );
            }
        }

        // Add folder_ids to response
        result.rows[0].folder_ids = validFolderIds;

        // Handle instrument (many-to-many)
        if (instrument) {
            const instrumentResult = await db.query(
                'SELECT id FROM instruments WHERE name = $1',
                [instrument]
            );
            if (instrumentResult.rows.length > 0) {
                await db.query(
                    'INSERT INTO sheet_instruments (sheet_id, instrument_id, is_primary) VALUES ($1, $2, true)',
                    [result.rows[0].id, instrumentResult.rows[0].id]
                );
            }
        }

        // Add instrument, genre_name, and ensure all fields are present for frontend consistency
        result.rows[0].instrument = instrument || null;
        result.rows[0].genre_name = genre || null;
        // Ensure media_links is parsed if it's a string
        if (typeof result.rows[0].media_links === 'string') {
            try {
                result.rows[0].media_links = JSON.parse(result.rows[0].media_links);
            } catch (e) {
                result.rows[0].media_links = [];
            }
        }

        res.status(201).json(result.rows[0]);
    } catch (e) {
        console.error('Create sheet failed:', e);
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/sheets/:id', authenticate, upload.single('file'), async (req, res) => {
    const { id } = req.params;
    const {
        title, subtitle, composer, arranger, lyricist,
        instrument, keySignature, timeSignature, tempo,
        genre, difficulty, opus, publisher, copyrightYear,
        tags, notes, folderId, folderIds, annotations, mediaLinks
    } = req.body;

    try {
        // Get existing sheet - ensure it belongs to the user
        const existing = await db.query('SELECT * FROM sheets WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Sheet not found' });
        }
        const sheet = existing.rows[0];

        let fileUrl = sheet.file_url;
        let fileName = sheet.file_name;
        let fileSize = sheet.file_size;
        let fileType = sheet.file_type;
        let storageKey = sheet.storage_key;

        // Upload new file if provided
        if (req.file) {
            // Delete old file from storage
            if (sheet.storage_key) {
                await deleteFile(sheet.storage_key);
            }

            const uploadResult = await uploadFile(req.file.path, req.file.originalname);
            fileUrl = uploadResult.url;
            storageKey = uploadResult.storageKey;
            fileName = req.file.originalname;
            fileSize = uploadResult.size;
            fileType = req.file.mimetype;

            if (fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
        }

        // Parse tags
        const tagsArray = tags !== undefined
            ? (typeof tags === 'string' ? tags.split(',').map(t => t.trim()).filter(t => t) : tags)
            : sheet.tags;

        // Handle folder IDs (many-to-many)
        const isValidUUID = (str) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

        let parsedFolderIds = null; // null means no change
        if (folderIds !== undefined) {
            try {
                parsedFolderIds = typeof folderIds === 'string' ? JSON.parse(folderIds) : folderIds;
                parsedFolderIds = parsedFolderIds.filter(fid => isValidUUID(fid));
            } catch (e) {
                parsedFolderIds = [];
            }
        } else if (folderId !== undefined) {
            // Legacy support
            parsedFolderIds = folderId && isValidUUID(folderId) ? [folderId] : [];
        }

        // Parse annotations
        const annotationsJson = annotations !== undefined
            ? (typeof annotations === 'string' ? JSON.parse(annotations) : annotations)
            : sheet.annotations;

        // Parse media links
        let mediaLinksJson = sheet.media_links;
        if (mediaLinks !== undefined) {
            try {
                mediaLinksJson = typeof mediaLinks === 'string' ? JSON.parse(mediaLinks) : mediaLinks;
            } catch (e) {
                mediaLinksJson = [];
            }
        }

        // Look up genre_id
        let genreId = sheet.genre_id;
        if (genre !== undefined) {
            if (genre) {
                const genreResult = await db.query('SELECT id FROM genres WHERE name = $1', [genre]);
                genreId = genreResult.rows.length > 0 ? genreResult.rows[0].id : null;
            } else {
                genreId = null;
            }
        }

        const result = await db.query(`
            UPDATE sheets SET
                title = $1, subtitle = $2, composer = $3, arranger = $4, lyricist = $5,
                key_signature = $6, time_signature = $7, tempo = $8,
                difficulty = $9, genre_id = $10, opus = $11, publisher = $12, copyright_year = $13,
                tags = $14, notes = $15, media_links = $16,
                file_url = $17, file_name = $18, file_size = $19, file_type = $20, storage_key = $21,
                annotations = $22,
                status = $23
            WHERE id = $24
            RETURNING *
        `, [
            title !== undefined ? title : sheet.title,
            subtitle !== undefined ? subtitle : sheet.subtitle,
            composer !== undefined ? composer : sheet.composer,
            arranger !== undefined ? arranger : sheet.arranger,
            lyricist !== undefined ? lyricist : sheet.lyricist,
            keySignature !== undefined ? keySignature : sheet.key_signature,
            timeSignature !== undefined ? timeSignature : sheet.time_signature,
            tempo !== undefined ? tempo : sheet.tempo,
            difficulty !== undefined ? difficulty : sheet.difficulty,
            genreId,
            opus !== undefined ? opus : sheet.opus,
            publisher !== undefined ? publisher : sheet.publisher,
            copyrightYear !== undefined ? (copyrightYear ? parseInt(copyrightYear) : null) : sheet.copyright_year,
            tagsArray,
            notes !== undefined ? notes : sheet.notes,
            JSON.stringify(mediaLinksJson),
            fileUrl,
            fileName,
            fileSize,
            fileType,
            storageKey,
            annotationsJson,
            fileUrl ? 'uploaded' : sheet.status,
            id
        ]);

        // Update folder associations if provided
        if (parsedFolderIds !== null) {
            // Remove old associations
            await db.query('DELETE FROM sheet_folders WHERE sheet_id = $1', [id]);
            // Insert new associations - validate folder IDs exist first
            if (parsedFolderIds.length > 0) {
                // Filter to only valid folder IDs that exist in the database
                const validFoldersResult = await db.query(
                    'SELECT id FROM folders WHERE id = ANY($1::uuid[])',
                    [parsedFolderIds]
                );
                const validFolderIds = validFoldersResult.rows.map(r => r.id);

                if (validFolderIds.length > 0) {
                    const folderValues = validFolderIds.map((fid, i) => `($1, $${i + 2})`).join(', ');
                    await db.query(
                        `INSERT INTO sheet_folders (sheet_id, folder_id) VALUES ${folderValues}`,
                        [id, ...validFolderIds]
                    );
                }
                result.rows[0].folder_ids = validFolderIds;
            } else {
                result.rows[0].folder_ids = [];
            }
        } else {
            // Fetch current folder_ids
            const folderResult = await db.query(
                'SELECT folder_id FROM sheet_folders WHERE sheet_id = $1',
                [id]
            );
            result.rows[0].folder_ids = folderResult.rows.map(r => r.folder_id);
        }

        // Update instrument if provided
        if (instrument !== undefined) {
            // Remove old instruments
            await db.query('DELETE FROM sheet_instruments WHERE sheet_id = $1', [id]);

            if (instrument) {
                const instrumentResult = await db.query('SELECT id FROM instruments WHERE name = $1', [instrument]);
                if (instrumentResult.rows.length > 0) {
                    await db.query(
                        'INSERT INTO sheet_instruments (sheet_id, instrument_id, is_primary) VALUES ($1, $2, true)',
                        [id, instrumentResult.rows[0].id]
                    );
                }
            }
            result.rows[0].instrument = instrument || null;
        } else {
            // Fetch current instrument
            const instResult = await db.query(`
                SELECT i.name FROM sheet_instruments si
                JOIN instruments i ON si.instrument_id = i.id
                WHERE si.sheet_id = $1 AND si.is_primary = true LIMIT 1
            `, [id]);
            result.rows[0].instrument = instResult.rows[0]?.name || null;
        }

        // Add genre_name to response
        if (genre !== undefined) {
            result.rows[0].genre_name = genre || null;
        } else {
            const genreResult = await db.query(
                'SELECT name FROM genres WHERE id = $1',
                [result.rows[0].genre_id]
            );
            result.rows[0].genre_name = genreResult.rows[0]?.name || null;
        }

        // Ensure media_links is parsed if it's a string
        if (typeof result.rows[0].media_links === 'string') {
            try {
                result.rows[0].media_links = JSON.parse(result.rows[0].media_links);
            } catch (e) {
                result.rows[0].media_links = [];
            }
        }

        res.json(result.rows[0]);
    } catch (e) {
        console.error('Update sheet failed:', e);
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/sheets/:id', authenticate, async (req, res) => {
    const { id } = req.params;

    try {
        // Check if user owns the sheet OR has 'full' permission
        const accessCheck = await db.query(`
            SELECT s.storage_key, s.user_id,
                   CASE WHEN s.user_id = $2 THEN true ELSE false END as is_owner,
                   ss.permission
            FROM sheets s
            LEFT JOIN sheet_shares ss ON s.id = ss.sheet_id AND ss.shared_with_user_id = $2
            WHERE s.id = $1 AND (s.user_id = $2 OR ss.shared_with_user_id = $2)
        `, [id, req.user.id]);

        if (accessCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Sheet not found' });
        }

        const { is_owner, permission, storage_key } = accessCheck.rows[0];

        // Only owner or users with 'full' permission can delete
        if (!is_owner && permission !== 'full') {
            return res.status(403).json({ error: 'You do not have permission to delete this sheet' });
        }

        // Delete the file from storage
        if (storage_key) {
            await deleteFile(storage_key);
        }

        // Delete the sheet (will cascade delete shares)
        await db.query('DELETE FROM sheets WHERE id = $1', [id]);
        res.status(204).send();
    } catch (e) {
        console.error('Delete sheet failed:', e);
        res.status(500).json({ error: e.message });
    }
});

// Mass delete sheets
app.post('/api/sheets/batch-delete', authenticate, async (req, res) => {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'No sheet IDs provided' });
    }

    try {
        // Check permissions for all sheets
        const accessCheck = await db.query(`
            SELECT s.id, s.storage_key, s.user_id,
                   CASE WHEN s.user_id = $2 THEN true ELSE false END as is_owner,
                   ss.permission
            FROM sheets s
            LEFT JOIN sheet_shares ss ON s.id = ss.sheet_id AND ss.shared_with_user_id = $2
            WHERE s.id = ANY($1::uuid[]) AND (s.user_id = $2 OR ss.shared_with_user_id = $2)
        `, [ids, req.user.id]);

        const accessibleSheets = accessCheck.rows;
        const deletableSheets = accessibleSheets.filter(
            sheet => sheet.is_owner || sheet.permission === 'full'
        );

        if (deletableSheets.length === 0) {
            return res.status(403).json({ error: 'You do not have permission to delete any of the selected sheets' });
        }

        const deletedIds = [];
        const errors = [];

        // Delete files from storage and database
        for (const sheet of deletableSheets) {
            try {
                // Delete from storage if exists
                if (sheet.storage_key) {
                    await deleteFile(sheet.storage_key);
                }

                // Delete from database
                await db.query('DELETE FROM sheets WHERE id = $1', [sheet.id]);
                deletedIds.push(sheet.id);
            } catch (err) {
                console.error(`Failed to delete sheet ${sheet.id}:`, err);
                errors.push({ id: sheet.id, error: err.message });
            }
        }

        // Report sheets that weren't accessible
        const notFoundIds = ids.filter(id => !accessibleSheets.find(s => s.id === id));
        const noPermissionIds = accessibleSheets
            .filter(s => !s.is_owner && s.permission !== 'full')
            .map(s => s.id);

        res.json({
            deleted: deletedIds,
            notFound: notFoundIds,
            noPermission: noPermissionIds,
            errors: errors,
            message: `Successfully deleted ${deletedIds.length} of ${ids.length} sheets`
        });
    } catch (e) {
        console.error('Batch delete failed:', e);
        res.status(500).json({ error: e.message });
    }
});

// Download Sheet (redirect to storage URL or generate annotated PDF)
app.get('/api/sheets/:id/download', authenticate, async (req, res) => {
    const { id } = req.params;
    const { annotated } = req.query;

    try {
        // Check ownership or shared access
        const result = await db.query(`
            SELECT s.* FROM sheets s
            LEFT JOIN sheet_shares ss ON s.id = ss.sheet_id AND ss.shared_with_user_id = $2
            WHERE s.id = $1 AND (s.user_id = $2 OR ss.shared_with_user_id = $2)
        `, [id, req.user.id]);
        if (result.rows.length === 0 || !result.rows[0].file_url) {
            return res.status(404).send("File not found");
        }

        const sheet = result.rows[0];
        const targetAnnotations = sheet.annotations || {};
        const hasAnnotations = Object.keys(targetAnnotations).length > 0;

        // If not annotated request or no annotations exist, redirect to file URL
        if (annotated !== 'true' || !hasAnnotations) {
            return res.redirect(sheet.file_url);
        }

        console.log('Generating annotated PDF for sheet:', id);
        console.log('Annotations:', JSON.stringify(targetAnnotations).substring(0, 200));

        // Generate annotated PDF
        const response = await fetch(sheet.file_url);
        if (!response.ok) {
            console.error('Failed to fetch PDF:', response.status);
            return res.status(500).send("Failed to fetch original PDF");
        }
        const pdfBuffer = await response.arrayBuffer();

        const pdfDoc = await PDFDocument.load(pdfBuffer);
        const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const pages = pdfDoc.getPages();

        Object.keys(targetAnnotations).forEach(pageIndex => {
            const pageNum = parseInt(pageIndex);
            if (pageNum >= 1 && pageNum <= pages.length) {
                const page = pages[pageNum - 1];
                const { width, height } = page.getSize();
                const pageAnns = targetAnnotations[pageIndex] || [];

                pageAnns.forEach(ann => {
                    try {
                        if (ann.type === 'path' && ann.points && ann.points.length > 1) {
                            const pathPoints = ann.points.map(p => ({
                                x: p.x * width,
                                y: height - (p.y * height)
                            }));

                            let colorObj = { r: 1, g: 1, b: 0 };
                            try {
                                colorObj = ann.color ? JSON.parse(ann.color) : colorObj;
                            } catch (e) {}
                            const opacity = ann.opacity !== undefined ? ann.opacity : 0.5;
                            const thickness = ann.strokeWidth || 5;

                            for (let i = 0; i < pathPoints.length - 1; i++) {
                                page.drawLine({
                                    start: pathPoints[i],
                                    end: pathPoints[i+1],
                                    thickness: thickness,
                                    color: rgb(colorObj.r, colorObj.g, colorObj.b),
                                    opacity: opacity,
                                });
                            }
                        } else if (ann.type === 'text' && ann.text) {
                            const fontSize = ann.size || 12;
                            const x = ann.x * width;
                            const y = height - (ann.y * height) - fontSize + 2;
                            let colorObj = { r: 0, g: 0, b: 0 };
                            try {
                                colorObj = ann.color ? JSON.parse(ann.color) : colorObj;
                            } catch (e) {}

                            page.drawText(ann.text, {
                                x: x,
                                y: y,
                                size: fontSize,
                                font: helveticaFont,
                                color: rgb(colorObj.r, colorObj.g, colorObj.b),
                            });
                        }
                    } catch (annErr) {
                        console.error('Error processing annotation:', annErr);
                    }
                });
            }
        });

        const pdfBytes = await pdfDoc.save();
        // Sanitize filename for Content-Disposition header
        const safeTitle = (sheet.title || 'sheet').replace(/[^\w\s.-]/g, '_').substring(0, 50);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_annotated.pdf"`);
        res.send(Buffer.from(pdfBytes));

    } catch (e) {
        console.error("Download failed:", e);
        res.status(500).json({ error: e.message });
    }
});

// --- PROXY PDF (to avoid CORS issues) ---
app.get('/api/sheets/:id/pdf', authenticate, async (req, res) => {
    const { id } = req.params;

    try {
        // Check ownership or shared access
        const result = await db.query(`
            SELECT s.file_url, s.file_name FROM sheets s
            LEFT JOIN sheet_shares ss ON s.id = ss.sheet_id AND ss.shared_with_user_id = $2
            WHERE s.id = $1 AND (s.user_id = $2 OR ss.shared_with_user_id = $2)
        `, [id, req.user.id]);
        if (result.rows.length === 0 || !result.rows[0].file_url) {
            return res.status(404).send('File not found');
        }

        const sheet = result.rows[0];
        const response = await fetch(sheet.file_url);
        const buffer = await response.arrayBuffer();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${sheet.file_name}"`);
        res.send(Buffer.from(buffer));
    } catch (e) {
        console.error('PDF proxy failed:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- SHEET SHARING ---

// Permission levels:
// 'view'          - View only, no modifications
// 'annotate_self' - Can add personal annotations (only they can see)
// 'annotate_all'  - Can add annotations visible to everyone
// 'full'          - Full access including ability to delete
const VALID_PERMISSIONS = ['view', 'annotate_self', 'annotate_all', 'full'];

// Share a sheet with another user by email
app.post('/api/sheets/:id/share', authenticate, async (req, res) => {
    const { id } = req.params;
    const { email, permission = 'view' } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    if (!VALID_PERMISSIONS.includes(permission)) {
        return res.status(400).json({ error: 'Invalid permission level. Must be: view, annotate_self, annotate_all, or full' });
    }

    try {
        // Verify the sheet exists and the user owns it
        const sheetResult = await db.query(
            'SELECT id, title FROM sheets WHERE id = $1 AND user_id = $2',
            [id, req.user.id]
        );
        if (sheetResult.rows.length === 0) {
            return res.status(404).json({ error: 'Sheet not found or you do not own it' });
        }

        // Find the user by email
        const userResult = await db.query(
            'SELECT id, email, display_name FROM users WHERE LOWER(email) = LOWER($1)',
            [email]
        );
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'Email not registered to a user' });
        }

        const targetUser = userResult.rows[0];

        // Cannot share with yourself
        if (targetUser.id === req.user.id) {
            return res.status(400).json({ error: 'Cannot share a sheet with yourself' });
        }

        // Check if already shared
        const existingShare = await db.query(
            'SELECT id FROM sheet_shares WHERE sheet_id = $1 AND shared_with_user_id = $2',
            [id, targetUser.id]
        );
        if (existingShare.rows.length > 0) {
            return res.status(409).json({ error: 'Sheet is already shared with this user' });
        }

        // Create the share with permission
        const shareResult = await db.query(`
            INSERT INTO sheet_shares (sheet_id, shared_with_user_id, shared_by_user_id, permission)
            VALUES ($1, $2, $3, $4)
            RETURNING id, permission, created_at
        `, [id, targetUser.id, req.user.id, permission]);

        res.status(201).json({
            message: 'Sheet shared successfully',
            share: {
                id: shareResult.rows[0].id,
                sheet_id: id,
                permission: shareResult.rows[0].permission,
                shared_with: {
                    id: targetUser.id,
                    email: targetUser.email,
                    display_name: targetUser.display_name
                },
                created_at: shareResult.rows[0].created_at
            }
        });
    } catch (e) {
        console.error('Share sheet failed:', e);
        res.status(500).json({ error: e.message });
    }
});

// Get list of users a sheet is shared with
app.get('/api/sheets/:id/shares', authenticate, async (req, res) => {
    const { id } = req.params;

    try {
        // Verify the sheet exists and the user owns it
        const sheetResult = await db.query(
            'SELECT id FROM sheets WHERE id = $1 AND user_id = $2',
            [id, req.user.id]
        );
        if (sheetResult.rows.length === 0) {
            return res.status(404).json({ error: 'Sheet not found or you do not own it' });
        }

        // Get all shares for this sheet with permission
        const sharesResult = await db.query(`
            SELECT ss.id, ss.permission, ss.created_at,
                   u.id as user_id, u.email, u.display_name
            FROM sheet_shares ss
            JOIN users u ON ss.shared_with_user_id = u.id
            WHERE ss.sheet_id = $1
            ORDER BY ss.created_at DESC
        `, [id]);

        res.json(sharesResult.rows.map(row => ({
            id: row.id,
            permission: row.permission,
            user: {
                id: row.user_id,
                email: row.email,
                display_name: row.display_name
            },
            created_at: row.created_at
        })));
    } catch (e) {
        console.error('Get shares failed:', e);
        res.status(500).json({ error: e.message });
    }
});

// Remove share access by email
app.delete('/api/sheets/:id/share', authenticate, async (req, res) => {
    const { id } = req.params;
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    try {
        // Verify the sheet exists and the user owns it
        const sheetResult = await db.query(
            'SELECT id FROM sheets WHERE id = $1 AND user_id = $2',
            [id, req.user.id]
        );
        if (sheetResult.rows.length === 0) {
            return res.status(404).json({ error: 'Sheet not found or you do not own it' });
        }

        // Find the user by email
        const userResult = await db.query(
            'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
            [email]
        );
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'Email not registered to a user' });
        }

        const targetUserId = userResult.rows[0].id;

        // Delete the share
        const deleteResult = await db.query(
            'DELETE FROM sheet_shares WHERE sheet_id = $1 AND shared_with_user_id = $2 RETURNING id',
            [id, targetUserId]
        );

        if (deleteResult.rows.length === 0) {
            return res.status(404).json({ error: 'Share not found' });
        }

        res.status(200).json({ message: 'Share removed successfully' });
    } catch (e) {
        console.error('Remove share failed:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- LOOKUP DATA ---

app.get('/api/instruments', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM instruments WHERE is_active = true ORDER BY display_order, name'
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/genres', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM genres WHERE is_active = true ORDER BY display_order, name'
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- START SERVER ---

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
    
    // Log Email Service Status
    if (process.env.RESEND_API_KEY) {
        console.log('📧 Email Service: ACTIVE (Resend)');
    } else {
        console.log('⚠️ Email Service: DISABLED (Missing RESEND_API_KEY)');
    }
});
