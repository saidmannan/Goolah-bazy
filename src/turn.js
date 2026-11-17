// Turn order for Goolah Bazy.
//
// Both players of the throwing team take their throws before the opposing team
// plays: Shānanda P1, Shānanda P2, then Orange P1, Orange P2. The team that
// starts a round alternates each round so neither side is always first.
export function turnAt(seq, startTeam, playersPerTeam = 2) {
  const block = Math.floor(seq / playersPerTeam);
  return {
    teamIndex: (startTeam + block) % 2,
    playerIndex: seq % playersPerTeam,
    block,
    // First or second throw of this team's block.
    throwInBlock: seq % playersPerTeam,
  };
}

/** The full throw order of one round, for display and for tests. */
export function roundTurns(startTeam, playersPerTeam = 2, teamCount = 2) {
  const total = playersPerTeam * teamCount;
  const turns = [];
  for (let i = 0; i < total; i += 1) turns.push(turnAt(i, startTeam, playersPerTeam));
  return turns;
}
