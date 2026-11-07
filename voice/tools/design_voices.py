"""Design the reference voices once (Apple Silicon, Qwen3-TTS VoiceDesign over mlx-audio).

    voice/.venv/bin/python voice/tools/design_voices.py [name ...] [--force]

Writes voice/voices/<name>.wav and <name>.txt. The clips are committed, so players never need the
VoiceDesign model: the Base model clones these clips on every backend. Each clip reads an
in-character line, because a clone keeps the delivery of its reference as well as the timbre.
narrator, villain and gruff come from solo-dm and are not listed here.
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pr_voice.voices import VOICE_DIR  # noqa: E402

DESIGN_MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-6bit"

VOICES = {
    "goblin": ("A small goblin with a high, shrill, nasal and scratchy voice, fast and gleeful, cackling and "
               "mischievous, sneering.",
               "Hee hee! Shiny boots, shiny buckles, all mine soon! You lot look tasty, and slow, and very, very stupid."),
    "brute": ("A huge ogre with a very deep, booming, slow and gravelly voice, dim-witted but menacing, chest "
              "resonance, heavy breathing.",
              "You small. You weak. Me hungry. Me smash you flat, then me eat you all up for supper."),
    "undead": ("An ancient undead creature with a hollow, dry, rasping whisper, slow and cold, airy and breathy, "
               "with an eerie echo of the grave.",
               "Cold. So cold, for so very long. Come closer, living ones. Lie down with us in the dark, and rest forever."),
    "crone": ("An old witch with a cracked, wavering, high old woman's voice, cackling, sly and amused, slightly "
              "hoarse.",
              "Oh ho ho, look what the bog dragged in! Sit down, dearies, the kettle's on, and the frogs are fresh this morning."),
    "zealot": ("A fanatical cult priest, a middle-aged man with an intense, fervent, trembling voice, preaching "
               "with feverish conviction, hissing on his consonants.",
               "The darkness is coming, and it is beautiful! Kneel, unbelievers, kneel, and the shadow may yet spare your souls."),
    "man": ("A friendly middle-aged man with a warm, hearty, medium-low voice, plain-spoken and good-humoured, a "
            "village tavern keeper.",
            "Come in, come in, out of the rain! There's stew on the fire and a bed upstairs, and I won't charge you for the gossip."),
    "woman": ("A warm, confident middle-aged woman with a clear, medium voice, practical and kind, a little "
              "teasing.",
              "Well, look at you, mud to the knees and swords still dripping. Sit down before you fall down, and tell me everything."),
    "lady": ("A refined noblewoman with a cool, elegant, precise voice, haughty and theatrical, slow and "
             "deliberate.",
             "How terribly brave of you to come all this way. Do wipe your boots, darlings. These carpets are older than your kingdom."),
    "elder": ("A frail, kindly old man with a thin, creaky, slow voice, wise and a little forgetful, gentle.",
              "Ah, travellers. I remember when the road was safe, oh, sixty winters back. Sit, sit, and let an old man tell you a secret."),
    "youth": ("A young boy of about twelve with a bright, eager, high voice, a little breathless and excited.",
              "Wait for me, wait for me! I can carry the torch, I promise. I'm not scared of the dark. Well, only a little."),
    "sly": ("A sly young man, a rogue, with a smooth, quick, playful voice, light and conspiratorial, always half "
            "laughing.",
            "Easy, friend, easy. Nobody needs to get stabbed today. I know a door, and a guard who sleeps, and a little secret."),
}


def main():
    import mlx.core as mx
    import soundfile as sf
    from mlx_audio.tts.utils import load_model

    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    names = args or list(VOICES)
    model = load_model(DESIGN_MODEL)
    for name in names:
        wav = VOICE_DIR / f"{name}.wav"
        if wav.exists() and not force:
            print(f"skip {name} (exists)")
            continue
        instruct, text = VOICES[name]
        chunks = [np.asarray(r.audio, dtype=np.float32) for r in
                  model.generate_voice_design(text=text, instruct=instruct, language="English", max_tokens=400)]
        audio = np.concatenate(chunks)
        peak = float(np.max(np.abs(audio))) or 1.0
        sf.write(str(wav), audio * (0.9 / peak), model.sample_rate, subtype="PCM_16")
        wav.with_suffix(".txt").write_text(text + "\n", encoding="utf-8")
        print(f"{name}: {audio.size / model.sample_rate:.1f}s")
        mx.clear_cache()


if __name__ == "__main__":
    main()
