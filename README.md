# voicedataset

Record your own voice dataset in the browser, sentence by sentence, and download it as a ready-to-train ZIP.

**https://voicedataset.cobanov.dev**

- **Nothing leaves your device.** Recording, trimming, storage and the ZIP all happen in your browser. There is no server code and no upload.
- **One sentence per clip.** No long recording to cut up afterwards. Press Space, read, press Space.
- **Clean takes.** The microphone is opened without echo cancellation, noise suppression or auto gain. Each take is trimmed to the speech plus about a quarter second of room tone, so the key clicks go too. Takes that clip, are too quiet, or have a word cut off are flagged so you can record them again.
- **Ready to train.** The ZIP follows the LJSpeech layout that most TTS and voice-cloning recipes accept: 16-bit mono WAV, `metadata.csv` (`id|text|text`) and a `metadata.jsonl` with levels and warnings. You can resample to 48, 44.1, 24, 22.05 or 16 kHz on export.
- **Languages:** English, Turkish, German. Each script has 200 original sentences in five parts (everyday speech; questions and feelings; numbers, names and borrowed words; talking to camera; long sentences and pace), plus a quick set of 50. You can also paste your own sentences.

## What's in the ZIP

```
alex-en-voicedataset/
├── wavs/
│   ├── alex_en_consent.wav
│   ├── alex_en_p1_01.wav
│   └── …
├── metadata.csv      # alex_en_p1_01|Text of the sentence.|Text of the sentence.
├── metadata.jsonl    # {"audio": "wavs/alex_en_p1_01.wav", "text": …, "duration": 3.42, "peak_db": -7.1, …}
└── README.md
```

The first clip is a consent line in the speaker's own voice ("My name is Alex. I am recording my own voice, of my own free will, to train a voice model.").

## Run it locally

It is a static site with no build step:

```bash
cd website && python3 -m http.server 8000
```

Then open http://localhost:8000. Browsers only allow the microphone on `localhost` or HTTPS.

## Add a language

Adding a language is one JSON file. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Project layout

| Path | What it is |
|---|---|
| `website/index.html`, `site.css` | The page |
| `website/app.js` | Recorder, navigation, export |
| `website/audio.js` | Take analysis and trimming, WAV encoding, resampling |
| `website/worklet.js` | AudioWorklet that taps the microphone |
| `website/store.js` | IndexedDB storage for takes |
| `website/zip.js` | Minimal ZIP writer |
| `website/i18n.js` | Interface strings (English, Turkish, German) |
| `website/languages/` | Reading scripts, one JSON file per language |
| `scripts/validate.mjs` | Checks the reading scripts (`node scripts/validate.mjs`) |

It is deployed as static assets on Cloudflare Workers (`npx wrangler deploy`).

## License

Code: [MIT](LICENSE). Reading scripts in `website/languages/`: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), so you can use the sentences for anything, including commercial models. Your recordings are yours.
