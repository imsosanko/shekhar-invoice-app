# Runs the app exactly as tested locally: Node/Express serving the API and
# frontend, with Python (reportlab/openpyxl) available for PDF/Excel
# generation. Built for platforms that run a real container — Render,
# Railway, Fly.io, a plain VPS, etc. NOT for Netlify: Netlify Functions only
# support JavaScript/TypeScript/Go (no Python runtime) and have no
# persistent server or filesystem, which this app needs. See the
# "Deploying online" section in README.md for the full explanation and the
# Netlify-compatible alternative (static frontend only, backend hosted here).

FROM node:20-slim

# Python + pip for the PDF/Excel generation scripts.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps first so this layer is cached unless package*.json changes.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Install Python deps the same way.
COPY requirements.txt ./
RUN pip3 install --break-system-packages --no-cache-dir -r requirements.txt

# Now the rest of the app.
COPY server ./server
COPY public ./public

# Data directory: mount a persistent volume/disk here in production (see
# README) or data/db.json will be lost whenever the container restarts —
# most hosting platforms give containers an ephemeral, disposable filesystem
# outside of any volume you explicitly attach.
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV SHEKHAR_DATA_DIR=/app/data
EXPOSE 3000

CMD ["node", "server/server.js"]
