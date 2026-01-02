# OpusOne API Server

The backend API for OpusOne, a modern sheet music management application. Built with Node.js, Express, and PostgreSQL (via Supabase).

## Features

- **Sheet Music Management:** CRUD operations for sheet music entries with metadata.
- **Advanced Search:** Filter by composer, instrument, genre, difficulty, key, and more.
- **OCR Integration:** Extracts text and metadata from uploaded sheet music images/PDFs using Tesseract.js.
- **File Storage:** Secure file upload and retrieval using Supabase Storage.
- **Authentication:** User registration and login with JWT and bcrypt.
- **Sharing:** Share sheets and folders with other users with granular permissions.

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** PostgreSQL (Supabase)
- **Storage:** Supabase Storage
- **OCR:** Tesseract.js, pdf-lib
- **Authentication:** JSON Web Tokens (JWT)

## Local Setup

1.  **Install Dependencies:**
    ```bash
    npm install
    ```

2.  **Environment Variables:**
    Create a `.env` file in the root directory:
    ```env
    # Database
    DATABASE_URL=postgresql://postgres:[PASSWORD]@[HOST]:[PORT]/postgres

    # Supabase Storage
    SUPABASE_URL=https://[YOUR_PROJECT].supabase.co
    SUPABASE_ANON_KEY=[YOUR_KEY]

    # Auth
    JWT_SECRET=[YOUR_RANDOM_SECRET_STRING]

    # Email (Optional - for resets)
    RESEND_API_KEY=[YOUR_RESEND_KEY]
    FROM_EMAIL=onboarding@resend.dev

    # Client URL (for CORS)
    FRONTEND_URL=http://localhost:5173
    ```

3.  **Database Migration:**
    Run the migration script to set up tables and schema:
    ```bash
    node run-migration.js
    ```

4.  **Start Server:**
    ```bash
    npm start
    ```
    The server runs on `http://localhost:5000` by default.

## Deployment (Render)

1.  Push code to GitHub.
2.  Create a **Web Service** on Render.
3.  Connect your repository.
4.  **Build Command:** `npm install`
5.  **Start Command:** `node index.js`
6.  Add all Environment Variables from your `.env` file to the Render dashboard.

## API Endpoints

- `GET /api/sheets` - Search and list sheets
- `POST /api/sheets` - Upload new sheet
- `GET /api/sheets/:id` - Get sheet details
- `POST /api/ocr` - Process image/PDF for metadata
- `POST /api/auth/login` - User login
- `POST /api/auth/register` - User registration
