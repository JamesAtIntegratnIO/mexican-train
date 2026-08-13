// The wire protocol: everything that crosses the socket, in one place.
//
// This file is the contract the two ends were previously only implying. The
// server's `Game.view()` and `Room.snapshot()` produce these shapes; the client
// renders them. Before this existed the only way to know what a snapshot
// contained was to read both ends and hope they agreed — and the type checker
// now enforces that they do, across three build targets.
//
// Types only. It compiles to nothing and ships nothing.

/** Two pip counts, low first, joined by a hyphen: `"3-9"`, `"6-6"`. Canonical
 *  everywhere — a set holds no duplicates because `"9-3"` is never written. */
export type TileId = string;

export type PlayerId = string;

/** A player's own id, or the literal `'mexican'` for the communal train. */
export type TrainId = string;

export type Scoring = 'house' | 'official' | 'pips';

/** How many tiles a double demands before its branch forks. 1 means a double is
 *  covered once and never forks. */
export type Foot = 1 | 2 | 3;

export type Phase = 'seeking' | 'play';
export type Status = 'idle' | 'playing' | 'roundOver' | 'gameOver';

/** What the server says you owe the table, and what the turn bar offers. */
export type Prompt = 'engine' | 'seek' | 'play' | 'draw' | 'pass';

// ---------------------------------------------------------------- the board

/** A tile as laid: `a` is the end that connected, `b` the new open end. The
 *  orientation is the server's, so every client draws the line the same way. */
export interface LaidTile {
  a: number;
  b: number;
  tile: TileId;
}

/** An open pigeon foot: this branch takes `need` toes of `value` and has `placed`
 *  so far, and its train is frozen until it fills. Only ever present when the
 *  table's foot setting is 2 or 3. */
export interface FootView {
  need: number;
  placed: number;
  value: number;
}

/** One branch of a train. A train is a tree of these: `parent` is the branch it
 *  forked off, and `closed` means it has forked and can take nothing more. */
export interface SegView {
  id: number;
  parent: number | null;
  from: number;
  end: number;
  closed: boolean;
  tiles: LaidTile[];
  foot: FootView | null;
}

export interface TrainView {
  id: TrainId;
  owner: PlayerId | null;   // null is the Mexican train
  open: boolean;            // marker up — anyone may play here
  playable: boolean;        // may *you* play here, ignoring per-branch detail
  segs: SegView[];
}

/** A legal play. The client sends exactly this back as a `play` message. */
export interface Move {
  tile: TileId;
  train: TrainId;
  seg: number;
}

// ---------------------------------------------------------------- the players

/** A player as everyone at the table sees them. Hands are never included —
 *  only the count — so this shape is safe to send to spectators.
 *
 *  `connected` is stitched in by the room rather than the game, which knows
 *  nothing about sockets. It lives here so the client has one list of players
 *  to render instead of two it has to join. */
export interface PlayerView {
  id: PlayerId;
  name: string;
  bot: boolean;
  tiles: number;
  score: number;
  roundScores: number[];
  openingDone: boolean;
  connected: boolean;
  /** A bot's temperament, revealed only once the game is over. */
  temper?: number;
}

/** A player exactly as the rules engine knows them. The engine has no idea
 *  whether anyone is on the other end of a socket, so `connected` is the one
 *  field it cannot fill in — the room adds it on the way out. */
export type EnginePlayerView = Omit<PlayerView, 'connected'>;

export interface LogLine {
  text: string;
  kind: string;
  n: number;
}

// ---------------------------------------------------------------- the game

export interface GameView {
  max: number;
  foot: Foot;
  scoring: Scoring;
  round: number;
  totalRounds: number;
  engine: number;
  engineDown: boolean;
  phase: Phase;
  status: Status;
  turn: PlayerId | null;
  /** Only ever set when it is your turn; null for everyone else. */
  prompt: Prompt | null;
  pending: Array<{ train: TrainId; seg: number; value: number; need: number; placed: number }>;
  boneyard: number;
  lastPlay: { tile: TileId; trainId: TrainId; segId: number } | null;
  roundWinner: PlayerId | null;
  log: LogLine[];
  players: PlayerView[];
  trains: TrainView[];
  /** Yours alone. Empty for spectators and for an unknown id. */
  hand: TileId[];
  /** Yours alone, and only on your turn. */
  moves: Move[];
}

/** What `Game.view()` produces: everything above, minus the presence the engine
 *  cannot know. `Room.snapshot()` turns this into a `GameView`. */
export interface EngineGameView extends Omit<GameView, 'players'> {
  players: EnginePlayerView[];
}

// ---------------------------------------------------------------- the room

export interface Settings {
  max: number;
  foot: Foot;
  scoring: Scoring;
}

/** Settings plus the two figures the lobby derives from them. */
export interface SettingsView extends Settings {
  seats: number;
  deal: number;
}

export interface SeatView {
  id: PlayerId;
  name: string;
  bot: boolean;
  connected: boolean;
}

export interface WatcherView {
  id: PlayerId;
  name: string;
  connected: boolean;
}

/** The table's own notices — who joined, who left, who a bot took over for —
 *  and, only where chat is turned on, what players said to each other. */
export type ChatLine =
  | { system: true; text: string; ts: number }
  | { system?: undefined; from: string; text: string; ts: number };

export interface RoomSnapshot {
  t: 'room';
  code: string;
  youId: PlayerId;
  hostId: PlayerId | null;
  settings: SettingsView;
  phase: 'lobby' | 'game';
  seats: SeatView[];
  watchers: WatcherView[];
  spectating: boolean;
  chat: ChatLine[];
  /** Whether players may talk to each other here. Off unless the deployment
   *  turned it on, in which case `chat` carries only the table's notices. */
  chatEnabled: boolean;
  game: GameView | null;
}

// ---------------------------------------------------------------- messages

/** Everything a client may send. `join` establishes identity and is handled by
 *  each host directly; everything else goes through dispatch(), which both
 *  hosts share so the two builds cannot drift on what a message means. */
export type ClientMessage =
  | { t: 'join'; pid?: PlayerId | null; name?: string; spectate?: boolean }
  | { t: 'ping' }
  | { t: 'name'; name: string }
  | { t: 'settings'; settings: Partial<Settings> }
  | { t: 'addBot' }
  | { t: 'remove'; id: PlayerId }
  | { t: 'fillSeat'; id: PlayerId }
  | { t: 'start' }
  | { t: 'nextRound' }
  | { t: 'playAgain' }
  | { t: 'chat'; text: string }
  | { t: 'play'; tile: TileId; train: TrainId; seg: number }
  | { t: 'draw' }
  | { t: 'pass' }
  | { t: 'marker'; up: boolean }
  | { t: 'engine' };

export type ClientMessageType = ClientMessage['t'];

// ---------------------------------------------------------------- the funnel

/** The moments on the way to a table that the server cannot see for itself.
 *  Everything before the socket opens is invisible to it: someone who lands on
 *  the front page and leaves, or opens a shared link and never says who they
 *  are, produces no room, no join, and no log line.
 *
 *  A closed set, and it lives here so the two ends cannot drift — the client
 *  sends these names and the server accepts exactly these names. Anything an
 *  event could identify a person by is deliberately absent: this is a tally of
 *  moments, not a trail of one player through them.
 *
 *    home      the front door was rendered
 *    link      a shared link was opened and the table was found
 *    returned  a shared link was opened by someone already known at that table
 *    made      a table was minted from the front door
 *    code      a table was joined by typing its code
 *    seat      a shared link was entered as a player
 *    watch     a shared link was entered as a spectator
 *
 *  `home` and `link` are the denominators; the rest are what people did next. */
export type FunnelEvent = 'home' | 'link' | 'returned' | 'made' | 'code' | 'seat' | 'watch';

/** What came off the boneyard — sent only to the player who drew it. */
export interface DrewMessage {
  t: 'drew';
  tile: TileId;
  playable?: boolean;
  engine?: boolean;
  /** Present when the draw was part of hunting the engine, not ordinary play. */
  seeking?: boolean;
}

export type ServerMessage =
  | RoomSnapshot
  | { t: 'you'; pid: PlayerId }
  | { t: 'pong' }
  | { t: 'error'; msg: string }
  /** Terminal: the table is gone, or this client was turned away. */
  | { t: 'fatal'; msg: string }
  | DrewMessage;
