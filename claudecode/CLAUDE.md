# ClaudeCode UI

Interface de chat (fork d'`apiface`) qui propose **trois modes** :

- **Google Gemini API** — appel API direct depuis le navigateur.
- **OpenRouter** — appel API direct depuis le navigateur.
- **Claude Code** — lance réellement le binaire `claude` en mode console
  (`claude --print`) via un petit serveur local (`server.js`). Le modèle est au
  choix parmi les Claude d'OpenRouter.

## Pourquoi un serveur local pour "Claude Code"

Un navigateur ne peut pas exécuter de binaire ni lire des variables d'environnement.
Le serveur `server.js` fait le pont : il reçoit l'historique depuis l'UI, spawn
`claude --print` avec le setup OpenRouter, et renvoie la réponse en SSE.

Setup appliqué côté serveur (équivalent PowerShell) :

```
ANTHROPIC_BASE_URL   = https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN = <clé OpenRouter saisie dans l'UI>
OPENROUTER_API_KEY   = <clé OpenRouter saisie dans l'UI>
ANTHROPIC_MODEL      = <modèle choisi>
# ANTHROPIC_API_KEY est explicitement retirer
```

## Lancer en local

```bash
cd claudecode
node server.js
# ou : npm start
```

Puis ouvrir http://127.0.0.1:8787

Le binaire `claude` doit être installé et dans le PATH (sinon définir `CLAUDE_BIN`).
Le port est configurable via la variable d'env `PORT`. `CLAUDE_TIMEOUT_MS` (défaut 120000)
tue un `claude` qui ne répond pas (clé/modèle/réseau invalide).

## Déploiement (ex : Vercel)

Vercel héberge **l'UI** (`index.html`), mais ne peut pas lancer le binaire `claude`
(côté serverless impossible). Le pont `server.js` doit donc tourner **ailleurs**
(ta machine, un VPS, un conteneur) et l'UI déployée doit pointer dessus :

- Dans `index.html`, définir `window.CLAUDE_BRIDGE_URL` (avant le `<script>` applicatif)
  avec l'URL publique du pont, ex. `https://mon-pont.example.com/api/claudecode`.
  Si vide, l'UI utilise `/api/claudecode` (utile en local).
- Le pont distant sert alors les routes `/api/status` et `/api/claudecode`.

Google et OpenRouter continuent de faire des appels API **directs** depuis le
navigateur (pas besoin du pont).

## Provider "Claude Code"

- Dans Paramètres, choisir **Claude Code (binaire local)**.
- Saisir une clé OpenRouter (utilisée comme `ANTHROPIC_AUTH_TOKEN` + `OPENROUTER_API_KEY`).
- Choisir un modèle Claude (pré-rempli : opus-4.1, sonnet-4.5, haiku-4.5, sonnet-4).
- Au chargement, l'UI appelle `GET /api/status` pour vérifier que `claude` est
  disponible. Si le serveur est absent, l'envoi est bloqué avec un avertissement.

## Pièces jointes

Images/vidéos sont lues en data URL et affichées inline dans le message ; les
autres fichiers sont envoyés en texte à l'API (et au prompt `claude`). Limite 2 Mo/fichier.
