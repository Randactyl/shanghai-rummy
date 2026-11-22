# Shanghai Rummy

## Objective

Complete the game with the lowest score.

## Player count

Player count is a minimum of two and can be scaled up by adding more decks of cards to the deck.

How aggressively you choose to add decks has implications for difficulty and gameplay time. In general fewer decks and more players increases difficulty and gameplay time while more decks and fewer players decreases difficulty and gameplay time.

One deck may be used for two people. Use 1.5 decks : 2 people for easier play.

## Setup

1. Assign a Scorekeeper
1. Assign first Dealer:
   - player with the least shanghai rummy experience deals first
   - OR shuffle deck and have each player pull a card, player with the lowest card deals first. Card order (high to low): Joker, Ace, King, ..., Two; ties broken by suit (high to low): Hearts, Spades, Diamonds, Clubs (e.g. 2 of Clubs is lower than 2 of Hearts)

## Round Requirements

1. Two Groups
1. One Run, one Group
1. Two Runs
1. Two Groups, one Run
1. Two Runs, one Group
1. Three Groups
1. Three Runs

## Round

### Deal Phase

1. Shuffle
1. Dealer deals 11 cards clockwise to each player beginning with the player to their left, dealing one card to each player at a time
1. Dealer places un-dealt cards face down in the middle of the table
1. Scorekeeper announces the required number of Groups and/or Runs for the round
1. Players have x seconds to compose their hands, then the Dealer flips the top card of the deck over into the discard pile and gameplay begins with the player to the Dealer's left.

---

### Gameplay Phase

#### General Procedure

1. Current player begins turn by drawing one card from either the deck or the discard pile
1. If the current player has all cards for the round's required Groups and/or Runs, they may play the cards face up in front of them. They are now a Down Player.
1. If the current player is a Down Player, they may add any valid cards from their hand to other Down Players' face up cards.
1. Current player discards a card to end their turn.

If the current player has cards remaining in their hand, play passes clockwise. If the current player has no cards remaining in their hand, gameplay ends.

A player may also go out by playing every card in their hand to the table, with no final discard. (Round 7's three Runs use all 12 cards in hand after the draw.)

If the deck runs out, shuffle the discard pile, except its top card, to make a new deck.

**Stalemate.** Once every player is down, the only way to get rid of cards is to play them on the table. If no card left in the game (in anyone's hand, the deck or the discard pile) can ever be played there, nobody can go out. This happens, for example, when every Group already holds all the cards of its rank and both Jokers are on the table. The round ends at the next discard, and every player scores the cards in their hand. Online, the game spots this automatically.

#### Out of Order Play - Buying a Card

While the current player is taking their turn (*after* the current player has drawn a card and *before* the current player discards a card) any other player can buy the top card from the discard pile. Down Players may buy too.

If multiple players announce their intent to buy at the exact same moment, use upcoming player order as a tiebreaker. (Online, requests made within about a second of each other count as the same moment.)

##### Procedure

1. The buying player announces their intent to buy (e.g. "I'll buy that.")
1. The current player pauses their turn
1. The buying player draws the bought card from the discard pile as well as two penalty cards from the deck
1. The current player resumes their turn

#### Base Gameplay Modifiers

These gameplay modifiers are typically included in Shanghai Rummy rule sets. See [Optional Gameplay Modifiers](#optional-gameplay-modifiers) for more.

##### The Wild

Jokers are wild cards and may be used in place of any other card in a Group or Run. Only one wild card may be used in any one Group or Run.

Any wild cards may be replaced by any Down Player with the natural card it represents and replayed to any other valid place on the table.

The replaced wild card must be played right away to a different Group or Run that doesn't already have a wild card. If there's no such place, the swap can't be made.

##### The Shanghai

###### The Defensive Shanghai

If the current player wants to discard a card that they know can be played elsewhere on the table, they may call "Shanghai" while discarding it. This prevents the next player from drawing the card to begin their turn and also prevents other players from buying the card during the next player's turn. The Defensive Shanghai can only be called on a card that really can be played on the table.

If the card becomes exposed again in the future (the discarded cards covering it were drawn) it may be bought by any eligible player.

###### The Offensive Shanghai

If the current player discards a card that can be played elsewhere on the table and does not initiate the Defensive Shanghai, any other player may call "Shanghai" and then immediately add the discarded card to an appropriate place on the table. Note that the calling player does not have to be a Down Player.

The Offensive Shanghai can only be called before the next player draws.

The player who initiated the Offensive Shanghai then presents their face down hand to the discarding player and has them choose a card at random to add to their own hand.

---

### Scoring Phase

|Card Range|Point Value|
|----------|-----------|
|Joker|50 points|
|Ace|20 points|
|King - Ten|10 points|
|Nine - Two|5 points|

Players add up the point values for the cards remaining in their hand (cards not played to the table) and report the sum to the Scorekeeper.

---

### Pass Phase

The first player of the round collects all cards. They are now the Dealer of the new round.

## Glossary of terms

|Term|Definition|
|----|----------|
|Group|three or more cards with the same face value|
|Run|four or more cards of the same suit with sequential face value (Aces high)|
|Scorekeeper|keeps track of player score and announces requirements for each round|
|Dealer|shuffles deck and sets up gameplay|
|Down Player|a player who has collected all cards required for the round and has played them face up on the table|

## Optional Gameplay Modifiers

### Two Ways

> *"Aces are worth double the points of other face cards, why shouldn't they offer more?"*

- Aces are both high AND low (play as both 14 and 1, K -> A -> 2 -> 3).
- Runs may wrap around through the Ace (e.g. Q -> K -> A -> 2).

### Crazy Cards

> *"Because rules are for squares."*

- Groups are any card of a common suit and Runs are a sequence of four or more cards regardless of suit.
- A wild card in a Group can be replaced by any card of that Group's suit.

### The Gambit

> *"Are you feeling lucky?"*

- Players may lay down hand requirements as they get them, without waiting for the whole round's requirement. Down cards do not count toward end of round scoring.
- Until you're fully down, every Group or Run you lay down is the bare minimum: exactly 3 cards in a Group, 4 in a Run. Extra copies (with Seeing Double) wait until you're fully down too.
- The lay-down that completes your requirement makes you fully down and follows the normal rules, so it may be longer.
- Partially-down players cannot play on the table at all, not even on their own partial downs, and cannot swap Jokers.
- Fully-down players can play on any partially-down players or fully-down players. That's the gamble: your partial downs are safe from scoring, but they give everyone else somewhere to play.
- You can't go out while partially down. Online, the game won't let you lay down a partial that leaves you fewer than 2 cards (one to discard, one to keep), or call Shanghai on your last card.

Keeping partials to the minimum means you always hold enough cards to finish. Round 7's three Runs need all 12 cards you hold after drawing, so a single extra card in a partial Run would leave you unable to complete the last one.

### Seeing Double

> *"And they say singles have more fun..."*

- Allow players to put down additional copies of partial hand requirements (hand calls for 3 Groups, players can play 4+ Groups).
- Only extra copies of the kinds the round requires (no Runs in a Groups-only round). Down Players may put them down on later turns too.

### Restrictive Requirements

> *"Rules may be for squares, but squares are the most right."*

- Do not allow more than the minimum requirements when laying down hands (3 cards in a Group, 4 cards in a Run).

## Online-Only Rules

These only apply when playing in the web app.

### Arranging Your Hand

The "x seconds to compose their hands" countdown ends early once every player taps *I'm ready*. The host can also flip the first card at any time.

### Removing a Player

The host can remove a player who has disconnected (or anyone else) during a game.

- The removed player's hand is shuffled into the deck.
- Cards they already played to the table stay there, and other players can still add to them.
- Play passes around the empty seat. If the removed player was the Dealer, the player who went first this round still deals the next round.
- The removed player can't rejoin, and they're left out of the final standings.
- If fewer than two players remain, the game ends.

If the host leaves for good, any other player can take over hosting. The old host is removed in the same way, their hand and the deck being shuffled together into a new deck.
