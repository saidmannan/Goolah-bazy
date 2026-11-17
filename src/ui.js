import { CONFIG, TEAMS } from './config.js';

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
      turnBanner: $('turnBanner'),
      turnText: $('turnText'),
      turnHint: $('turnHint'),
      powerFill: $('powerFill'),
      toast: $('toast'),
      startOverlay: $('startOverlay'),
      rulesOverlay: $('rulesOverlay'),
      roundOverlay: $('roundOverlay'),
      winOverlay: $('winOverlay'),
      roundTitle: $('roundTitle'),
      roundSub: $('roundSub'),
      winTitle: $('winTitle'),
      winSub: $('winSub'),
      loader: $('loader'),
    };

    this.onScore = null;
    this.toastTimer = null;

    document.querySelectorAll('.score-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const team = Number(btn.dataset.team);
        const delta = Number(btn.dataset.delta);
        if (Number.isFinite(team) && Number.isFinite(delta) && this.onScore) {
          this.onScore(team, delta);
        }
      });
    });
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
    this.el.progA.style.width = `${(a / target) * 100}%`;
    this.el.progB.style.width = `${(b / target) * 100}%`;
  }

  pop(node) {
    node.classList.remove('pop');
    // eslint-disable-next-line no-unused-expressions
    void node.offsetWidth;
    node.classList.add('pop');
  }

  setTurn(teamIndex, playerIndex) {
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
    this.el.turnText.textContent = `${team.name} · Player ${playerIndex + 1}`;
    this.el.turnHint.textContent = 'Drag to aim · release to throw';
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
    this.toastTimer = setTimeout(() => node.classList.remove('show'), 1900);
  }

  showHint(text) {
    this.toast(text);
  }

  pulseScoreButton(teamIndex) {
    const btn = document.querySelector(`.score-btn.plus[data-team="${teamIndex}"]`);
    if (!btn) return;
    btn.classList.remove('hint');
    void btn.offsetWidth;
    btn.classList.add('hint');
    setTimeout(() => btn.classList.remove('hint'), 2800);
  }

  hideStart() {
    this.el.startOverlay.classList.add('hidden');
  }

  openRules() {
    this.el.rulesOverlay.classList.remove('hidden');
  }

  closeRules() {
    this.el.rulesOverlay.classList.add('hidden');
  }

  showRoundEnd(round) {
    this.el.roundTitle.textContent = `Round ${round} complete`;
    this.el.roundSub.textContent =
      'Both teams have thrown. Record the points with + and −, then continue.';
    this.el.roundOverlay.classList.remove('hidden');
  }

  hideRoundEnd() {
    this.el.roundOverlay.classList.add('hidden');
  }

  showWin(team) {
    this.el.winTitle.textContent = `${team.name} team wins`;
    this.el.winTitle.style.color = team.css;
    this.el.winSub.textContent = `${CONFIG.targetScore} points reached.`;
    this.el.winOverlay.classList.remove('hidden');
  }

  hideWin() {
    this.el.winOverlay.classList.add('hidden');
  }

  hideLoader() {
    this.el.loader.classList.add('hidden');
  }
}
