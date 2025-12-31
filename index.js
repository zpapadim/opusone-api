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

const app = express();
const port = process.env.PORT || 5000;

// CORS configuration - allow frontend origins
const allowedOrigins = [
    'http://localhost:5173',      // Vite dev
    'http://localhost:3000',      // React dev
    process.env.FRONTEND_URL      // Production frontend URL
].filter(Boolean);

app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (mobile apps, Postman, etc.)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.log('Blocked CORS request from:', origin);
            callback(null, true); // Allow all for now, restrict later if needed
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
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

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
async function extractMetadataFromImage(imagePath) {
    const worker = await Tesseract.createWorker('ell', 1, {
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

app.get('/', (req, res) => res.send('Sheet Music API Running'));

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


// MusicBrainz Search
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ results: [] });

    console.log('MusicBrainz Search:', query);

    try {
        const response = await fetch(
            `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=10`,
            {
                headers: {
                    'User-Agent': 'SheetMusicApp/1.0 (zpapadim@gmail.com)'
                }
            }
        );
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
        res.json({ results, query });
    } catch (e) {
        console.error("MusicBrainz Search Failed:", e.message);
        res.json({
            results: [],
            error: e.message,
            hint: e.message.includes('TLS') || e.message.includes('socket')
                ? 'Network/proxy issue - MusicBrainz may be blocked on this network'
                : null
        });
    }
});

// --- FOLDERS ---

app.get('/api/folders', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM folders ORDER BY display_order, name'
        );
        res.json(result.rows);
    } catch (e) {
        console.error('Get folders failed:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/folders', async (req, res) => {
    const { name, parentId, color } = req.body;

    try {
        const result = await db.query(
            `INSERT INTO folders (name, parent_id, color, user_id)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [name, parentId || null, color || null, null] // user_id null for now (no auth yet)
        );
        res.status(201).json(result.rows[0]);
    } catch (e) {
        console.error('Create folder failed:', e);
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/folders/:id', async (req, res) => {
    const { id } = req.params;

    try {
        await db.query('DELETE FROM folders WHERE id = $1', [id]);
        res.status(204).send();
    } catch (e) {
        console.error('Delete folder failed:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- SHEETS ---

app.get('/api/sheets', async (req, res) => {
    try {
        const result = await db.query(`
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
                    LIMIT 1) as instrument
            FROM sheets s
            LEFT JOIN genres g ON s.genre_id = g.id
            ORDER BY s.created_at DESC
        `);
        res.json(result.rows);
    } catch (e) {
        console.error('Get sheets failed:', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/sheets/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const result = await db.query(
            'SELECT * FROM sheets WHERE id = $1',
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Sheet not found' });
        }
        res.json(result.rows[0]);
    } catch (e) {
        console.error('Get sheet failed:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/sheets', upload.single('file'), async (req, res) => {
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
            
            // Check for duplicate content
            const dupCheck = await db.query('SELECT id, title, composer FROM sheets WHERE file_hash = $1', [fileHash]);
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
            null, // user_id null for now
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

app.put('/api/sheets/:id', upload.single('file'), async (req, res) => {
    const { id } = req.params;
    const {
        title, subtitle, composer, arranger, lyricist,
        instrument, keySignature, timeSignature, tempo,
        genre, difficulty, opus, publisher, copyrightYear,
        tags, notes, folderId, folderIds, annotations, mediaLinks
    } = req.body;

    try {
        // Get existing sheet
        const existing = await db.query('SELECT * FROM sheets WHERE id = $1', [id]);
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

app.delete('/api/sheets/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // Get sheet to delete file from Cloudinary
        const existing = await db.query('SELECT storage_key FROM sheets WHERE id = $1', [id]);
        if (existing.rows.length > 0 && existing.rows[0].storage_key) {
            await deleteFile(existing.rows[0].storage_key);
        }

        await db.query('DELETE FROM sheets WHERE id = $1', [id]);
        res.status(204).send();
    } catch (e) {
        console.error('Delete sheet failed:', e);
        res.status(500).json({ error: e.message });
    }
});

// Download Sheet (redirect to storage URL or generate annotated PDF)
app.get('/api/sheets/:id/download', async (req, res) => {
    const { id } = req.params;
    const { annotated } = req.query;

    try {
        const result = await db.query('SELECT * FROM sheets WHERE id = $1', [id]);
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
app.get('/api/sheets/:id/pdf', async (req, res) => {
    const { id } = req.params;

    try {
        const result = await db.query('SELECT file_url, file_name FROM sheets WHERE id = $1', [id]);
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
});
