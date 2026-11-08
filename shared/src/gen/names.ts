import type { Biome, SpeciesId } from '../types.js';
import type { Rng } from '../rng.js';

/**
 * Name generators: small syllable mixers and template fillers per culture, so a run rarely meets
 * the same town, innkeeper or goblin twice. Everything draws from the caller's Rng (world gen and
 * combat stay reproducible from a seed). A NameBook remembers what a run has already used.
 */

export type Gender = 'f' | 'm';
export type Culture =
  | 'human' | 'dwarf' | 'elf' | 'orc' | 'dragonborn' | 'halfling'
  | 'goblin' | 'kobold' | 'brute' | 'undead' | 'witch' | 'dragon' | 'bandit' | 'cult' | 'reptile' | 'beast' | 'construct' | 'fey';

const pick = <T>(rng: Rng, a: readonly T[]): T => rng.pick(a);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Join syllables, squashing awkward seams ("Grakk" + "ka" stays, "Aa" doesn't). */
function join(...parts: string[]): string {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    if (out && /[aeiouy]$/i.test(out) && /^[aeiouy]/i.test(p)) out += p.slice(1);
    else if (out && out.slice(-1).toLowerCase() === p[0]!.toLowerCase() && out.slice(-2, -1).toLowerCase() === p[0]!.toLowerCase()) out += p.slice(1);
    else out += p;
  }
  return cap(out.toLowerCase());
}

// ---------------------------------------------------------------- people

const HUMAN = {
  f: ['Alys', 'Bryony', 'Cassia', 'Della', 'Edda', 'Fenna', 'Greta', 'Hester', 'Isolde', 'Jessamy', 'Katrin', 'Liesel', 'Maud', 'Nell', 'Orla', 'Petra', 'Rosalind', 'Sabine', 'Tamsin', 'Una', 'Vesna', 'Willa', 'Yara', 'Zinnia', 'Ada', 'Beatrix', 'Clem', 'Dorota', 'Elspeth', 'Gwen', 'Ilse', 'Juna', 'Lark', 'Mira', 'Odile', 'Perpetua', 'Quilla', 'Rhosyn', 'Sorcha', 'Talia'],
  m: ['Aldric', 'Bram', 'Cedric', 'Dunstan', 'Edmund', 'Fergus', 'Godric', 'Hal', 'Ivo', 'Jory', 'Kester', 'Leofric', 'Merrick', 'Ned', 'Osric', 'Piers', 'Roland', 'Silas', 'Tobias', 'Ulric', 'Wystan', 'Barnaby', 'Corin', 'Davey', 'Emeric', 'Florian', 'Gideon', 'Hob', 'Jasper', 'Lorcan', 'Mattias', 'Nico', 'Oswin', 'Quill', 'Rufus', 'Stellan', 'Tamas', 'Vance', 'Wendel', 'Yorick'],
  pre: ['Al', 'Ber', 'Cal', 'Dor', 'El', 'Fen', 'Gar', 'Har', 'Is', 'Jor', 'Kel', 'Lor', 'Mar', 'Nor', 'Os', 'Per', 'Ros', 'Ser', 'Tam', 'Wil'],
  fsuf: ['a', 'ina', 'wen', 'issa', 'eth', 'ys', 'elle', 'ith', 'ara', 'ette'],
  msuf: ['ric', 'win', 'mund', 'bert', 'den', 'rick', 'an', 'ard', 'wick', 'o'],
};
const SURNAME = {
  a: ['Ash', 'Black', 'Bright', 'Bramble', 'Copper', 'Crow', 'Elder', 'Fair', 'Gold', 'Green', 'Hart', 'Hazel', 'Kettle', 'Lark', 'Mill', 'Moss', 'Oak', 'Pepper', 'Quick', 'Red', 'Salt', 'Stone', 'Thistle', 'Tumble', 'Under', 'Wex', 'Whit', 'Wild', 'Winter', 'Good', 'Half', 'Merry', 'Pot', 'Ember'],
  b: ['wood', 'ford', 'kettle', 'barrel', 'brook', 'hill', 'well', 'more', 'wick', 'thorn', 'field', 'worth', 'ley', 'by', 'stone', 'bottom', 'coin', 'water', 'hollow', 'leaf', 'bury', 'cott', 'gate', 'heart', 'son', 'smith'],
  trade: ['Cooper', 'Fletcher', 'Thatcher', 'Chandler', 'Tanner', 'Weaver', 'Mason', 'Brewer', 'Fowler', 'Carter', 'Sawyer', 'Baker', 'Draper', 'Glover'],
};
const DWARF = {
  pre: ['Bor', 'Dur', 'Thra', 'Gim', 'Hil', 'Brok', 'Dag', 'Fur', 'Grun', 'Kaz', 'Mor', 'Nor', 'Os', 'Rur', 'Tor', 'Vond', 'Bal', 'Ebb', 'Hrod', 'Ulf'],
  m: ['in', 'ak', 'grim', 'dain', 'rek', 'mund', 'ri', 'ok', 'bur', 'thor'],
  f: ['hild', 'dis', 'ra', 'una', 'wyn', 'li', 'ga', 'run', 'dra', 'lin'],
  sa: ['Stone', 'Iron', 'Deep', 'Coal', 'Gold', 'Anvil', 'Copper', 'Granite', 'Ember', 'Flint', 'Hammer', 'Rock', 'Silver', 'Forge'],
  sb: ['brow', 'hand', 'delver', 'beard', 'fist', 'mantle', 'shield', 'helm', 'breaker', 'born', 'heart', 'vein'],
};
const ELF = {
  pre: ['Ae', 'Syl', 'Ith', 'Lae', 'Fin', 'Cael', 'Elo', 'Mir', 'Thal', 'Va', 'Ner', 'Ari', 'Isil', 'Quen', 'Sae', 'Ely'],
  f: ['riel', 'wen', 'ara', 'lith', 'thiel', 'ya', 'nore', 'iel', 'issa', 'aine'],
  m: ['thas', 'ion', 'ras', 'orn', 'dril', 'vain', 'las', 'mir', 'endil', 'ros'],
  sa: ['Silver', 'Moon', 'Star', 'Dawn', 'Mist', 'Willow', 'Night', 'Sun', 'Leaf', 'Wind', 'Dew', 'Thorn'],
  sb: ['leaf', 'whisper', 'song', 'bough', 'shade', 'brook', 'glade', 'petal', 'runner', 'gleam', 'wind', 'veil'],
};
const ORC = {
  pre: ['Grom', 'Ug', 'Thak', 'Mor', 'Bru', 'Gash', 'Kur', 'Rok', 'Shag', 'Vor', 'Zug', 'Dra', 'Hag', 'Nar', 'Ogg', 'Urz'],
  m: ['gash', 'nak', 'dul', 'rok', 'mash', 'gor', 'thar', 'uk', 'buk', 'gar'],
  f: ['ga', 'sha', 'ra', 'zza', 'grit', 'na', 'ka', 'dra', 'gul', 'ma'],
  epi: ['Skullsplitter', 'Ironjaw', 'the Tusked', 'Bonechewer', 'Halfear', 'Redhand', 'the Loud', 'Gutripper', 'Stonefist', 'Blacktooth'],
};
const DRAGONBORN = {
  pre: ['Ar', 'Bal', 'Dra', 'Kri', 'Med', 'Nal', 'Rho', 'Sha', 'Tor', 'Vys', 'Zor', 'Hesk', 'Kava', 'Pan', 'Sora', 'Ush'],
  m: ['asar', 'kas', 'jhan', 'gar', 'thos', 'rash', 'van', 'zan', 'kith', 'mar'],
  f: ['ra', 'shann', 'thyra', 'via', 'lis', 'ka', 'rinn', 'jia', 'hith', 'sa'],
  clan: ['Kerrhylon', 'Delmirev', 'Yarjerit', 'Turnuroth', 'Myastan', 'Fenkenkabradon', 'Clethtinthiallor', 'Daardendrian', 'Kimbatuul', 'Prexijandilin'],
};
const HALFLING = {
  f: ['Pip', 'Rosie', 'Daisy', 'Marigold', 'Tilly', 'Bree', 'Poppy', 'Lavinia', 'Myrtle', 'Wynn'],
  m: ['Tobble', 'Milo', 'Ferris', 'Bingo', 'Cob', 'Perrin', 'Wendel', 'Ozzie', 'Fosco', 'Dilly'],
  sa: ['Under', 'Good', 'Tea', 'Thorn', 'Apple', 'Bramble', 'Honey', 'Burrow', 'Tumble', 'Green'],
  sb: ['bough', 'barrel', 'leaf', 'gage', 'foot', 'bottle', 'hill', 'kettle', 'field', 'dew'],
};

export function humanName(rng: Rng, g: Gender, opts: { surname?: boolean } = {}): string {
  const first = rng.chance(0.75) ? pick(rng, HUMAN[g]) : join(pick(rng, HUMAN.pre), pick(rng, g === 'f' ? HUMAN.fsuf : HUMAN.msuf));
  if (opts.surname === false) return first;
  return `${first} ${surname(rng)}`;
}
export function surname(rng: Rng): string {
  return rng.chance(0.2) ? pick(rng, SURNAME.trade) : join(pick(rng, SURNAME.a), pick(rng, SURNAME.b));
}

/** A first (and usually last) name for a playable species. */
export function speciesName(rng: Rng, species: SpeciesId | 'halfling', g: Gender = rng.chance(0.5) ? 'f' : 'm'): string {
  switch (species) {
    case 'dwarf':
      return `${join(pick(rng, DWARF.pre), pick(rng, DWARF[g]))} ${join(pick(rng, DWARF.sa), pick(rng, DWARF.sb))}`;
    case 'elf':
      return `${join(pick(rng, ELF.pre), pick(rng, ELF[g]))} ${join(pick(rng, ELF.sa), pick(rng, ELF.sb))}`;
    case 'orc':
      return rng.chance(0.6) ? `${join(pick(rng, ORC.pre), pick(rng, ORC[g]))} ${pick(rng, ORC.epi)}` : join(pick(rng, ORC.pre), pick(rng, ORC[g]));
    case 'dragonborn':
      return `${join(pick(rng, DRAGONBORN.pre), pick(rng, DRAGONBORN[g]))} ${pick(rng, DRAGONBORN.clan)}`;
    case 'halfling':
      return `${pick(rng, HALFLING[g])} ${join(pick(rng, HALFLING.sa), pick(rng, HALFLING.sb))}`;
    default:
      return humanName(rng, g);
  }
}

// ---------------------------------------------------------------- monsters

const MON = {
  goblin: { a: ['Gr', 'Sn', 'Skr', 'Z', 'Bl', 'Kr', 'Ny', 'Gn', 'Sk', 'Fl', 'Dr', 'Wr'], v: ['i', 'a', 'u', 'o', 'ee', 'ix'], b: ['k', 'z', 'b', 'g', 't', 'rk', 'zz', 'gg', 'nk', 'p'], s: ['it', 'ug', 'nak', 'rot', 'fang', 'tooth', 'wick', 'snout', 'grub', 'nose', 'gut', ''] },
  kobold: { a: ['Yip', 'Kib', 'Drak', 'Snik', 'Tik', 'Mek', 'Pazz', 'Rek', 'Vik', 'Zeep'], s: ['ik', 'po', 'zz', 'ka', 'lit', 'nub', 'scale', 'tail', 'yip', 'tok'] },
  brute: { a: ['Grom', 'Ug', 'Thud', 'Bor', 'Mog', 'Krug', 'Dob', 'Hurl', 'Gor', 'Lump', 'Bash', 'Oog'], s: ['gash', 'nak', 'dul', 'rok', 'bonk', 'gut', 'maw', 'lug', 'grub', 'nub', ''] },
  undead: { a: ['Vex', 'Mor', 'Nel', 'Xan', 'Az', 'Sar', 'Kel', 'Ur', 'Thul', 'Ves', 'Mal', 'Zor', 'Ny'], s: ['morrow', 'thrax', 'vane', 'ath', 'oth', 'ul', 'gorn', 'ess', 'iel', 'ark', 'mire', 'vos'] },
  dragon: { a: ['Ash', 'Cinder', 'Vor', 'Kal', 'Sear', 'Gloom', 'Scorch', 'Ember', 'Ruin', 'Smoul', 'Pyr', 'Ira', 'Drak', 'Vel'], s: ['maw', 'fang', 'thrax', 'gorath', 'wing', 'scale', 'vex', 'nyx', 'oros', 'claw', 'heart', 'mourn'] },
  reptile: { a: ['Ss', 'Ixx', 'Zha', 'Kesh', 'Sith', 'Tlak', 'Hass', 'Vrix', 'Saa', 'Kroa'], s: ['ith', 'ass', 'ka', 'eth', 'ix', 'ssk', 'tal', 'ra', 'ox', 'ees'] },
  witchFirst: ['Mother', 'Granny', 'Old Mag', 'Auntie', 'Grandmother', 'Sister', 'Widow', 'Nanna', 'Mistress'],
  witch: ['Murk', 'Wort', 'Gristle', 'Nettle', 'Toadbelly', 'Bramble', 'Hagwort', 'Bogwater', 'Thimble', 'Mildew', 'Rookwing', 'Blight', 'Crookback', 'Sallow', 'Grimalkin', 'Wormwood', 'Henbane', 'Nightshade', 'Moldwick', 'Sootsmock'],
  bandit: { nick: ['Knuckles', 'One-Ear', 'Red', 'Black', 'Lucky', 'Crooked', 'Mad', 'Quiet', 'Gentle', 'Scar', 'Patch', 'Handsome', 'Slippery', 'Big', 'Little'], tail: ['the Knife', 'the Rat', 'Two-Coins', 'Halfhand', 'the Weasel', 'Cutpurse', 'the Fox', 'Ninefingers', 'the Butcher', 'Smiles'] },
  cultTitle: ['Brother', 'Sister', 'Acolyte', 'Deacon', 'the Ashen', 'the Hollow', 'Mouth of the Dark', 'the Penitent'],
  beast: { a: ['Grey', 'Scar', 'Black', 'Old', 'Ragged', 'Torn', 'Silver', 'Red', 'Crook', 'Pale', 'Gnarl', 'Ash'], b: ['muzzle', 'ear', 'claw', 'back', 'tooth', 'tail', 'eye', 'hide', 'belly', 'fang', 'mane', 'paw'] },
  construct: { a: ['Brass', 'Iron', 'Rust', 'Clockwork', 'Granite', 'Copper', 'Bronze', 'Cog'], b: ['Sentinel', 'Warden', 'Guardian', 'Keeper', 'Watcher', 'Custodian'], n: ['II', 'III', 'IV', 'VII', 'IX', 'XII', 'XIV', 'XXI'] },
  fey: { a: ['Thistle', 'Bramble', 'Dew', 'Moth', 'Puck', 'Briar', 'Fennel', 'Nettle', 'Will', 'Glim'], b: ['wisp', 'down', 'kin', 'whit', 'foot', 'shine', 'wing', 'lock', 'nip', 'bell'] },
};

/** A personal name for a monster of a culture. */
export function monsterName(rng: Rng, culture: Culture, g: Gender = rng.chance(0.5) ? 'f' : 'm'): string {
  switch (culture) {
    case 'goblin': {
      const m = MON.goblin;
      return join(pick(rng, m.a), pick(rng, m.v), pick(rng, m.b), rng.chance(0.55) ? pick(rng, m.s) : '');
    }
    case 'kobold':
      return join(pick(rng, MON.kobold.a), pick(rng, MON.kobold.s));
    case 'brute':
      return join(pick(rng, MON.brute.a), pick(rng, MON.brute.s));
    case 'undead':
      return rng.chance(0.3) ? `${join(pick(rng, MON.undead.a), pick(rng, MON.undead.s))}-${join(pick(rng, MON.undead.a), pick(rng, MON.undead.s))}` : join(pick(rng, MON.undead.a), pick(rng, MON.undead.s));
    case 'dragon':
      return join(pick(rng, MON.dragon.a), pick(rng, MON.dragon.s));
    case 'reptile':
      return join(pick(rng, MON.reptile.a), pick(rng, MON.reptile.s));
    case 'witch':
      return `${pick(rng, MON.witchFirst)} ${pick(rng, MON.witch)}`;
    case 'bandit':
      return rng.chance(0.5) ? `${pick(rng, MON.bandit.nick)} ${humanName(rng, g, { surname: false })}` : `${humanName(rng, g, { surname: false })} ${pick(rng, MON.bandit.tail)}`;
    case 'cult': {
      const t = pick(rng, MON.cultTitle);
      return t.startsWith('the') || t.startsWith('Mouth') ? `${humanName(rng, g, { surname: false })} ${t}` : `${t} ${humanName(rng, g, { surname: false })}`;
    }
    case 'beast':
      return join(pick(rng, MON.beast.a), pick(rng, MON.beast.b));
    case 'construct':
      return `${pick(rng, MON.construct.a)} ${pick(rng, MON.construct.b)} ${pick(rng, MON.construct.n)}`;
    case 'fey':
      return join(pick(rng, MON.fey.a), pick(rng, MON.fey.b));
    case 'orc':
      return join(pick(rng, ORC.pre), pick(rng, ORC[g]));
    default:
      return speciesName(rng, culture as SpeciesId, g);
  }
}

/** Monster families whose members can carry a personal name, and the culture it comes from. */
export const FAMILY_CULTURE: Record<string, Culture> = {
  goblin: 'goblin', kobold: 'kobold', bandit: 'bandit', cult: 'cult', giant: 'brute', troll: 'brute', hag: 'witch',
  lizardfolk: 'reptile', sahuagin: 'reptile', vampire: 'undead', lich: 'undead', wraith: 'undead', skeleton: 'undead',
  dragon: 'dragon', wolf: 'beast', beast: 'beast', harpy: 'witch', fey: 'fey',
};

// ---------------------------------------------------------------- places

const TOWN = {
  pre: ['Oak', 'Mill', 'Thorn', 'Brook', 'Ash', 'Raven', 'Stone', 'Fern', 'Hollow', 'Bright', 'Wolf', 'Salt', 'Amber', 'Copper', 'Moss', 'Elder', 'Frost', 'Honey', 'Barrow', 'Kettle', 'Apple', 'Badger', 'Bram', 'Crane', 'Dun', 'Elm', 'Fox', 'Gold', 'Hazel', 'Heron', 'Iron', 'Lark', 'Marsh', 'Nettle', 'Otter', 'Pike', 'Quarry', 'Rook', 'Rush', 'Sedge', 'Silver', 'Swan', 'Tallow', 'Wether', 'Willow', 'Wren', 'Yew', 'Clover', 'Bell', 'Candle'],
  suf: ['ford', 'haven', 'wick', 'stead', 'bury', 'dale', 'mere', 'gate', 'watch', 'hollow', 'cross', 'field', 'bridge', 'well', 'moor', 'ton', 'ham', 'thorpe', 'by', 'combe', 'ley', 'worth', 'mouth', 'hithe', 'den', 'holme', 'shaw', 'burn', 'cote', 'stow'],
  lead: ['Upper', 'Lower', 'Little', 'Great', 'Old', 'New', 'East', 'West', 'North', 'South', 'Long', 'High'],
  river: ['Wyre', 'Esk', 'Teme', 'Lune', 'Ouse', 'Dove', 'Brent', 'Calder', 'Swale', 'Tarn'],
  tail: ['Crossing', 'Rest', 'End', 'Green', 'Market', 'Landing', 'Hope', 'Folly', 'Hollow', 'Reach'],
};

export function townName(rng: Rng): string {
  const base = () => join(pick(rng, TOWN.pre), pick(rng, TOWN.suf));
  const r = rng.next();
  if (r < 0.55) return base();
  if (r < 0.68) return `${pick(rng, TOWN.lead)} ${base()}`;
  if (r < 0.76) return `${base()}-on-${pick(rng, TOWN.river)}`;
  if (r < 0.84) return `Saint ${humanName(rng, rng.chance(0.5) ? 'f' : 'm', { surname: false })}'s`;
  if (r < 0.93) return `${humanName(rng, rng.chance(0.5) ? 'f' : 'm', { surname: false })}'s ${pick(rng, TOWN.tail)}`;
  return `${pick(rng, TOWN.pre)} ${pick(rng, TOWN.tail)}`;
}

const DUNGEON = {
  place: ['Crypt', 'Barrow', 'Den', 'Warren', 'Sunken Temple', 'Vault', 'Catacombs', 'Mine', 'Tower', 'Grotto', 'Lair', 'Keep', 'Pit', 'Ossuary', 'Halls', 'Cistern', 'Sepulchre', 'Labyrinth', 'Undercroft', 'Abbey', 'Chasm', 'Hive', 'Oubliette', 'Foundry'],
  of: ['of Sorrows', 'of the Forgotten King', 'of Whispers', 'of Bones', 'of the Deep', 'of Echoes', 'of the Moon', 'of Rust', 'of Mischief', 'of the Last Light', 'of Ash', 'of the Drowned Saint', 'of a Thousand Steps', 'of Hungry Shadows', 'of the Weeping Queen', 'of Broken Oaths', 'of Teeth', 'of the Black Candle', 'of Silent Bells', 'of the Pale Prince', 'of Rot', 'of Lost Children'],
  adj: ['Drowned', 'Shattered', 'Hollow', 'Crooked', 'Sunless', 'Gilded', 'Rotting', 'Howling', 'Forsaken', 'Salt-Crusted', 'Bleeding', 'Moaning', 'Cracked', 'Whispering', 'Sleeping', 'Upside-Down'],
};
export function dungeonName(rng: Rng): string {
  const r = rng.next();
  if (r < 0.5) return `The ${pick(rng, DUNGEON.place)} ${pick(rng, DUNGEON.of)}`;
  if (r < 0.78) return `The ${pick(rng, DUNGEON.adj)} ${pick(rng, DUNGEON.place)}`;
  return `${monsterName(rng, rng.chance(0.5) ? 'undead' : 'goblin').split('-')[0]}'s ${pick(rng, DUNGEON.place)}`;
}

const REGION: Partial<Record<Biome, { a: string[]; b: string[] }>> = {
  plains: { a: ['Golden', 'Windblown', 'Long', 'Sheepsbane', 'Barley', 'Rolling', 'Lonely', 'Poppy', 'Kingsway', 'Bramble'], b: ['Reach', 'Downs', 'Meadows', 'Fields', 'Leas', 'Wold', 'Steppe', 'Heath'] },
  forest: { a: ['Whisper', 'Gloom', 'Tangle', 'Oldroot', 'Moss', 'Raven', 'Thorn', 'Mirk', 'Owl', 'Fernshadow', 'Hag'], b: ['wood', 'weald', 'holt', 'briar', 'thicket', 'shaw', 'grove', 'hurst'] },
  swamp: { a: ['Murk', 'Bog', 'Weeping', 'Croak', 'Rot', 'Leech', 'Sedge', 'Misty', 'Drowned', 'Toad'], b: ['mire', 'fen', 'marsh', 'mere', 'slough', 'wallow', 'bottoms', 'carr'] },
  mountains: { a: ['Grim', 'Sky', 'Anvil', 'Frost', 'Iron', 'Thunder', 'Widow', 'Eagle', 'Cloud', 'Broken'], b: ['teeth', 'shear Peaks', 'Range', 'fang Heights', 'crag', 'spine', 'horns', 'Tors'] },
  desert: { a: ['Sunscald', 'Glass', 'Dry Bones', 'Red', 'Thirst', 'Scorpion', 'Shifting', 'Bleached', 'Mirage'], b: ['Wastes', 'Dunes', 'Basin', 'Flats', 'Sands', 'Barrens', 'Expanse'] },
  ruins: { a: ['Shattered', 'Fallen', 'Old Empire\'s', 'Ghost', 'Hollow', 'Sunken', 'Toppled', 'Forgotten', 'Ashen'], b: ['Court', 'Spire', 'Bones', 'gate', 'Colonnade', 'Throne', 'Causeway', 'Forum'] },
  coast: { a: ['Salt', 'Gull', 'Wreckers\'', 'Pearl', 'Shingle', 'Storm', 'Kelp', 'Lantern', 'Siren'], b: ['cliffs', 'whistle Shore', 'Coast', 'strand', 'Bay', 'Point', 'Cove', 'Spit'] },
  water: { a: ['Mirror', 'Deep', 'Grey', 'Still', 'Sunken', 'Silver'], b: ['Lake', 'water', 'Sound', 'Loch', 'Mere', 'Deeps'] },
};
export function regionName(rng: Rng, biome: Biome): string {
  const t = REGION[biome] ?? REGION.plains!;
  const a = pick(rng, t.a);
  const b = pick(rng, t.b);
  return `the ${/^[a-z]/.test(b) ? `${a}${b}` : `${a} ${b}`}`;
}

const POI = {
  camp: { a: ['Old', 'Hunters\'', 'Wayfarer\'s', 'Lonely', 'Shepherd\'s', 'Pilgrim\'s', 'Smuggler\'s', 'Drover\'s', 'Woodcutter\'s'], b: ['Campsite', 'Rest', 'Fire', 'Hearth', 'Lean-to', 'Bivouac', 'Clearing', 'Hut'] },
  shrine: { a: ['Dawn', 'the Wanderer', 'the Moss Saint', 'Starfall', 'the Quiet Mother', 'the Lantern', 'Hollow Bells', 'the Weeping Stone', 'Saint Hob', 'the Last Ember'] },
  merchant: { a: ['Peddler\'s Wagon', 'Trading Post', 'Odd Little Shop', 'Curio Cart', 'Tinker\'s Tent', 'Crossroads Stall', 'Bargain Barrow', 'Lucky Bazaar'] },
  lair: { a: ['Beast', 'Bone-Strewn', 'Monster', 'Stinking', 'Gnawed', 'Howling', 'Shadow', 'Thornback'], b: ['Lair', 'Den', 'Nest', 'Burrow', 'Hollow', 'Wallow'] },
  ruin: { a: ['Crumbling Ruins', 'Forgotten Monument', 'Old Watchtower', 'Toppled Statue', 'Broken Aqueduct', 'Roofless Chapel', 'Giant\'s Footprint', 'Mossy Obelisk', 'Burnt Manor'] },
};
export function poiName(rng: Rng, kind: 'camp' | 'shrine' | 'merchant' | 'lair' | 'ruin'): string {
  switch (kind) {
    case 'camp':
      return `${pick(rng, POI.camp.a)} ${pick(rng, POI.camp.b)}`;
    case 'shrine':
      return `Shrine of ${pick(rng, POI.shrine.a)}`;
    case 'merchant':
      return rng.chance(0.4) ? `${humanName(rng, rng.chance(0.5) ? 'f' : 'm', { surname: false })}'s ${pick(rng, ['Wagon', 'Wares', 'Emporium', 'Stall', 'Curios'])}` : pick(rng, POI.merchant.a);
    case 'lair':
      return `${pick(rng, POI.lair.a)} ${pick(rng, POI.lair.b)}`;
    case 'ruin':
      return pick(rng, POI.ruin.a);
  }
}

const TAVERN = {
  adj: ['Prancing', 'Drunken', 'Laughing', 'Sleepy', 'Golden', 'Rusty', 'Jolly', 'Three-Legged', 'Wandering', 'Bashful', 'Singing', 'Soggy'],
  noun: ['Pony', 'Goose', 'Dragon', 'Badger', 'Kettle', 'Hen', 'Owl', 'Boot', 'Barrel', 'Stag', 'Toad', 'Lantern'],
};
export function tavernName(rng: Rng): string {
  return rng.chance(0.7) ? `The ${pick(rng, TAVERN.adj)} ${pick(rng, TAVERN.noun)}` : `The ${pick(rng, TAVERN.noun)} & ${pick(rng, TAVERN.noun)}`;
}

const TRINKET = {
  mat: ['Silver', 'Moonsilver', 'Copper', 'Bone', 'Glass', 'Amber', 'Jade', 'Iron', 'Star-Iron', 'Obsidian', 'Gilded', 'Coral'],
  obj: ['Locket', 'Ledger', 'Ingot', 'Crown', 'Idol', 'Map', 'Chalice', 'Music Box', 'Key', 'Bell', 'Compass', 'Mirror', 'Signet Ring', 'Reliquary', 'Hourglass', 'Lute'],
  plant: ['Moonpetal', 'Ghostcap', 'Dragon\'s Tongue', 'Sunroot', 'Witchbloom', 'Frostberry'],
};
export function trinketName(rng: Rng): string {
  if (rng.chance(0.15)) return pick(rng, TRINKET.plant);
  if (rng.chance(0.25)) return `${humanName(rng, rng.chance(0.5) ? 'f' : 'm', { surname: false })}'s ${pick(rng, TRINKET.obj)}`;
  return `${pick(rng, TRINKET.mat)} ${pick(rng, TRINKET.obj)}`;
}

// ---------------------------------------------------------------- NPCs

/** Honorifics per NPC archetype; a name gets one of these about half the time (always for nobles). */
const NPC_TITLES: Record<string, { f?: string[]; m?: string[]; always?: boolean; culture?: Culture; nick?: string[] }> = {
  innkeeper: { f: ['Big', 'Old', 'Mother'], m: ['Big', 'Old', 'Fat'] },
  blacksmith: { f: ['Iron'], m: ['Hammer'], culture: 'dwarf' },
  hermit: { f: ['Grandmother', 'Old', 'Sister'], m: ['Old', 'Brother', 'Father'] },
  noble: { f: ['Lady', 'Countess', 'Duchess', 'Baroness', 'Dame'], m: ['Lord', 'Count', 'Duke', 'Baron', 'Sir'], always: true },
  guard_captain: { f: ['Captain', 'Sergeant', 'Commander'], m: ['Captain', 'Sergeant', 'Commander'], always: true },
  priest: { f: ['Mother', 'Sister', 'Abbess'], m: ['Father', 'Brother', 'Abbot'], always: true },
  knight_errant: { f: ['Dame'], m: ['Sir'], always: true },
  scholar: { f: ['Professor', 'Magister', 'Archivist', 'Doctor'], m: ['Professor', 'Magister', 'Archivist', 'Doctor'], always: true },
  pirate: { f: ['Captain', 'Mad', 'One-Tooth'], m: ['Captain', 'Salty', 'Black'] },
  friendly_witch: { f: ['Granny', 'Auntie', 'Old Mother'], m: ['Old'] },
  old_adventurer: { f: ['Granny', 'Old'], m: ['Old', 'One-Eyed', 'Grizzled'] },
  tax_collector: { f: ['Madam', 'Auditor', 'Clerk'], m: ['Mister', 'Auditor', 'Clerk'], always: true },
  defector: { f: ['Sister'], m: ['Brother'] },
  dwarf_miner: { culture: 'dwarf' },
  ranger: { culture: 'elf' },
  lost_child: { nick: ['Little'] },
  thief: { nick: ['Nimble', 'Sly', 'Quick', 'Two-Coins', 'Light-Fingered'] },
  rival_bard: { f: ['Dame'], m: ['Sir'], nick: ['the Magnificent', 'Quickverse', 'Silvertongue', 'the Sublime'] },
  fortune_teller: { f: ['Madame', 'Old Nan'], m: ['The Great', 'Old'] },
  ghost: { f: ['Lady', 'Poor'], m: ['Captain', 'Poor'] },
};
const ANIMALS = ['a cat', 'a goat', 'a raven', 'a goose', 'a badger', 'a toad', 'a fox', 'a pig', 'an owl', 'a hedgehog'];
const ANIMAL_NAMES = ['Sir Whiskers', 'Barnaby', 'Mister Pickles', 'Duchess', 'Captain Fluff', 'Lord Snoot', 'Madam Feathers', 'Biscuit', 'Professor Hops', 'Old Grumble'];

/** Which of the reference voices are women's and men's, for matching a generated name to a voice. */
export const VOICE_GENDER: Record<string, Gender | undefined> = { woman: 'f', lady: 'f', crone: 'f', hag: 'f', man: 'm', elder: 'm', gruff: 'm', sly: 'm', zealot: 'm', youth: 'm' };

/** A fresh name for an NPC of an archetype, as a woman or a man. */
export function npcName(rng: Rng, archetypeId: string, g: Gender): string {
  if (archetypeId === 'talking_animal') return `${pick(rng, ANIMAL_NAMES)} (${pick(rng, ANIMALS)})`;
  const t = NPC_TITLES[archetypeId] ?? {};
  const culture = t.culture && rng.chance(0.7) ? t.culture : rng.chance(0.15) ? pick(rng, ['dwarf', 'elf', 'halfling'] as const) : 'human';
  const full = culture === 'human' ? humanName(rng, g) : speciesName(rng, culture as SpeciesId | 'halfling', g);
  const first = full.split(' ')[0]!;
  const titles = t[g];
  if (archetypeId === 'lost_child') return rng.chance(0.4) ? `Little ${first}` : first;
  if (t.nick && rng.chance(0.4)) {
    const n = pick(rng, t.nick);
    return archetypeId === 'rival_bard' || n.startsWith('the') ? `${first} ${n}` : `${n} ${first}`;
  }
  if (titles && (t.always || rng.chance(0.45))) {
    const title = pick(rng, titles);
    return /^(Big|Old|Fat|Mad|Salty|Black|One-Tooth|One-Eyed|Grizzled|Iron|Hammer|Poor|Little)$/.test(title) ? `${title} ${first}` : `${title} ${rng.chance(0.5) ? full : first}`;
  }
  return full;
}

// ---------------------------------------------------------------- antagonists

/** A fresh personal name for an antagonist whose canonical name is a personal name (not a title). */
export function antagonistName(rng: Rng, id: string): string | undefined {
  switch (id) {
    case 'grizzlefang':
      return monsterName(rng, 'goblin');
    case 'mother_murk':
      return `Mother ${pick(rng, MON.witch)}`;
    case 'vex_morrow':
      return `${join(pick(rng, MON.undead.a), pick(rng, MON.undead.s))}-${join(pick(rng, MON.undead.a), pick(rng, MON.undead.s))}`;
    case 'ashmaw':
      return monsterName(rng, 'dragon');
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- no repeats

/** Remembers the names a run has handed out and retries a generator until it gives a new one. */
export class NameBook {
  readonly used: Set<string>;
  constructor(used: Iterable<string> = []) {
    this.used = new Set(used);
  }
  take(gen: () => string, tries = 16): string {
    let n = gen();
    for (let i = 0; i < tries && this.used.has(n); i++) n = gen();
    this.used.add(n);
    return n;
  }
}
