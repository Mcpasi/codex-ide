const ROUND_SECONDS = 30;
const FIRST_STAR_DELAY = 760;
const FASTEST_STAR_DELAY = 320;
const STAR_DELAY_STEP = 45;
const BEST_SCORE_KEY = 'sternensammler-best';

const scoreDisplay = document.querySelector('#score');
const comboDisplay = document.querySelector('#combo');
const timeDisplay = document.querySelector('#time');
const bestScoreDisplay = document.querySelector('#best-score');
const startButton = document.querySelector('#start-button');
const playfield = document.querySelector('#playfield');
const welcomeCard = document.querySelector('#welcome');
const statusMessage = document.querySelector('#status');

let score = 0;
let combo = 0;
let bestScore = loadBestScore();
let isPlaying = false;
let roundEndsAt = 0;
let countdownTimer = null;
let nextStarTimer = null;
let starExpiryTimer = null;

bestScoreDisplay.textContent = String(bestScore);
startButton.addEventListener('click', startGame);
window.addEventListener('resize', () => {
  const star = playfield.querySelector('.star-button');
  if (!star) return;

  const halfWidth = star.offsetWidth / 2;
  const halfHeight = star.offsetHeight / 2;
  star.style.left = `${Math.max(halfWidth, Math.min(parseFloat(star.style.left), playfield.clientWidth - halfWidth))}px`;
  star.style.top = `${Math.max(halfHeight, Math.min(parseFloat(star.style.top), playfield.clientHeight - halfHeight))}px`;
});

function loadBestScore() {
  try {
    const stored = localStorage.getItem(BEST_SCORE_KEY);
    if (stored === null || !/^\d+$/.test(stored)) return 0;
    const value = Number(stored);
    return Number.isSafeInteger(value) ? value : 0;
  } catch {
    return 0;
  }
}

function saveBestScore() {
  try {
    localStorage.setItem(BEST_SCORE_KEY, String(bestScore));
  } catch {
    // Das Spiel funktioniert auch, wenn der Browser keinen Speicher erlaubt.
  }
}

function setStatus(message) {
  statusMessage.firstChild.textContent = `${message} Bester Lauf: `;
}

function currentStarDelay() {
  const speedUp = Math.floor(score / 4) * STAR_DELAY_STEP;
  return Math.max(FASTEST_STAR_DELAY, FIRST_STAR_DELAY - speedUp);
}

function clearTimers() {
  window.clearInterval(countdownTimer);
  window.clearTimeout(nextStarTimer);
  window.clearTimeout(starExpiryTimer);
  countdownTimer = null;
  nextStarTimer = null;
  starExpiryTimer = null;
}

function removeStar() {
  window.clearTimeout(starExpiryTimer);
  starExpiryTimer = null;
  playfield.querySelector('.star-button')?.remove();
}

function scheduleNextStar() {
  window.clearTimeout(nextStarTimer);
  if (isPlaying) {
    nextStarTimer = window.setTimeout(spawnStar, currentStarDelay());
  }
}

function spawnStar() {
  if (!isPlaying) return;
  if (performance.now() >= roundEndsAt) {
    finishGame();
    return;
  }

  removeStar();
  const star = document.createElement('button');
  star.type = 'button';
  const isGolden = Math.random() < 0.2;
  const starLifetime = isGolden ? 700 : 1100;
  star.className = isGolden ? 'star-button star-button--golden' : 'star-button';
  star.textContent = isGolden ? '★' : '✦';
  const points = isGolden ? 5 : combo + 1 >= 3 ? 2 : 1;
  star.setAttribute('aria-label', `${isGolden ? 'Goldenen Stern' : 'Stern'} fangen, ${points} ${points === 1 ? 'Punkt' : 'Punkte'}`);
  playfield.append(star);
  const halfWidth = star.offsetWidth / 2;
  const halfHeight = star.offsetHeight / 2;
  star.style.left = `${halfWidth + Math.random() * Math.max(0, playfield.clientWidth - star.offsetWidth)}px`;
  star.style.top = `${halfHeight + Math.random() * Math.max(0, playfield.clientHeight - star.offsetHeight)}px`;

  const starExpiresAt = performance.now() + starLifetime;
  function missStar() {
    if (performance.now() >= roundEndsAt) {
      finishGame();
      return;
    }
    combo = 0;
    comboDisplay.textContent = '0';
    setStatus(isGolden ? 'Goldener Stern verpasst! Combo beendet.' : 'Stern verpasst! Combo beendet.');
    removeStar();
    scheduleNextStar();
  }

  star.addEventListener('click', () => {
    if (!isPlaying) return;
    if (performance.now() >= roundEndsAt) {
      finishGame();
      return;
    }
    if (performance.now() >= starExpiresAt) {
      missStar();
      return;
    }

    combo += 1;
    comboDisplay.textContent = String(combo);
    score += points;
    scoreDisplay.textContent = String(score);
    setStatus(isGolden ? 'Goldener Stern gefangen! +5 Punkte.' : points === 2 ? `Combo ${combo}! +2 Punkte.` : 'Stern gefangen! +1 Punkt.');

    if (score > bestScore) {
      bestScore = score;
      bestScoreDisplay.textContent = String(bestScore);
      saveBestScore();
    }

    removeStar();
    scheduleNextStar();
  });

  starExpiryTimer = window.setTimeout(missStar, starLifetime);
}

function finishGame() {
  if (!isPlaying) return;

  isPlaying = false;
  roundEndsAt = 0;
  clearTimers();
  removeStar();
  timeDisplay.textContent = '0';
  startButton.disabled = false;
  startButton.textContent = 'Noch einmal spielen';
  setStatus(score > 0 ? 'Zeit vorbei!' : 'Die Zeit ist um!');
}

function startGame() {
  clearTimers();
  removeStar();

  score = 0;
  combo = 0;
  scoreDisplay.textContent = '0';
  comboDisplay.textContent = '0';
  timeDisplay.textContent = String(ROUND_SECONDS);
  welcomeCard.hidden = true;
  isPlaying = true;
  startButton.disabled = true;
  startButton.textContent = 'Sammeln läuft …';

  roundEndsAt = performance.now() + ROUND_SECONDS * 1000;
  setStatus('Viel Erfolg!');

  countdownTimer = window.setInterval(() => {
    const secondsLeft = Math.max(0, Math.ceil((roundEndsAt - performance.now()) / 1000));
    timeDisplay.textContent = String(secondsLeft);
    if (secondsLeft === 0) finishGame();
  }, 100);

  spawnStar();
}
