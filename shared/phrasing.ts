// How the rules are said in words, in one place.
//
// A rule that is explained in more than one screen gets explained differently
// in each of them, and then one of them goes stale. That has already happened
// here: the scoring style was described three times over — in the rules card,
// the scoreboard panel and the lobby picker — in three different phrasings, and
// the pigeon foot twice, with only one of the two mentioning that the train
// freezes. The wording lives here now so those screens quote it rather than
// each having an opinion.
//
// Deliberately knows no markup. Everything here is plain text a caller wraps
// however its screen wants, which is what lets the server put the same sentence
// in an error message that the client puts in a tooltip.

import type { Foot, GameName, Hub, Scoring } from './protocol.js';

/** What each game is called, wherever one has to be named to a player. */
export const GAME_TITLE: Record<GameName, string> = {
  mexicanTrain: 'Mexican Train',
  chickenFoot: 'Chicken Foot',
};

/** The one-line version, for a picker that has to say what you are choosing. */
export const GAME_NOTE: Record<GameName, string> = {
  mexicanTrain: 'A train each and a communal one. Your marker up opens yours to the table.',
  chickenFoot: 'One shared board. Every double stops the whole table until three toes are down.',
};

/** A phrase written to sit mid-sentence, turned into one of its own. */
export const sentence = (clause: string): string => clause[0].toUpperCase() + clause.slice(1) + '.';

/** What each scoring style does to blanks, as a clause. The rest of scoring is
 *  the same everywhere — count the pips left in your hand, lowest total wins —
 *  so blanks are the only thing the three styles disagree about.
 *  Kept beside `Game.tileScore`, which is what actually decides. */
export const SCORING_BLANKS: Record<Scoring, string> = {
  house: 'blank halves are free, but the double blank costs 50',
  official: 'every blank half is 25, and the double blank 50',
  pips: 'blanks are worth nothing at all',
};

/** What a double demands, and what the table gets back for it.
 *
 *  The demand is the same in both games; what it costs is not. A train belongs
 *  to one player, so freezing it inconveniences them and the fork is something
 *  a marker can hand away. A board belongs to everybody, so freezing it stops
 *  the room. The rules card says more than this; it may not say anything
 *  different. */
export const footRule = (foot: Foot, game: GameName = 'mexicanTrain'): string => {
  if (foot === 1) return 'A double just has to be covered by one tile before play carries on.';
  if (game === 'chickenFoot') {
    return `A double takes ${foot} tiles, and until they are all down the whole board is frozen — `
      + `nobody plays anywhere at all. Then the branch forks into ${foot} live ends.`;
  }
  return `A double takes ${foot} tiles, and that whole train is frozen until they are all down. `
    + `Then the branch forks into ${foot} live ends — and a marker up hands opponents every one of them.`;
};

/** What the opening double demands before Chicken Foot opens up. Tables differ
 *  on the number, so the sentence is built round it rather than saying "six". */
export const hubRule = (hub: Hub): string =>
  `The round's double goes in the middle and wants ${WORD[hub]} tiles around it before anything else can happen. `
  + `Until it is ringed, the only legal play on the table is another tile matching it — and those ${WORD[hub]} become the board's live ends.`;

/** How a ring reads in a picker, where the number is the thing being chosen. */
export const hubNote = (hub: Hub): string => (hub === 4
  ? 'The short ring — the board opens two tiles sooner, and on four live ends instead of six.'
  : 'The common rule: six tiles round the opening double, and six live ends once it is ringed.');

const WORD: Record<Hub, string> = { 4: 'four', 6: 'six' };

/** What a bot's temperament reads as. The number is rolled once per bot by
 *  `randomTemper` and stays secret until the game is over, so these five words
 *  are the only form of it a player ever sees — which is why they live with the
 *  wording rather than beside the roll. The bands have to keep step with what
 *  that roll produces: it is pulled toward the middle, so most bots land in the
 *  three names in the centre and the two at the ends stay rare. */
export const temperName = (t: number): string =>
  (t < 0.2 ? 'obliging' : t < 0.4 ? 'good-natured' : t < 0.6 ? 'even-handed'
    : t < 0.8 ? 'competitive' : 'ruthless');

/** What an open foot is still owed, as a player would say it: "2 more 6s".
 *  Structural on purpose, so the engine's `PendingFoot` and the wire's
 *  `FootView` can both be handed to it. */
export const owedPhrase = (f: { need: number; placed: number; value: number }): string => {
  const owed = f.need - f.placed;
  return `${owed} more ${f.value}${owed === 1 ? '' : 's'}`;
};
