# Saut Audio Visualizer — separate FFmpeg renderer

This project separates the visualizer preview (static frontend) from MP4 rendering (Node.js + FFmpeg backend). The frontend is suitable for Vercel; the backend uses Docker and can be deployed as a Render web service.

## Important free-tier limitations

- Free backend instances can sleep, restart, or run out of CPU/RAM during long 1080p jobs. No free tier can guarantee reliable full-length 1080p rendering for every nasheed.
- The backend intentionally allows one render at a time, caps uploads at 100 MB, and caps audio at 15 minutes by default. Change `MAX_UPLOAD_MB` / `MAX_DURATION_SECONDS` only after checking the hosting provider's limits.
- Rendered files live on temporary server storage and may disappear when the instance restarts. Download the MP4 as soon as the job completes.
- If you need dependable long-form 1080p rendering, persistent storage and a paid worker/compute plan will eventually be needed.
- The renderer currently produces MP4 (H.264 video + AAC audio). The visualizer preview is client-side; FFmpeg renders the export independently using audio-reactive frequency/waveform filters. The available 22 frontend style labels map to a set of robust FFmpeg waveform/spectrum variants, not 22 wholly separate 3D engines.

## Project structure

- `index.html` — frontend to deploy on Vercel
- `backend/server.js` — render API, job state and progress polling
- `backend/Dockerfile` — installs FFmpeg and Arabic-capable Noto fonts
- `backend/render.yaml` — Render Blueprint configuration

## 1. Push to GitHub

Upload the contents of this project to the root of a GitHub repository. Keep `index.html` at the repository root and keep the `backend` folder intact.

## 2. Deploy the frontend to Vercel

1. Import the repository in Vercel.
2. Framework preset: **Other**.
3. Root directory: repository root.
4. Build command: leave blank; output directory: `.` (or leave the default for a static project).
5. Deploy. The main page is `index.html`.

## 3. Deploy the FFmpeg backend to Render

1. In Render, create a new **Web Service** from the same GitHub repository.
2. Set **Root Directory** to `backend`.
3. Choose **Docker** runtime (Render should detect `backend/Dockerfile`).
4. Select the Free plan if available in your account/region and create the service.
5. Environment variables (optional; defaults are set in `server.js`):
   - `MAX_UPLOAD_MB=100`
   - `MAX_DURATION_SECONDS=900`
   - `FRONTEND_ORIGIN=*` (works easily for initial setup; for production, set this to your exact Vercel URL)
6. Wait until the service is live. Open `https://YOUR-SERVICE.onrender.com/api/health`; it should return JSON with `ok: true`.

If using a Blueprint, select `backend/render.yaml` as the blueprint file if the dashboard supports specifying a nested blueprint. Otherwise follow the manual service steps above; the manual setup is less confusing for a first deployment.

## 4. Connect the frontend to the backend

1. Open your Vercel website.
2. In **RENDER BACKEND URL**, paste the backend's base URL, e.g. `https://saut-ffmpeg-renderer.onrender.com` (no `/api` at the end).
3. Select an audio file from your device. URL-loaded audio is not sent to the server automatically.
4. Choose aspect ratio, 720p/1080p, frame rate, visual style, cover, title and timestamped Urdu lyrics.
5. Tap **Render MP4 on server**. Wait for the status to say **MP4 render complete**, then download immediately.

The backend URL is remembered in local browser storage. Audio and cover files are uploaded to the backend for processing. Do not upload private or sensitive audio unless you trust the hosting service.

## Local development

Requirements: Node.js 20+, FFmpeg and FFprobe installed and available on PATH.

```bash
cd backend
npm install
npm start
```

Open `index.html` from a local static server (recommended) and set the backend URL to `http://localhost:8080`. For example, from the project root:

```bash
python -m http.server 5173
```

Then visit `http://localhost:5173` and paste `http://localhost:8080` in the backend URL field. Browser security/CORS rules may differ if testing from a `file://` URL; use a local web server.

## API endpoints

- `GET /api/health` — service health and free-tier limits
- `POST /api/render` — multipart upload (`audio`, optional `cover`, and render options); returns a job ID
- `GET /api/jobs/:id` — status and approximate frame-render progress
- `GET /api/jobs/:id/download` — downloads completed MP4
- `DELETE /api/jobs/:id` — cancels/removes a job

## Troubleshooting

- **Render URL not responding:** free services sleep; the first request may take a minute. Open `/api/health` first and retry.
- **CORS error:** set `FRONTEND_ORIGIN` to your exact Vercel origin, such as `https://your-project.vercel.app`, then redeploy the backend.
- **Audio rejected:** try MP3 or WAV; keep the upload under the configured limit.
- **Arabic lyrics appear incorrectly:** the backend installs Noto fonts, but complex Urdu shaping can vary by FFmpeg/libass build. Test a short clip first.
- **Render fails or times out:** try 720p, 24 FPS, a smaller audio file, and remove the cover image. Free compute is limited.
- **Download disappeared:** free-tier temporary files are not durable. Re-render and download promptly.
