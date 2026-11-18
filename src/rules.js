// Traditional Goolah Bazy rules — a pure, testable engine.
//
// Nothing here touches Three.js, the DOM or the physics: the game reports what
// happened on the field and this module decides points, extra chances, mat
// ownership, Mat-per status, round transitions and the match result. Section
// numbers in the comments refer to the agreed rule set (1-10).

export const RULES = {
  playersPerTeam: 2,
  teamCount: 2,
  matCount: 4,

  /* §3  every player starts a turn with one chance */
  initialChances: 1,
  /* §4  the first two mats a team captures in a round earn nothing */
  freeMats: 2,
  /* §5  a Mat-per goolah held in the hollow / knocked out of it */
  matPerHoldPoints: 3,
  matPerKnockoutPoints: 7,
  /* §3/§8  a normal Tir */
  tirPoints: 1,
  /* §6  one last throw at one opponent after the final mat */
  finalMatTargets: 1,
  /* §1/§10 */
  targetScore: 21,
};

/* §1  Zananda (orange, index 1) starts the match as the throwing team. */
export const FIRST_THROWING_TEAM = 1;

export const ballKey = (teamIndex, playerIndex) => `${teamIndex}:${playerIndex}`;

/* §4  Mat points = max(0, mats captured this round - 2). The mat numbers
   themselves never matter, only how many a team captured. */
export function matPointsFor(capturedCount) {
  return Math.max(0, capturedCount - RULES.freeMats);
}

/* §1  the two teams exchange roles at the end of every round */
export function throwingTeamForRound(round) {
  return round % 2 === 1 ? FIRST_THROWING_TEAM : 1 - FIRST_THROWING_TEAM;
}

/* §2  throwing team P1, throwing team P2, defending P1, defending P2 */
export function turnOrderFor(state) {
  const order = [];
  for (const teamIndex of [state.throwingTeam, state.defendingTeam]) {
    for (let playerIndex = 0; playerIndex < RULES.playersPerTeam; playerIndex += 1) {
      order.push({ teamIndex, playerIndex });
    }
  }
  return order;
}

function freshMats() {
  return Array.from({ length: RULES.matCount }, (_, index) => ({
    index,
    completed: false,
    capturedBy: null,
    capturedByPlayer: -1,
    matPer: null,
  }));
}

function freshMatPer() {
  return Array.from({ length: RULES.teamCount }, () =>
    Array.from({ length: RULES.playersPerTeam }, () => null)
  );
}

function freshLocks() {
  return Array.from({ length: RULES.teamCount }, () =>
    Array.from({ length: RULES.playersPerTeam }, () => [])
  );
}

export function createMatchState({ round = 1 } = {}) {
  const throwingTeam = throwingTeamForRound(round);
  return {
    scores: [0, 0],
    round,
    throwingTeam,
    defendingTeam: 1 - throwingTeam,
    captured: [0, 0],
    mats: freshMats(),
    // §5  Mat-per is per player, so both players of a team can hold one.
    matPer: freshMatPer(),
    // §3  temporary Tir target lockout, per player.
    locked: freshLocks(),
    turn: {
      teamIndex: throwingTeam,
      playerIndex: 0,
      index: 0,
      chances: RULES.initialChances,
      pendingMatPer: null,
      finalOpportunity: false,
    },
    turnIndex: 0,
    // §6  set when the fourth mat is completed.
    finalMat: null,
    roundOver: false,
    matchOver: false,
    winner: null,
    log: [],
  };
}

/* §9  Rakh: a goolah that stops somewhere unplayable is brought to the nearest
   playable spot on a straight line toward the field. Ordinary obstacles that
   leave the goolah playable are not Rakh, so the caller only asks when it
   genuinely cannot be played. */
export function rakhPosition(point, isPlayable, options = {}) {
  const { toward = { x: 0, z: 0 }, step = 0.15, maxDistance = 16 } = options;
  if (isPlayable(point.x, point.z)) {
    return { x: point.x, z: point.z, applied: false, distance: 0 };
  }
  const dx = toward.x - point.x;
  const dz = toward.z - point.z;
  const length = Math.hypot(dx, dz) || 1;
  const ux = dx / length;
  const uz = dz / length;

  for (let d = step; d <= maxDistance; d += step) {
    const x = point.x + ux * d;
    const z = point.z + uz * d;
    if (isPlayable(x, z)) return { x, z, applied: true, distance: d };
  }
  return { x: toward.x, z: toward.z, applied: true, distance: length };
}

export class RulesEngine {
  constructor(options = {}) {
    this.state = createMatchState(options);
    this.beginTurn(0);
  }

  get s() {
    return this.state;
  }

  /* ---------------------------------------------------------------- turns -- */

  /* §1/§4  a new round: roles swap, mats and captures reset, all four goolahs
     go back to their starting positions (the game does the placement). */
  startRound(round) {
    const s = this.state;
    if (typeof round === 'number') s.round = round;
    s.throwingTeam = throwingTeamForRound(s.round);
    s.defendingTeam = 1 - s.throwingTeam;
    s.captured = [0, 0];
    s.mats = freshMats();
    s.matPer = freshMatPer();
    s.locked = freshLocks();
    s.finalMat = null;
    s.roundOver = false;
    this.beginTurn(0);
    return s;
  }

  /* §3  a fresh turn starts with one chance and clears the temporary target
     lockout, because every other player has played since it was set. */
  beginTurn(index = this.state.turnIndex) {
    const s = this.state;
    s.turnIndex = index;
    const order = turnOrderFor(s);
    const slot = order[index];
    if (!slot) {
      s.roundOver = true;
      return s.turn;
    }
    s.locked[slot.teamIndex][slot.playerIndex] = [];
    const held = s.matPer[slot.teamIndex][slot.playerIndex];
    s.turn = {
      ...slot,
      index,
      chances: RULES.initialChances,
      /* §5  a Mat-per goolah waits for this player's next turn. */
      pendingMatPer: held ? { ...held } : null,
      finalOpportunity: false,
    };
    return s.turn;
  }

  endTurn() {
    const s = this.state;
    s.turn.chances = 0;
    const order = turnOrderFor(s);
    const next = s.turnIndex + 1;
    if (next >= order.length) {
      s.roundOver = true;
      return s.turn;
    }
    return this.beginTurn(next);
  }

  /* --------------------------------------------------------------- throws -- */

  canThrow() {
    const s = this.state;
    if (s.matchOver || s.roundOver) return false;
    return Boolean(s.turn) && s.turn.chances > 0;
  }

  /* §3  targets: the two opponent goolahs, minus any this player just hit. */
  availableTargets() {
    const s = this.state;
    const t = s.turn;
    if (!t) return [];
    const opponentTeam = 1 - t.teamIndex;
    const locked = s.locked[t.teamIndex][t.playerIndex] || [];
    const targets = [];
    for (let playerIndex = 0; playerIndex < RULES.playersPerTeam; playerIndex += 1) {
      const key = ballKey(opponentTeam, playerIndex);
      if (locked.includes(key)) continue;
      targets.push({
        teamIndex: opponentTeam,
        playerIndex,
        key,
        matPer: Boolean(s.matPer[opponentTeam][playerIndex]),
      });
    }
    return targets;
  }

  isMatPerBall(teamIndex, playerIndex) {
    return Boolean(this.state.matPer[teamIndex]?.[playerIndex]);
  }

  award(teamIndex, points, reason) {
    const s = this.state;
    if (!points) return;
    s.scores[teamIndex] += points;
    s.log.push({ round: s.round, teamIndex, points, reason });
    /* §10  the match ends the moment a team reaches 21. */
    if (!s.matchOver && s.scores[teamIndex] >= RULES.targetScore) {
      s.matchOver = true;
      s.winner = teamIndex;
    }
  }

  /* §4  a mat is completed once per round and cannot be reused, even if the
     goolah later leaves it. Points come from the team's running total. */
  captureMat(matIndex, teamIndex, playerIndex = -1) {
    const s = this.state;
    const mat = s.mats[matIndex];
    if (!mat || mat.completed) return null;
    mat.completed = true;
    mat.capturedBy = teamIndex;
    mat.capturedByPlayer = playerIndex;
    s.captured[teamIndex] += 1;

    const before = matPointsFor(s.captured[teamIndex] - 1);
    const after = matPointsFor(s.captured[teamIndex]);
    const points = after - before;
    if (points > 0) this.award(teamIndex, points, 'mat');

    return {
      matIndex,
      teamIndex,
      playerIndex,
      points,
      total: s.captured[teamIndex],
    };
  }

  /**
   * Score one throw.
   *
   * @param {object} shot
   * @param {Array}  shot.collisions  goolahs the shot touched, first contact only:
   *        { kind:'opponent'|'teammate', teamIndex, playerIndex,
   *          matPer?:boolean, knockedOutOfMat?:boolean, matIndex?:number,
   *          enteredMat?:number, previous?:{x,y,z} }
   * @param {number} shot.ownMatIndex  mat the thrown goolah settled into, or -1
   */
  resolveThrow(shot = {}) {
    const s = this.state;
    const thrower = s.turn;
    const team = thrower.teamIndex;
    const player = thrower.playerIndex;

    const result = {
      points: 0,
      awards: [],
      captures: [],
      matPerOffers: [],
      restore: [],
      extraChance: false,
      notes: [],
      matchOver: false,
      roundOver: false,
      finalMat: null,
      stayOnPlayer: false,
    };

    /* Leaving a Mat-per mat to throw consumes the held status (§5). */
    if (s.turn.pendingMatPer) {
      const held = s.turn.pendingMatPer;
      s.matPer[team][player] = null;
      const heldMat = s.mats[held.matIndex];
      if (heldMat) heldMat.matPer = null;
      s.turn.pendingMatPer = null;
    }

    const collisions = Array.isArray(shot.collisions) ? shot.collisions : [];

    /* §7  a teammate collision scores nothing, grants no chance, and the
       teammate's goolah goes back to exactly where it was. Collision order
       does not matter: a valid opponent Tir in the same throw still counts. */
    for (const c of collisions) {
      if (c.kind !== 'teammate') continue;
      result.restore.push({
        teamIndex: c.teamIndex,
        playerIndex: c.playerIndex,
        position: c.previous,
      });
      result.notes.push('teammate hit: no point, no extra chance, goolah restored');
    }

    /* §5  a Mat-per goolah is worth exactly 3 (stays in the hollow) or 7
       (knocked out), and that replaces the normal Tir point. Only the first
       collision with it counts (§8). */
    const matPerHits = collisions.filter((c) => c.kind === 'opponent' && c.matPer);
    if (matPerHits.length) {
      const first = matPerHits[0];
      const mat = s.mats[first.matIndex];
      if (first.knockedOutOfMat) {
        this.award(team, RULES.matPerKnockoutPoints, 'matper-knockout');
        result.points += RULES.matPerKnockoutPoints;
        result.awards.push({
          type: 'matper-knockout',
          points: RULES.matPerKnockoutPoints,
          teamIndex: team,
        });
        /* §5  the mat stays completed, Mat-per ends. */
        if (mat) mat.matPer = null;
        s.matPer[first.teamIndex][first.playerIndex] = null;
        result.notes.push('Mat-per goolah knocked out: 7 points, mat stays completed, Mat-per ends');
      } else {
        this.award(team, RULES.matPerHoldPoints, 'matper-hold');
        result.points += RULES.matPerHoldPoints;
        result.awards.push({
          type: 'matper-hold',
          points: RULES.matPerHoldPoints,
          teamIndex: team,
        });
        result.notes.push('Mat-per goolah stays in the hollow: 3 points, Mat-per continues');
      }
      result.extraChance = true;
      if (matPerHits.length > 1) result.notes.push('only the first Mat-per collision scores');
    }

    /* §3/§8  a normal Tir: one point and one extra chance at most, however
       many opponent goolahs the throw touches. */
    const plainHits = collisions.filter((c) => c.kind === 'opponent' && !c.matPer);
    if (plainHits.length) {
      this.award(team, RULES.tirPoints, 'tir');
      result.points += RULES.tirPoints;
      result.awards.push({ type: 'tir', points: RULES.tirPoints, teamIndex: team });
      result.extraChance = true;
      for (const c of plainHits) {
        const key = ballKey(c.teamIndex, c.playerIndex);
        const locked = s.locked[team][player];
        if (!locked.includes(key)) locked.push(key);
      }
      if (plainHits.length > 1) {
        result.notes.push('both opponents hit: still one Tir and one extra chance');
      }
    }

    /* §3/§4  the thrown goolah falling into an open mat captures it for its
       team and earns one extra chance. */
    const ownMatIndex = Number.isInteger(shot.ownMatIndex) ? shot.ownMatIndex : -1;
    if (ownMatIndex >= 0) {
      const capture = this.captureMat(ownMatIndex, team, player);
      if (capture) {
        result.captures.push(capture);
        result.extraChance = true;
        /* §3  completing a Mat clears this player's target lockout. */
        s.locked[team][player] = [];
        /* §5  the player may hold the goolah in the mat instead of throwing. */
        s.turn.pendingMatPer = { matIndex: ownMatIndex, teamIndex: team, playerIndex: player };
        result.matPerOffers.push({ ...s.turn.pendingMatPer });
        if (capture.points > 0) {
          result.notes.push(`mat ${ownMatIndex + 1} captured: +${capture.points} mat point`);
        } else {
          result.notes.push(`mat ${ownMatIndex + 1} captured (inside the two free mats)`);
        }
      }
    }

    /* §8  an opponent goolah knocked into a mat is credited to the team that
       owns it, while the shooter keeps the normal Tir point. */
    for (const c of collisions) {
      if (c.kind !== 'opponent') continue;
      if (!Number.isInteger(c.enteredMat) || c.enteredMat < 0) continue;
      const capture = this.captureMat(c.enteredMat, c.teamIndex, c.playerIndex);
      if (capture) {
        result.captures.push(capture);
        result.notes.push(
          `opponent goolah entered mat ${c.enteredMat + 1}: credited to its own team`
        );
      }
    }

    /* §6  the fourth mat opens one last opportunity for whoever completed it. */
    const completed = s.mats.filter((m) => m.completed).length;
    if (completed >= RULES.matCount && !s.finalMat) {
      const last = result.captures[result.captures.length - 1];
      const by = last
        ? { teamIndex: last.teamIndex, playerIndex: last.playerIndex }
        : { teamIndex: team, playerIndex: player };
      s.finalMat = {
        teamIndex: by.teamIndex,
        playerIndex: by.playerIndex,
        matIndex: last ? last.matIndex : -1,
        used: false,
        targetsRemaining: RULES.finalMatTargets,
      };
      result.finalMat = { ...s.finalMat };
      result.notes.push('final mat completed: one last throw at one opponent, then the round ends');
    }

    return result;
  }

  /**
   * Advance the turn after a throw has been fully scored.
   * Call this once, after resolveThrow and after any Mat-per choice.
   */
  afterThrow(result = {}) {
    const s = this.state;
    if (s.matchOver) {
      result.matchOver = true;
      return result;
    }

    const thrower = s.turn;

    /* §6  after the final mat only the player who completed it throws, at one
       opponent, and then the round is over. Their teammate's unused turn and
       chances are lost. */
    if (s.finalMat) {
      if (thrower.finalOpportunity) {
        s.finalMat.used = true;
        s.roundOver = true;
        result.roundOver = true;
        return result;
      }
      if (s.finalMat.teamIndex === thrower.teamIndex && s.finalMat.playerIndex === thrower.playerIndex) {
        s.turn.chances = 1;
        s.turn.finalOpportunity = true;
        s.turn.pendingMatPer = null;
        result.stayOnPlayer = true;
        return result;
      }
      s.turn = {
        teamIndex: s.finalMat.teamIndex,
        playerIndex: s.finalMat.playerIndex,
        index: s.turnIndex,
        chances: 1,
        pendingMatPer: null,
        finalOpportunity: true,
      };
      result.stayOnPlayer = true;
      result.finalOpportunityFor = { ...s.finalMat };
      return result;
    }

    /* §3  an extra chance keeps the same player on the field. */
    if (result.extraChance) {
      s.turn.chances = 1;
      result.stayOnPlayer = true;
      return result;
    }

    /* Neither Tir nor Mat: the turn ends and the next player takes theirs. */
    this.endTurn();
    result.stayOnPlayer = false;
    result.roundOver = s.roundOver;
    return result;
  }

  /* §5  hold the goolah in the mat (postpone the chance to the next turn) or
     leave it and use the chance now. */
  chooseMatPer(hold) {
    const s = this.state;
    const t = s.turn;
    if (!t || !t.pendingMatPer) return null;
    const { matIndex } = t.pendingMatPer;
    const team = t.teamIndex;
    const player = t.playerIndex;

    if (hold) {
      s.matPer[team][player] = { matIndex, teamIndex: team, playerIndex: player };
      const mat = s.mats[matIndex];
      if (mat) mat.matPer = { teamIndex: team, playerIndex: player };
      s.turn.pendingMatPer = null;
      s.turn.chances = 0;
      this.endTurn();
      return { held: true, matIndex, roundOver: s.roundOver, turn: { ...s.turn } };
    }

    s.matPer[team][player] = null;
    const mat = s.mats[matIndex];
    if (mat) mat.matPer = null;
    s.turn.pendingMatPer = null;
    s.turn.chances = 1;
    return { held: false, matIndex, roundOver: false, turn: { ...s.turn } };
  }

  /* §6  the completing player picks which opponent the last throw may hit. */
  chooseFinalTarget(teamIndex, playerIndex) {
    const s = this.state;
    if (!s.finalMat) return null;
    s.finalMat.targetKey = ballKey(teamIndex, playerIndex);
    return { ...s.finalMat };
  }

  describe() {
    const s = this.state;
    return {
      round: s.round,
      throwingTeam: s.throwingTeam,
      defendingTeam: s.defendingTeam,
      scores: [...s.scores],
      captured: [...s.captured],
      matPoints: [matPointsFor(s.captured[0]), matPointsFor(s.captured[1])],
      mats: s.mats.map((m) => ({
        index: m.index,
        completed: m.completed,
        capturedBy: m.capturedBy,
        capturedByPlayer: m.capturedByPlayer,
        matPer: m.matPer ? { ...m.matPer } : null,
      })),
      turn: {
        teamIndex: s.turn.teamIndex,
        playerIndex: s.turn.playerIndex,
        chances: s.turn.chances,
        pendingMatPer: s.turn.pendingMatPer ? { ...s.turn.pendingMatPer } : null,
        finalOpportunity: s.turn.finalOpportunity,
      },
      targets: this.availableTargets(),
      matPer: s.matPer.map((team) => team.map((m) => (m ? { ...m } : null))),
      finalMat: s.finalMat ? { ...s.finalMat } : null,
      roundOver: s.roundOver,
      matchOver: s.matchOver,
      winner: s.winner,
      targetScore: RULES.targetScore,
    };
  }
}
