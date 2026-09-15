import type { Random } from './random.js';

/**
 * What seeded reviewers write, by shelf and by how pleased they were.
 *
 * Written to sound like people who bought one thing from a small shop: specific about the
 * thing, brief, and occasionally unimpressed. A shop whose every review is a paragraph of
 * praise is a shop whose reviews nobody believes, and the demo is meant to show the rating
 * machinery working on a spread, not a wall of fives.
 */

type Words = { title: string; body: string };
type Band = 'high' | 'middle' | 'low';

const SHELF_WORDS: Record<string, Record<Band, Words[]>> = {
  'coffee-tea': {
    high: [
      {
        title: 'Now my daily cup',
        body: 'Ordered one bag to try and have reordered twice. Fresh, clearly roasted days before it arrived.',
      },
      {
        title: 'Exactly as described',
        body: 'The tasting notes are not marketing — you really can taste them. Brewed as a V60 at 94°C.',
      },
      {
        title: 'Worth the price',
        body: 'More than the supermarket, and the difference is obvious from the first sip.',
      },
      {
        title: 'Lovely with milk',
        body: 'We drink it as flat whites at the weekend. Sweet, round, no bitterness at all.',
      },
      {
        title: 'Arrived quickly',
        body: 'Well packed, with the roast date on the bag. Smells wonderful when you open it.',
      },
      { title: 'A treat', body: 'Bought as a present for my dad and ended up keeping half of it.' },
    ],
    middle: [
      {
        title: 'Good, not my favourite',
        body: 'Perfectly nice but a bit milder than I expected from the description.',
      },
      {
        title: 'Takes some dialling in',
        body: 'Sour at first as espresso. Better once I ground finer, but it took most of the bag.',
      },
    ],
    low: [
      {
        title: 'Not for me',
        body: 'Too bright for my taste. Nothing wrong with it, I just prefer darker coffee.',
      },
    ],
  },
  ceramics: {
    high: [
      {
        title: 'Beautiful glaze',
        body: 'The photos do not do the colour justice. Heavier than it looks, in a good way.',
      },
      {
        title: 'Use it every day',
        body: 'Holds heat well and feels lovely in the hand. Survived the dishwasher for months now.',
      },
      {
        title: 'Bought a second',
        body: 'Liked the first so much I bought another in a different glaze. They look good together.',
      },
      {
        title: 'Well packed',
        body: 'Arrived wrapped in so much paper I was worried there was nothing inside. Not a scratch.',
      },
      {
        title: 'Properly handmade',
        body: 'You can see the throwing lines. Mine has a small drip of glaze at the foot that I rather like.',
      },
    ],
    middle: [
      {
        title: 'Smaller than I thought',
        body: 'Nice piece, but check the dimensions — I had pictured something bigger.',
      },
      {
        title: 'Colour a little different',
        body: 'Greener than on my screen. Still nice, just not what I pictured.',
      },
    ],
    low: [
      {
        title: 'Arrived with a chip',
        body: 'Small chip on the rim. The shop replaced it without fuss, but still disappointing.',
      },
    ],
  },
  apothecary: {
    high: [
      {
        title: 'Gentle on my skin',
        body: 'I react to most soaps and this one has been fine for weeks. Lasts ages too.',
      },
      {
        title: 'Smells natural',
        body: 'Not perfumey at all. The scent is there when you use it and gone after.',
      },
      {
        title: 'My winter essential',
        body: 'The only thing that fixes my hands in January. A little goes a long way.',
      },
      {
        title: 'Lovely gift',
        body: 'Bought three as presents and everyone asked where they were from.',
      },
      {
        title: 'Burns evenly',
        body: 'No tunnelling and no black smoke. The scent fills the room without being heavy.',
      },
    ],
    middle: [
      {
        title: 'Nice but faint',
        body: 'Pleasant, though I could barely smell it once it was lit.',
      },
      {
        title: 'Fine',
        body: 'Does the job. Not sure it is different enough from cheaper ones to buy again.',
      },
    ],
    low: [
      {
        title: 'Too greasy for me',
        body: 'Takes a long time to sink in. Probably better for very dry skin than mine.',
      },
    ],
  },
  textiles: {
    high: [
      {
        title: 'Softer every wash',
        body: 'Slightly stiff when it arrived and now, a month in, it is lovely. Dries glasses perfectly.',
      },
      {
        title: 'Beautiful colour',
        body: 'A proper, deep colour that has not faded after lots of washes.',
      },
      { title: 'Heirloom quality', body: 'Heavy, warm and very well made. It will outlast me.' },
      {
        title: 'Worth every penny',
        body: 'Expensive, but I sleep better and it looks lovely on the bed.',
      },
      {
        title: 'Generous size',
        body: 'Bigger than the ones I had before. Hangs nicely over the oven rail.',
      },
    ],
    middle: [
      {
        title: 'Creases a lot',
        body: 'I knew linen creases, but this is a lot. Looks good once you stop minding.',
      },
      {
        title: 'Good but shed at first',
        body: 'Left fluff everywhere for the first few washes. Fine now.',
      },
    ],
    low: [{ title: 'Shrank', body: 'Washed at 40 as it said and it came out noticeably smaller.' }],
  },
  pantry: {
    high: [
      {
        title: 'Tastes of somewhere',
        body: 'You can taste where it came from. Nothing like the supermarket version.',
      },
      {
        title: 'On everything',
        body: 'Put it on eggs, salads, roast vegetables. The jar did not last a fortnight.',
      },
      { title: 'Properly good', body: 'Peppery and fresh. We save it for bread and dipping.' },
      {
        title: 'A kitchen staple now',
        body: 'I keep a spare in the cupboard so we never run out.',
      },
      {
        title: 'Lovely present',
        body: 'Took it to a dinner and the host asked for the name of the shop.',
      },
    ],
    middle: [
      { title: 'Good, pricey', body: 'Tastes good, but it is a lot for the size of the jar.' },
      {
        title: 'Set solid',
        body: 'Crystallised within a week. I know that is normal, but it is a nuisance to spread.',
      },
    ],
    low: [{ title: 'Too strong', body: 'Much too bitter for us. Probably an acquired taste.' }],
  },
  tools: {
    high: [
      {
        title: 'Built to last',
        body: 'Solid, well balanced, and clearly made by people who use one themselves.',
      },
      {
        title: 'A pleasure to use',
        body: 'I did not know a tool could make a job this much nicer. Sharp out of the box.',
      },
      {
        title: 'Better than my old one',
        body: 'Replaced a cheap one that broke after a season. This feels like it will not.',
      },
      {
        title: 'Gorgeous wood',
        body: 'The grain is beautiful. I oil it every few weeks and it looks better each time.',
      },
      { title: 'Worth waiting for', body: 'Was out of stock for a while and I am glad I waited.' },
    ],
    middle: [
      {
        title: 'Needs care',
        body: 'Works well, but it rusted when I left it wet overnight. My fault, still worth knowing.',
      },
      { title: 'Heavy', body: 'Well made but heavier than I would like for long jobs.' },
    ],
    low: [
      {
        title: 'Handle came loose',
        body: 'After a few months the handle worked loose. Glued it back, but I expected better.',
      },
    ],
  },
};

const band = (rating: number): Band => (rating >= 4 ? 'high' : rating === 3 ? 'middle' : 'low');

/**
 * A title and body for a review of something on this shelf, or nothing: about one person in
 * five leaves the stars and no words, which is what real reviews look like. Two reviews of one
 * product never share a headline — that reads as a copy, not as two customers — so when every
 * suitable one is taken the reviewer leaves stars alone.
 */
export function reviewWords(
  shelf: string,
  rating: number,
  random: Random,
  /** Headlines already on this product, which a second reviewer does not repeat word for word. */
  taken: ReadonlySet<string> = new Set(),
): { title?: string; body?: string } {
  if (random.chance(0.2)) return {};
  const pool = (SHELF_WORDS[shelf.split('/')[0]!]?.[band(rating)] ?? []).filter(
    (words) => !taken.has(words.title),
  );
  if (pool.length === 0) return {};
  const words = random.pick(pool);
  return random.chance(0.15) ? { title: words.title } : words;
}

/** A star rating that clusters around what reviewers tend to think of a product. */
export function ratingFor(regard: number, random: Random): number {
  if (regard >= 5) return 5;
  const rating = Math.round(regard + (random.next() - 0.5) * 2.2);
  return Math.min(5, Math.max(1, rating));
}
