# RoughCut – New Mac AI Handover Prompt

Copy and paste the entire block below into a new chat with your AI assistant on your Mac mini or secondary Mac:

```markdown
You are assisting me with RoughCut, a Premiere Pro UXP plugin and local Python backend engine that automates podcast editing.

### Project Context
- **Repository:** https://github.com/jimbrouw/banans.git (local folder: `~/Developer/Roughcut`)
- **Main Branch:** All recent features (UXP panel, local engine, Whisper transcription, Auto-Cut, overnight ingest, and clap sync) have been merged into `main`.
- **System Architecture:**
  1. Frontend: Premiere Pro UXP Plugin in `plugin-dist/` (React 16, Vite, TypeScript).
  2. Backend: Local Python engine in `engine/` running via `uv` on port `7317` managed on-demand by macOS `launchd`.

### Task: Setup & Verify RoughCut on this Mac
Please run and verify the following setup sequence in `~/Developer/Roughcut`:

1. **Pull Latest Main Branch:**
   ```bash
   cd ~/Developer/Roughcut
   git stash
   git checkout main
   git pull origin main
   ```

2. **System Prerequisites:**
   Ensure Homebrew has installed:
   ```bash
   brew install node ffmpeg uv
   ```

3. **Build the UXP Plugin:**
   ```bash
   npm install
   npm run build:uxp
   ```

4. **Install & Start Background Engine:**
   ```bash
   ./engine/install.sh
   ```

5. **Verify Engine Health:**
   ```bash
   curl http://localhost:7317/health
   ```
   (Should return `{"ok":true,...}`)

### Loading in Premiere Pro
- Open **Adobe UXP Developer Tool** -> **Add Plugin** -> select `~/Developer/Roughcut/plugin-dist/manifest.json` -> click **Load**.
- In Premiere Pro: **Window → UXP Plugins → RoughCut**.

### Critical Premiere Multi-Cam Rules
When testing Auto-Cut:
- Open the multi-camera source sequence by **Right-clicking the Multi-Camera Source Sequence in the Project panel → "Open in Timeline"** (do NOT run it on a nested multicam clip).
- Ensure each video track (V1, V2, etc.) contains **exactly 1 continuous clip** covering the full recording.

Please check the status of this machine and verify everything is operational.
```
