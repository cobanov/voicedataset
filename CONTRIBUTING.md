# Contributing

The most useful contribution is a reading script for a new language. Fixes to existing scripts, interface translations and bug reports are welcome too.

## Add a language

1. Copy `website/languages/en.json` to `website/languages/<code>.json`, where `<code>` is the language's ISO 639-1 code (`fr`, `es`, `pt-BR` …).
2. Fill in `code`, `name` (in English), `nativeName` (in the language itself) and a `consent` line that contains `{name}`.
3. Write the sentences. Keep the five parts, or adapt them if your language calls for it.
4. Add the language to `website/languages/index.json`.
5. Run `node scripts/validate.mjs`, open the site locally (`cd website && python3 -m http.server 8000`) and record a few sentences yourself.
6. Open a pull request.

### Writing the sentences

The script is what the voice model learns from, so a good one is worth the time.

- **Write them yourself.** Every sentence is released under CC0, so nothing can be copied from books, songs, films, ads, news or existing corpora. Writing your own sentences, with a model's help if you like, is the safe way.
- **Aim for 200 sentences in five parts of 40**, mostly 10–18 words; long-sentence parts 18–32.
- **Cover the sounds.** Across the script, every phoneme of the language should come up many times, including the rare ones, plus consonant clusters, long compound words and anything else that is typical of the language.
- **Spell everything out.** Write numbers, dates, times, prices, units and abbreviations as words ("twenty-fourth of November", "ten percent"), so the text matches what is said. No digits, symbols or emoji, and never the `|` character.
- **Natural, neutral, pleasant.** Modern everyday language that sounds good read aloud. No politics, religion, violence, health scares, real private people or trademarks. First-person sentences should work for any speaker (no gendered self-reference where the language allows).
- **Vary the prosody.** Statements, questions of every kind, exclamations, mild emotions, short and long sentences.
- **The quick set** is every fourth line of each part (lines 1, 5, 9 … 37), so make those lines a balanced sample on their own. You can list your own quick set instead with `"quick": ["p1_01", "p2_05", …]`.

### File format

```json
{
  "code": "en",
  "name": "English",
  "nativeName": "English",
  "version": "2026-11-24",
  "license": "CC0-1.0",
  "consent": "My name is {name}. I am recording my own voice, of my own free will, to train a voice model.",
  "parts": [
    {
      "id": "p1",
      "title": "Everyday speech",
      "note": "Calm, in your normal everyday voice.",
      "lines": ["…", "…"]
    }
  ]
}
```

Sentence ids are `<part id>_<line number>` (`p1_01`), and they name the files in the exported ZIP. After a script is published, change a sentence in place rather than inserting or removing lines, so existing recordings keep their ids. The recorder marks a take for re-recording when its sentence text has changed, and bump `version` when you change the script.

## Translate the interface

Interface strings are in `website/i18n.js`. Copy the `en` block, translate the values and add the language to `UI_LANGS`. A reading script and an interface translation can come in separate pull requests.

## Code

There is no build step and no dependencies: plain ES modules served as static files. Keep it that way. Test changes to the recorder in Chrome, Firefox and Safari if you can, since microphone handling differs between them.
