// server.js — pont local pour l'option "Claude Code" de l'interface claudecode.
//
// Un navigateur ne peut pas exécuter le binaire `claude` ni lire des variables
// d'environnement. Ce petit serveur Node fait le pont : il sert index.html et,
// pour le provider "claude", spawn réellement `claude --print` en mode console
// avec le setup OpenRouter, puis streame la réponse vers l'UI en SSE.
//
// Démarrage :  node server.js   (puis ouvrir http://127.0.0.1:8787)
// Port configurable via la variable d'env PORT.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const OPENROUTER_BASE = process.env.ANTHROPIC_BASE_URL || 'https://openrouter.ai/api';
// Délai max d'une génération claude (le binaire peut planter sur un appel réseau).
// Au-delà, on tue le processus et on signale une erreur au client.
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 120000);

// ── Utilitaires ────────────────────────────────────────

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// Vérifie que `claude` est installé et récupère sa version.
function checkClaude() {
  return new Promise((resolve) => {
    const p = spawn(CLAUDE_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve({ claude: false, version: null }));
    p.on('close', (code) => {
      const version = out.toString().trim().split('\n')[0] || null;
      resolve({ claude: code === 0, version });
    });
  });
}

// Formate l'historique en un prompt texte pour `claude --print --input-format text`.
function buildPrompt(messages) {
  const lines = [];
  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'Assistant' : 'User';
    const text = (m.content || '').trim();
    if (!text && !(m.files && m.files.length)) continue;
    lines.push(`${role}: ${text}`);
    if (m.files && m.files.length) {
      for (const f of m.files) {
        if (f.dataUrl) lines.push(`[Fichier joint: ${f.name}]\n${f.dataUrl}`);
        else if (f.content != null) lines.push(`[Fichier joint: ${f.name}]\n${f.content}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

// ── Endpoint SSE : spawn claude ────────────────────────

async function handleClaudeCode(req, res) {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      return sendJson(res, 400, { error: 'JSON invalide' });
    }

    const apiKey = (payload.apiKey || '').trim();
    const model = (payload.model || '').trim();
    const messages = payload.messages || [];

    if (!apiKey) return sendJson(res, 400, { error: 'Clé API OpenRouter manquante' });
    if (!model) return sendJson(res, 400, { error: 'Modèle manquant' });

    const probe = await checkClaude();
    if (!probe.claude) {
      return sendJson(res, 500, {
        error: "Le binaire `claude` est introuvable. Installez Claude Code ou définissez CLAUDE_BIN.",
      });
    }

    // Headers SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const prompt = buildPrompt(messages);

    // Env = env courant, SANS ANTHROPIC_API_KEY (comme le setup PowerShell),
    // avec le routage OpenRouter + token fourni par l'UI.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    env.ANTHROPIC_BASE_URL = OPENROUTER_BASE;
    env.ANTHROPIC_AUTH_TOKEN = apiKey;
    env.OPENROUTER_API_KEY = apiKey;
    env.ANTHROPIC_MODEL = model;

    const args = [
      '--print',
      '--input-format', 'text',
      '--model', model,
      '--dangerously-skip-permissions',
    ];

    let child;
    try {
      child = spawn(CLAUDE_BIN, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: String(e.message || e) })}\n\n`);
      return res.end();
    }

    child.stdin.write(prompt);
    child.stdin.end();

    let acc = '';
    let errored = false;

    child.stdout.on('data', (d) => {
      const text = d.toString();
      acc += text;
      res.write(`data: ${JSON.stringify(text)}\n\n`);
    });

    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (e) => {
      errored = true;
      res.write(`event: error\ndata: ${JSON.stringify({ error: String(e.message || e) })}\n\n`);
      res.end();
    });

    child.on('close', (code) => {
      if (errored) return;
      if (code !== 0) {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            error: `claude a terminé avec le code ${code}`,
            detail: stderr.slice(-2000),
          })}\n\n`
        );
        return res.end();
      }
      res.write(`data: ${JSON.stringify('[DONE]')}\n\n`);
      res.end();
    });

    // Keep-alive : évite la coupure de la connexion par proxy.
    const ka = setInterval(() => res.write(': ping\n\n'), 15000);
    const timer = setTimeout(() => {
      clearInterval(ka);
      res.write(`event: error\ndata: ${JSON.stringify({ error: `Claude Code n'a pas repondu sous ${CLAUDE_TIMEOUT_MS / 1000} s (clé/modèle/réseau ?)` })}\n\n`);
      res.end();
      if (child && !child.killed) child.kill();
    }, CLAUDE_TIMEOUT_MS);
    child.on('close', () => clearTimeout(timer));
    req.on('close', () => {
      clearInterval(ka);
      clearTimeout(timer);
      if (child && !child.killed) child.kill();
    });
  });
}

// ── Serveur statique + routage ─────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/api/status') {
    const probe = await checkClaude();
    return sendJson(res, 200, probe);
  }

  if (pathname === '/api/claudecode' && req.method === 'POST') {
    return handleClaudeCode(req, res);
  }

  // Fichier statique : index.html par défaut
  let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(ROOT)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Retomber sur index.html (SPA)
      fs.readFile(path.join(ROOT, 'index.html'), (e2, d2) => {
        if (e2) return sendJson(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`claudecode serveur : http://${HOST}:${PORT}`);
  console.log(`Binaire claude : ${CLAUDE_BIN}  (base URL: ${OPENROUTER_BASE})`);
});
