import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, addDoc, setDoc, onSnapshot, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const authClient = getAuth(app);

const root = document.getElementById('app-root');
const titleEl = document.getElementById('tournament-title');
const pillEl = document.getElementById('phase-pill');

let currentConfig = null;
let suggestions = [];
let bracketData = null;
let currentUser = null;
let voterDoc = null;
let voterUnsub = null;

// Voter accounts don't use real email — we turn their chosen name into a
// fake-but-valid-looking email address just so Firebase's built-in
// email/password auth can be reused as a lightweight name+code login.
function nameToEmail(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!slug) return null;
  return `${slug}@voter.local`;
}

async function handleVoterAuth(name, code) {
  const email = nameToEmail(name);
  if (!email) throw new Error('Please enter a name with at least one letter or number.');
  if (!/^[0-9]{6}$/.test(code)) throw new Error('Code must be exactly 6 digits.');
  try {
    const cred = await createUserWithEmailAndPassword(authClient, email, code);
    await setDoc(doc(db, 'voters', cred.user.uid), { name, status: 'pending', createdAt: serverTimestamp() });
  } catch (err) {
    if (err.code === 'auth/email-already-in-use') {
      try {
        await signInWithEmailAndPassword(authClient, email, code);
      } catch (err2) {
        throw new Error('That name is already in use with a different code. Try a variation, e.g. add your last initial.');
      }
    } else if (err.code === 'auth/weak-password') {
      throw new Error('Code must be at least 6 digits.');
    } else {
      throw new Error('Something went wrong — try again.');
    }
  }
}

onAuthStateChanged(authClient, (user) => {
  currentUser = user;
  if (voterUnsub) { voterUnsub(); voterUnsub = null; }
  if (user) {
    voterUnsub = onSnapshot(doc(db, 'voters', user.uid), (snap) => {
      voterDoc = snap.exists() ? snap.data() : null;
      render();
    });
  } else {
    voterDoc = null;
    render();
  }
});

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
  else if (currentConfig.phase === 'voting') {
    if (!currentUser || !voterDoc || voterDoc.status !== 'approved') renderVoterGate();
    else renderBracket(false);
  }
  else if (currentConfig.phase === 'complete') renderBracket(true);
}

function renderVoterGate() {
  let statusMsg = '';
  if (currentUser && voterDoc) {
    if (voterDoc.status === 'pending') statusMsg = `<p class="status-msg">Hi ${escapeHtml(voterDoc.name)} — waiting for the admin to approve you before you can vote.</p>`;
    if (voterDoc.status === 'rejected') statusMsg = `<p class="status-msg error">Your request wasn't approved. Check with the admin.</p>`;
  }
  root.innerHTML = `
    <div class="card">
      <h2>${currentUser ? 'Voting access' : 'Sign in to vote'}</h2>
      ${!currentUser ? `<p class="subtext" style="color:#555;">Enter your name and pick a 6-digit code you'll remember. First time creates your voting account — the admin approves it before you can vote.</p>` : ''}
      ${statusMsg}
      ${!currentUser ? `
        <form class="submit-form" id="voter-form">
          <div><label for="voter-name">Your name</label><br/><input type="text" id="voter-name" maxlength="40" required /></div>
          <div><label for="voter-code">6-digit code</label><br/><input type="text" id="voter-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required /></div>
          <button type="submit">Continue</button>
          <p class="status-msg error" id="voter-error"></p>
        </form>
      ` : `<button id="voter-signout" class="secondary">Sign out</button>`}
    </div>
  `;
  if (!currentUser) {
    document.getElementById('voter-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('voter-name').value.trim();
      const code = document.getElementById('voter-code').value.trim();
      const errEl = document.getElementById('voter-error');
      errEl.textContent = '';
      try {
        await handleVoterAuth(name, code);
      } catch (err) {
        errEl.textContent = err.message;
      }
    });
  } else {
    document.getElementById('voter-signout').addEventListener('click', () => signOut(authClient));
  }
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

function renderBracket(isComplete) {
  if (!bracketData || !bracketData.left || !bracketData.right) {
    root.innerHTML = `<div class="card"><p>Bracket is being set up — check back shortly.</p></div>`;
    return;
  }

  const leftRounds = bracketData.left.rounds;
  const rightRounds = bracketData.right.rounds;
  const stackCount = leftRounds[0].matches.length;
  const perSideTotalRounds = Math.log2(stackCount * 2);

  const leftCols = [];
  const roundsBySide = { left: [], right: [] };
  for (let ri = 0; ri < perSideTotalRounds; ri++) {
    const matches = getRoundMatches(leftRounds, ri, stackCount, 'left');
    roundsBySide.left[ri] = matches.map(m => m.id);
    leftCols.push(columnHtml(matches, ri, perSideTotalRounds, false));
  }
  const rightCols = [];
  for (let ri = perSideTotalRounds - 1; ri >= 0; ri--) {
    const matches = getRoundMatches(rightRounds, ri, stackCount, 'right');
    roundsBySide.right[ri] = matches.map(m => m.id); // indexed by real round number, not DOM order
    rightCols.push(columnHtml(matches, ri, perSideTotalRounds, true));
  }

  const finalId = bracketData.final ? bracketData.final.id : 'final-slot';
  const finalCol = `
    <div class="round-col final-col" style="--n:1">
      <div class="round-label">Final</div>
      ${bracketData.final ? renderMatch(bracketData.final, isFinalOpen()) : `<div class="match" data-mid="final-slot"><div class="contender bye">TBD</div><div class="contender bye">TBD</div></div>`}
    </div>
  `;

  const signOutBar = currentUser && voterDoc && voterDoc.status === 'approved'
    ? `<p class="subtext" style="color:var(--text-on-ink); opacity:0.6; margin-bottom:1rem;">Voting as ${escapeHtml(voterDoc.name)} — <a href="#" id="voter-signout-link">sign out</a></p>`
    : '';

  root.innerHTML = `
    ${signOutBar}
    <p class="bracket-hint">Click and drag to look around the bracket</p>
    <div class="bracket-viewport" id="bracket-viewport">
      <div class="bracket-row" id="bracket-row" style="--stack-count:${stackCount}">
        <svg class="connector-svg" id="connector-svg"></svg>
        ${leftCols.join('')}
        ${finalCol}
        ${rightCols.join('')}
      </div>
    </div>
  `;

  initBracketPan();
  drawConnectors(roundsBySide, finalId, perSideTotalRounds);

  const signOutLink = document.getElementById('voter-signout-link');
  if (signOutLink) signOutLink.addEventListener('click', (e) => { e.preventDefault(); signOut(authClient); });

  if (isComplete && bracketData.final && bracketData.final.winnerId) {
    const winner = getContenderText(bracketData.final, bracketData.final.winnerId);
    root.insertAdjacentHTML('beforeend', `
      <div class="winner-banner">
        <div class="label">Winner</div>
        <div class="display">${escapeHtml(winner)}</div>
      </div>
    `);
    celebrateWinner();
  }

  attachVoteCounts();
  if (!isComplete) {
    attachVoteHandlers();
    applyExistingVotes();
  }
}

function isFinalOpen() {
  return !!bracketData.final && !bracketData.final.winnerId;
}

function getRoundMatches(sideRounds, roundIndex, stackCount, side) {
  if (sideRounds[roundIndex]) return sideRounds[roundIndex].matches;
  const count = stackCount / Math.pow(2, roundIndex);
  return Array.from({ length: count }, (_, i) => ({
    id: `placeholder-${side}-${roundIndex}-${i}`, aId: null, bId: null, aText: '', bText: '', winnerId: null
  }));
}

function columnHtml(matches, roundIndex, totalRounds, isRightSide) {
  const label = sideRoundLabel(roundIndex, totalRounds);
  const isCurrentRound = !bracketData.final && roundIndex === bracketData.currentRound;
  const mirrorClass = isRightSide ? ' mirror' : '';
  return `
    <div class="round-col${mirrorClass}" style="--n:${matches.length}">
      <div class="round-label">${label}</div>
      ${matches.map(m => renderMatch(m, isCurrentRound)).join('')}
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
  if (m.aId === 'bye' || m.bId === 'bye') {
    const winnerText = m.winnerId === 'bye' ? 'Bye' : getContenderText(m, m.winnerId);
    return `<div class="match bye-match" data-mid="${m.id}">
      <div class="contender winner">
        <span>${escapeHtml(winnerText)}</span>
      </div>
      <div class="bye-note">auto-advances (bye)</div>
    </div>`;
  }

  const decided = !!m.winnerId;

  const contender = (id, text) => {
    if (id === null) return `<div class="contender bye">TBD</div>`;
    if (id === 'bye') return `<div class="contender bye">Bye</div>`;
    const classes = ['contender'];
    if (decided) {
      classes.push(id === m.winnerId ? 'winner' : 'loser');
    }
    if (!isCurrentRound || decided) classes.push('locked');
    const voteSpan = decided ? `<span class="votes" data-vote-for="${m.id}:${id}"></span>` : '';
    return `<button type="button" class="${classes.join(' ')}" data-match="${m.id}" data-choice="${id}" ${(!isCurrentRound || decided) ? 'disabled' : ''}>
      <span>${escapeHtml(text || '')}</span>
      ${voteSpan}
    </button>`;
  };

  return `<div class="match" data-mid="${m.id}">
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
    btn.addEventListener('click', async () => {
      if (!currentUser) return;
      const choice = btn.dataset.choice;
      const voteId = `${matchId}__${currentUser.uid}`;
      try {
        await setDoc(doc(db, 'votes', voteId), {
          matchId, round: matchId, choice, voterToken: currentUser.uid, createdAt: serverTimestamp()
        });
        document.querySelectorAll(`.contender[data-match="${matchId}"]`).forEach(el => {
          el.classList.add('locked');
          el.disabled = true;
        });
        btn.classList.add('selected');
      } catch (err) {
        alert('That account has already voted on this match.');
      }
    });
  });
}

// Marks whichever option the signed-in voter already picked on each
// currently-open match, so their choice stays visible across logins,
// browsers, or just leaving and coming back — not just this page load.
async function applyExistingVotes() {
  if (!currentUser) return;
  const openMatchIds = new Set();
  document.querySelectorAll('.contender[data-match]:not(:disabled)').forEach(btn => openMatchIds.add(btn.dataset.match));

  for (const matchId of openMatchIds) {
    try {
      const snap = await getDoc(doc(db, 'votes', `${matchId}__${currentUser.uid}`));
      if (snap.exists()) {
        const choice = snap.data().choice;
        document.querySelectorAll(`.contender[data-match="${matchId}"]`).forEach((btn) => {
          btn.classList.add('locked');
          btn.disabled = true;
          if (btn.dataset.choice === choice) btn.classList.add('selected');
        });
      }
    } catch (err) {
      // If the check fails, just leave the match voteable as normal.
    }
  }
}

function initBracketPan() {
  const viewport = document.getElementById('bracket-viewport');
  const content = document.getElementById('bracket-row');
  if (!viewport || !content) return;

  let dragging = false;
  let startPointerX = 0, startPointerY = 0;
  let startX = 0, startY = 0;
  let curX = 0, curY = 0;

  function bounds() {
    const maxNegX = Math.min(0, viewport.clientWidth - content.offsetWidth);
    const maxNegY = Math.min(0, viewport.clientHeight - content.offsetHeight);
    return { minX: maxNegX, maxX: 0, minY: maxNegY, maxY: 0 };
  }

  function apply() {
    content.style.transform = `translate(${curX}px, ${curY}px)`;
  }

  function down(x, y) {
    dragging = true;
    startPointerX = x; startPointerY = y;
    startX = curX; startY = curY;
    viewport.classList.add('dragging');
  }

  function move(x, y) {
    if (!dragging) return;
    const b = bounds();
    curX = Math.min(b.maxX, Math.max(b.minX, startX + (x - startPointerX)));
    curY = Math.min(b.maxY, Math.max(b.minY, startY + (y - startPointerY)));
    apply();
  }

  function up() {
    dragging = false;
    viewport.classList.remove('dragging');
  }

  viewport.addEventListener('mousedown', (e) => { down(e.clientX, e.clientY); e.preventDefault(); });
  window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
  window.addEventListener('mouseup', up);

  viewport.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    down(t.clientX, t.clientY);
  }, { passive: true });
  viewport.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    move(t.clientX, t.clientY);
  }, { passive: true });
  viewport.addEventListener('touchend', up);
}

let lastConnectorArgs = null;
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (lastConnectorArgs) drawConnectors(...lastConnectorArgs);
  }, 150);
});

function drawConnectors(roundsBySide, finalId, perSideTotalRounds) {
  lastConnectorArgs = [roundsBySide, finalId, perSideTotalRounds];
  const bracketRow = document.getElementById('bracket-row');
  const svg = document.getElementById('connector-svg');
  if (!bracketRow || !svg) return;

  // Force layout, then size the SVG to exactly cover the (untransformed) content.
  const w = bracketRow.offsetWidth;
  const h = bracketRow.offsetHeight;
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

  const originRect = bracketRow.getBoundingClientRect();
  const lines = [];

  function localEdge(id, edge) {
    const el = bracketRow.querySelector(`[data-mid="${cssEscape(id)}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: (edge === 'right' ? r.right : r.left) - originRect.left,
      y: (r.top + r.height / 2) - originRect.top
    };
  }

  function addElbow(idA, idB, parentId, parentEdge, outEdge) {
    const pA = localEdge(idA, outEdge);
    const pB = localEdge(idB, outEdge);
    const pP = localEdge(parentId, parentEdge);
    if (!pA || !pB || !pP) return;
    const midX = (pA.x + pP.x) / 2;
    lines.push([pA.x, pA.y, midX, pA.y]);
    lines.push([pB.x, pB.y, midX, pB.y]);
    lines.push([midX, pA.y, midX, pB.y]);
    lines.push([midX, pP.y, pP.x, pP.y]);
  }

  ['left', 'right'].forEach((side) => {
    const outEdge = side === 'left' ? 'right' : 'left';
    const parentEdge = side === 'left' ? 'left' : 'right';
    for (let r = 0; r < perSideTotalRounds; r++) {
      const ids = roundsBySide[side][r];
      const isLast = r === perSideTotalRounds - 1;
      const nextIds = isLast ? [finalId] : roundsBySide[side][r + 1];
      for (let k = 0; k < ids.length; k += 2) {
        const parentId = isLast ? nextIds[0] : nextIds[k / 2];
        addElbow(ids[k], ids[k + 1], parentId, parentEdge, outEdge);
      }
    }
  });

  svg.innerHTML = lines.map(([x1, y1, x2, y2]) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--steel)" stroke-width="2" />`
  ).join('');
}

function cssEscape(str) {
  return String(str).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

let confettiShown = false;
function celebrateWinner() {
  if (confettiShown) return;
  confettiShown = true;
  const colors = ['#e3a83b', '#c1502f', '#6fa287', '#7b8492', '#f5f2ea'];
  for (let i = 0; i < 70; i++) {
    const el = document.createElement('div');
    el.className = 'confetti-piece';
    el.style.left = Math.random() * 100 + 'vw';
    el.style.background = colors[Math.floor(Math.random() * colors.length)];
    el.style.animationDelay = (Math.random() * 0.4) + 's';
    el.style.animationDuration = (2.2 + Math.random() * 1.6) + 's';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
