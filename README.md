# Shanghai Rummy

A browser-to-browser version of the family Shanghai Rummy rules in [RULES.md](RULES.md).
It's a plain static site: no server, no build step, no accounts.

## How it works

```
 Host's browser  ◀──── WebRTC data channels ────▶  each player's browser
 (runs the rules,
  deals, keeps score)
        ▲
        └── PeerJS public broker: only used to introduce browsers to each other
```

- Whoever clicks **Host a new game** becomes the authoritative "table". Their browser shuffles, deals,
  checks every move and keeps score.
- Everyone else connects straight to the host's browser. They only ever receive **their own hand** plus the
  public table, so nobody can peek at anyone else's cards. The one exception is the host, who could dig the
  hands out of their browser's dev tools. It's a family game.
- [PeerJS](https://peerjs.com) (vendored in `js/vendor/`) uses its free public broker to make the
  introduction. If two players' networks can't connect directly, it falls back to PeerJS's free TURN relay.
- The host's game is saved in their browser. If the host reloads or their browser crashes, they reopen the
  page and the game resumes with the same code. Other players reconnect automatically. A player who reloads
  rejoins mid-game with their hand intact.

## When the host leaves

- **Passing hosting on purpose:** the host opens ⋯ → *Pass hosting to someone else…* (or uses the button in
  the lobby). The whole game moves to that player's browser. The old host carries on as a regular player
  with their hand intact, and everyone reconnects automatically within a few seconds.
- **If the host just disappears:** everyone's table freezes with a "Can't reach the host" bar. If the host
  reopens the page, the game carries on as if nothing happened. After about 10 seconds, any player can tap
  **Take over hosting**:
  1. Their browser claims the game code, so everyone else's auto-reconnect lands on them.
  2. Each player's browser sends in its own hand. Everything else (the table, discards, scores, whose turn
     it is) is public, and every player already keeps a copy of it.
  3. The old host is treated as a dropped player. Their unknown hand and the unknown deck are just "the cards
     nobody can see", so they're shuffled together into a new deck. No one sees anything they shouldn't.
  4. If someone else is also missing, the new host can *Continue without* them; they're dropped the same way.

  If the old host comes back afterwards, they're told someone took over and that they're out of the game.
  If two people tap *Take over* at once, whoever claims the game code first wins and the other just reconnects.

## Putting it online

Any static host works. You just upload the folder.

**GitHub Pages:** create a repo, push this folder's contents, then go to
*Settings → Pages → Deploy from branch → main / root*. Your link is
`https://<you>.github.io/<repo>/`.

**Netlify / Cloudflare Pages:** drag-and-drop the folder into their "deploy a site" page.

**Link previews:** the Open Graph tags in `index.html` use absolute URLs (link-preview crawlers require them),
so change `og:url` and `og:image` if you host it somewhere else. The preview image `og-image.png` is rendered
from `og-image.svg`; after editing the SVG, re-render it with:

```sh
firefox --headless --window-size=1200,630 --screenshot "$PWD/og-image.png" "file://$PWD/og-image.svg"
```

**Try it locally:**

```sh
python3 -m http.server 8000     # then open http://localhost:8000
```

To test alone, open `http://localhost:8000/?local` in several tabs. In `?local` mode, tabs in the same
browser talk to each other directly, with no network at all.

## Playing

1. The host enters a name, clicks **Host a new game**, and shares the invite link (or the 5-letter code).
2. Players join. The host sets the seat order, which is the turn order, and the table settings and modifiers.
   Players can tap 👍 *Vote* on the modifiers they'd like; the host sees each modifier's votes and who cast them,
   but only the host turns modifiers on or off. The host then clicks **Start game**.
3. Everyone sees the cards drawn for first dealer flip over one at a time, then who deals, who plays first and a
   summary of this game's rules. The host taps *Deal round 1*.
4. While hands are dealt, everyone has a few seconds to arrange. Tap *I'm ready*; the first card flips as soon
   as everyone is ready, or the host can tap *Flip now*.
5. On your turn, tap the deck or the discard pile to draw. When your turn starts you get a "Your turn!" flash, a chime
   and a buzz (on phones that support it); until you touch the screen the page glows gold, the tab title blinks,
   and the chime repeats every 12 seconds a few times. Turn the chime off from the menu.
   - **Lay down:** the *Going down* tray shows a slot for each Group/Run the round needs. Select cards; when
     they make a valid set, tap *Make Group* / *Make Run* (or the glowing slot). Once every slot is filled,
     tap *Lay down*. You can fill the tray while waiting for your turn.
     If a run's Joker could go at either end, use ⇄ to move it.
   - **Play on the table** (once you're down): select one card. Every meld it fits on lights up; tap one.
     If the card can replace a Joker, you'll be offered the swap. You then tap where the Joker goes.
   - **Discard:** select one card, then *Discard* (or *Discard + Shanghai* to call the defensive Shanghai).
6. Off-turn, a **Buy** button appears once the current player has drawn. A **Shanghai!** button appears
   right after someone discards.
7. Drag cards in your hand to rearrange them, or pick *Sort: Rank / Suit*. A chosen sort sticks, so newly
   drawn cards slot into place (the gold dot shows where); dragging a card switches back to your own order.
8. Cards on the table with a gold outline were played since your last turn. Tap the round name (or *Rules*)
   to see which modifiers are on. *⋯ → Card style* changes card backs and turns on four-color suits, just for
   your device.
9. If someone disconnects for good, the host can remove them from the "is disconnected" banner, or from
   ⋯ → *Remove a player*.

**The host's page must stay open for the whole game.** A laptop is the best host. If a phone hosts, the app
keeps the screen awake, but switching apps or locking the phone pauses the game for everyone.

## Known limitations

- Only the host can remove players.
- A takeover needs at least one other player besides the new host. In a 2-player game, losing the host ends
  the game.
- Each player keeps a copy of the public game state so a takeover is possible. That means the full discard
  pile (not just the top card) is technically in every browser. In person you'd have seen those cards
  go down anyway.
- If the PeerJS public broker is down, new players can't join. Games already connected keep working.
