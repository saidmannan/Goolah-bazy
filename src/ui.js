import { RULES, matPointsFor } from './rules.js';
import { TEAMS } from './config.js';
import {
  DEFAULT_DIFFICULTY,
  DEFAULT_SEATS,
  DIFFICULTIES,
  DIFFICULTY_ORDER,
  normalizeSeats,
  seatKey,
} from './ai.js';

const SETUP_KEY = 'goolah.setup.v1';

export class UI {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      cardA: $('cardA'),
      cardB: $('cardB'),
      scoreA: $('scoreA'),
      scoreB: $('scoreB'),
      chipsA: $('chipsA'),
      chipsB: $('chipsB'),
      progA: $('progA'),
      progB: $('progB'),
      matsA: $('matsA'),
      matsB: $('matsB'),
      matPerA: $('matPerA'),
      matPerB: $('matPerB'),
      turnBanner: $('turnBanner'),
      turnText: $('turnText'),
      turnHint: $('turnHint'),
      turnChance: $('turnChance'),
      powerFill: $('powerFill'),
      toast: $('toast'),
      startOverlay: $('startOverlay'),
      rulesOverlay: $('rulesOverlay'),
      roundOverlay: $('roundOverlay'),
      winOverlay: $('winOverlay'),
      roundTitle: $('roundTitle'),
      roundSub: $('roundSub'),
      roundSummary: $('roundSummary'),
      winTitle: $('winTitle'),
      winSub: $('winSub'),
      matPerPanel: $('matPerPanel'),
      matPerCopy: $('matPerCopy'),
      loader: $('loader'),
    };

    this.toastTimer = null;

    // Line-up and AI difficulty live in the setup panel and survive a reload.
    this.setup = this.loadSetup();
    this.bindSetup();
  }

  get overlayOpen() {
    return (
      !this.el.rulesOverlay.classList.contains('hidden') ||
      !this.el.roundOverlay.classList.contains('hidden') ||
      !this.el.winOverlay.classList.contains('hidden') ||
      !this.el.startOverlay.classList.contains('hidden')
    );
  }

  setScores(scores, target) {
    const [a, b] = scores;
    if (this.el.scoreA.textContent !== String(a)) {
      this.el.scoreA.textContent = String(a);
      this.pop(this.el.scoreA);
    }
    if (this.el.scoreB.textContent !== String(b)) {
      this.el.scoreB.textContent = String(b);
      this.pop(this.el.scoreB);
    }
    const pct = (v) => `${Math.min(100, (v / target) * 100)}%`;
    this.el.progA.style.width = pct(a);
    this.el.progB.style.width = pct(b);
  }

  /** Mat tally per team for the current round (rule 4). */
  setMats(captured, mats, matCount) {
    this.el.matsA.innerHTML = `Mats <b>${captured[0]}</b>/${matCount}`;
    this.el.matsB.innerHTML = `Mats <b>${captured[1]}</b>/${matCount}`;
    this.el.cardA.classList.toggle('quota-met', captured[0] >= 2);
    this.el.cardB.classList.toggle('quota-met', captured[1] >= 2);
    const open = [];
    mats.forEach((mat, index) => {
      if (!mat.completed) open.push(index + 1);
    });
    this.el.cardA.title = open.length ? `Open mats: ${open.join(', ')}` : 'All mats completed';
  }

  /** Rule 5: show which team currently holds a Mat-per goolah. */
  setMatPer(matPer) {
    const held = (teamIndex) => matPer[teamIndex].some(Boolean);
    this.el.matPerA.classList.toggle('hidden', !held(0));
    this.el.matPerB.classList.toggle('hidden', !held(1));
  }

  pop(node) {
    node.classList.remove('pop');
    // eslint-disable-next-line no-unused-expressions
    void node.offsetWidth;
    node.classList.add('pop');
  }

  setTurn(teamIndex, playerIndex, chances = 1, extra = {}) {
    const team = TEAMS[teamIndex];
    const isBlue = teamIndex === 0;

    this.el.cardA.classList.toggle('active', isBlue);
    this.el.cardB.classList.toggle('active', !isBlue);

    const chips = isBlue ? this.el.chipsA : this.el.chipsB;
    chips.querySelectorAll('.chip').forEach((chip, index) => {
      chip.classList.toggle('on', index === playerIndex);
    });

    this.el.turnBanner.classList.remove('blue', 'orange');
    this.el.turnBanner.classList.add(team.cssClass);

    const role = teamIndex === extra.throwingTeam ? 'Throwing' : 'Defending';
    this.el.turnText.textContent = `${team.name} · Player ${playerIndex + 1} · ${role}`;

    if (extra.finalOpportunity) {
      this.el.turnChance.textContent = 'Final throw';
    } else if (extra.matPerHeld) {
      this.el.turnChance.textContent = 'Mat-per';
    } else {
      this.el.turnChance.textContent = `${chances} throw${chances === 1 ? '' : 's'}`;
    }
    this.el.turnChance.classList.toggle('locked', Boolean(extra.finalOpportunity));
  }

  setTurnHint(text) {
    this.el.turnHint.textContent = text;
  }

  setPower(power) {
    this.el.powerFill.style.right = `${(1 - Math.min(1, Math.max(0, power))) * 100}%`;
  }

  toast(text, color) {
    const node = this.el.toast;
    node.textContent = text;
    node.style.borderColor = color || 'rgba(255, 214, 150, 0.5)';
    node.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => node.classList.remove('show'), 2200);
  }

  showHint(text) {
    this.toast(text);
  }

  hideStart() {
    this.el.startOverlay.classList.add('hidden');
  }

  showStart() {
    this.el.startOverlay.classList.remove('hidden');
    this.renderSetup();
  }

  /* ----------------------------------------------------------- line-up --- */

  loadSetup() {
    const fallback = { seats: { ...DEFAULT_SEATS }, difficulty: DEFAULT_DIFFICULTY };
    try {
      const raw = localStorage.getItem(SETUP_KEY);
      if (!raw) return fallback;
      const saved = JSON.parse(raw) || {};
      return {
        seats: normalizeSeats(saved.seats),
        difficulty: DIFFICULTY_ORDER.includes(saved.difficulty)
          ? saved.difficulty
          : DEFAULT_DIFFICULTY,
      };
    } catch (err) {
      return fallback;
    }
  }

  saveSetup() {
    try {
      localStorage.setItem(SETUP_KEY, JSON.stringify(this.setup));
    } catch (err) {
      // Private mode: the in-memory choice still applies to this match.
    }
  }

  bindSetup() {
    this.seatButtons = Array.from(document.querySelectorAll('.seat'));
    for (const button of this.seatButtons) {
      button.addEventListener('click', () => {
        const key = seatKey(Number(button.dataset.team), Number(button.dataset.player));
        this.setup.seats[key] = this.setup.seats[key] === 'ai' ? 'human' : 'ai';
        this.saveSetup();
        this.renderSetup();
      });
    }

    this.diffButtons = Array.from(document.querySelectorAll('.seg-btn'));
    for (const button of this.diffButtons) {
      button.addEventListener('click', () => {
        this.setup.difficulty = button.dataset.difficulty;
        this.saveSetup();
        this.renderSetup();
      });
    }

    const preset = (id, seats) => {
      const node = document.getElementById(id);
      if (!node) return;
      node.addEventListener('click', () => {
        this.setup.seats = { ...seats };
        this.saveSetup();
        this.renderSetup();
      });
    };
    preset('presetSolo', { '0:0': 'ai', '0:1': 'ai', '1:0': 'human', '1:1': 'ai' });
    preset('presetDuo', { '0:0': 'human', '0:1': 'human', '1:0': 'human', '1:1': 'human' });
    preset('presetWatch', { '0:0': 'ai', '0:1': 'ai', '1:0': 'ai', '1:1': 'ai' });

    this.renderSetup();
  }

  renderSetup() {
    const seats = this.setup.seats;
    const keys = ['0:0', '0:1', '1:0', '1:1'];
    const humans = keys.filter((key) => seats[key] !== 'ai');
    const label = (DIFFICULTIES[this.setup.difficulty] || DIFFICULTIES.intermediate).label;

    for (const button of this.seatButtons || []) {
      const key = seatKey(Number(button.dataset.team), Number(button.dataset.player));
      const isAI = seats[key] === 'ai';
      button.classList.toggle('is-ai', isAI);
      button.setAttribute('aria-pressed', String(isAI));
      const role = button.querySelector('.seat-role');
      if (role) {
        role.textContent = isAI
          ? `AI · ${label}`
          : humans.length === 1 && humans[0] === key
            ? 'You'
            : 'Human';
      }
    }

    for (const button of this.diffButtons || []) {
      const on = button.dataset.difficulty === this.setup.difficulty;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    }

    const hint = document.getElementById('setupHint');
    if (hint) {
      hint.textContent =
        humans.length === 0
          ? 'All four seats are AI: the match plays itself.'
          : humans.length === 4
            ? 'Four human seats on one device, taking turns.'
            : `${humans.length} human · ${4 - humans.length} AI`;
    }

    this.setSeatRoles(seats);
  }

  /** Mark AI seats on the scoreboard chips so the table reads at a glance. */
  setSeatRoles(seats) {
    const label = (DIFFICULTIES[this.setup.difficulty] || DIFFICULTIES.intermediate).label;
    for (const teamIndex of [0, 1]) {
      const chips = teamIndex === 0 ? this.el.chipsA : this.el.chipsB;
      chips.querySelectorAll('.chip').forEach((chip, playerIndex) => {
        const isAI = seats[seatKey(teamIndex, playerIndex)] === 'ai';
        chip.textContent = isAI ? `P${playerIndex + 1} AI` : `P${playerIndex + 1}`;
        chip.classList.toggle('ai', isAI);
        chip.title = isAI ? `AI · ${label}` : 'Human player';
      });
    }
  }

  openRules() {
    this.el.rulesOverlay.classList.remove('hidden');
  }

  closeRules() {
    this.el.rulesOverlay.classList.add('hidden');
  }

  /* --------------------------------------------------------- mat-per --- */

  showMatPerChoice(matNumber, teamName) {
    this.el.matPerCopy.textContent =
      `Leave the goolah in mat ${matNumber} and keep the chance for your next turn, ` +
      `or lift it out and throw now (${teamName}).`;
    this.el.matPerPanel.classList.remove('hidden');
  }

  hideMatPerChoice() {
    this.el.matPerPanel.classList.add('hidden');
  }

  /* -------------------------------------------------- round and match --- */

  showRoundEnd(info) {
    this.el.roundTitle.textContent = `Round ${info.round} complete`;
    this.el.roundSub.textContent = 'All four mats are closed. Roles swap for the next round.';

    const rows = [];
    for (const teamIndex of [0, 1]) {
      const team = TEAMS[teamIndex];
      const captured = info.captured[teamIndex];
      const points = info.matPoints[teamIndex];
      rows.push(
        `<li><span class="dot" style="background:${team.css}"></span>` +
          `<b>${team.name}</b> captured ${captured} mat${captured === 1 ? '' : 's'} · ` +
          `${points} point${points === 1 ? '' : 's'}</li>`
      );
    }
    rows.push(
      `<li class="total">Score: ${TEAMS[0].name} <b>${info.scores[0]}</b> — ` +
        `<b>${info.scores[1]}</b> ${TEAMS[1].name}</li>`
    );
    rows.push(
      `<li class="next">${TEAMS[info.nextThrowingTeam].name} throw${''} first next round · ` +
        `first to ${RULES.targetScore} wins</li>`
    );
    this.el.roundSummary.innerHTML = rows.join('');
    this.el.roundOverlay.classList.remove('hidden');
  }

  hideRoundEnd() {
    this.el.roundOverlay.classList.add('hidden');
  }

  showWin(team, scores = [0, 0], round = 1) {
    if (team) {
      this.el.winTitle.textContent = `${team.name} team wins`;
      this.el.winTitle.style.color = team.css;
    } else {
      this.el.winTitle.textContent = 'Match drawn';
      this.el.winTitle.style.color = '';
    }
    this.el.winSub.textContent =
      `${scores[0]} — ${scores[1]} after ${round} round${round === 1 ? '' : 's'}. ` +
      `${RULES.targetScore} points reached.`;
    this.el.winOverlay.classList.remove('hidden');
  }

  hideWin() {
    this.el.winOverlay.classList.add('hidden');
  }

  hideLoader() {
    this.el.loader.classList.add('hidden');
  }
}
