import { content, sanitizeText, shortRest, type ChoiceOption } from '@pr/shared';
import type { Game } from '../Game.js';

type Use = 'kingdom' | 'mascot' | 'rumor' | 'npc' | 'place' | 'deed' | 'lore' | 'tavern' | 'motto' | 'title';

/**
 * Jackbox-style round: everyone writes privately on their phone, answers appear
 * anonymously on the TV, everyone votes (not for their own), and the winner is woven into the world.
 */
export async function jackboxRound(g: Game, use: Use, promptId?: string): Promise<string | undefined> {
  const w = g.state.world;
  const pool = content().prompts.filter((p) => (promptId ? p.id === promptId : p.use === use));
  if (!pool.length) return undefined;
  const p = g.rng.pick(pool);
  const writers = g.partyIds().filter((id) => g.players.has(id));
  if (!writers.length) return undefined;
  const humans = writers.filter((id) => !g.players.get(id)?.isBot);
  const prev = g.state.scene;
  g.state.scene = { kind: 'jackbox', prompt: g.fillTemplate(p.text), stage: 'writing' };
  g.fx({ kind: 'sound', name: 'jackbox' });
  g.narrate(`✍️ ${g.fillTemplate(p.text)}`, 'title');
  g.dirty();
  const answers = await g.askAll<string>(
    writers,
    () => ({ kind: 'text', title: g.fillTemplate(p.text), text: 'Write something funny! Answers are shown anonymously.', maxLen: 60, placeholder: p.examples[0] ?? '', suggestions: p.examples.slice(0, 2) }),
    {
      timeoutMs: 75000,
      fallback: () => g.rng.pick(p.examples.length ? p.examples : ['...']),
      bot: () => g.rng.pick(p.examples.length ? p.examples : ['Something mysterious']),
      validate: (v) => sanitizeText(v, 60) || undefined,
    },
  );
  const list = Object.entries(answers).map(([pid, text], i) => ({ id: `a${i}`, pid, text }));
  // shuffle for anonymity
  g.rng.shuffle(list);
  let winner = list[0]!;
  if (humans.length >= 2 && list.length >= 2) {
    g.state.scene = { kind: 'jackbox', prompt: g.fillTemplate(p.text), stage: 'voting', answers: list.map((a) => ({ id: a.id, text: a.text })) };
    g.dirty();
    await g.beat(1500);
    const votes = await g.askAll<string>(
      writers,
      (pid) => ({
        kind: 'choice',
        title: '🗳️ Vote for your favorite!',
        text: g.fillTemplate(p.text),
        style: 'vote',
        options: list.map((a): ChoiceOption => ({ id: a.id, label: a.text, emoji: '📝', disabled: a.pid === pid ? "That's yours!" : undefined })),
      }),
      {
        timeoutMs: 40000,
        fallback: () => '__none',
        bot: (pid) => g.rng.pick(list.filter((a) => a.pid !== pid)).id,
        validate: (v, pid) => (typeof v === 'string' && list.some((a) => a.id === v && a.pid !== pid) ? v : undefined),
      },
    );
    const tally: Record<string, number> = {};
    for (const v of Object.values(votes)) if (v !== '__none') tally[v] = (tally[v] ?? 0) + 1;
    const max = Math.max(0, ...Object.values(tally));
    const top = list.filter((a) => (tally[a.id] ?? 0) === max);
    winner = top.length > 1 ? top[g.rng.int(0, top.length - 1)]! : top[0]!;
    g.state.scene = {
      kind: 'jackbox',
      prompt: g.fillTemplate(p.text),
      stage: 'result',
      answers: list.map((a) => ({ id: a.id, text: a.text, votes: tally[a.id] ?? 0, author: g.players.get(a.pid)?.name })),
      winner: winner.id,
    };
    const wc = g.state.chars[winner.pid];
    if (wc) wc.inspiration++;
    g.fx({ kind: 'banner', text: `🏆 "${winner.text}" — ${g.players.get(winner.pid)?.name ?? ''}`, style: 'good' }, { kind: 'sound', name: 'victory' });
    g.dirty();
    await g.beat(3500);
  } else {
    g.state.scene = { kind: 'jackbox', prompt: g.fillTemplate(p.text), stage: 'result', answers: list.map((a) => ({ id: a.id, text: a.text, author: g.players.get(a.pid)?.name })), winner: winner.id };
    g.dirty();
    await g.beat(2000);
  }
  const text = winner.text;
  const author = g.players.get(winner.pid)?.name;
  if (w) {
    switch (p.use) {
      case 'kingdom':
        w.kingdomName = text;
        g.narrate(`So it is decided: you hail from the kingdom of ${text}!`, 'title');
        g.journal('world', `The heroes hail from the kingdom of ${text}.`, author);
        break;
      case 'mascot':
        w.mascot = text;
        g.narrate(`The beloved mascot of ${w.home?.name ?? 'home'}: ${text}.`, 'good');
        g.journal('world', `The village mascot is ${text}.`, author);
        break;
      case 'tavern':
        w.lore.tavern = text;
        g.narrate(`You step into "${text}".`, 'good');
        g.journal('world', `A tavern called "${text}".`, author);
        break;
      case 'rumor':
        w.lore.rumor = text;
        g.narrate(`The rumor everyone's whispering: "${text}"`, 'whisper');
        g.journal('lore', `Rumor: ${text}`, author);
        break;
      case 'npc':
        w.lore.legend = text;
        g.journal('lore', `Locals fear ${text}.`, author);
        break;
      case 'place': {
        const t = w.tiles.find((x) => x.q === w.party.q && x.r === w.party.r);
        if (t) t.name = text;
        g.journal('world', `This place is now known as ${text}.`, author);
        break;
      }
      case 'motto':
        g.state.party.motto = text;
        g.journal('world', `The party motto: "${text}"`, author);
        break;
      case 'title':
        g.state.party.name = text;
        g.narrate(`Behold: ${text}!`, 'title');
        g.journal('world', `The party calls itself ${text}.`, author);
        break;
      default:
        g.journal('lore', text, author);
    }
  }
  g.state.scene = prev;
  g.dirty();
  return text;
}

/** Camp: a short rest plus an optional quirk-driven roleplay beat; the group votes to award Inspiration. */
export async function campScene(g: Game, opts: { canLongRest?: boolean } = {}) {
  const w = g.state.world!;
  const chars = g.partyChars().filter((c) => !c.dead);
  const text = `The party makes camp${w.time === 'night' ? ' under the stars' : ''}. A fire crackles.`;
  g.state.scene = { kind: 'camp', text };
  g.fx({ kind: 'sound', name: 'rest' });
  g.narrate(`⛺ ${text}`, 'title');
  g.dirty();
  await g.beat(1200);
  const bard = chars.find((c) => c.known.includes('song_of_rest'));
  for (const c of chars) shortRest(c, { bonusHeal: bard ? g.rng.die(6) + bard.level : 0 });
  g.narrate(`Everyone recovers some HP and abilities (short rest)${bard ? `, soothed by ${bard.name}'s Song of Rest` : ''}.`, 'good');
  g.dirty();

  const humans = chars.filter((c) => !g.players.get(c.id)?.isBot);
  if (humans.length >= 2) {
    const [a, b] = g.rng.shuffle([...humans]).slice(0, 2) as [typeof humans[0], typeof humans[0]];
    const quirkDef = content().quirks[g.rng.pick(a.quirks)];
    const prompts = content().camp.filter((cp) => !cp.text.includes('{quirk}') || quirkDef);
    const cp = g.rng.pick(prompts);
    const line = g.fillTemplate(cp.text, { a: a.name, b: b.name, quirk: quirkDef?.name ?? 'quirk' });
    const roleplay = quirkDef && g.rng.chance(0.4) ? `${line} (Roleplay hint: ${quirkDef.prompt})` : line;
    g.state.scene = { kind: 'camp', text, prompt: { a: a.name, b: b.name, text: roleplay } };
    g.narrate(`🔥 Campfire moment: ${roleplay}`, 'whisper');
    g.dirty();
    await Promise.all(
      [a, b].map((c) =>
        g.ask(c.id, { kind: 'notice', title: '🔥 Your campfire moment!', text: `${roleplay}\n\nAct it out out loud, then tap when you're done.`, okLabel: "We're done!" }, { timeoutMs: 120000, fallback: () => true }),
      ),
    );
    const voters = chars.filter((c) => c.id !== a.id && c.id !== b.id && !g.players.get(c.id)?.isBot).map((c) => c.id);
    let yes = 1;
    let no = 0;
    if (voters.length) {
      const votes = await g.askAll<string>(
        voters,
        () => ({ kind: 'choice', title: `Did ${a.name} & ${b.name} nail it?`, style: 'vote', options: [{ id: 'yes', label: 'Bravo!', emoji: '👏' }, { id: 'no', label: 'Meh', emoji: '😐' }] }),
        { timeoutMs: 30000, fallback: () => 'yes', bot: () => 'yes' },
      );
      yes = Object.values(votes).filter((v) => v === 'yes').length;
      no = Object.values(votes).length - yes;
    }
    if (yes >= no) {
      a.inspiration++;
      b.inspiration++;
      g.narrate(`👏 The party applauds! ${a.name} and ${b.name} each gain Inspiration.`, 'good');
      g.journal('deed', `At camp: ${line}`);
    } else g.narrate('The fire pops. Someone coughs. Maybe next time.');
    g.dirty();
  }
  if (opts.canLongRest && chars.some((c) => c.hp < c.maxHp || c.sp < c.maxSp)) {
    const idx = await (await import('./event.js')).partyVote(g, '🌙 Sleep here for the night? (Long rest, small ambush risk)', [
      { id: 'yes', label: 'Sleep (long rest)', emoji: '😴' },
      { id: 'no', label: 'Move on', emoji: '🥾' },
    ]);
    if (idx === 0) {
      if (g.rng.chance(w.time === 'night' ? 0.3 : 0.18)) {
        g.narrate('Something moves in the dark... AMBUSH!', 'bad');
        return 'ambush' as const;
      }
      const { innRest } = await import('./town.js');
      await innRest(g);
    }
  }
  return undefined;
}
