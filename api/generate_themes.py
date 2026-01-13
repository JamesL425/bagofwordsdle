#!/usr/bin/env python3
"""
Generate and/or validate theme word datasets for BagOfWordsdle.

Requirements:
- Single words only
- Lowercase
- Letters only (^[a-zA-Z]{2,30}$)
- No profanity (api/profanity.json)
- Filter out obscure words using wordfreq zipf_frequency

This script is optional at runtime (server uses api/themes.json).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import statistics
from pathlib import Path
from typing import Any, Dict, List, Tuple

from openai import OpenAI
from wordfreq import zipf_frequency


WORD_PATTERN = re.compile(r"^[a-zA-Z]{2,30}$")


# Fun, high-signal theme roster. Each theme is expected to end up with exactly 120 words.
DEFAULT_THEME_ROSTER: List[Dict[str, str]] = [
    {
        "name": "Internet & Memes",
        "prompt": "internet culture, social media, streaming, memes, online slang (clean, non-sexual, non-violent).",
    },
    {
        "name": "Video Games",
        "prompt": "video games and gaming concepts (no franchise names, no trademarks).",
    },
    {
        "name": "Spycraft & Espionage",
        "prompt": "spies, heists, codes, surveillance, disguises, gadgets, and intrigue.",
    },
    {
        "name": "Pirates & Treasure",
        "prompt": "pirates, ships, treasure, islands, sea adventure, swashbuckling.",
    },
    {
        "name": "Monsters & Creatures",
        "prompt": "classic monsters and spooky creatures (not too obscure).",
    },
    {
        "name": "Space Adventure",
        "prompt": "space exploration, sci fi adventure, astronauts, aliens, planets, starships.",
    },
    {
        "name": "Fantasy & Magic",
        "prompt": "fantasy adventure, magic, wizards, quests, castles, enchanted items.",
    },
    {
        "name": "Mythology & Legends",
        "prompt": "mythology and legends (keep only widely-known names, avoid niche proper nouns).",
    },
    {
        "name": "Superheroes & Comics",
        "prompt": "superheroes and comic-book concepts (no specific character names).",
    },
    {
        "name": "Crime & Mystery",
        "prompt": "mystery stories, detectives, clues, investigations, courtroom drama.",
    },
    {
        "name": "Halloween & Spooky",
        "prompt": "halloween, haunted houses, spooky vibes, costumes, scares (clean).",
    },
    {
        "name": "Disaster & Survival",
        "prompt": "survival, disasters, storms, rescues, emergency gear, wilderness.",
    },
    {
        "name": "Kitchen Chaos",
        "prompt": "cooking, kitchen tools, recipes, snacks, restaurants, food chaos.",
    },
    {
        "name": "Music & Concerts",
        "prompt": "music genres, instruments, concerts, festivals, DJs, band life.",
    },
    {
        "name": "Animals (Wild & Weird)",
        "prompt": "animals and wildlife (fun variety, avoid ultra-obscure species).",
    },
    {
        "name": "Ocean & Adventure",
        "prompt": "ocean, islands, storms, sea life, sailing, diving, exploration.",
    },
]


def load_json(path: Path, default: Any) -> Any:
    try:
        if path.exists():
            return json.loads(path.read_text())
    except Exception:
        pass
    return default


def load_profanity_words(repo_root: Path) -> set:
    profanity_path = repo_root / "api" / "profanity.json"
    data = load_json(profanity_path, default=[])
    if isinstance(data, dict):
        data = data.get("words", [])
    if not isinstance(data, list):
        return set()
    return {str(w).strip().lower() for w in data if str(w).strip()}


def sanitize_candidates(
    raw_words: List[str],
    profanity: set,
    always_exclude: set,
    always_include: set,
    min_zipf: float,
) -> Tuple[List[str], List[Tuple[str, str]]]:
    """
    Returns (clean_words, rejected) where rejected includes (word, reason).
    """
    seen = set()
    cleaned_scored: List[Tuple[str, float]] = []
    rejected: List[Tuple[str, str]] = []

    def _accept(token: str) -> bool:
        if token in always_exclude:
            rejected.append((token, "always_exclude"))
            return False
        if token in profanity:
            rejected.append((token, "profanity"))
            return False
        if not WORD_PATTERN.match(token):
            rejected.append((token, "invalid_format"))
            return False
        return True

    for w in raw_words or []:
        token = str(w or "").strip().lower()
        if not token:
            continue
        if token in seen:
            continue
        seen.add(token)
        if not _accept(token):
            continue
        z = float(zipf_frequency(token, "en"))
        if token not in always_include and z < float(min_zipf):
            rejected.append((token, f"too_rare(zipf={z:.2f})"))
            continue
        cleaned_scored.append((token, z))

    # Force include any requested tokens (if they pass basic validation)
    for token in always_include:
        token = str(token or "").strip().lower()
        if not token or token in seen:
            continue
        if not _accept(token):
            continue
        cleaned_scored.append((token, float(zipf_frequency(token, "en"))))
        seen.add(token)

    # Return sorted by score desc for easier debugging
    cleaned_scored.sort(key=lambda x: x[1], reverse=True)
    return [w for w, _ in cleaned_scored], rejected


def validate_theme_words(words: List[str], profanity: set) -> Dict[str, Any]:
    cleaned = []
    seen = set()
    invalid = []
    for w in words or []:
        token = str(w or "").strip().lower()
        if not token:
            continue
        if token in seen:
            continue
        seen.add(token)
        if token in profanity:
            invalid.append((token, "profanity"))
            continue
        if not WORD_PATTERN.match(token):
            invalid.append((token, "invalid_format"))
            continue
        cleaned.append(token)
    zipfs = [float(zipf_frequency(w, "en")) for w in cleaned] if cleaned else []
    return {
        "count": len(cleaned),
        "invalid": invalid,
        "min_zipf": min(zipfs) if zipfs else None,
        "median_zipf": statistics.median(zipfs) if zipfs else None,
    }


def generate_theme_words(
    client: OpenAI,
    model: str,
    theme_name: str,
    theme_prompt: str,
    candidates: int,
) -> List[str]:
    """
    Ask the model for a big candidate list (we'll filter locally).
    """
    system = (
        "You generate candidate word lists for a party word game.\n"
        "Return strict JSON only."
    )
    user = (
        f"Theme: {theme_name}\n"
        f"Theme description: {theme_prompt}\n\n"
        f"Generate {candidates} single-word entries.\n"
        "- lowercase\n"
        "- letters only (no spaces, hyphens, apostrophes, numbers)\n"
        "- 2-30 characters\n"
        "- avoid profanity\n"
        "- avoid ultra-technical jargon\n"
        "- avoid obscure proper nouns; only include widely-known names\n\n"
        "Return JSON with exactly this shape:\n"
        '{\"words\": [\"word\", \"word\", ...]}\n'
    )

    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        response_format={"type": "json_object"},
        temperature=0.7,
    )
    content = resp.choices[0].message.content or "{}"
    data = json.loads(content)
    words = data.get("words", [])
    if not isinstance(words, list):
        raise ValueError("Model did not return a JSON list at key 'words'")
    return [str(w) for w in words]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=os.getenv("THEME_MODEL", "gpt-4o-mini"))
    parser.add_argument("--count", type=int, default=120, help="Final words per theme")
    parser.add_argument("--candidates", type=int, default=260, help="Raw candidates per theme (before filtering)")
    parser.add_argument("--min-zipf", type=float, default=3.0, help="Minimum zipf_frequency for a word to be kept")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--out", default=str(Path(__file__).parent / "themes.json"))
    parser.add_argument("--overrides", default=str(Path(__file__).parent / "theme_overrides.json"))
    parser.add_argument("--validate-only", action="store_true", help="Validate existing themes.json and exit")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    profanity = load_profanity_words(repo_root)

    out_path = Path(args.out).resolve()
    overrides_path = Path(args.overrides).resolve()

    overrides = load_json(overrides_path, default={"global": {}, "themes": {}})
    global_inc = set((overrides.get("global", {}) or {}).get("always_include", []) or [])
    global_exc = set((overrides.get("global", {}) or {}).get("always_exclude", []) or [])
    per_theme = overrides.get("themes", {}) or {}

    if args.validate_only:
        data = load_json(out_path, default={})
        if not isinstance(data, dict):
            raise SystemExit(f"Invalid themes.json: expected object, got {type(data)}")
        ok = True
        for theme_name, words in data.items():
            info = validate_theme_words(words if isinstance(words, list) else [], profanity)
            count = info["count"]
            if count != int(args.count) or info["invalid"]:
                ok = False
            print(
                f"{theme_name}: count={count} min_zipf={info['min_zipf']} median_zipf={info['median_zipf']} invalid={len(info['invalid'])}"
            )
        return 0 if ok else 2

    api_key = os.getenv("OPENAI_API_KEY", "")
    if not api_key:
        raise SystemExit("OPENAI_API_KEY is required to generate themes. Use --validate-only to validate instead.")

    random.seed(int(args.seed))
    client = OpenAI(api_key=api_key)

    themes_out: Dict[str, List[str]] = {}

    for theme in DEFAULT_THEME_ROSTER:
        name = theme["name"]
        prompt = theme["prompt"]

        raw = generate_theme_words(
            client=client,
            model=args.model,
            theme_name=name,
            theme_prompt=prompt,
            candidates=int(args.candidates),
        )

        theme_cfg = per_theme.get(name, {}) or {}
        always_include = set(global_inc) | set(theme_cfg.get("always_include", []) or [])
        always_exclude = set(global_exc) | set(theme_cfg.get("always_exclude", []) or [])

        cleaned, rejected = sanitize_candidates(
            raw_words=raw,
            profanity=profanity,
            always_exclude=always_exclude,
            always_include=always_include,
            min_zipf=float(args.min_zipf),
        )

        if len(cleaned) < int(args.count):
            raise SystemExit(
                f"Theme '{name}' only produced {len(cleaned)} usable words after filtering; need {args.count}. "
                f"Try increasing --candidates or lowering --min-zipf. (Rejected: {len(rejected)})"
            )

        final = cleaned[:]
        if len(final) > int(args.count):
            final = random.sample(final, int(args.count))
        final = sorted(set(final))

        # Ensure exact size after de-dupe/sort
        if len(final) != int(args.count):
            # Fill deterministically from cleaned list (already sorted by zipf desc)
            seen = set(final)
            for w in cleaned:
                if w in seen:
                    continue
                final.append(w)
                seen.add(w)
                if len(final) >= int(args.count):
                    break
            final = sorted(set(final))

        if len(final) != int(args.count):
            raise SystemExit(f"Theme '{name}' failed to reach exact size {args.count}; got {len(final)}")

        zipfs = [float(zipf_frequency(w, "en")) for w in final]
        print(
            f"{name}: {len(final)} words | min_zipf={min(zipfs):.2f} median_zipf={statistics.median(zipfs):.2f} | rejected={len(rejected)}"
        )
        themes_out[name] = final

    out_path.write_text(json.dumps(themes_out, indent=2, sort_keys=True) + "\n")
    print(f"Wrote: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


