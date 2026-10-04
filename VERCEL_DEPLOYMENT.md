# Deploying DocuMind AI Backend to Vercel

This guide outlines how to deploy the **DocuMind AI Backend** to Vercel as a serverless Node.js Express application.

---

## 1. Prerequisites

Before deploying, ensure you have:
1. A **Vercel Account** ([vercel.com](https://vercel.com/)).
2. A **Cloud PostgreSQL Database** with the `pgvector` extension enabled.
   - Recommended providers:
     - **Neon** ([neon.tech](https://neon.tech/)) — Serverless PostgreSQL with native `pgvector` support.
     - **Supabase** ([supabase.com](https://supabase.com/)) — PostgreSQL with `pgvector`.
     - **Railway / Render** — PostgreSQL with `pgvector`.
3. An **NVIDIA NIM API Key** ([build.nvidia.com](https://build.nvidia.com/)).

---

## 2. Configuration Files Included

The repository already includes the necessary Vercel configuration:
* `backend/api/index.js`: Serverless entry point wrapping the Express application.
* `backend/vercel.json`: Rewrites all incoming requests (`/(.*)`) to the serverless handler (`/api/index.js`).
* `backend/src/index.js`: Exports the `app` instance and conditionally runs `app.listen()` only during local execution.
* `backend/src/config/db.js`: Automatically handles SSL connections for cloud PostgreSQL providers (Neon, Supabase, Railway, etc.).
* `backend/src/controllers/documents.js`: Automatically uses `/tmp` (`os.tmpdir()`) for file uploads since Vercel's root filesystem is read-only.

---

## 3. Step-by-Step Vercel Deployment

### Method A: Deploy via Vercel Web Dashboard (Recommended)

1. **Push your code to GitHub / GitLab / Bitbucket**.
2. Go to [vercel.com/new](https://vercel.com/new).
3. Import your repository.
4. In the **Project Configuration** screen:
   - **Root Directory**: Click "Edit" and select **`backend`**.
   - **Framework Preset**: Leave as **Other** (Vercel will detect Node.js).
5. Expand the **Environment Variables** section and add the following:

| Variable Name | Description | Example / Recommended Value |
| :--- | :--- | :--- |
| `DATABASE_URL` | Cloud Postgres connection string with `pgvector` | `postgresql://user:password@ep-xyz.neon.tech/neondb?sslmode=require` |
| `NVIDIA_NIM_API_KEY` | NVIDIA NIM API key for chat & embeddings | `nvapi-...` |
| `JWT_SECRET` | Secret key used to sign JWT auth tokens | `your_long_random_jwt_secret_key_32_chars` |
| `NODE_ENV` | Environment mode | `production` |
| `DB_SSL` | Force SSL for Postgres (auto-detected if cloud) | `true` |

6. Click **Deploy**.
7. Once deployment finishes, Vercel will provide your live URL (e.g. `https://documind-backend.vercel.app`).

---

### Method B: Deploy via Vercel CLI

1. Install Vercel CLI globally if not already installed:
   ```bash
   npm install -g vercel
   ```
2. Navigate to the `backend` folder:
   ```bash
   cd backend
   ```
3. Deploy:
   ```bash
   vercel
   ```
4. Set environment variables when prompted or run:
   ```bash
   vercel env add DATABASE_URL
   vercel env add NVIDIA_NIM_API_KEY
   vercel env add JWT_SECRET
   ```
5. Deploy to production:
   ```bash
   vercel --prod
   ```

---

## 4. Verification

After deployment, verify your backend is active:
* **Root status**: Visit `https://your-backend.vercel.app/`
  * Expected response:
    ```json
    {
      "name": "DocuMind AI Backend API",
      "status": "online",
      "version": "1.0.0",
      "documentation": "/health"
    }
    ```
* **Health check**: Visit `https://your-backend.vercel.app/health`
  * Expected response:
    ```json
    {
      "status": "healthy",
      "timestamp": "2026-10-04T..."
    }
    ```

---

## 5. Connecting Your Frontend

Once your backend is live on Vercel:

1. Open `frontend-react/.env` (or configure in Vercel if hosting frontend on Vercel too):
   ```env
   VITE_API_BASE=https://your-backend.vercel.app/api
   ```
2. Re-build or re-deploy the frontend:
   ```bash
   npm run build --prefix frontend-react
   ```
3. The frontend will now communicate directly with your live Vercel backend.
