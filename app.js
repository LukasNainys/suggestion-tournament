import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, onSnapshot, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const root = document.getElementById('app-root');
const titleEl = document.getElementById('tournament-title');
const pillEl = document.getElementById('phase-pill');

// If this page was opened via a private per-friend link (?v=TOKEN), use that
// token going forward — it identifies a specific person, not just a browser,
// and is what lets the server (not just this browser) block a second vote.
// Without a link, fall back to a random per-browser id (weaker, but still works).
function getVoterToken() {
  const fromLink = new URLSearchParams(location.search).get('v');
  if (fromLink) {
    localStorage.setItem('voterToken', fromLink);
    return fromLink;
  }
  let t = localStorage.getItem('voterToken');
  if (!t) {
    t = crypto.randomUUID();
    localStorage.setItem('voterToken', t);
  }
  return t;
}

function votedKey(stage, matchId) {
  return `voted_${stage}_${matchId}`;
}

let currentConfig = null;
let suggestions = [];

onSnapshot(doc(db, 'config', 'tournament'), (snap) => {
  currentConfig = snap.exists() ? snap.data() : { phase: 'submissions', title: 'Suggestion Tournament' };
  titleEl.textContent = currentConfig.title || 'Suggestion Tournament';
  renderPhasePill();
  render();
});

onSnapshot(collection(db, 'suggestions'), (snap) => {
  suggestions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (currentConfig && (currentConfig.phase === 'submissions' || currentConfig.phase === 'locked')) render();
});

let bracketData = null;
onSnapshot(doc(db, 'config', 'bracket'), (snap) => {
  bracketData = snap.exists() ? snap.data() : null;
  if (currentConfig && (currentConfig.phase === 'voting' || currentConfig.phase === 'complete')) render();
});

function renderPhasePill() {
  const labels = {
    submissions: 'Submissions open',
    locked: 'Submissions locked — bracket coming soon',
    voting: 'Voting in progress',
    complete: 'Tournament complete'
  };
  pillEl.textContent = labels[currentConfig.phase] || currentConfig.phase;
  pillEl.className = 'phase-pill ' + (currentConfig.phase === 'locked' ? 'locked' : currentConfig.phase === 'complete' ? 'complete' : '');
}

function render() {
  if (!currentConfig) return;
  if (currentConfig.phase === 'submissions') renderSubmissions();
  else if (currentConfig.phase === 'locked') renderLocked();
  else if (currentConfig.phase === 'voting') renderBracket(false);
  else if (currentConfig.phase === 'complete') renderBracket(true);
}

function renderSubmissions() {
  const approvedOrPending = suggestions.filter(s => s.status !== 'rejected');
  root.innerHTML = `
    <div class="card">
      <h2>Add your suggestion</h2>
      <p class="subtext" style="color:#555;">Submissions close soon and get filtered before the bracket starts.</p>
      <form class="submit-form" id="sugg-form">
        <div>
          <label for="sugg-text">Your suggestion</label><br/>
          <input type="text" id="sugg-text" maxlength="140" required placeholder="e.g. Taco night" />
        </div>
        <div>
          <label for="sugg-name">Your name (optional)</label><br/>
          <input type="text" id="sugg-name" maxlength="40" placeholder="e.g. Sam" />
        </div>
        <button type="submit">Submit suggestion</button>
        <p class="status-msg" id="sugg-status"></p>
      </form>
    </div>
    <h3 style="margin-top:2rem;">Submitted so far (${approvedOrPending.length})</h3>
    <ul class="suggestion-list">
      ${approvedOrPending.map(s => `<li>${escapeHtml(s.text)} ${s.submitter ? `<span class="submitter">— ${escapeHtml(s.submitter)}</span>` : ''}</li>`).join('') || '<li>No suggestions yet — be the first.</li>'}
    </ul>
  `;

  document.getElementById('sugg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = document.getElementById('sugg-text').value.trim();
    const submitter = document.getElementById('sugg-name').value.trim();
    const statusEl = document.getElementById('sugg-status');
    if (!text) return;
    try {
      await addDoc(collection(db, 'suggestions'), {
        text, submitter, status: 'pending', createdAt: serverTimestamp()
      });
      statusEl.textContent = 'Added! Thanks.';
      statusEl.className = 'status-msg ok';
      e.target.reset();
    } catch (err) {
      statusEl.textContent = 'Something went wrong — try again.';
      statusEl.className = 'status-msg error';
    }
  });
}

function renderLocked() {
  root.innerHTML = `
    <div class="card">
      <h2>Submissions are locked</h2>
      <p>The admin is filtering suggestions and building the bracket. Check back soon.</p>
    </div>
  `;
}

// ---- Two-sided bracket rendering ----
// Layout: [left round 0, left round 1, ... left finalist round] [FINAL] [right finalist round, ... right round 1, right round 0]
// so both sides visually converge on the center Final match, like a standard tournament poster.

function renderBracket(isComplete) {
  if (!bracketData || !bracketData.left || !bracketData.right) {
    root.innerHTML = `<div class="card"><p>Bracket is being set up — check back shortly.</p></div>`;
    return;
  }

  const leftRounds = bracketData.left.rounds;
  const rightRounds = bracketData.right.rounds;
  const stackCount = leftRounds[0].matches.length;
  const perSideTotalRounds = leftRounds.length; // both sides always advance together

  const leftCols = leftRounds.map((round, ri) => columnHtml(round, ri, perSideTotalRounds, false));
  const rightCols = [...rightRounds].map((round, ri) => ({ round, ri })).reverse()
    .map(({ round, ri }) => columnHtml(round, ri, perSideTotalRounds, true));

  const finalCol = `
    <div class="round-col final-col" style="--n:1">
      <div class="round-label">Final</div>
      ${bracketData.final ? renderMatch(bracketData.final, isFinalOpen()) : `<div class="match"><div class="contender bye">TBD</div><div class="contender bye">TBD</div></div>`}
    </div>
  `;

  root.innerHTML = `
    <div class="bracket-scroll">
      <div class="bracket-row" style="--stack-count:${stackCount}">
        ${leftCols.join('')}
        ${finalCol}
        ${rightCols.join('')}
      </div>
    </div>
  `;

  if (isComplete && bracketData.final && bracketData.final.winnerId) {
    const winner = getContenderText(bracketData.final, bracketData.final.winnerId);
    root.insertAdjacentHTML('beforeend', `
      <div class="winner-banner">
        <div class="label">Winner</div>
        <div class="display">${escapeHtml(winner)}</div>
      </div>
    `);
  }

  attachVoteCounts();
  if (!isComplete) attachVoteHandlers();
}

function isFinalOpen() {
  return !!bracketData.final && !bracketData.final.winnerId;
}

function columnHtml(round, roundIndex, totalRounds, isRightSide) {
  const label = sideRoundLabel(roundIndex, totalRounds);
  const isCurrentRound = !bracketData.final && roundIndex === bracketData.currentRound;
  const mirrorClass = isRightSide ? ' mirror' : '';
  return `
    <div class="round-col${mirrorClass}" style="--n:${round.matches.length}">
      <div class="round-label">${label}</div>
      ${round.matches.map(m => renderMatch(m, isCurrentRound)).join('')}
    </div>
  `;
}

function sideRoundLabel(i, total) {
  const fromEnd = total - i;
  if (fromEnd === 1) return 'Semifinal';
  if (fromEnd === 2) return 'Quarterfinal';
  return `Round ${i + 1}`;
}

function getContenderText(match, id) {
  if (id === 'bye') return 'Bye';
  if (match.aId === id) return match.aText;
  if (match.bId === id) return match.bText;
  return '';
}

function renderMatch(m, isCurrentRound) {
  const decided = !!m.winnerId;

  const contender = (id, text) => {
    if (id === null) return `<div class="contender bye">TBD</div>`;
    if (id === 'bye') return `<div class="contender bye">Bye</div>`;
    const classes = ['contender'];
    if (decided) {
      classes.push(id === m.winnerId ? 'winner' : 'loser');
    }
    if (!isCurrentRound || decided) classes.push('locked');
    // Vote counts are only ever shown once a match is decided, so people
    // can't see running totals while a round is still open for voting.
    const voteSpan = decided ? `<span class="votes" data-vote-for="${m.id}:${id}"></span>` : '';
    return `<button type="button" class="${classes.join(' ')}" data-match="${m.id}" data-stage="${m.id}" data-choice="${id}" ${(!isCurrentRound || decided) ? 'disabled' : ''}>
      <span>${escapeHtml(text || '')}</span>
      ${voteSpan}
    </button>`;
  };

  return `<div class="match">
    ${contender(m.aId, m.aText)}
    ${contender(m.bId, m.bText)}
  </div>`;
}

function allMatches() {
  const list = [];
  bracketData.left.rounds.forEach(r => list.push(...r.matches));
  bracketData.right.rounds.forEach(r => list.push(...r.matches));
  if (bracketData.final) list.push(bracketData.final);
  return list;
}

// Shows vote counts only for matches that already have a declared winner
// (i.e. a round that has closed) — never for the currently open round/final.
function attachVoteCounts() {
  allMatches().forEach(m => {
    if (!m.winnerId || m.aId === 'bye' || m.bId === 'bye') return;
    const q = query(collection(db, 'votes'), where('matchId', '==', m.id));
    onSnapshot(q, (snap) => {
      const counts = { [m.aId]: 0, [m.bId]: 0 };
      snap.docs.forEach(d => {
        const c = d.data().choice;
        if (c in counts) counts[c]++;
      });
      document.querySelectorAll(`[data-vote-for="${m.id}:${m.aId}"]`).forEach(el => el.textContent = counts[m.aId]);
      document.querySelectorAll(`[data-vote-for="${m.id}:${m.bId}"]`).forEach(el => el.textContent = counts[m.bId]);
    });
  });
}

function attachVoteHandlers() {
  document.querySelectorAll('.contender[data-match]:not(:disabled)').forEach(btn => {
    const matchId = btn.dataset.match;
    const stage = btn.dataset.stage;
    if (localStorage.getItem(votedKey(stage, matchId))) {
      btn.classList.add('locked');
      btn.disabled = true;
      return;
    }
    btn.addEventListener('click', async () => {
      if (localStorage.getItem(votedKey(stage, matchId))) return;
      const choice = btn.dataset.choice;
      const voterToken = getVoterToken();
      const voteId = `${matchId}__${voterToken}`;
      try {
        await setDoc(doc(db, 'votes', voteId), {
          matchId, round: stage, choice, voterToken, createdAt: serverTimestamp()
        });
        localStorage.setItem(votedKey(stage, matchId), '1');
        document.querySelectorAll(`.contender[data-match="${matchId}"]`).forEach(el => {
          el.classList.add('locked');
          el.disabled = true;
        });
        btn.classList.add('winner');
      } catch (err) {
        alert('That link has already voted on this match.');
      }
    });
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
