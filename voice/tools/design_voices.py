"""Design the reference voices once (Apple Silicon, Qwen3-TTS VoiceDesign over mlx-audio).

    voice/.venv/bin/python voice/tools/design_voices.py [name ...] [--force]

Writes voice/voices/<name>.wav and <name>.txt. The clips are committed, so players never need the
VoiceDesign model: the Base model clones these clips on every backend. Each clip reads an
in-character line, because a clone keeps the delivery of its reference as well as the timbre.
villain and gruff come from solo-dm and are not listed here. The narrator uses solo-dm's narrator
description, redesigned here with a longer (~12 s) reference, which solo-dm found clones more steadily.
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pr_voice.voices import VOICE_DIR  # noqa: E402

# Seeds of the takes that were kept (picked from several by pitch, roughness and how well the Base
# model's clone of them is understood); rerun with --force to roll new ones.
SEEDS = {"narrator": 2104, "crone": 1012, "hag": 1024, "goblin_king": 1039, "undead": 1034, "goblin": 1041}
# goblin: the designed clip is too clean for a goblin at that pitch, so it gets some grit before use
# (38 Hz growl flutter, tanh drive 8, +6 dB at 1.4 kHz, -6 dB at 250 Hz); the clone keeps it.

DESIGN_MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-6bit"

VOICES = {
    "narrator": ("A warm, deep, unhurried storyteller in his fifties, slightly husky, like a veteran tabletop game master reading by candlelight. Clear English.",
                 "The lantern gutters, and the old road bends into the dark between the pines. Somewhere ahead a bell is ringing, slow and patient, as if it has waited a hundred years for you."),
    "goblin": ("A nasty little goblin with a raspy, hoarse, gravelly voice pitched high and squeezed through the nose, like a rusty hinge: harsh, crackling and croaky, spitting and hissing, fast and twitchy, giggling wickedly. A creature, not a human; very rough and scratchy, never smooth or clear.",
             "Hee hee! Shiny boots, shiny buckles, all mine soon! You lot look tasty, and slow, and very, very stupid. Stab 'em! Stab 'em!"),
    "goblin_king": ("A goblin warlord king: a fat, cruel old goblin with a thick, guttural, gravelly and wet croaking voice, nasal and throaty, greedy and pompous, snarling and slurping his words, growling laughter. Clearly a monster, not a normal human man.",
             "Bow before your king, you soggy little worms! The king wants gold, the king wants blood, and the king always gets what he wants. Ha! Ha!"),
    "crone": ("A very old woman of about eighty, a cackling witch. Her voice is thin, cracked and croaking, dry and hoarse, with a constant tremble and wobble in it, breathy and wheezing between phrases, a nasal sing-song delivery that keeps breaking into a crackly cackle. Unmistakably elderly: never a young woman or a girl.",
             "Oh ho ho, look what the bog dragged in! Sit down, dearies, the kettle's on, and the frogs are fresh this morning. Heh heh."),
    "hag": ("An ancient, evil swamp hag. A low, guttural, gravelly old woman's voice that crackles like dry leaves, wet and phlegmy, slow and venomous, half-whispered threats that break into a rasping, wheezing cackle. Very old and very hoarse; menacing, not kindly.",
             "Little lambs, lost in my bog. Mother will boil your bones and grind your teeth, and sing you to sleep in the black water. Heh heh heh."),
    "undead": ("An ancient undead creature speaking in a hollow, dry, rasping whisper, almost no voice at all, only breath and rattle, slow and cold, each word dragged out of a dead throat, with an eerie, airy hiss of the grave.",
             "Cold. So cold, for so very long. Come closer, living ones. Lie down with us in the dark, and rest forever."),
    "brute": ("A huge ogre with a very deep, booming, slow and gravelly voice, dim-witted but menacing, chest "
              "resonance, heavy breathing.",
              "You small. You weak. Me hungry. Me smash you flat, then me eat you all up for supper."),
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
        if name in SEEDS and not force:
            mx.random.seed(SEEDS[name])
        chunks = [np.asarray(r.audio, dtype=np.float32) for r in
                  model.generate_voice_design(text=text, instruct=instruct, language="English", max_tokens=420)]
        audio = np.concatenate(chunks)
        peak = float(np.max(np.abs(audio))) or 1.0
        sf.write(str(wav), audio * (0.9 / peak), model.sample_rate, subtype="PCM_16")
        wav.with_suffix(".txt").write_text(text + "\n", encoding="utf-8")
        print(f"{name}: {audio.size / model.sample_rate:.1f}s")
        mx.clear_cache()


if __name__ == "__main__":
    main()
