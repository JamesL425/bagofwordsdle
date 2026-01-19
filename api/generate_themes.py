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


# Fun, high-signal theme roster. Each theme is expected to end up with exactly 100 words.
DEFAULT_THEME_ROSTER: List[Dict[str, str]] = [
    {
        "name": "The Great Outdoors",
        "prompt": "camping, hiking, nature, weather, mountains, forests, wildlife, outdoor adventure.",
    },
    {
        "name": "Food & Flavors",
        "prompt": "cooking, ingredients, tastes, dishes, restaurants, cuisine, kitchen, recipes.",
    },
    {
        "name": "Moods & Emotions",
        "prompt": "feelings, expressions, states of mind, emotional vocabulary, psychology.",
    },
    {
        "name": "Sports & Athletes",
        "prompt": "games, equipment, actions, competitions, teams, athletics, famous sports.",
    },
    {
        "name": "Music & Instruments",
        "prompt": "genres, instruments, performance terms, concerts, bands, musical vocabulary.",
    },
    {
        "name": "Planes, Trains & Automobiles",
        "prompt": "vehicles, travel, transportation, roads, airports, trains, cars, journeys.",
    },
    {
        "name": "The Lab",
        "prompt": "chemistry, physics, lab equipment, scientific method, biology, experiments.",
    },
    {
        "name": "History & Ancient Times",
        "prompt": "historical periods, famous figures, artifacts, civilizations, wars, empires.",
    },
    {
        "name": "Screens & Machines",
        "prompt": "technology, gadgets, computing, internet, devices, digital, software, hardware.",
    },
    {
        "name": "Gods & Monsters",
        "prompt": "mythology, deities, legendary creatures, folklore, ancient gods, mythical beasts.",
    },
    {
        "name": "Creatures of the Deep",
        "prompt": "ocean life, marine biology, sea creatures, underwater, fish, coral, diving.",
    },
    {
        "name": "Books & Authors",
        "prompt": "literature, famous authors, writing, novels, genres, storytelling, publishing.",
    },
    {
        "name": "Art & Artists",
        "prompt": "painting, sculpture, famous artists, art movements, galleries, creative techniques.",
    },
    {
        "name": "Movies & Hollywood",
        "prompt": "cinema, actors, film terms, directors, genres, awards, movie making.",
    },
    {
        "name": "Health & Anatomy",
        "prompt": "body parts, medical terms, wellness, fitness, doctors, hospitals, health.",
    },
    {
        "name": "Crime & Mystery",
        "prompt": "detective work, clues, investigations, police, courts, criminals, mysteries.",
    },
    {
        "name": "Wizards & Spells",
        "prompt": "magic, fantasy, enchantment, sorcery, wizards, witches, magical creatures.",
    },
    {
        "name": "Animals & Wildlife",
        "prompt": "creatures, habitats, animal behavior, mammals, birds, reptiles, insects.",
    },
    {
        "name": "Space & Sci-Fi",
        "prompt": "astronomy, sci-fi concepts, exploration, planets, aliens, rockets, future technology.",
    },
    {
        "name": "Cities & Civilization",
        "prompt": "urban life, landmarks, society, buildings, infrastructure, city living.",
    },
    {
        "name": "Clothes & Fashion",
        "prompt": "garments, style, accessories, designers, fabrics, trends, wardrobe.",
    },
    {
        "name": "Holidays & Parties",
        "prompt": "celebrations, festivities, traditions, decorations, gifts, seasonal events.",
    },
    {
        "name": "Love & Romance",
        "prompt": "relationships, affection, dating, weddings, emotions, romantic vocabulary.",
    },
    {
        "name": "Horror & Haunts",
        "prompt": "scary things, monsters, spooky vibes, haunted places, fear, supernatural horror.",
    },
    {
        "name": "Superheroes & Villains",
        "prompt": "superheroes, villains, comic books, powers, secret identities, capes, battles, justice.",
    },
    {
        "name": "Dinosaurs & Fossils",
        "prompt": "dinosaurs, fossils, prehistoric creatures, paleontology, extinction, excavation, ancient life.",
    },
    {
        "name": "Video Games & Gaming",
        "prompt": "video games, gaming culture, consoles, characters, levels, achievements, multiplayer.",
    },
    {
        "name": "Fantasy & Magic",
        "prompt": "magic, fantasy, enchantment, sorcery, wizards, witches, magical creatures, spells.",
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


def theme_name_to_filename(name: str) -> str:
    """Convert theme name to a valid filename."""
    # Replace & with 'and', spaces with underscores, lowercase
    filename = name.lower().replace(" & ", "_").replace(" ", "_")
    # Remove any non-alphanumeric characters except underscores
    filename = re.sub(r"[^a-z0-9_]", "", filename)
    return f"{filename}.json"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=os.getenv("THEME_MODEL", "gpt-4o-mini"))
    parser.add_argument("--count", type=int, default=100, help="Final words per theme")
    parser.add_argument("--candidates", type=int, default=260, help="Raw candidates per theme (before filtering)")
    parser.add_argument("--min-zipf", type=float, default=3.0, help="Minimum zipf_frequency for a word to be kept")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--out-dir", default=str(Path(__file__).parent / "themes"), help="Output directory for theme files")
    parser.add_argument("--legacy-out", default=str(Path(__file__).parent / "themes.json"), help="Legacy single-file output")
    parser.add_argument("--overrides", default=str(Path(__file__).parent / "theme_overrides.json"))
    parser.add_argument("--validate-only", action="store_true", help="Validate existing themes and exit")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    profanity = load_profanity_words(repo_root)

    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    
    legacy_out_path = Path(args.legacy_out).resolve()
    overrides_path = Path(args.overrides).resolve()

    overrides = load_json(overrides_path, default={"global": {}, "themes": {}})
    global_inc = set((overrides.get("global", {}) or {}).get("always_include", []) or [])
    global_exc = set((overrides.get("global", {}) or {}).get("always_exclude", []) or [])
    per_theme = overrides.get("themes", {}) or {}

    if args.validate_only:
        # Validate from individual theme files
        registry_path = out_dir / "theme_registry.json"
        if registry_path.exists():
            registry = load_json(registry_path, default={"themes": []})
            ok = True
            for entry in registry.get("themes", []):
                theme_file = out_dir / entry.get("file", "")
                if not theme_file.exists():
                    print(f"{entry['name']}: MISSING FILE {theme_file}")
                    ok = False
                    continue
                theme_data = load_json(theme_file, default={})
                words = theme_data.get("words", [])
                info = validate_theme_words(words if isinstance(words, list) else [], profanity)
                count = info["count"]
                if count != int(args.count) or info["invalid"]:
                    ok = False
                print(
                    f"{entry['name']}: count={count} min_zipf={info['min_zipf']} median_zipf={info['median_zipf']} invalid={len(info['invalid'])}"
                )
            return 0 if ok else 2
        else:
            # Fallback to legacy validation
            data = load_json(legacy_out_path, default={})
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
    registry_entries: List[Dict[str, str]] = []

    for theme in DEFAULT_THEME_ROSTER:
        name = theme["name"]
        prompt = theme["prompt"]
        filename = theme_name_to_filename(name)

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
        
        # Store for legacy output
        themes_out[name] = final
        
        # Write individual theme file
        theme_file_path = out_dir / filename
        theme_data = {"name": name, "words": final}
        theme_file_path.write_text(json.dumps(theme_data, indent=2) + "\n")
        print(f"  -> Wrote: {theme_file_path}")
        
        # Add to registry
        registry_entries.append({"name": name, "file": filename})

    # Write theme registry
    registry = {
        "themes": registry_entries,
    }
    registry_path = out_dir / "theme_registry.json"
    registry_path.write_text(json.dumps(registry, indent=2) + "\n")
    print(f"Wrote registry: {registry_path}")

    # Also write legacy single-file output for backwards compatibility
    legacy_out_path.write_text(json.dumps(themes_out, indent=2, sort_keys=True) + "\n")
    print(f"Wrote legacy: {legacy_out_path}")
    
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


