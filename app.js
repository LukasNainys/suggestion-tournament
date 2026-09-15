import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, addDoc, onSnapshot, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const root = document.getElementById('app-root');
const titleEl = document.getElementById('tournament-title');
const pillEl = document.getElementById('phase-pill');

// A per-browser random id so we can stop someone voting twice in the same match
// from the same browser. Not bulletproof, but enough for a friendly group.
function getVoterToken() {
  let t = localStorage.getItem('voterToken');
  if (!t) {
    t = crypto.randomUUID();
    localStorage.setItem('voterToken', t);
  }
  return t;
}

function votedKey(round, matchId) {
  return `voted_${round}_${matchId}`;
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

function renderBracket(isComplete) {
  if (!bracketData || !bracketData.rounds || bracketData.rounds.length === 0) {
    root.innerHTML = `<div class="card"><p>Bracket is being set up — check back shortly.</p></div>`;
    return;
  }

  const rounds = bracketData.rounds;
  const totalRounds = Math.log2(rounds[0].matches.length * 2);
  const roundNames = rounds.map((_, i) => roundLabel(i, totalRounds));

  root.innerHTML = `
    <div class="bracket-scroll">
      <div class="bracket-row" style="--stack-count:${rounds[0].matches.length}">
        ${rounds.map((round, ri) => `
          <div class="round-col" style="--n:${round.matches.length}">
            <div class="round-label">${roundNames[ri]}</div>
            ${round.matches.map(m => renderMatch(m, ri)).join('')}
          </div>
        `).join('')}
      </div>
    </div>
  `;

  if (isComplete) {
    const finalRound = rounds[rounds.length - 1].matches;
    const finalMatch = finalRound[0];
    const winner = finalMatch && finalMatch.winnerId
      ? getContenderText(finalMatch, finalMatch.winnerId)
      : null;
    if (winner) {
      root.insertAdjacentHTML('beforeend', `
        <div class="winner-banner">
          <div class="label">Winner</div>
          <div class="display">${escapeHtml(winner)}</div>
        </div>
      `);
    }
  }

  attachVoteCounts(rounds);
  if (!isComplete) attachVoteHandlers(rounds);
}

// Shows vote counts only for matches that already have a declared winner
// (i.e. a round that has closed) — never for the currently open round.
function attachVoteCounts(rounds) {
  rounds.forEach(round => {
    round.matches.forEach(m => {
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
  });
}

function roundLabel(i, total) {
  const fromEnd = total - i;
  if (fromEnd === 1) return 'Final';
  if (fromEnd === 2) return 'Semifinal';
  if (fromEnd === 3) return 'Quarterfinal';
  return `Round ${i + 1}`;
}

function getContenderText(match, id) {
  if (id === 'bye') return 'Bye';
  if (match.aId === id) return match.aText;
  if (match.bId === id) return match.bText;
  return '';
}

function renderMatch(m, roundIndex) {
  const isCurrentRound = roundIndex === bracketData.currentRound;
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
    return `<button type="button" class="${classes.join(' ')}" data-match="${m.id}" data-round="${roundIndex}" data-choice="${id}" ${(!isCurrentRound || decided) ? 'disabled' : ''}>
      <span>${escapeHtml(text || '')}</span>
      ${voteSpan}
    </button>`;
  };

  return `<div class="match">
    ${contender(m.aId, m.aText)}
    ${contender(m.bId, m.bText)}
  </div>`;
}

function attachVoteHandlers(rounds) {
  const currentRound = bracketData.currentRound;
  const matches = (rounds[currentRound] && rounds[currentRound].matches) || [];

  document.querySelectorAll('.contender[data-match]').forEach(btn => {
    const matchId = btn.dataset.match;
    const round = btn.dataset.round;
    if (localStorage.getItem(votedKey(round, matchId))) {
      btn.classList.add('locked');
      btn.disabled = true;
    }
    btn.addEventListener('click', async () => {
      if (localStorage.getItem(votedKey(round, matchId))) return;
      const choice = btn.dataset.choice;
      try {
        await addDoc(collection(db, 'votes'), {
          matchId, round: Number(round), choice, voterToken: getVoterToken(), createdAt: serverTimestamp()
        });
        localStorage.setItem(votedKey(round, matchId), '1');
        document.querySelectorAll(`.contender[data-match="${matchId}"]`).forEach(el => {
          el.classList.add('locked');
          el.disabled = true;
        });
        btn.classList.add('winner');
      } catch (err) {
        alert('Vote failed — try again.');
      }
    });
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
