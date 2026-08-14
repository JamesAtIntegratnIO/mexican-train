// Which board a game is played on, and the only place that chooses.
//
// There is more than one thing that repaints the board — a snapshot landing, a
// tile being picked up, a lift ending — and each of them used to name the
// painter directly. That was fine while there was one. With two it is a bug
// waiting for its second call site: picking a tile up repainted a Chicken Foot
// table as Mexican Train lanes, because the hand knew a painter by name rather
// than asking which one this table wants.

import { paintLanes, onLaneClick } from './lanes.js';
import { paintBoard, onBoardClick } from './board.js';
import type { GameView } from '../shared/protocol.js';

export function paintTable(g: GameView): void {
  if (g.game === 'chickenFoot') paintBoard(g); else paintLanes(g);
}

export const boardClick = (g: GameView): ((e: Event) => void) =>
  (g.game === 'chickenFoot' ? onBoardClick : onLaneClick);
