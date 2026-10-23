# Suno2X

MP3 Suno → vidéo MP4 prête à poster sur X. Tout tourne dans le navigateur : aucun fichier n'est envoyé sur un serveur.

- Image de fond (flou, assombrissement, zoom lent, pulse sur les basses, couleurs auto extraites de l'image)
- Vumètres animés par le son : **Spectre**, **Vinyle** (radial + visuel qui tourne), **VU stéréo**
- **Lecture auto des métadonnées Suno** : titre, artiste, pochette (fond par défaut) et paroles (`TXXX:lyrics-xxx`)
- Paroles synchronisées ligne par ligne (rien si instrumental) :
  - **calage automatique** : Whisper (`onnx-community/whisper-base_timestamped`, ~80 Mo, exécuté dans le navigateur) + alignement sur les paroles connues ; lignes peu fiables signalées ⚠
  - sans paroles fournies : transcription brute découpée en lignes
  - calage au tap (Espace), import/export `.lrc`, décalage global ±0,1 s
- Export **H.264 High + AAC LC, 30 fps** (specs X) : 4:5 1080×1350 (recommandé, fil mobile), 1:1, 16:9 1920×1080, 9:16 1080×1900
- Limite X gratuite de 2:20 gérée : choix de l'extrait + fondu de sortie ; option Premium

## Développement

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # sortie statique dans dist/
```

Stack : Vite + TypeScript vanilla, [Mediabunny](https://mediabunny.dev) (WebCodecs + mux MP4 + lecture ID3), encodeur AAC WASM en repli (Firefox, Chromium Linux), [Transformers.js](https://huggingface.co/docs/transformers.js) dans un Web Worker pour Whisper.

> `npm install --ignore-scripts` évite le téléchargement d'onnxruntime-node (inutile côté navigateur).

## Déploiement

Le workflow `.github/workflows/deploy.yml` publie `dist/` sur GitHub Pages à chaque push sur `main` (activer *Settings → Pages → Source : GitHub Actions*).
