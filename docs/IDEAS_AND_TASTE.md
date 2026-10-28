# Game ideas: what fits Jeeto Skill Se, and what the founder has already said

Read this before proposing or choosing a game. Ideas are cheap; the filter below is the product.

## The platform in one paragraph
Pakistan-first skill contest. Players buy a pass, play a few featured games a day on a phone,
and the top scores on each daily board win real cash. So a game must be: quick to understand
(learn it in one 5 second popup), one-thumb or two-thumb on a phone held upright, scored by one
number, and decided by skill, not luck or money. A player returns daily, so a run is 1 to 5 minutes
and ranking against others must feel earnable.

## Hard filters (an idea that fails one is dropped before any code)
1. **Replayable from a seed and inputs.** The whole course must be a pure function of the seed.
   Anything that needs a second human live (multiplayer, async ghosts that change the world) is out.
   An AI opponent is out unless it is a fixed seeded script.
2. **One clear score.** Distance, points, time survived, levels cleared. No currency, no upgrades
   that carry between runs (a fair board means every run starts equal).
3. **Skill beats grind.** No pay or progress advantage. Everyone plays the same seeded course.
4. **Portrait phone, touch first.** Tap, hold, swipe, drag. Keyboard is a bonus.
5. **Learnable in seconds.** If it needs more than a short static HOW TO PLAY, it is too deep.
6. **No gambling look.** No slots, cards for money, dice, wagering, loot boxes. The framing is
   "skill contest". Never use stake, bet or luck language.
7. **Own the IP.** Take the mechanic of a famous game if you like, never its name, art or sounds.
8. **Passable by construction.** The generator must guarantee a way through; prove it by
   measurement, not argument.

## The art gate (the lesson that killed four games)
Name the objects the player will look at. If they are things (a ball, a goat, a ship, a person,
a car with a body), who draws them? Code-drawn art works for ABSTRACT games (shapes, rings,
tiles, lines, gems, bubbles). It fails for anything that is its characters or craft. Alien Hamla,
Hoop Shot, Nishana and Gilli Danda were all killed by the founder for this, in genres that ARE
their art. In this cloud repo you cannot get artwork, so **propose abstract or geometric
games, or games whose look is simple, bold and drawable in code.** If an idea needs characters,
say so and flag it for later with an artist.

## The fun gate
Get a playable core in front of the founder in the first hour, before any suite exists. Replay
work verifies a game; it cannot tell you there is one. When feedback arrives, ask whether the fix
is a REMOVAL before adding anything. "Too much going on" has been the verdict twice.

## Already built (do not re-propose; mutate the idea if you must)
Live or built: Sky Tower (stacking), Pulse, Smash Down and Twist Fall (falling ball past arcs),
Epic Slicer, Boom Patakha, Orbit Runner, Patli Gali (zig-zag), Save The Birdie, Block Blast,
Bubble Shooter, Stick Hero, Bakri Dash (lane hopper), Gannay Wala (Timberman), Drifty Car,
Hex Rush (Super Hexagon), Do Gaari (two lanes, two thumbs), Raftaar (three-lane rush),
Cannon Rush, Rickshaw Run, Stairs, Sky Ride, Sky Racer, Duet, Tappa, Kaanch, Snake Blocks,
2048 Rush, Jelly Jump, Jelly Jhoom, Ulta Pulta (gravity flip), Fruit Merge (Suika), Dots Reflexes,
Chal Cube (draw to climb), Into the Haze, Crazy Motorway, Roller Rani, Chor Police, Oh Bhains,
Ramp Ball, Color Dunk, Chakkar Chaku (knife throw), Dart Champ, Bo Kaata (kites), Mini Golf,
Rail Junction, Saanp (snake), Jungle Baandar (rope swing).
Parked or killed: Alien Hamla, Hoop Shot, Air Hockey, Phata Phat, Nishana, Gilli Danda, Udaan.

## Genres that work well here
- One-input timing (tap or hold at the right moment): the cheapest to make provably fair.
- Reflex lanes and wheels; rhythm-free "do it now" decisions.
- Drag-to-steer survival (a finger moves a thing through a seeded course).
- Merge, match and routing puzzles under a clock (turn based, so frame rate cannot matter).
- Physics toys with few objects (fixed step, integers).

## Genres to avoid
Anything with a story, dialogue or characters; two-player or live; open-ended building; big
worlds; heavy 3D art; games where skill is hard to see (idle, gacha); very slow games.

## Flavour that lands
Pakistani setting and sounds are a strength (rickshaw, kites, goats, cricket, truck art,
motorway, bazaar, charpai). Use them as a SKIN on an abstract mechanic, with simple shapes,
Urdu or Roman Urdu title text, and Web Audio sounds. The founder likes: bold colours, one
accent, quiet screens, satisfying sound, and a fast restart.

## What a good idea pitch contains (give exactly this)
1. Name and one sentence: what the player does with their thumb.
2. The score, and what a great run looks like at 60 seconds, 3 minutes.
3. The seeded course: what the seed decides.
4. How skill shows (what separates a good player from an average one).
5. Why it is passable and why standing still dies.
6. What it looks like in code-drawn shapes only.
7. Which existing game it is closest to, and what is genuinely different.
8. How a bot would beat it, and one thing to record to catch that.
Offer 5 to 8 ideas at a time, ranked, and let the founder pick before any building.
